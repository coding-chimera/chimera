/**
 * Query-plan guards for the session/message read indexes added in
 * `20261124021936_session-query-indexes`.
 *
 * These tests read the planner's own verdict (`EXPLAIN QUERY PLAN`) instead of
 * timing anything, so they are deterministic. They assert the *target* index is
 * chosen and that the session list does not need a temp sort — they do not pin
 * the full plan text.
 *
 * The queries mirror the production shapes in `Session.list`, `Session.listGlobal`
 * and `ContextEpoch.latestCompaction`. Keep them in sync when those queries change.
 *
 * `part_session_step_snapshot_idx` was rolled back in
 * `20261124063942_drop-part-step-snapshot-index`: the partial expression index
 * amplified writes on every part row, so `MessageV2.snapshotRange` keeps its
 * plain query and no longer pins an index hint.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { applyMigrations } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "@/storage/tables/session.sql"
import type { SessionID } from "@/contracts/session-ids"
import type { ProjectID } from "@/project/schema"

const migrationDir = path.join(import.meta.dirname, "../../migration")

function migrations() {
  return readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(migrationDir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function createDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  // Migrations run on a schema-less client: `applyMigrations` is typed for the
  // default `SQLiteBunDatabase` (empty schema), which a schema-bound client is
  // not assignable to. The query client is then built over the same connection
  // with the schema so `eq`/`select` infer column types.
  applyMigrations(drizzle({ client: sqlite }), migrations())
  const db = drizzle({ client: sqlite, schema: { MessageTable, PartTable, SessionTable } })
  return { sqlite, db }
}

type PlanRow = { detail: string }

function plan(sqlite: Database, query: string): string[] {
  return (sqlite.prepare("EXPLAIN QUERY PLAN " + query).all() as PlanRow[]).map((row) => row.detail)
}

function indexSql(sqlite: Database, name: string) {
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as
    | { sql: string | null }
    | null
  return row?.sql ?? ""
}

function usesIndex(details: string[], name: string) {
  return details.some((detail) => detail.includes(`USING INDEX ${name}`))
}

function hasTempSort(details: string[]) {
  return details.some((detail) => detail.includes("TEMP B-TREE"))
}

// Mirrors MessageV2.snapshotRange exactly: bound type parameter, no INDEXED BY
// hint, and the same ordering/limit. Kept here so the data-correctness test
// exercises the same query shape as production.
function snapshotQuery(
  db: ReturnType<typeof createDb>["db"],
  sessionID: SessionID,
  type: "step-start" | "step-finish",
  order: "asc" | "desc",
) {
  return db
    .select({ snapshot: sql<string | null>`json_extract(${PartTable.data}, '$.snapshot')` })
    .from(PartTable)
    .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        sql`json_extract(${PartTable.data}, '$.type') = ${type}`,
        sql`json_extract(${PartTable.data}, '$.snapshot') IS NOT NULL`,
        sql`json_extract(${PartTable.data}, '$.snapshot') != ''`,
      ),
    )
    .orderBy(
      order === "asc" ? MessageTable.time_created : desc(MessageTable.time_created),
      order === "asc" ? MessageTable.id : desc(MessageTable.id),
      order === "asc" ? PartTable.id : desc(PartTable.id),
    )
    .limit(1)
}

describe("session query indexes", () => {
  test("migration creates the archive-partial and summary indexes and drops the step index", () => {
    const { sqlite } = createDb()

    expect(indexSql(sqlite, "session_project_time_updated_id_idx")).toContain("WHERE time_archived IS NULL")
    expect(indexSql(sqlite, "session_project_directory_time_updated_id_idx")).toContain("WHERE time_archived IS NULL")
    expect(indexSql(sqlite, "session_time_updated_id_idx")).toContain("WHERE time_archived IS NULL")

    const summary = indexSql(sqlite, "message_session_summary_time_created_idx")
    expect(summary).toContain("json_extract(data, '$.summary') = 1")

    // Rolled back by `20261124063942_drop-part-step-snapshot-index`: a fresh
    // database must not carry the write-amplifying partial step index.
    expect(indexSql(sqlite, "part_session_step_snapshot_idx")).toBe("")
  })

  test("project session list uses the keyset index without a temp sort", () => {
    const { sqlite, db } = createDb()
    const query = db
      .select()
      .from(SessionTable)
      .where(and(eq(SessionTable.project_id, "proj" as ProjectID), isNull(SessionTable.time_archived)))
      .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
      .limit(100)
      .toSQL()

    const details = plan(sqlite, query.sql)
    expect(usesIndex(details, "session_project_time_updated_id_idx")).toBe(true)
    expect(hasTempSort(details)).toBe(false)
  })

  test("project+directory session list uses the directory keyset index without a temp sort", () => {
    const { sqlite, db } = createDb()
    const query = db
      .select()
      .from(SessionTable)
      .where(
        and(
          eq(SessionTable.project_id, "proj" as ProjectID),
          eq(SessionTable.directory, "/work"),
          isNull(SessionTable.time_archived),
        ),
      )
      .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
      .limit(100)
      .toSQL()

    const details = plan(sqlite, query.sql)
    expect(usesIndex(details, "session_project_directory_time_updated_id_idx")).toBe(true)
    expect(hasTempSort(details)).toBe(false)
  })

  test("global session list uses the time_updated keyset index without a temp sort", () => {
    const { sqlite, db } = createDb()
    const query = db
      .select()
      .from(SessionTable)
      .where(isNull(SessionTable.time_archived))
      .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
      .limit(100)
      .toSQL()

    const details = plan(sqlite, query.sql)
    expect(usesIndex(details, "session_time_updated_id_idx")).toBe(true)
    expect(hasTempSort(details)).toBe(false)
  })

  test("latestCompaction uses the summary partial index", () => {
    const { sqlite, db } = createDb()
    const query = db
      .select({ seq: sql<number | null>`MAX(${MessageTable.time_created})` })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, "sess" as SessionID),
          sql`json_extract(${MessageTable.data}, '$.summary') = 1`,
        ),
      )
      .toSQL()

    const details = plan(sqlite, query.sql)
    expect(usesIndex(details, "message_session_summary_time_created_idx")).toBe(true)
  })

  for (const [type, order] of [
    ["step-start", "asc"],
    ["step-finish", "desc"],
  ] as const) {
    test(`snapshotRange (${type}, ${order}) plan does not reference the dropped step index`, () => {
      const { sqlite, db } = createDb()
      const query = snapshotQuery(db, "sess" as SessionID, type, order).toSQL()

      const details = plan(sqlite, query.sql)
      expect(details.some((detail) => detail.includes("part_session_step_snapshot_idx"))).toBe(false)
    })
  }

  test("snapshotRange returns the first step-start and last step-finish snapshots", () => {
    const { sqlite, db } = createDb()
    sqlite.exec(`
      INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('p', '/w', '[]', 1, 1);
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('sess', 'p', 's', '/w', 't', '1', 1, 1);
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('other', 'p', 's', '/w', 't', '1', 1, 1);
      INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
        ('m1', 'sess', 100, 100, '{}'),
        ('m2', 'sess', 200, 200, '{}'),
        ('m3', 'sess', 300, 300, '{}'),
        ('om1', 'other', 50, 50, '{}');
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
        ('p1', 'm1', 'sess', 100, 100, '{"type":"step-start","snapshot":"snap-a"}'),
        ('p2', 'm1', 'sess', 100, 100, '{"type":"step-finish","snapshot":"snap-b"}'),
        ('p3', 'm2', 'sess', 200, 200, '{"type":"step-start","snapshot":"snap-c"}'),
        ('p4', 'm1', 'sess', 100, 100, '{"type":"text","snapshot":"tool-snapshot"}'),
        ('p5', 'm2', 'sess', 200, 200, '{"type":"step-finish","snapshot":""}'),
        ('p6', 'm3', 'sess', 300, 300, '{"type":"step-finish","snapshot":"snap-z"}'),
        ('p7', 'm3', 'sess', 300, 300, '{"type":"step-start"}'),
        ('op1', 'om1', 'other', 50, 50, '{"type":"step-start","snapshot":"decoy"}');
    `)

    expect(snapshotQuery(db, "sess" as SessionID, "step-start", "asc").get()?.snapshot).toBe("snap-a")
    expect(snapshotQuery(db, "sess" as SessionID, "step-finish", "desc").get()?.snapshot).toBe("snap-z")
  })
})