import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { SyncEvent } from "@/sync"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { Log } from "@opencode-ai/core/util/log"
import nextProjectors from "./projectors-next"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

function grab<T extends object, K1 extends keyof T, X>(
  obj: T,
  field1: K1,
  cb?: (val: NonNullable<T[K1]>) => X,
): X | undefined {
  if (obj == undefined || !(field1 in obj)) return undefined

  const val = obj[field1]
  if (val && typeof val === "object" && cb) {
    return cb(val)
  }
  if (val === undefined) {
    throw new Error(
      "Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj),
    )
  }
  return val as X | undefined
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    workspace_id: grab(info, "workspaceID"),
    parent_id: grab(info, "parentID"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    path: grab(info, "path"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    share_url: grab(info, "share", (v) => grab(v, "url")),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    revert: grab(info, "revert"),
    permission: grab(info, "permission"),
    usage: grab(info, "usage"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
  }

  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

export type ProjectedSessionRow = typeof SessionTable.$inferSelect

/**
 * Session rows captured by the projectors below, keyed by sync event payload
 * identity.
 *
 * `SyncEvent.process` projects an event inside an immediate write transaction
 * and then runs the `convertEvent` hook for the very same payload object in the
 * post-commit callback — synchronously, on this process's single database
 * connection — so nothing in-process can change the row in between. Publishing
 * the `UPDATE ... RETURNING` row is therefore not a cache: it is exactly the
 * state this event committed. Unlike a post-commit read it also cannot pick up
 * a concurrent foreign writer's change that this process never announced an
 * event for, which would let a later event look like a revert.
 *
 * Consumed by `src/server/projectors.ts`; a miss falls back to a fresh read.
 */
export const projectedSessionRows = new WeakMap<object, ProjectedSessionRow>()

export default [
  SyncEvent.project(Session.Event.Created, (db, data) => {
    db.insert(SessionTable)
      .values(Session.toRow(data.info as Session.Info))
      .run()
  }),

  SyncEvent.project(Session.Event.Updated, (db, data) => {
    const info = data.info
    const row = db
      .update(SessionTable)
      .set(toPartialRow(info as Session.Patch))
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
    projectedSessionRows.set(data, row)
  }),
  SyncEvent.project(Session.Event.Deleted, (db, data) => {
    db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  }),

  SyncEvent.project(MessageV2.Event.Updated, (db, data) => {
    const time_created = data.info.time.created
    const { id, sessionID, ...rest } = data.info

    try {
      db.insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created,
          data: rest,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, (db, data) => {
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, (db, data) => {
    db.delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, (db, data) => {
    const { id, messageID, sessionID, ...rest } = data.part

    try {
      db.insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: data.time,
          data: rest,
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
    }
  }),
  SyncEvent.project(Session.Event.PermissionSlot, (db, data) => {
    const row = db
      .select({ permission: SessionTable.permission })
      .from(SessionTable)
      .where(eq(SessionTable.id, data.sessionID))
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
    const current = row.permission ?? []
    const next = [
      ...current.filter((rule) => !data.rules.some((r) => r.permission === rule.permission && r.pattern === rule.pattern)),
      ...data.rules,
    ]
    const updated = db
      .update(SessionTable)
      .set({ permission: next, time_updated: data.timestamp })
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (updated) projectedSessionRows.set(data, updated)
  }),

  ...nextProjectors,
]
