import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "./fixture/tmpdir"

const queryTables = (db: Database.Interface["db"]) =>
  db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)

describe("Database trunk (vendored upstream migrations)", () => {
  test("bootstraps a fresh trunk db with the full upstream migration lineage", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "chimera-v2-trunk-bootstrap.db")

    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      const journaled = yield* db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)
      expect(journaled.length).toBe(migrations.length)
      expect(journaled.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id).sort())

      const tables = (yield* queryTables(db)).map((row) => row.name)
      for (const expected of ["event", "event_sequence", "session", "workspace", "credential"]) {
        expect(tables).toContain(expected)
      }

      const foreignKeys = yield* db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
      expect(foreignKeys?.foreign_keys).toBe(1)
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped, Effect.runPromise)

    expect(await Bun.file(file).exists()).toBe(true)
  })

  test("reopening an initialized trunk db is a migration no-op", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "chimera-v2-trunk-reopen.db")
    const layer = Database.layerFromPath(file)

    const countMigrations = Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)
      return rows.length
    }).pipe(Effect.provide(layer), Effect.scoped)

    const first = await Effect.runPromise(countMigrations)
    const second = await Effect.runPromise(countMigrations)
    expect(first).toBe(migrations.length)
    expect(second).toBe(first)
  })

  test("default path is chimera-v2 isolated from the production fork chimera.db", () => {
    const resolved = Database.path()
    expect(path.dirname(resolved)).toBe(Global.Path.data)
    // L5.0 decision ②: upstream TS migrations must never target the fork's
    // production chimera.db; the trunk default is a dedicated chimera-v2 db.
    expect(path.basename(resolved).startsWith("chimera-v2")).toBe(true)
    expect(resolved).not.toBe(path.join(Global.Path.data, "chimera.db"))
    expect(resolved).not.toBe(path.join(Global.Path.data, "opencode.db"))
    expect(resolved).not.toContain("opencode")
  })
})
