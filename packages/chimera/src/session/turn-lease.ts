import { and, eq, lt, or } from "drizzle-orm"
import { Database } from "@/storage/db"
import { SessionTurnLeaseTable } from "./turn-lease.sql"
import type { SessionID } from "./schema"

/**
 * Process-scoped host identity stamped onto turn-lease rows at acquire time.
 * Format `boot_<process-start-ms>_<pid>` — the same scheme and caveats as
 * `HOST_BOOT_ID` in src/chimera/store.ts: pid liveness is judged in the
 * checking process's pid namespace, so processes in separate namespaces
 * sharing one database can misjudge each other's hosts (the TTL below is the
 * conservative fallback in that case).
 */
const HOST_BOOT_ID = `boot_${Date.now() - Math.floor(performance.now())}_${process.pid}`

export function currentBootID() {
  return HOST_BOOT_ID
}

/** A persisted lease row, mapped to camelCase for consumers. */
export interface Holder {
  readonly sessionID: SessionID
  readonly ownerBootID: string
  readonly ownerPID: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export function read(sessionID: SessionID): Holder | undefined {
  const row = Database.use((db) =>
    db.select().from(SessionTurnLeaseTable).where(eq(SessionTurnLeaseTable.session_id, sessionID)).get(),
  )
  if (!row) return undefined
  return {
    sessionID: row.session_id,
    ownerBootID: row.owner_boot_id,
    ownerPID: row.owner_pid,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  }
}

/**
 * Whether the process behind a lease row still looks alive. Mirrors the
 * edit-intent `isHostBootAlive` probe (src/chimera/edit-intent.ts): our own
 * boot id is alive by definition; while this process runs no other process can
 * hold its pid, so a row naming our pid counts as alive — never treat a lease
 * we could be racing with as dead. EPERM means the process exists but belongs
 * to another user: alive.
 */
export function hostLooksAlive(bootID: string, pid: number): boolean {
  if (bootID === HOST_BOOT_ID) return true
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

/**
 * The lease holder a reader must respect right now: an unexpired lease owned
 * by this process, or by another process that still looks alive. An unexpired
 * lease whose owner is provably dead is crash leftover, not a live holder, and
 * returns undefined so orphan reconciliation can proceed immediately instead
 * of waiting out the TTL.
 */
export function liveHolder(sessionID: SessionID, options?: { bootID?: string; now?: number }): Holder | undefined {
  const holder = read(sessionID)
  if (!holder) return undefined
  if (holder.expiresAt <= (options?.now ?? Date.now())) return undefined
  const bootID = options?.bootID ?? HOST_BOOT_ID
  if (holder.ownerBootID === bootID) return holder
  return hostLooksAlive(holder.ownerBootID, holder.ownerPID) ? holder : undefined
}

/**
 * The holder that blocks a *new* turn on this session from another process's
 * point of view: an unexpired lease owned by a different, live-looking boot.
 * Own-process leases are excluded — the in-process Runner map is the authority
 * for same-process mutual exclusion, and a stale own-boot row is overwritten
 * on the next acquire.
 */
export function foreignLiveHolder(
  sessionID: SessionID,
  options?: { bootID?: string; now?: number },
): Holder | undefined {
  const holder = read(sessionID)
  if (!holder) return undefined
  if (holder.expiresAt <= (options?.now ?? Date.now())) return undefined
  if (holder.ownerBootID === (options?.bootID ?? HOST_BOOT_ID)) return undefined
  return hostLooksAlive(holder.ownerBootID, holder.ownerPID) ? holder : undefined
}

/**
 * Lease lifetime without a renewal. Deliberately generous (30 minutes): the
 * TTL is only the crash fallback for a host that died without releasing, and
 * a false-expiry would let a second process start a concurrent turn, while a
 * false-hold only delays a genuinely orphaned session until the probe or the
 * TTL clears it. Live turns renew every RENEW_INTERVAL_MS, so TTL length does
 * not limit turn length.
 */
export const LEASE_TTL_MS = 30 * 60 * 1000

/**
 * Renewal cadence while a turn is alive. One third of the TTL leaves two
 * missed renewals of headroom before a live holder's lease could lapse.
 */
export const RENEW_INTERVAL_MS = 10 * 60 * 1000

export type AcquireResult = { readonly acquired: true } | { readonly acquired: false; readonly holder: Holder }

function claim(sessionID: SessionID, bootID: string, pid: number, now: number, expiresAt: number) {
  // Single-statement atomic takeover: a fresh insert, or an update of a row
  // this boot already owns (self-renew/re-acquire) or whose TTL has lapsed.
  // A foreign unexpired row fails the DO UPDATE guard and returns nothing.
  const row = Database.use((db) =>
    db
      .insert(SessionTurnLeaseTable)
      .values({ session_id: sessionID, owner_boot_id: bootID, owner_pid: pid, acquired_at: now, expires_at: expiresAt })
      .onConflictDoUpdate({
        target: SessionTurnLeaseTable.session_id,
        set: { owner_boot_id: bootID, owner_pid: pid, acquired_at: now, expires_at: expiresAt },
        setWhere: or(eq(SessionTurnLeaseTable.owner_boot_id, bootID), lt(SessionTurnLeaseTable.expires_at, now)),
      })
      .returning({ sessionID: SessionTurnLeaseTable.session_id })
      .get(),
  )
  return row !== undefined
}

function steal(sessionID: SessionID, holder: Holder, bootID: string, pid: number, now: number, expiresAt: number) {
  // CAS against the observed holder identity: if the leftover was concurrently
  // claimed or renewed by someone else, the guard misses and nothing is
  // clobbered.
  const row = Database.use((db) =>
    db
      .update(SessionTurnLeaseTable)
      .set({ owner_boot_id: bootID, owner_pid: pid, acquired_at: now, expires_at: expiresAt })
      .where(
        and(
          eq(SessionTurnLeaseTable.session_id, sessionID),
          eq(SessionTurnLeaseTable.owner_boot_id, holder.ownerBootID),
          eq(SessionTurnLeaseTable.expires_at, holder.expiresAt),
        ),
      )
      .returning({ sessionID: SessionTurnLeaseTable.session_id })
      .get(),
  )
  return row !== undefined
}

/**
 * Claim the turn lease for a session. Succeeds when no row exists, when this
 * boot already owns the row, when the row's TTL lapsed, or when the holder is
 * provably dead (crash leftover — a restarted chimera on the same machine
 * inherits its predecessor's lease immediately instead of waiting out the
 * TTL; pid reuse and foreign pid namespaces degrade conservatively to the
 * TTL). Fails with the live foreign holder otherwise; the caller turns that
 * into the busy error surfaced to the user.
 */
export function acquire(
  sessionID: SessionID,
  options?: { bootID?: string; pid?: number; now?: number; ttlMs?: number },
): AcquireResult {
  const bootID = options?.bootID ?? HOST_BOOT_ID
  const pid = options?.pid ?? process.pid
  const now = options?.now ?? Date.now()
  const expiresAt = now + (options?.ttlMs ?? LEASE_TTL_MS)
  if (claim(sessionID, bootID, pid, now, expiresAt)) return { acquired: true }
  let holder = read(sessionID)
  if (holder && !hostLooksAlive(holder.ownerBootID, holder.ownerPID)) {
    if (steal(sessionID, holder, bootID, pid, now, expiresAt)) return { acquired: true }
    holder = read(sessionID)
  }
  if (!holder) {
    // The row vanished mid-race (owner released, or session cleanup): retry once.
    if (claim(sessionID, bootID, pid, now, expiresAt)) return { acquired: true }
    holder = read(sessionID)
  }
  if (!holder) throw new Error(`turn lease for session ${sessionID} could neither be claimed nor read`)
  return { acquired: false, holder }
}

/**
 * Release this process's lease on a session. Owner-guarded: a lease another
 * process legitimately took over after our TTL lapsed is never deleted.
 */
export function release(sessionID: SessionID, options?: { bootID?: string }) {
  const bootID = options?.bootID ?? HOST_BOOT_ID
  Database.use((db) =>
    db
      .delete(SessionTurnLeaseTable)
      .where(and(eq(SessionTurnLeaseTable.session_id, sessionID), eq(SessionTurnLeaseTable.owner_boot_id, bootID)))
      .run(),
  )
}

/**
 * Push the expiry of every lease this process owns one TTL into the future.
 * One statement covers all sessions of this process; rows this boot no longer
 * owns (taken over after a lapse) are untouched by the owner guard.
 */
export function renewAll(options?: { bootID?: string; now?: number; ttlMs?: number }) {
  const bootID = options?.bootID ?? HOST_BOOT_ID
  const now = options?.now ?? Date.now()
  Database.use((db) =>
    db
      .update(SessionTurnLeaseTable)
      .set({ expires_at: now + (options?.ttlMs ?? LEASE_TTL_MS) })
      .where(eq(SessionTurnLeaseTable.owner_boot_id, bootID))
      .run(),
  )
}

export * as SessionTurnLease from "./turn-lease"
