import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

/**
 * `deriveEvent` below already reads the committed session row to build the
 * derived `session.updated` payload, and `SyncEvent.process` converts that
 * derived event in the same synchronous post-commit callback. Handing the
 * projected info over by payload identity removes a second SELECT of the same
 * row per permission-slot event — one per prompt and one per subagent dispatch
 * — including re-parsing its JSON columns (`permission`, `usage`, `revert`,
 * which can carry a full file-diff list) and the second `Session.fromRow`.
 *
 * Keyed by object identity so a payload this module did not build always falls
 * back to a fresh read. A TTL cache was deliberately not used: convertEvent
 * runs right after the event's own commit, where a fresh read is exactly the
 * state that event published, and a cached row would publish stale
 * title/time.updated values and re-break session list ordering.
 */
const derivedSessionInfo = new WeakMap<object, Session.Info>()

function sessionInfo(sessionID: Session.Info["id"]) {
  const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
  if (!row) return
  return Session.fromRow(row)
}

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const { sessionID } = data as SyncEvent.Event<typeof Session.Event.Updated>["data"]
        const info = derivedSessionInfo.get(data as object) ?? sessionInfo(sessionID)

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
    // Runs after the transaction commits, so the row read is the latest.
    deriveEvent: (type, data) => {
      if (type !== "session.permission.slot") return []
      const { sessionID } = data as SyncEvent.Event<typeof Session.Event.PermissionSlot>["data"]
      const info = sessionInfo(sessionID)
      if (!info) return []
      const derived = { sessionID, info }
      derivedSessionInfo.set(derived, info)
      return [{ type: "session.updated", data: derived }]
    },
  })
}

initProjectors()
