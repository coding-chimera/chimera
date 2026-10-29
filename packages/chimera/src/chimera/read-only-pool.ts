import fs from "fs"
import * as Log from "@opencode-ai/core/util/log"
import { getDatabasePath } from "@/graph"
import type { ProjectGraphState } from "./provenance"

/**
 * Read-only CodeGraph connection pool (tarn.js/sqlx-shaped).
 *
 * Read-only graph opens were never cached: every graph HTTP request and every
 * read-only tool open paid a fresh SQLite connection (page cache + mmap +
 * migration check) and closed it again on release. Under WebUI use that churn
 * fragmented native memory — mimalloc arenas keep freed spans, so the process
 * RSS ratcheted up with every open/close cycle even though each connection was
 * short-lived.
 *
 * Design (mirrors tarn.js create/validate/destroy plus sqlx pool semantics):
 * - Capacity is max 4 pooled connections per project root
 *   (CHIMERA_GRAPH_RO_POOL_MAX). Read-only graph requests are synchronous
 *   SQLite reads on the main thread, so a single connection serialized
 *   every concurrent request behind the others; four lets independent
 *   requests proceed without a queue wait while still bounding the
 *   per-connection page cache + mmap footprint (mimalloc never returns it).
 *   Lower the cap when the RSS budget matters more than read concurrency.
 * - Validate-on-checkout (tarn `validate` / sqlx `test_before_acquire`): an
 *   idle entry is destroyed and recreated when the database file disappeared,
 *   the connection was closed underneath the pool, or the entry reached
 *   maxLifetime. Freshness needs no validation: `getSnapshot()` reads live
 *   SQL per call and WAL readers see the latest committed state per
 *   statement. A replaced database file (the `reopenReplacedDatabase` case)
 *   is picked up by maxLifetime retirement at the latest; the writer-side
 *   heal stays where it is because `reopenReplacedDatabase` refuses
 *   read-only handles.
 * - maxLifetime (sqlx `max_lifetime`, CHIMERA_GRAPH_RO_MAX_LIFETIME_MS,
 *   default 10 min, 0 disables) exists for the same mimalloc-retention
 *   reason: retiring a connection periodically is the only way to actually
 *   free its accumulated per-connection SQLite cache back to the OS. Checked
 *   on checkout AND by the idle sweep.
 * - Idle TTL (sqlx `idle_timeout`, CHIMERA_GRAPH_RO_IDLE_TTL_MS, default
 *   60s, 0 disables): idle entries are reaped by the existing
 *   `evictGraphStates` sweep in provenance.ts via `reapReadOnlyPool` — this
 *   module never arms its own interval.
 * - Contending acquires queue FIFO and are handed the connection in arrival
 *   order; a waiter that is not served within
 *   CHIMERA_GRAPH_RO_ACQUIRE_TIMEOUT_MS (default 5s) rejects. The timeout
 *   bounds the QUEUE wait, not the open itself: once creation starts for a
 *   waiter its timer is cleared, and a hung open only affects that waiter
 *   (later waiters still time out because the root stays in `creating`).
 *   A wait over 1s logs a warn (sqlx slow-acquire-warning analog).
 * - release(true) returns the entry to the idle set; release(false) (the use
 *   threw) destroys it. close() errors are swallowed with a warn.
 *
 * Boundary: ONLY the provenance.ts withProjectGraph path is pooled (its
 * openGraphState readOnly route acquires leases and its release callback
 * returns them). Read-only opens that manage their own CodeGraph lifecycle
 * stay unpooled by design: the MCP engine (src/graph/mcp/engine.ts) and the
 * graph CLI (src/graph/cli/chimera.ts) live inside src/graph/, which must
 * never depend on src/chimera/ or @opencode-ai/core. A direct
 * `Chimera.openProjectGraph({ readOnly: true })` caller that neither uses
 * withProjectGraph nor releases its lease pins the pooled entry in-use —
 * use withProjectGraph for read-only opens.
 *
 * Read-only invariants hold: the pool never creates graph data. Acquiring on
 * an uninitialized root fails exactly like a direct read-only open (the
 * caller-supplied `open` rejects), and validation only ever reads the
 * filesystem and closes connections.
 */

export interface ReadOnlyLease {
  state: ProjectGraphState
  release(ok: boolean): void
}

interface PoolEntry {
  state: ProjectGraphState
  createdAt: number
  lastUsedAt: number
  inUse: boolean
}

interface Waiter {
  open: () => Promise<ProjectGraphState>
  resolve: (lease: ReadOnlyLease) => void
  reject: (error: Error) => void
  enqueuedAt: number
  timer: ReturnType<typeof setTimeout>
}

const graphLog = Log.create({ service: "chimera.read-only-pool" })

const DEFAULT_POOL_MAX = 4
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000
const DEFAULT_IDLE_TTL_MS = 60 * 1000
const DEFAULT_RO_CACHE_MB = 4
const SLOW_ACQUIRE_WARN_MS = 1_000

const entries = new Map<string, PoolEntry[]>()
const waiters = new Map<string, Waiter[]>()
/** Roots with an in-flight create; single-flight so capacity is never exceeded. */
const creating = new Set<string>()

function envNumber(name: string, fallback: number) {
  const raw = process.env[name]
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Read per call so tests (and operators) can retune without a reload. */
function poolSettings() {
  return {
    max: Math.max(1, envNumber("CHIMERA_GRAPH_RO_POOL_MAX", DEFAULT_POOL_MAX)),
    acquireTimeoutMs: envNumber("CHIMERA_GRAPH_RO_ACQUIRE_TIMEOUT_MS", DEFAULT_ACQUIRE_TIMEOUT_MS),
    maxLifetimeMs: envNumber("CHIMERA_GRAPH_RO_MAX_LIFETIME_MS", DEFAULT_MAX_LIFETIME_MS),
    idleTtlMs: envNumber("CHIMERA_GRAPH_RO_IDLE_TTL_MS", DEFAULT_IDLE_TTL_MS),
  }
}

/** Per-connection page-cache budget for pooled read-only opens (MB). */
export function readOnlyCacheSizeMB() {
  return envNumber("CHIMERA_SQLITE_RO_CACHE_MB", DEFAULT_RO_CACHE_MB)
}

function entryList(root: string) {
  return entries.get(root) ?? []
}

function destroyEntry(root: string, entry: PoolEntry, reason: string) {
  const list = entries.get(root)
  if (list) {
    const index = list.indexOf(entry)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) entries.delete(root)
  }
  entry.state.graph.close().catch((error: unknown) => {
    graphLog.warn("read-only pool close failed", {
      root,
      reason,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/** tarn `validate` / sqlx `test_before_acquire`: why an idle entry must not be checked out. */
function invalidReason(root: string, entry: PoolEntry, now: number) {
  if (!fs.existsSync(getDatabasePath(root))) return "database-missing"
  if (entry.state.graph.isClosed()) return "connection-closed"
  const { maxLifetimeMs } = poolSettings()
  if (maxLifetimeMs > 0 && now - entry.createdAt >= maxLifetimeMs) return "max-lifetime"
  return undefined
}

/** Validate idle entries, destroy the invalid ones, check out the first valid one. */
function checkoutIdleEntry(root: string, now: number) {
  const valid = entryList(root)
    .filter((entry) => !entry.inUse)
    .filter((entry) => {
      const reason = invalidReason(root, entry, now)
      if (!reason) return true
      destroyEntry(root, entry, reason)
      return false
    })
  const entry = valid[0]
  if (!entry) return undefined
  entry.inUse = true
  entry.lastUsedAt = now
  return entry
}

function leaseFor(root: string, entry: PoolEntry): ReadOnlyLease {
  let released = false
  return {
    state: entry.state,
    release(ok: boolean) {
      if (released) return
      released = true
      if (!ok) destroyEntry(root, entry, "use-failed")
      else {
        entry.inUse = false
        entry.lastUsedAt = Date.now()
      }
      pump(root)
    },
  }
}

function settleWaiter(root: string, waiter: Waiter, entry: PoolEntry) {
  clearTimeout(waiter.timer)
  const waitedMs = Date.now() - waiter.enqueuedAt
  if (waitedMs >= SLOW_ACQUIRE_WARN_MS) {
    graphLog.warn("slow read-only pool acquire", { root, waitedMs })
  }
  waiter.resolve(leaseFor(root, entry))
}

function waiterTimeout(root: string, waiter: Waiter) {
  const queue = waiters.get(root)
  if (!queue) return
  const index = queue.indexOf(waiter)
  if (index < 0) return
  queue.splice(index, 1)
  waiter.reject(
    new Error(
      `Timed out after ${poolSettings().acquireTimeoutMs}ms waiting for a pooled read-only graph connection for ${root}`,
    ),
  )
}

/** FIFO drain: hand an idle entry to the next waiter, or create one within capacity. */
function pump(root: string) {
  if (creating.has(root)) return
  const queue = waiters.get(root)
  if (!queue || queue.length === 0) return
  const idle = checkoutIdleEntry(root, Date.now())
  if (idle) {
    const waiter = queue.shift()
    if (waiter) settleWaiter(root, waiter, idle)
    pump(root)
    return
  }
  if (entryList(root).length >= poolSettings().max) return
  const waiter = queue.shift()
  if (!waiter) return
  // The timeout bounds the queue wait, not the open itself (see header).
  clearTimeout(waiter.timer)
  creating.add(root)
  waiter.open().then(
    (state) => {
      creating.delete(root)
      const now = Date.now()
      const entry: PoolEntry = { state, createdAt: now, lastUsedAt: now, inUse: true }
      const list = entries.get(root) ?? []
      list.push(entry)
      entries.set(root, list)
      settleWaiter(root, waiter, entry)
      pump(root)
    },
    (error: unknown) => {
      creating.delete(root)
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
      // Let the next waiter retry the create instead of stranding the queue.
      pump(root)
    },
  )
}

/**
 * Acquire a pooled read-only graph state for `root`. `open` is the
 * caller-supplied create function (tarn `create`); it is only invoked when
 * the pool has no valid idle entry and capacity allows a new one, so an
 * uninitialized root fails exactly like a direct read-only open.
 */
export function acquire(root: string, open: () => Promise<ProjectGraphState>): Promise<ReadOnlyLease> {
  const enqueuedAt = Date.now()
  // Fairness: never steal an idle entry past queued waiters.
  const queue = waiters.get(root)
  if (!queue || queue.length === 0) {
    const entry = checkoutIdleEntry(root, enqueuedAt)
    if (entry) return Promise.resolve(leaseFor(root, entry))
  }
  const { acquireTimeoutMs } = poolSettings()
  return new Promise<ReadOnlyLease>((resolve, reject) => {
    const timer = setTimeout(() => waiterTimeout(root, waiter), acquireTimeoutMs)
    timer.unref?.()
    const waiter: Waiter = { open, resolve, reject, enqueuedAt, timer }
    const list = waiters.get(root) ?? []
    list.push(waiter)
    waiters.set(root, list)
    pump(root)
  })
}

/**
 * Idle reap for the existing provenance.ts sweep (no second interval):
 * closes idle entries past the idle TTL or past maxLifetime. In-use entries
 * are never touched; their lifetime retirement happens at the next checkout.
 */
export function reapReadOnlyPool(now: number) {
  const { idleTtlMs, maxLifetimeMs } = poolSettings()
  if (idleTtlMs <= 0 && maxLifetimeMs <= 0) return 0
  return [...entries.entries()]
    .map(([root, list]) =>
      list
        .filter((entry) => !entry.inUse)
        .filter(
          (entry) =>
            (idleTtlMs > 0 && now - entry.lastUsedAt >= idleTtlMs) ||
            (maxLifetimeMs > 0 && now - entry.createdAt >= maxLifetimeMs),
        )
        .map((entry) => {
          destroyEntry(root, entry, idleTtlMs > 0 && now - entry.lastUsedAt >= idleTtlMs ? "idle-ttl" : "max-lifetime")
          return 1
        })
        .reduce((count, one) => count + one, 0),
    )
    .reduce((count, one) => count + one, 0)
}

/** Test seam: pool size, in-use count, and per-entry age/idle-age; optionally scoped to one root. */
export function readOnlyPoolStats(root?: string) {
  const now = Date.now()
  const all = [...entries.entries()]
    .filter(([entryRoot]) => root === undefined || entryRoot === root)
    .flatMap(([entryRoot, list]) =>
      list.map((entry) => ({
        root: entryRoot,
        inUse: entry.inUse,
        ageMs: now - entry.createdAt,
        idleAgeMs: entry.inUse ? 0 : now - entry.lastUsedAt,
      })),
    )
  return { size: all.length, inUse: all.filter((entry) => entry.inUse).length, entries: all }
}

/** Test seam: backdate an idle entry's createdAt/lastUsedAt for sweep tests. */
export function ageReadOnlyPoolEntryForTest(root: string, createdAt: number, lastUsedAt: number) {
  const entry = entryList(root).find((candidate) => !candidate.inUse)
  if (!entry) return false
  entry.createdAt = createdAt
  entry.lastUsedAt = lastUsedAt
  return true
}

/** Test seam: destroy every pooled entry and drop every queue without closing waits. */
export function resetReadOnlyPoolForTest() {
  for (const [root, list] of [...entries.entries()]) {
    for (const entry of [...list]) destroyEntry(root, entry, "test-reset")
  }
  for (const [, queue] of [...waiters.entries()]) {
    for (const waiter of queue) clearTimeout(waiter.timer)
  }
  waiters.clear()
}

export * as ReadOnlyPool from "./read-only-pool"
