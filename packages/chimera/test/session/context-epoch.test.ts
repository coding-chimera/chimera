import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Effect, Layer, Schema } from "effect"
import { readFileSync, readdirSync } from "fs"
import path from "path"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ContextEpoch } from "@/session/context-epoch"
import { MessageID, SessionID } from "@/session/schema"
import { MessageTable, SessionContextEpochTable, SessionTable } from "@/session/session.sql"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { applyMigrations, Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(ContextEpoch.defaultLayer))

let projectSeq = 0

function seedSession(sessionID: SessionID) {
  const projectID = ProjectID.make(`proj_ctxepoch${String(projectSeq++).padStart(8, "0")}`)
  Database.transaction((db) => {
    db.insert(ProjectTable)
      .values({ id: projectID, worktree: "/tmp/ctx-epoch", sandboxes: [] })
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "ctx-epoch",
        directory: "/tmp/ctx-epoch",
        title: "Context Epoch Test",
        version: "test",
      })
      .run()
  })
}

function makeContext(state: { text: string }) {
  return SystemContext.make({
    key: SystemContext.Key.make("test/source"),
    codec: Schema.Struct({ text: Schema.String }),
    load: Effect.sync(() => ({ text: state.text })),
    baseline: (current) => current.text,
    update: (previous, current) => `updated: ${previous.text} -> ${current.text}`,
  })
}

function epochRow(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, sessionID)).get(),
  )
}

describe("ContextEpoch", () => {
  it.instance("initialize creates the epoch row", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const result = yield* svc.initialize({
        sessionID,
        context: Effect.succeed(makeContext({ text: "hello baseline" })),
      })
      expect(result).toEqual({ baseline: "hello baseline", baselineSeq: expect.any(Number) })
      const row = epochRow(sessionID)
      expect(row?.baseline).toBe("hello baseline")
      expect(row?.baseline_seq).toBe(result?.baselineSeq)
      expect(row?.snapshot).toEqual({ "test/source": { value: { text: "hello baseline" } } })
    }),
  )

  it.instance("initialize is idempotent when the epoch already exists", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const state = { text: "first" }
      const first = yield* svc.initialize({ sessionID, context: Effect.succeed(makeContext(state)) })
      expect(first?.baseline).toBe("first")
      state.text = "second"
      const second = yield* svc.initialize({ sessionID, context: Effect.succeed(makeContext(state)) })
      expect(second).toBeUndefined()
      expect(epochRow(sessionID)?.baseline).toBe("first")
    }),
  )

  it.instance("prepare initializes when no epoch exists", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const result = yield* svc.prepare({
        sessionID,
        context: Effect.succeed(makeContext({ text: "prepared baseline" })),
      })
      expect(result.baseline).toBe("prepared baseline")
      expect(epochRow(sessionID)?.baseline).toBe("prepared baseline")
    }),
  )

  it.instance("prepare keeps the baseline when sources are unchanged", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const state = { text: "stable" }
      const first = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      const second = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      expect(second).toEqual(first)
      expect(epochRow(sessionID)?.baseline_seq).toBe(first.baselineSeq)
    }),
  )

  it.instance("prepare advances the snapshot and keeps the baseline on update", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const state = { text: "v1" }
      const first = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      expect(first.baseline).toBe("v1")
      state.text = "v2"
      const second = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      // Reconcile keeps the cached baseline stable; the delta rides the
      // ContextUpdated event instead of rebuilding the baseline.
      expect(second.baseline).toBe("v1")
      expect(second.baselineSeq).toBe(first.baselineSeq)
      const row = epochRow(sessionID)
      expect(row?.baseline).toBe("v1")
      expect(row?.baseline_seq).toBe(first.baselineSeq)
      expect(row?.snapshot).toEqual({ "test/source": { value: { text: "v2" } } })
      // A third prepare with the same value must now report the baseline as
      // unchanged again (the advanced snapshot was persisted).
      const third = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      expect(third.baselineSeq).toBe(first.baselineSeq)
    }),
  )

  it.instance("prepare replaces the baseline when compaction crossed it", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const state = { text: "v1" }
      const first = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      // Fork compaction marker: an assistant summary message created after
      // the baseline position.
      Database.use((db) =>
        db
          .insert(MessageTable)
          .values({
            id: MessageID.ascending(),
            session_id: sessionID,
            time_created: first.baselineSeq + 1000,
            time_updated: first.baselineSeq + 1000,
            data: { role: "assistant", summary: true },
          } as never)
          .run(),
      )
      state.text = "v2"
      const second = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext(state)) })
      expect(second.baseline).toBe("v2")
      expect(second.baselineSeq).toBe(first.baselineSeq + 1000)
      const row = epochRow(sessionID)
      expect(row?.baseline).toBe("v2")
      expect(row?.baseline_seq).toBe(first.baselineSeq + 1000)
      expect(row?.snapshot).toEqual({ "test/source": { value: { text: "v2" } } })
    }),
  )

  it.instance("prepare fails with ContextSnapshotDecodeError on a corrupted snapshot", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      yield* svc.initialize({ sessionID, context: Effect.succeed(makeContext({ text: "v1" })) })
      Database.use((db) =>
        db
          .update(SessionContextEpochTable)
          .set({ snapshot: { "test/source": {} } } as never)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .run(),
      )
      const error = yield* svc
        .prepare({ sessionID, context: Effect.succeed(makeContext({ text: "v1" })) })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Session.ContextSnapshotDecodeError")
      if (error._tag !== "Session.ContextSnapshotDecodeError") throw new Error("unexpected error")
      expect(error.sessionID).toBe(sessionID)
    }),
  )

  it.instance("reset removes the epoch row", () =>
    Effect.gen(function* () {
      const svc = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      yield* svc.initialize({ sessionID, context: Effect.succeed(makeContext({ text: "v1" })) })
      expect(epochRow(sessionID)).toBeDefined()
      yield* svc.reset(sessionID)
      expect(epochRow(sessionID)).toBeUndefined()
      // After reset the next prepare starts a fresh generation.
      const result = yield* svc.prepare({ sessionID, context: Effect.succeed(makeContext({ text: "v2" })) })
      expect(result.baseline).toBe("v2")
    }),
  )
})

describe("session_context_epoch migration", () => {
  test("applyMigrations is idempotent and creates the epoch table", () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec("PRAGMA foreign_keys = ON")
    const dir = path.join(import.meta.dirname, "../../migration")
    const migrations = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
        timestamp: Number(entry.name.split("_")[0]),
        name: entry.name,
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
    expect(migrations.some((migration) => migration.name === "20260903000000_session_context_epoch")).toBe(true)
    const db = drizzle({ client: sqlite })
    applyMigrations(db, migrations)
    applyMigrations(db, migrations)
    const columns = sqlite.prepare("PRAGMA table_info(session_context_epoch)").all() as { name: string }[]
    expect(columns.map((column) => column.name).sort()).toEqual([
      "baseline",
      "baseline_seq",
      "session_id",
      "snapshot",
    ])
    const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(session_context_epoch)").all() as {
      table: string
      from: string
      to: string
      on_delete: string
    }[]
    expect(foreignKeys.map((fk) => ({ table: fk.table, from: fk.from, to: fk.to, on_delete: fk.on_delete }))).toEqual([
      { table: "session", from: "session_id", to: "id", on_delete: "CASCADE" },
    ])
    sqlite.close()
  })
})
