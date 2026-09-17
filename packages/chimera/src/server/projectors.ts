import sessionProjectors, { projectedSessionRows, type ProjectedSessionRow } from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

/**
 * Session info sources for a `session.updated` publish, cheapest first:
 *
 * 1. `derivedSessionInfo` — `deriveEvent` below builds the derived payload for
 *    a permission-slot event and `SyncEvent.process` converts that same payload
 *    object in the same synchronous post-commit callback, so the projection is
 *    handed over by identity instead of being read a second time.
 * 2. `projectedSessionRows` — the row the session projector's own
 *    `UPDATE ... RETURNING` produced inside the event's immediate write
 *    transaction. That row is exactly the state this event committed (see the
 *    transactional argument in `src/session/projectors.ts`), so publishing it
 *    removes the per-event SELECT without introducing staleness.
 * 3. A fresh read, kept as the fallback for any payload this process did not
 *    project (and for the `session.permission.slot` pre-read path).
 *
 * Both handoffs are keyed by object identity in a WeakMap, so an unrelated
 * payload can never pick up another event's row. A TTL cache was deliberately
 * not used: convertEvent runs right after the event's own commit, where the
 * committed row is precisely the state being published, while a cached row
 * would republish stale title/time.updated values and re-break session list
 * ordering.
 */
const derivedSessionInfo = new WeakMap<object, Session.Info>()

function sessionInfo(sessionID: Session.Info["id"], row?: ProjectedSessionRow) {
  if (row) return Session.fromRow(row)
  const fresh = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
  if (!fresh) return
  return Session.fromRow(fresh)
}

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const { sessionID } = data as SyncEvent.Event<typeof Session.Event.Updated>["data"]
        const info =
          derivedSessionInfo.get(data as object) ?? sessionInfo(sessionID, projectedSessionRows.get(data as object))

        if (!info) return data

        return {
          sessionID,
          info,
        }
      }
      return data
    },
    // Derive a complete session.updated after permission slot updates so
    // local, history, and live paths all publish the same single event.
    // Runs after the transaction commits, on the row that transaction wrote.
    deriveEvent: (type, data) => {
      if (type !== "session.permission.slot") return []
      const { sessionID } = data as SyncEvent.Event<typeof Session.Event.PermissionSlot>["data"]
      const info = sessionInfo(sessionID, projectedSessionRows.get(data as object))
      if (!info) return []
      const derived = { sessionID, info }
      derivedSessionInfo.set(derived, info)
      return [{ type: "session.updated", data: derived }]
    },
  })
}

initProjectors()
