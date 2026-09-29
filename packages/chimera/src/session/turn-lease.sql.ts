import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import type { SessionID } from "./schema"

/**
 * Cross-process turn mutex for session runs.
 *
 * One row per session that a chimera process currently has a turn running on:
 * acquired when the session's Runner goes busy, released when it goes idle,
 * and periodically renewed while the turn is alive (see src/session/turn-lease.ts).
 *
 * `session_id` intentionally has no foreign key to `session` (same precedent as
 * `part.session_id`): lease rows are transient coordination state, and keeping
 * the FK out means a lease can be probed/acquired without a session row being
 * visible in the same transaction. A lease left behind by a session removal is
 * harmless — it expires by TTL and is never consulted again.
 *
 * Crash semantics: a killed host cannot release, so the row survives until
 * `expires_at` passes (TTL fallback) or another process proves `owner_pid` is
 * dead and takes over. `owner_boot_id` (format `boot_<process-start-ms>_<pid>`,
 * the src/chimera/store.ts host-identity precedent) lets the same process
 * re-acquire its own lease and lets probes distinguish a stale leftover from a
 * live sibling.
 */
export const SessionTurnLeaseTable = sqliteTable("session_turn_lease", {
  session_id: text().$type<SessionID>().primaryKey(),
  owner_boot_id: text().notNull(),
  owner_pid: integer().notNull(),
  acquired_at: integer().notNull(),
  expires_at: integer().notNull(),
})
