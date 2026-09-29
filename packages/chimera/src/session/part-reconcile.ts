import { and, eq, like, ne, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { StorageMaintenanceTable } from "@/storage/maintenance.sql"
import { MessageTable, PartTable } from "./session.sql"
import { SessionTurnLease } from "./turn-lease"
import type { SessionID } from "./schema"
import type { MessageV2 } from "./message-v2"

/** Error text written into orphaned tool states (mirrors the background-job open-time reconciliation wording). */
export const ORPHAN_TOOL_ERROR = "host process restarted; tool call interrupted"

/** Marker prefix in `storage_maintenance`; the full key is `<prefix>:<sessionID>:<bootID>`. */
const RECONCILE_MARKER = "part-orphan-reconcile"

// Sessions already scanned for the current boot; the durable marker keeps the
// scan from repeating across reads, and the boot-scoped key makes a restart
// rescan (a fresh crash may have left fresh orphans). Same capped-FIFO shape
// as the summary-trim memo in message-v2.ts: the durable marker is the source
// of truth, an evicted key only costs one indexed SELECT on the next touch.
const RECONCILED_MAX = 10_000
const reconciledKeys = new Set<string>()

function rememberReconciled(key: string) {
  reconciledKeys.add(key)
  for (const item of reconciledKeys) {
    if (reconciledKeys.size <= RECONCILED_MAX) break
    reconciledKeys.delete(item)
  }
}

/**
 * Sessions whose Runner is busy in THIS process, maintained by the
 * SessionRunState onBusy/onIdle hooks. A busy session's running/pending tool
 * parts and its in-flight assistant message are live state, not crash
 * orphans, so reconciliation must skip them. Cross-process protection rides
 * on the turn lease (see SessionTurnLease.liveHolder).
 */
const busySessions = new Set<SessionID>()

export function markBusy(sessionID: SessionID) {
  busySessions.add(sessionID)
}

export function markIdle(sessionID: SessionID) {
  busySessions.delete(sessionID)
}

export function isBusy(sessionID: SessionID) {
  return busySessions.has(sessionID)
}

export function markerKey(sessionID: SessionID, bootID: string) {
  return `${RECONCILE_MARKER}:${sessionID}:${bootID}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Rewrite crash-orphaned turn state for one session to terminal shapes:
 *
 * - tool parts stuck in `running`/`pending` become `error` with
 *   `metadata.interrupted = true` and `time.end` set — the same terminal
 *   shape `errorToolPart` produces on abort, so `toModelMessages` replays
 *   them through its existing interrupted branch and no schema/SDK contract
 *   changes (the part status vocabulary stays 4-state).
 * - assistant messages still missing `time.completed` get it backfilled with
 *   the reconciliation time (aligns with the processor cleanup write), so
 *   readers stop seeing a permanently "pending" assistant.
 *
 * Callers guarantee the session has no live turn (busy registry + turn-lease
 * guards in `ensureOrphansReconciled`, lease ownership in the forced
 * turn-start path). Runs in one immediate write transaction together with the
 * live-lease recheck and the durable marker, so a concurrent process either
 * got its lease in before us (we see it and skip) or blocks on the write lock
 * until we commit (its turn writes land strictly after the scan).
 */
function reconcileOrphans(tx: Database.TxOrDb, sessionID: SessionID, bootID: string, now: number) {
  const partRows = tx
    .select()
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
        sql`json_extract(${PartTable.data}, '$.state.status') IN ('running', 'pending')`,
      ),
    )
    .all()
  for (const row of partRows) {
    const data = row.data as MessageV2.Part
    if (data.type !== "tool") continue
    const state = data.state
    if (state.status !== "running" && state.status !== "pending") continue
    const metadata = state.status === "running" && isRecord(state.metadata) ? state.metadata : {}
    const errorState: MessageV2.ToolStateError = {
      status: "error",
      input: state.input,
      error: ORPHAN_TOOL_ERROR,
      metadata: { ...metadata, interrupted: true },
      // A pending state never got a start time; errorToolPart falls back to
      // the end time in the same situation.
      time: { start: state.status === "running" ? state.time.start : now, end: now },
    }
    tx
      .update(PartTable)
      .set({ data: { ...row.data, state: errorState } as typeof row.data })
      .where(eq(PartTable.id, row.id))
      .run()
  }

  const messageRows = tx
    .select()
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, sessionID),
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.time.completed') IS NULL`,
      ),
    )
    .all()
  for (const row of messageRows) {
    const data = row.data as MessageV2.Info
    if (data.role !== "assistant") continue
    if (data.time.completed !== undefined) continue
    tx
      .update(MessageTable)
      .set({ data: { ...row.data, time: { ...data.time, completed: now } } as typeof row.data })
      .where(eq(MessageTable.id, row.id))
      .run()
  }

  const key = markerKey(sessionID, bootID)
  tx.insert(StorageMaintenanceTable)
    .values({ key, time_created: now })
    .onConflictDoNothing()
    .run()
  // One marker row per session: drop markers other boots left behind (each new
  // boot rescans once anyway). The LIKE pattern can over-match on `_`
  // wildcards inside the id, so filter with an exact prefix check before
  // deleting.
  const prefix = `${RECONCILE_MARKER}:${sessionID}:`
  const stale = tx
    .select({ key: StorageMaintenanceTable.key })
    .from(StorageMaintenanceTable)
    .where(and(like(StorageMaintenanceTable.key, `${prefix}%`), ne(StorageMaintenanceTable.key, key)))
    .all()
  for (const row of stale) {
    if (!row.key.startsWith(prefix)) continue
    tx.delete(StorageMaintenanceTable).where(eq(StorageMaintenanceTable.key, row.key)).run()
  }
}

/**
 * Lazy crash-orphan reconciliation for the read path (`MessageV2.page` /
 * `MessageV2.get`), following the `ensureStoredSummariesTrimmed` pattern: at
 * most one scan per session per process boot, recorded with a durable marker
 * so restarts rescan exactly once per touched session.
 *
 * Skips (without marking, so a later read retries) while the session has a
 * live turn: busy in this process, or an unexpired lease held by this process
 * or by another process that still looks alive. An unexpired lease whose
 * owner pid is provably dead is crash leftover and does NOT block — that is
 * precisely the case this repair exists for.
 *
 * The scan itself is idempotent (`state.status IN ('running','pending')`
 * matches nothing after the first pass), so repeated boots, repeated reads,
 * and racing processes are all safe.
 */
export function ensureOrphansReconciled(sessionID: SessionID, options?: { bootID?: string; now?: number }) {
  const bootID = options?.bootID ?? SessionTurnLease.currentBootID()
  const now = options?.now ?? Date.now()
  const key = markerKey(sessionID, bootID)
  if (reconciledKeys.has(key)) return
  const marked = Database.use((db) =>
    db.select({ key: StorageMaintenanceTable.key }).from(StorageMaintenanceTable).where(eq(StorageMaintenanceTable.key, key)).get(),
  )
  if (marked) {
    rememberReconciled(key)
    return
  }
  if (busySessions.has(sessionID)) return
  if (SessionTurnLease.liveHolder(sessionID, { bootID, now })) return
  const scanned = Database.transaction(
    (tx) => {
      // Recheck the lease under the write lock: between the guard above and
      // BEGIN IMMEDIATE another process may have claimed the session. The
      // busy registry needs no recheck — this whole path is synchronous, so
      // no in-process state can interleave.
      if (SessionTurnLease.liveHolder(sessionID, { bootID, now })) return false
      reconcileOrphans(tx, sessionID, bootID, now)
      return true
    },
    { behavior: "immediate" },
  )
  if (scanned) rememberReconciled(key)
}

/**
 * Forced reconciliation at turn start (SessionRunState onBusy, after the turn
 * lease was acquired). The lease acquire just proved no foreign live process
 * holds this session and this process's Runner was idle, so the guards of the
 * lazy path are unnecessary — and skipping them is the point: a long-lived
 * process whose boot-scoped marker was written before a sibling process
 * crashed mid-turn would otherwise never heal that session's orphans.
 */
export function reconcileOrphansNow(sessionID: SessionID, options?: { bootID?: string; now?: number }) {
  const bootID = options?.bootID ?? SessionTurnLease.currentBootID()
  const now = options?.now ?? Date.now()
  Database.transaction(
    (tx) => {
      reconcileOrphans(tx, sessionID, bootID, now)
    },
    { behavior: "immediate" },
  )
  rememberReconciled(markerKey(sessionID, bootID))
}

export * as SessionPartReconcile from "./part-reconcile"
