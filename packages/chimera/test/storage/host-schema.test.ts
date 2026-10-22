import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import { applyMigrations } from "@/storage/db"

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

function createTestDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  const db = drizzle({ client: sqlite })
  return [sqlite, db] as const
}

function names(sqlite: Database, type: "table" | "index") {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
      .all(type) as { name: string }[]
  ).map((row) => row.name)
}

function indexSql(sqlite: Database, name: string) {
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as
    | { sql: string | null }
    | null
  return row?.sql ?? ""
}

const hostTables = [
  "host_worker",
  "host_state",
  "session_turn_checkpoint",
  "pending_request",
  "request_idempotency",
  "host_event",
]

const hostIndexes = [
  "host_worker_workspace_generation_idx",
  "host_worker_active_idx",
  "host_worker_status_heartbeat_idx",
  "host_worker_workspace_status_idx",
  "session_turn_checkpoint_session_status_idx",
  "session_turn_checkpoint_worker_idx",
  "session_turn_checkpoint_active_idx",
  "pending_request_active_key_idx",
  "pending_request_session_status_idx",
  "pending_request_status_expires_idx",
  "request_idempotency_expires_idx",
  "host_event_aggregate_seq_idx",
  "host_event_created_idx",
]

describe("host control-plane schema", () => {
  test("creates the six H1 host-owned tables", () => {
    const [sqlite, db] = createTestDb()
    try {
      applyMigrations(db, migrations())
      const tables = names(sqlite, "table")
      for (const table of hostTables) expect(tables).toContain(table)
    } finally {
      sqlite.close()
    }
  })

  test("creates the declared host indexes, including partial unique indexes", () => {
    const [sqlite, db] = createTestDb()
    try {
      applyMigrations(db, migrations())
      const indexes = names(sqlite, "index")
      for (const name of hostIndexes) expect(indexes).toContain(name)

      expect(indexSql(sqlite, "host_worker_active_idx")).toContain(
        "WHERE status NOT IN ('exited', 'crashed', 'killed')",
      )
      expect(indexSql(sqlite, "session_turn_checkpoint_active_idx")).toContain("WHERE status IN (")
      expect(indexSql(sqlite, "pending_request_active_key_idx")).toContain("WHERE status = 'pending'")
      expect(indexSql(sqlite, "host_event_aggregate_seq_idx")).toContain("WHERE aggregate_seq IS NOT NULL")
    } finally {
      sqlite.close()
    }
  })

  test("re-applying the migration chain is idempotent", () => {
    const [sqlite, db] = createTestDb()
    try {
      const entries = migrations()
      applyMigrations(db, entries)
      const before = { tables: names(sqlite, "table"), indexes: names(sqlite, "index") }
      applyMigrations(db, entries)
      expect(names(sqlite, "table")).toEqual(before.tables)
      expect(names(sqlite, "index")).toEqual(before.indexes)
    } finally {
      sqlite.close()
    }
  })

  test("the host_control_plane migration is additive-only", () => {
    const dirs = readdirSync(migrationDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    const hostDir = dirs.find((entry) => entry.name.endsWith("_host_control_plane"))
    expect(hostDir).toBeDefined()
    const sql = readFileSync(path.join(migrationDir, hostDir!.name, "migration.sql"), "utf-8")
    expect(sql).not.toContain("ALTER TABLE")
    expect(sql).not.toContain("DROP TABLE")
    for (const table of hostTables) expect(sql).toContain(`CREATE TABLE \`${table}\``)
  })
})