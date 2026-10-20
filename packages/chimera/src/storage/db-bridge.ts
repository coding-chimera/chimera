/**
 * Native SQLite bridge — opt-in replacement for the lowest-level drizzle
 * client (the bun:sqlite `Database` in db.bun.ts), backed by the
 * `sqlite_bridge` module of the codegraph-kernel .node addon (rusqlite with
 * the vendored amalgamation).
 *
 * The bridge is OPTIONAL everywhere and default-OFF: it activates only when
 * CHIMERA_SQLITE_BRIDGE=1 AND a contract-verified binary loads AND the
 * connection opens. Every failure mode (kill switch unset, no binary for
 * this platform, dlopen error, ABI/capability mismatch, open failure)
 * resolves to null and the caller silently keeps the existing bun:sqlite
 * path — loader discipline copied from src/graph/store/loader.ts. Set
 * CHIMERA_SQLITE_BRIDGE_DEBUG=1 to see why the bridge didn't load.
 *
 * Binary search order (same convention as the store loader — the bridge
 * ships inside the SAME codegraph-kernel.node):
 *   1. CHIMERA_SQLITE_BRIDGE_PATH — explicit .node path (dev/testing
 *      override; falls back to CODEGRAPH_STORE_PATH / CODEGRAPH_KERNEL_PATH)
 *   2. <dir of process.execPath>/kernel/codegraph-kernel.node — release bundle
 *   3. <repo root>/codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node
 *      — staged prebuilds (a pre-bridge binary is skipped by the export
 *      probe, so enabling the env var never breaks an older installation)
 *
 * Sync model: every bridge call is a synchronous short DB operation on the
 * main thread — the same posture as the bun:sqlite path it replaces (db.ts's
 * NotPromise constraint). No long-running work may be added to a bridge call.
 */
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"
import { decodePackedAll, decodePackedValues } from "./db-bridge-decode"

/** Must equal sqlite_bridge.rs SQLITE_BRIDGE_ABI_VERSION. */
export const SQLITE_BRIDGE_ABI_VERSION = 1

/** Opaque napi SqliteBridgeHandle (one handle = one SQLite connection). */
export type SqliteBridgeHandle = object

export interface SqliteBridgeRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteBridgeContractInfo {
  abiVersion: number
  bridgeVersion: string
  capabilities: string[]
}

/** The sqlite_bridge export surface of codegraph-kernel.node (napi camelCase). */
export interface SqliteBridgeModule {
  sqliteBridgeContractInfo(): SqliteBridgeContractInfo
  sqliteBridgeOpen(path: string): SqliteBridgeHandle
  sqliteBridgeExec(handle: SqliteBridgeHandle, sql: string): void
  sqliteBridgeRun(handle: SqliteBridgeHandle, sql: string, params: unknown[]): SqliteBridgeRunResult
  sqliteBridgeGet(handle: SqliteBridgeHandle, sql: string, params: unknown[]): Record<string, unknown> | null
  sqliteBridgeAll(handle: SqliteBridgeHandle, sql: string, params: unknown[]): Record<string, unknown>[]
  sqliteBridgeValues(handle: SqliteBridgeHandle, sql: string, params: unknown[]): unknown[][]
  sqliteBridgeTransactionBegin(handle: SqliteBridgeHandle, behavior: string): void
  sqliteBridgeTransactionCommit(handle: SqliteBridgeHandle): void
  sqliteBridgeTransactionRollback(handle: SqliteBridgeHandle): void
  sqliteBridgeInTransaction(handle: SqliteBridgeHandle): boolean
  sqliteBridgePragma(
    handle: SqliteBridgeHandle,
    pragma: string,
  ): Record<string, unknown> | null | undefined
  sqliteBridgeClose(handle: SqliteBridgeHandle): void
  /**
   * OPTIONAL exports (capability "packed-read", same storeClose? posture):
   * the whole result set encoded into ONE flat Uint8Array per query — the
   * packed wire decoded by db-bridge-decode.ts. An older binary without them
   * stays contract-valid; the statement closures probe per call and fall
   * back to the object path. Deliberately NOT in the export-probe hard gate
   * below and NOT in BRIDGE_REQUIRED_CAPABILITIES.
   */
  sqliteBridgeAllPacked?(handle: SqliteBridgeHandle, sql: string, params: unknown[]): Uint8Array
  sqliteBridgeValuesPacked?(handle: SqliteBridgeHandle, sql: string, params: unknown[]): Uint8Array
}

/**
 * Capabilities the TS client routes through — the contract gate requires
 * capabilities ⊇ THIS set (the CTX_ROUTED_GETTERS posture): a binary missing
 * any routed op is refused wholesale and the bun:sqlite path stays.
 */
export const BRIDGE_REQUIRED_CAPABILITIES: readonly string[] = [
  "open",
  "exec",
  "run",
  "get",
  "all",
  "values",
  "transaction",
  "pragma",
  "close",
]

const bridgeDebugEnabled = () => process.env.CHIMERA_SQLITE_BRIDGE_DEBUG === "1"
export function bridgeDebug(msg: string): void {
  if (bridgeDebugEnabled()) process.stderr.write(`[sqlite-bridge] ${msg}\n`)
}

/** undefined = not attempted yet; null = attempted and unavailable. */
let cached: SqliteBridgeModule | null | undefined

/** Repo root from src/storage/ (dev/test runs only — inside a compiled
 *  binary this path doesn't exist and the candidate is skipped). */
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..")

function candidatePaths(): string[] {
  const candidates: string[] = []
  const explicit =
    process.env.CHIMERA_SQLITE_BRIDGE_PATH ?? process.env.CODEGRAPH_STORE_PATH ?? process.env.CODEGRAPH_KERNEL_PATH
  if (explicit) candidates.push(explicit)
  candidates.push(path.join(path.dirname(process.execPath), "kernel", "codegraph-kernel.node"))
  candidates.push(
    path.join(repoRoot, "codegraph-kernel", "prebuilds", `${process.platform}-${process.arch}`, "codegraph-kernel.node"),
  )
  return candidates
}

/**
 * Verify the binary speaks our bridge contract: ABI EQUALITY (independent
 * numbering, the STORE_ABI_VERSION posture) plus the routed-capability
 * subset. Any mismatch → false → silent bun:sqlite fallback.
 */
export function verifyBridgeContract(info: SqliteBridgeContractInfo): boolean {
  if (info.abiVersion !== SQLITE_BRIDGE_ABI_VERSION) {
    bridgeDebug(`bridge ABI ${info.abiVersion} != expected ${SQLITE_BRIDGE_ABI_VERSION} — ignoring bridge module`)
    return false
  }
  const missing = BRIDGE_REQUIRED_CAPABILITIES.filter((capability) => !info.capabilities.includes(capability))
  if (missing.length > 0) {
    bridgeDebug(`bridge capabilities missing routed ops: '${missing.join("', '")}' — ignoring bridge module`)
    return false
  }
  return true
}

/**
 * Load (once per process) and return the bridge module, or null when
 * unavailable. The kill switch is NOT checked here — callers route through
 * `sqliteBridgeEnabled()` which checks it per call (tests flip it at
 * runtime).
 */
export function getBridgeModule(): SqliteBridgeModule | null {
  if (cached !== undefined) return cached
  cached = null
  for (const candidate of candidatePaths()) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue
      // createRequire: works identically from CJS output and future ESM.
      const req = createRequire(import.meta.url)
      const mod = req(candidate) as Partial<SqliteBridgeModule>
      if (
        typeof mod.sqliteBridgeContractInfo !== "function" ||
        typeof mod.sqliteBridgeOpen !== "function" ||
        typeof mod.sqliteBridgeRun !== "function" ||
        typeof mod.sqliteBridgeGet !== "function" ||
        typeof mod.sqliteBridgeAll !== "function" ||
        typeof mod.sqliteBridgeValues !== "function" ||
        typeof mod.sqliteBridgeExec !== "function" ||
        typeof mod.sqliteBridgeTransactionBegin !== "function" ||
        typeof mod.sqliteBridgeTransactionCommit !== "function" ||
        typeof mod.sqliteBridgeTransactionRollback !== "function" ||
        typeof mod.sqliteBridgeClose !== "function"
      ) {
        bridgeDebug(`${candidate}: missing sqlite_bridge exports (pre-bridge kernel binary?) — ignoring`)
        continue
      }
      const info = mod.sqliteBridgeContractInfo()
      if (!verifyBridgeContract(info)) {
        bridgeDebug(`${info.bridgeVersion ? `bridge ${info.bridgeVersion} @ ` : ""}${candidate}: contract mismatch`)
        continue
      }
      bridgeDebug(`loaded sqlite bridge from ${candidate} (bridge ${info.bridgeVersion}, abi ${info.abiVersion})`)
      cached = mod as SqliteBridgeModule
      break
    } catch (err) {
      bridgeDebug(`${candidate}: failed to load — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return cached
}

/**
 * Per-call routing gate: CHIMERA_SQLITE_BRIDGE=1 opt-in AND a verified
 * module. Unset / "0" / anything else keeps the existing bun:sqlite path
 * (default-OFF); checked per call so tests and embedders can flip it.
 */
export function sqliteBridgeEnabled(): boolean {
  if (process.env.CHIMERA_SQLITE_BRIDGE !== "1") return false
  return getBridgeModule() !== null
}

/** Test hook: forget the loaded module so a changed env is re-evaluated. */
export function resetBridgeForTests(): void {
  cached = undefined
}

/** Test hook: install a fake SqliteBridgeModule, bypassing search/contract. */
export function setBridgeModuleForTests(mod: SqliteBridgeModule | null): void {
  cached = mod
}

// ---------------------------------------------------------------------------
// bun:sqlite-shaped client
// ---------------------------------------------------------------------------

export interface BridgeStatement {
  run(...params: unknown[]): SqliteBridgeRunResult
  get(...params: unknown[]): Record<string, unknown> | null
  all(...params: unknown[]): Record<string, unknown>[]
  values(...params: unknown[]): unknown[][]
}

export type BridgeTransactionBehavior = "deferred" | "immediate" | "exclusive"

export interface BridgeTransactionWrapper<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T>
  deferred(...args: Parameters<T>): ReturnType<T>
  immediate(...args: Parameters<T>): ReturnType<T>
  exclusive(...args: Parameters<T>): ReturnType<T>
}

/**
 * The client surface drizzle-orm/bun-sqlite/session.js drives: `prepare(sql)`
 * → `{run,get,all,values}`, `exec(sql)`, `transaction(cb)` → callable with
 * `.deferred()/.immediate()/.exclusive()` (the session calls
 * `[config.behavior ?? "deferred"]()`), plus `close()` (db.ts $client.close).
 * `pragma`/`run`/`query`/`open`/`inTransaction` mirror the bun:sqlite
 * Database conveniences the storage layer uses elsewhere.
 */
export interface BridgeClient {
  prepare(sql: string): BridgeStatement
  query(sql: string): BridgeStatement
  exec(sql: string): void
  run(sql: string, ...params: unknown[]): SqliteBridgeRunResult
  transaction<T extends (...args: any[]) => any>(fn: T): BridgeTransactionWrapper<T>
  pragma(str: string, options?: { simple?: boolean }): unknown
  close(): void
  readonly open: boolean
  readonly inTransaction: boolean
}

type NamedParameterMap = Record<string, unknown>

function isPlainParameterMap(value: unknown): value is NamedParameterMap {
  return Object.prototype.toString.call(value) === "[object Object]"
}

/**
 * Bun's named parameter binding is stricter than SQLite: `@id` requires an
 * object key spelled `@id`. The expansion sends every prefix variant
 * (x/@x/$x/:x) and the bridge binds only the declared ones —
 * graph/db/sqlite-adapter.ts:57-78 expandNamedParameters parity.
 */
export function expandNamedParameters(value: unknown): unknown {
  if (!isPlainParameterMap(value)) return value

  const expanded: NamedParameterMap = { ...value }
  for (const [rawKey, paramValue] of Object.entries(value)) {
    const key = rawKey.match(/^[@$:](.+)$/)?.[1] ?? rawKey
    if (!Object.prototype.hasOwnProperty.call(expanded, key)) {
      expanded[key] = paramValue
    }
    if (!Object.prototype.hasOwnProperty.call(expanded, `@${key}`)) {
      expanded[`@${key}`] = paramValue
    }
    if (!Object.prototype.hasOwnProperty.call(expanded, `$${key}`)) {
      expanded[`$${key}`] = paramValue
    }
    if (!Object.prototype.hasOwnProperty.call(expanded, `:${key}`)) {
      expanded[`:${key}`] = paramValue
    }
  }

  return expanded
}

function normalizeParams(params: unknown[]): unknown[] {
  return params.map(expandNamedParameters)
}

/**
 * Per-call packed-read gate: the optional export exists (that IS the
 * "packed-read" capability probe — old binaries and fake modules simply
 * lack it) AND the CHIMERA_SQLITE_BRIDGE_PACKED kill switch is not "0"
 * (default ON whenever the binary carries the exports). Checked per call,
 * the sqliteBridgeEnabled() discipline, so tests and embedders can flip it
 * at runtime without cache invalidation.
 */
function packedReadEnabled(packed: unknown): boolean {
  return typeof packed === "function" && process.env.CHIMERA_SQLITE_BRIDGE_PACKED !== "0"
}

/**
 * Wrap a loaded bridge module + open handle in the bun:sqlite Database
 * shape. The prepare cache lives Rust-side (rusqlite prepare_cached, LRU 256
 * by SQL text, released with the connection), so `prepare` is a cheap
 * closure factory — no JS-side withPrepareCache proxy needed.
 */
export function bridgeClient(mod: SqliteBridgeModule, handle: SqliteBridgeHandle): BridgeClient {
  let closed = false

  // all()/values() route through the packed wire when available (ONE napi
  // crossing per query + TS-side DataView/TextDecoder decode instead of one
  // napi value creation per cell); get() stays on the object path — a single
  // row never amortizes the packed header, and drizzle's hot field-mapped
  // reads go through values() anyway.
  const statement = (sql: string): BridgeStatement => ({
    run: (...params: unknown[]) => mod.sqliteBridgeRun(handle, sql, normalizeParams(params)),
    get: (...params: unknown[]) => mod.sqliteBridgeGet(handle, sql, normalizeParams(params)),
    all: (...params: unknown[]) =>
      packedReadEnabled(mod.sqliteBridgeAllPacked)
        ? decodePackedAll(mod.sqliteBridgeAllPacked!(handle, sql, normalizeParams(params)))
        : mod.sqliteBridgeAll(handle, sql, normalizeParams(params)),
    values: (...params: unknown[]) =>
      packedReadEnabled(mod.sqliteBridgeValuesPacked)
        ? decodePackedValues(mod.sqliteBridgeValuesPacked!(handle, sql, normalizeParams(params)))
        : mod.sqliteBridgeValues(handle, sql, normalizeParams(params)),
  })

  const runTransaction =
    <T extends (...args: any[]) => any>(fn: T, behavior: BridgeTransactionBehavior) =>
    (...args: Parameters<T>): ReturnType<T> => {
      // Nested calls JOIN the outer unit (Rust depth counter — plain
      // BEGIN/COMMIT, NO savepoints; sqlite-adapter.ts / store.rs parity).
      mod.sqliteBridgeTransactionBegin(handle, behavior)
      try {
        const result = fn(...args)
        mod.sqliteBridgeTransactionCommit(handle)
        return result
      } catch (error) {
        try {
          mod.sqliteBridgeTransactionRollback(handle)
        } catch {
          // A JOINed inner failure already rolled the whole unit back; the
          // outer rollback then legitimately errors — the original throw is
          // what matters.
        }
        throw error
      }
    }

  return {
    prepare: (sql: string) => statement(sql),
    // bun's db.query() is the cached prepare; the Rust prepare cache makes
    // this identical to prepare().
    query: (sql: string) => statement(sql),
    exec: (sql: string) => mod.sqliteBridgeExec(handle, sql),
    run: (sql: string, ...params: unknown[]) => mod.sqliteBridgeRun(handle, sql, normalizeParams(params)),
    transaction<T extends (...args: any[]) => any>(fn: T): BridgeTransactionWrapper<T> {
      const wrapper = ((...args: Parameters<T>) => runTransaction(fn, "deferred")(...args)) as BridgeTransactionWrapper<T>
      wrapper.deferred = (...args: Parameters<T>) => runTransaction(fn, "deferred")(...args)
      wrapper.immediate = (...args: Parameters<T>) => runTransaction(fn, "immediate")(...args)
      wrapper.exclusive = (...args: Parameters<T>) => runTransaction(fn, "exclusive")(...args)
      return wrapper
    },
    pragma(str: string, options?: { simple?: boolean }): unknown {
      // Read/write split lives Rust-side ("k = v" → write, undefined result);
      // `{ simple: true }` applies the first-column projection here
      // (sqlite-adapter.ts:188-203 parity).
      const out = mod.sqliteBridgePragma(handle, str.trim())
      if (options?.simple) {
        return out && typeof out === "object" ? Object.values(out)[0] : out
      }
      return out
    },
    close() {
      // Idempotent on BOTH sides (contract): the TS guard keeps a
      // double-close from even reaching a released handle.
      if (closed) return
      closed = true
      mod.sqliteBridgeClose(handle)
    },
    get open() {
      return !closed
    },
    get inTransaction() {
      return mod.sqliteBridgeInTransaction(handle)
    },
  }
}

/**
 * The db.bun.ts entry point: a verified bridge client for `dbPath`, or null
 * for ANY reason (kill switch off, module unavailable, open failure) — the
 * caller then silently keeps `withPrepareCache(new Database(...))`.
 */
export function createBridgeClient(dbPath: string): BridgeClient | null {
  if (!sqliteBridgeEnabled()) return null
  const mod = getBridgeModule()
  if (!mod) return null
  try {
    return bridgeClient(mod, mod.sqliteBridgeOpen(dbPath))
  } catch (error) {
    bridgeDebug(`open failed for ${dbPath} — falling back to bun:sqlite: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
