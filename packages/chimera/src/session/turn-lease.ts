import { eq } from "drizzle-orm"
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

export * as SessionTurnLease from "./turn-lease"
