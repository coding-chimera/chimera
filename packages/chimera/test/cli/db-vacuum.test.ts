// Tests for `chimera db vacuum`: the stale `message.summary.diffs` sweep and
// the freelist-based reclaimable-space estimate, plus the subcommand help.

import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  SUMMARY_DIFFS_RETENTION_MS,
  clearStaleSummaryDiffs,
  countStaleSummaryDiffs,
  formatBytes,
  summaryDiffsCutoff,
  vacuumEstimate,
} from "../../src/cli/cmd/db"

const root = path.resolve(import.meta.dir, "../..")
const DAY = 24 * 60 * 60 * 1000

function seedMessages(db: Database) {
  db.run(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)",
  )
  const insert = db.query("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
  const now = Date.now()
  insert.run("old-diffs", "ses_1", now - 40 * DAY, JSON.stringify({ summary: { diffs: [{ file: "a.ts" }] } }))
  insert.run("old-empty", "ses_1", now - 40 * DAY, JSON.stringify({ summary: { diffs: [] } }))
  insert.run("old-no-summary", "ses_1", now - 40 * DAY, JSON.stringify({ role: "user" }))
  insert.run("recent-diffs", "ses_1", now - DAY, JSON.stringify({ summary: { diffs: [{ file: "b.ts" }] } }))
}

function diffs(db: Database, id: string) {
  const row = db.query("SELECT data FROM message WHERE id = ?").get(id) as { data: string }
  return JSON.parse(row.data).summary.diffs
}

describe("db vacuum summary.diffs sweep", () => {
  test("cutoff is 30 days before now", () => {
    expect(summaryDiffsCutoff(1_000 * DAY)).toBe(1_000 * DAY - SUMMARY_DIFFS_RETENTION_MS)
    expect(SUMMARY_DIFFS_RETENTION_MS).toBe(30 * DAY)
  })

  test("counts and clears only stale non-empty summary.diffs", () => {
    const db = new Database(":memory:")
    seedMessages(db)
    const cutoff = summaryDiffsCutoff()

    expect(countStaleSummaryDiffs(db, cutoff)).toBe(1)
    expect(clearStaleSummaryDiffs(db, cutoff)).toBe(1)

    expect(diffs(db, "old-diffs")).toEqual([])
    expect(diffs(db, "old-empty")).toEqual([])
    expect(diffs(db, "recent-diffs")).toEqual([{ file: "b.ts" }])
    expect(countStaleSummaryDiffs(db, cutoff)).toBe(0)
    db.close()
  })
})

describe("db vacuum estimate", () => {
  test("reports page geometry and reclaimable bytes from the freelist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-vacuum-"))
    const db = new Database(path.join(dir, "test.db"))
    try {
      db.run("CREATE TABLE bloat (id INTEGER PRIMARY KEY, payload BLOB)")
      const insert = db.query("INSERT INTO bloat (payload) VALUES (?)")
      for (let i = 0; i < 200; i++) insert.run(new Uint8Array(4096))
      db.run("DELETE FROM bloat")

      const estimate = vacuumEstimate(db)
      expect(estimate.pageSize).toBeGreaterThan(0)
      expect(estimate.pageCount).toBeGreaterThan(0)
      expect(estimate.freePages).toBeGreaterThan(0)
      expect(estimate.reclaimableBytes).toBe(estimate.freePages * estimate.pageSize)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
  })
})

describe("chimera db vacuum --help", () => {
  test("documents the dry-run default and --yes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "db-vacuum-help-"))
    const dataHome = path.join(home, ".local/share/chimera")
    fs.mkdirSync(dataHome, { recursive: true })
    // Pre-create the marker so src/index.ts skips the one-time migration.
    fs.writeFileSync(path.join(dataHome, "chimera.db"), "")
    try {
      const child = Bun.spawn(["bun", "run", "--conditions=browser", path.join(root, "src/index.ts"), "db", "vacuum", "--help"], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          OPENCODE_TEST_HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_STATE_HOME: path.join(home, ".local/state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ username: "probe", lsp: false, formatter: false }),
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_PURE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_AUTH_CONTENT: "{}",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const exitCode = await child.exited
      const output = `${await stdout}\n${await stderr}`
      expect(exitCode, output).toBe(0)
      expect(output).toContain("db vacuum")
      expect(output).toContain("--yes")
      expect(output).toContain("dry run")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})