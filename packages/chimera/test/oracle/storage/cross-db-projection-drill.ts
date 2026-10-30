#!/usr/bin/env bun
/**
 * WP-05 cross-DB projection recovery drill.
 *
 * Models the real topology: an authority SQLite file (main DB / upstream
 * durable facts) and a separate projection SQLite file (project graph DB /
 * downstream overlay). There is NO cross-file transaction, so the drill
 * exercises the only safe contract:
 *
 *   authority commit -> projection rows + checkpoint in one projection txn
 *   -> ack cursor advances only after the projection checkpoint catches up
 *
 * A child writer process is SIGKILLed at four different points (kill -9
 * equivalent). The parent then reopens both files, bumps the writer lease
 * generation (fencing), replays from the durable projection checkpoint with
 * `INSERT OR IGNORE`, and verifies:
 *   - no phantom rows,
 *   - authority and projection checksums match,
 *   - a second replay writes 0 rows (idempotent),
 *   - a stale generation cannot acquire the lease or insert facts.
 *
 * Run from packages/chimera:
 *   bun test/oracle/storage/cross-db-projection-drill.ts
 *
 * The script writes `cross-db-projection-drill.result.json` next to itself.
 * It uses only `bun:sqlite` + node builtins, never imports `src/**`, and
 * records logical file names only (no absolute paths or credentials).
 */

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const FACT_COUNT = 12
const BATCHES: Array<[number, number]> = [
  [1, 5],
  [6, 10],
  [11, 12],
]
const RESULT_PATH = path.join(import.meta.dirname, "cross-db-projection-drill.result.json")

type CrashPoint = "authority-only" | "mid-projection" | "projection-before-checkpoint" | "after-ack" | "none"

type FactRow = {
  seq: number
  fact_id: string
  payload: string
}

type FencingReport = {
  lease_before: number
  stale_acquire_rejected: boolean
  new_generation: number
  new_acquire_ok: boolean
  stale_insert_rejected: boolean
}

type ReconcileReport = {
  ok: boolean
  phantoms: number[]
  replayed: number
  checkpoint_before: number
  checkpoint_after: number
  acked_seq: number
  authority_checksum: string
  projection_checksum: string
}

type ScenarioResult = {
  name: string
  crash: CrashPoint
  child_exit_code: number | null
  child_signal: string | null
  before: {
    authority_rows: number
    projection_rows: number
    checkpoint: number
    acked_seq: number
    wal_present: boolean
    wal_bytes: number
  }
  fencing: FencingReport
  first_reconcile: ReconcileReport
  second_reconcile: ReconcileReport
  pass: boolean
  failures: string[]
}

function configure(db: Database) {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
}

function initAuthority(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS authority_fact (
      seq INTEGER PRIMARY KEY,
      fact_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      writer_generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS writer_lease (
      scope TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      owner TEXT NOT NULL,
      acquired_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ack_cursor (
      scope TEXT PRIMARY KEY,
      acked_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS authority_fact_generation_guard
    BEFORE INSERT ON authority_fact
    FOR EACH ROW
    WHEN NEW.writer_generation != (SELECT generation FROM writer_lease WHERE scope = 'authority')
    BEGIN
      SELECT RAISE(ABORT, 'stale_generation');
    END;
    INSERT OR IGNORE INTO writer_lease(scope, generation, owner, acquired_at)
      VALUES ('authority', 0, 'bootstrap', 0);
    INSERT OR IGNORE INTO ack_cursor(scope, acked_seq, generation, updated_at)
      VALUES ('authority', 0, 0, 0);
  `)
}

function initProjection(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_row (
      seq INTEGER PRIMARY KEY,
      fact_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projection_checkpoint (
      scope TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO projection_checkpoint(scope, last_seq, generation, updated_at)
      VALUES ('projection', 0, 0, 0);
  `)
}

function openAuthority(root: string) {
  const db = new Database(path.join(root, "authority.db"))
  configure(db)
  return db
}

function openProjection(root: string) {
  const db = new Database(path.join(root, "projection.db"))
  configure(db)
  return db
}

function acquireLease(db: Database, generation: number, owner: string) {
  const result = db
    .prepare(
      `INSERT INTO writer_lease(scope, generation, owner, acquired_at)
       VALUES ('authority', ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         generation = excluded.generation,
         owner = excluded.owner,
         acquired_at = excluded.acquired_at
       WHERE excluded.generation > writer_lease.generation`,
    )
    .run(generation, owner, Date.now())
  return result.changes > 0
}

function leaseGeneration(db: Database) {
  const row = db.prepare("SELECT generation FROM writer_lease WHERE scope = 'authority'").get() as
    | { generation: number }
    | undefined
  return row?.generation ?? 0
}

function readCheckpoint(db: Database) {
  const row = db.prepare("SELECT last_seq FROM projection_checkpoint WHERE scope = 'projection'").get() as
    | { last_seq: number }
    | undefined
  return row?.last_seq ?? 0
}

function readAck(db: Database) {
  const row = db.prepare("SELECT acked_seq FROM ack_cursor WHERE scope = 'authority'").get() as
    | { acked_seq: number }
    | undefined
  return row?.acked_seq ?? 0
}

function checksum(rows: FactRow[]) {
  return createHash("sha256")
    .update(rows.map((row) => `${row.seq}\u0000${row.fact_id}\u0000${row.payload}`).join("\n"))
    .digest("hex")
}

function killSelf(): never {
  process.kill(process.pid, "SIGKILL")
  // SIGKILL is not catchable; this is only a TypeScript control-flow aid.
  process.exit(137)
}

function runWriter(root: string, crash: CrashPoint, generation: number) {
  const authority = openAuthority(root)
  const projection = openProjection(root)

  if (!acquireLease(authority, generation, `writer-${generation}`)) {
    console.error("lease acquisition failed")
    process.exit(3)
  }

  const now = Date.now()
  authority.transaction(() => {
    const insert = authority.prepare(
      "INSERT INTO authority_fact(seq, fact_id, payload, created_at, writer_generation) VALUES (?, ?, ?, ?, ?)",
    )
    for (let seq = 1; seq <= FACT_COUNT; seq++) {
      insert.run(seq, `fact-${seq}`, `payload-${seq}`, now, generation)
    }
  })()

  if (crash === "authority-only") killSelf()

  for (let index = 0; index < BATCHES.length; index++) {
    const [from, to] = BATCHES[index]
    if (crash === "mid-projection" && index === 1) killSelf()

    // The negative case models a buggy writer that commits projection rows but
    // updates the checkpoint in a separate step. Replay must still converge.
    const separateCheckpoint = crash === "projection-before-checkpoint" && index === 1

    projection.transaction(() => {
      const insert = projection.prepare(
        "INSERT OR IGNORE INTO projection_row(seq, fact_id, payload, generation) VALUES (?, ?, ?, ?)",
      )
      for (let seq = from; seq <= to; seq++) insert.run(seq, `fact-${seq}`, `payload-${seq}`, generation)
      if (!separateCheckpoint) {
        projection
          .prepare(
            "UPDATE projection_checkpoint SET last_seq = ?, generation = ?, updated_at = ? WHERE scope = 'projection'",
          )
          .run(to, generation, Date.now())
      }
    })()

    if (separateCheckpoint) killSelf()
  }

  if (crash === "after-ack") {
    authority.transaction(() => {
      authority
        .prepare("UPDATE ack_cursor SET acked_seq = ?, generation = ?, updated_at = ? WHERE scope = 'authority'")
        .run(FACT_COUNT, generation, Date.now())
    })()
    killSelf()
  }

  authority.close()
  projection.close()
}

function fencing(root: string): FencingReport {
  const authority = openAuthority(root)
  const leaseBefore = leaseGeneration(authority)
  const staleAcquireRejected = !acquireLease(authority, leaseBefore, "stale-writer")
  const newGeneration = leaseBefore + 1
  const newAcquireOk = acquireLease(authority, newGeneration, "reconciler")

  let staleInsertRejected = false
  try {
    authority
      .prepare(
        "INSERT INTO authority_fact(seq, fact_id, payload, created_at, writer_generation) VALUES (?, ?, ?, ?, ?)",
      )
      .run(999, "stale-fact", "stale", Date.now(), leaseBefore)
  } catch (error) {
    staleInsertRejected = /stale_generation/.test(String(error))
  }

  authority.close()
  return {
    lease_before: leaseBefore,
    stale_acquire_rejected: staleAcquireRejected,
    new_generation: newGeneration,
    new_acquire_ok: newAcquireOk,
    stale_insert_rejected: staleInsertRejected,
  }
}

function reconcile(root: string, options: { strict: boolean }): ReconcileReport {
  const authority = openAuthority(root)
  const projection = openProjection(root)

  const generation = leaseGeneration(authority) + 1
  if (!acquireLease(authority, generation, "reconciler")) throw new Error("reconciler lease acquisition failed")

  const checkpointBefore = readCheckpoint(projection)
  const authorityRows = authority
    .prepare("SELECT seq, fact_id, payload FROM authority_fact ORDER BY seq")
    .all() as FactRow[]
  const projectedRows = projection
    .prepare("SELECT seq, fact_id, payload FROM projection_row ORDER BY seq")
    .all() as FactRow[]

  const bySeq = new Map(authorityRows.map((row) => [row.seq, row]))
  const phantoms = projectedRows
    .filter((row) => {
      const fact = bySeq.get(row.seq)
      return fact === undefined || fact.fact_id !== row.fact_id || fact.payload !== row.payload
    })
    .map((row) => row.seq)

  if (options.strict && phantoms.length > 0) {
    const report: ReconcileReport = {
      ok: false,
      phantoms,
      replayed: 0,
      checkpoint_before: checkpointBefore,
      checkpoint_after: checkpointBefore,
      acked_seq: readAck(authority),
      authority_checksum: checksum(authorityRows),
      projection_checksum: checksum(projectedRows),
    }
    authority.close()
    projection.close()
    return report
  }

  const missing = authorityRows.filter((row) => row.seq > checkpointBefore)
  let replayed = 0
  const maxSeq = authorityRows.at(-1)?.seq ?? checkpointBefore

  projection.transaction(() => {
    const insert = projection.prepare(
      "INSERT OR IGNORE INTO projection_row(seq, fact_id, payload, generation) VALUES (?, ?, ?, ?)",
    )
    for (const row of missing) replayed += insert.run(row.seq, row.fact_id, row.payload, generation).changes
    projection
      .prepare(
        "UPDATE projection_checkpoint SET last_seq = ?, generation = ?, updated_at = ? WHERE scope = 'projection'",
      )
      .run(Math.max(checkpointBefore, maxSeq), generation, Date.now())
  })()

  const checkpointAfter = readCheckpoint(projection)
  const projectedAfter = projection
    .prepare("SELECT seq, fact_id, payload FROM projection_row ORDER BY seq")
    .all() as FactRow[]

  let ackedSeq = readAck(authority)
  if (checkpointAfter >= maxSeq) {
    authority.transaction(() => {
      authority
        .prepare("UPDATE ack_cursor SET acked_seq = ?, generation = ?, updated_at = ? WHERE scope = 'authority'")
        .run(maxSeq, generation, Date.now())
    })()
    ackedSeq = readAck(authority)
  }

  const authorityChecksum = checksum(authorityRows)
  const projectionChecksum = checksum(projectedAfter)
  const report: ReconcileReport = {
    ok: phantoms.length === 0 && authorityChecksum === projectionChecksum && ackedSeq === maxSeq,
    phantoms,
    replayed,
    checkpoint_before: checkpointBefore,
    checkpoint_after: checkpointAfter,
    acked_seq: ackedSeq,
    authority_checksum: authorityChecksum,
    projection_checksum: projectionChecksum,
  }

  authority.close()
  projection.close()
  return report
}

function snapshot(root: string) {
  const authority = openAuthority(root)
  const projection = openProjection(root)
  const authorityRows = authority.prepare("SELECT COUNT(*) AS count FROM authority_fact").get() as { count: number }
  const projectionRows = projection.prepare("SELECT COUNT(*) AS count FROM projection_row").get() as { count: number }
  const checkpoint = readCheckpoint(projection)
  const ackedSeq = readAck(authority)
  authority.close()
  projection.close()

  const walPath = path.join(root, "authority.db-wal")
  const walPresent = existsSync(walPath)
  return {
    authority_rows: authorityRows.count,
    projection_rows: projectionRows.count,
    checkpoint,
    acked_seq: ackedSeq,
    wal_present: walPresent,
    wal_bytes: walPresent ? statSync(walPath).size : 0,
  }
}

function initRoot(root: string) {
  mkdirSync(root, { recursive: true })
  const authority = openAuthority(root)
  initAuthority(authority)
  authority.close()
  const projection = openProjection(root)
  initProjection(projection)
  projection.close()
}

async function runScenario(name: string, crash: CrashPoint, root: string): Promise<ScenarioResult> {
  initRoot(root)

  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "--role",
      "writer",
      "--root",
      root,
      "--crash",
      crash,
      "--generation",
      "1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  const exitCode = await child.exited
  const signal = child.signalCode ?? null
  const stderr = await new Response(child.stderr).text()
  if (stderr.trim()) console.error(`[${name}] child stderr: ${stderr.trim()}`)

  const before = snapshot(root)
  const fencingReport = fencing(root)
  const first = reconcile(root, { strict: true })
  const second = reconcile(root, { strict: true })

  const failures: string[] = []
  if (crash !== "none" && signal !== "SIGKILL") failures.push(`expected SIGKILL, got exit=${exitCode} signal=${signal}`)
  if (!fencingReport.stale_acquire_rejected) failures.push("stale generation acquired the lease")
  if (!fencingReport.new_acquire_ok) failures.push("new generation failed to acquire the lease")
  if (!fencingReport.stale_insert_rejected) failures.push("stale generation insert was not rejected")
  if (!first.ok) failures.push(`first reconcile failed: phantoms=${first.phantoms.join(",") || "none"}`)
  if (!second.ok) failures.push("second reconcile failed")
  if (second.replayed !== 0) failures.push(`second reconcile wrote ${second.replayed} rows (expected 0)`)
  if (second.checkpoint_after !== first.checkpoint_after) failures.push("second reconcile moved the checkpoint")

  return {
    name,
    crash,
    child_exit_code: exitCode,
    child_signal: signal,
    before,
    fencing: fencingReport,
    first_reconcile: first,
    second_reconcile: second,
    pass: failures.length === 0,
    failures,
  }
}

async function runPhantomScenario(root: string): Promise<ScenarioResult> {
  initRoot(root)

  const child = Bun.spawn(
    [process.execPath, import.meta.path, "--role", "writer", "--root", root, "--crash", "none", "--generation", "1"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const exitCode = await child.exited
  const signal = child.signalCode ?? null

  // Inject a projection row that has no authority fact. A reconciler must
  // report it instead of silently accepting it.
  const projection = openProjection(root)
  projection
    .prepare("INSERT INTO projection_row(seq, fact_id, payload, generation) VALUES (?, ?, ?, ?)")
    .run(999, "phantom-999", "phantom", 1)
  projection.close()

  const before = snapshot(root)
  const fencingReport = fencing(root)
  const detected = reconcile(root, { strict: true })

  const projection2 = openProjection(root)
  projection2.prepare("DELETE FROM projection_row WHERE seq = 999").run()
  projection2.close()

  const first = reconcile(root, { strict: true })
  const second = reconcile(root, { strict: true })

  const failures: string[] = []
  if (detected.ok) failures.push("phantom row was not detected")
  if (!detected.phantoms.includes(999)) failures.push("phantom seq 999 missing from report")
  if (!fencingReport.stale_acquire_rejected) failures.push("stale generation acquired the lease")
  if (!fencingReport.new_acquire_ok) failures.push("new generation failed to acquire the lease")
  if (!fencingReport.stale_insert_rejected) failures.push("stale generation insert was not rejected")
  if (!first.ok) failures.push("reconcile after phantom cleanup failed")
  if (second.replayed !== 0) failures.push(`second reconcile wrote ${second.replayed} rows (expected 0)`)

  return {
    name: "phantom-negative",
    crash: "none",
    child_exit_code: exitCode,
    child_signal: signal,
    before,
    fencing: fencingReport,
    first_reconcile: detected,
    second_reconcile: second,
    pass: failures.length === 0,
    failures,
  }
}

async function main() {
  const roleIndex = process.argv.indexOf("--role")
  if (roleIndex >= 0) {
    const role = process.argv[roleIndex + 1]
    if (role !== "writer") throw new Error(`unknown role: ${role}`)
    const root = process.argv[process.argv.indexOf("--root") + 1]
    const crash = process.argv[process.argv.indexOf("--crash") + 1] as CrashPoint
    const generation = Number(process.argv[process.argv.indexOf("--generation") + 1])
    runWriter(root, crash, generation)
    return
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "wp05-projection-drill-"))
  const scenarios: ScenarioResult[] = []
  try {
    scenarios.push(await runScenario("authority-only", "authority-only", path.join(tempRoot, "authority-only")))
    scenarios.push(await runScenario("mid-projection", "mid-projection", path.join(tempRoot, "mid-projection")))
    scenarios.push(
      await runScenario(
        "projection-before-checkpoint",
        "projection-before-checkpoint",
        path.join(tempRoot, "projection-before-checkpoint"),
      ),
    )
    scenarios.push(await runScenario("after-ack", "after-ack", path.join(tempRoot, "after-ack")))
    scenarios.push(await runPhantomScenario(path.join(tempRoot, "phantom-negative")))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  const passed = scenarios.filter((scenario) => scenario.pass).length
  const record = {
    schema: "wp05.cross-db-projection-drill/v1",
    generated_at: new Date().toISOString(),
    bun: Bun.version,
    model: {
      authority: "authority.db",
      projection: "projection.db",
      fact_count: FACT_COUNT,
      batches: BATCHES,
      crash_signal: "SIGKILL (kill -9 equivalent)",
    },
    scenarios,
    summary: {
      total: scenarios.length,
      passed,
      failed: scenarios.length - passed,
    },
  }

  writeFileSync(RESULT_PATH, `${JSON.stringify(record, null, 2)}\n`)

  for (const scenario of scenarios) {
    const mark = scenario.pass ? "PASS" : "FAIL"
    console.log(
      `${mark} ${scenario.name}: before={authority:${scenario.before.authority_rows},projection:${scenario.before.projection_rows},checkpoint:${scenario.before.checkpoint},ack:${scenario.before.acked_seq}} ` +
        `first={replayed:${scenario.first_reconcile.replayed},checkpoint:${scenario.first_reconcile.checkpoint_before}->${scenario.first_reconcile.checkpoint_after},phantoms:${scenario.first_reconcile.phantoms.length}} ` +
        `second_replayed=${scenario.second_reconcile.replayed} fencing=${scenario.fencing.stale_acquire_rejected && scenario.fencing.stale_insert_rejected}`,
    )
    for (const failure of scenario.failures) console.error(`  - ${failure}`)
  }
  console.log(`summary: ${passed}/${scenarios.length} scenarios passed; record=${path.basename(RESULT_PATH)}`)
  if (passed !== scenarios.length) process.exit(1)
}

await main()