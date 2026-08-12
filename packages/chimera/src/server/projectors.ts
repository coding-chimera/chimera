import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as SyncEvent.Event<typeof Session.Event.Updated>["data"]).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
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
      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
      if (!row) return []
      return [{ type: "session.updated", data: { sessionID, info: Session.fromRow(row) } }]
    },
  })
}

initProjectors()
