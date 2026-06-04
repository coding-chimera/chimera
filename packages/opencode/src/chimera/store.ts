import path from "path"
import { createHash } from "crypto"
import { appendFile, mkdir } from "fs/promises"
import { DatabaseConnection, getDatabasePath } from "../../../../../codegraph/dist/index.js"
import type { ToolMutationRecord } from "./provenance"

type ChimeraDb = ReturnType<DatabaseConnection["getDb"]>

type PayloadRow = {
  payload_json: string
}

type CountRow = {
  count: number
}

type ObligationLike = {
  id: string
  fingerprint: string
  status: string
  target: string
  risk: string
  classification?: string
  reason: string
  evidence: string
  createdAt: string
  updatedAt: string
}

export type ObligationStoreLike<T extends ObligationLike> = {
  schemaVersion: 1
  obligations: T[]
}

export type AuditRunInput = {
  source: string
  provenanceID?: string
  changedFiles: string[]
  snapshotRevision: string
  seedNodes: unknown[]
  obligations: unknown[]
  payload: unknown
}

const CHIMERA_SCHEMA = `
CREATE TABLE IF NOT EXISTS chimera_change_event (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  provenance_strength TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  project_root TEXT NOT NULL,
  worktree TEXT NOT NULL,
  directory TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  before_revision TEXT NOT NULL,
  after_revision TEXT NOT NULL,
  actor_session_id TEXT,
  actor_message_id TEXT,
  actor_call_id TEXT,
  actor_agent TEXT,
  observer_id TEXT,
  observer_session_id TEXT,
  observer_agent TEXT,
  metadata_json TEXT,
  payload_json TEXT NOT NULL,
  migrated_from TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chimera_change_file (
  event_id TEXT NOT NULL,
  file_index INTEGER NOT NULL,
  absolute_path TEXT NOT NULL,
  graph_path TEXT,
  inside_graph INTEGER NOT NULL,
  status TEXT,
  PRIMARY KEY (event_id, file_index),
  FOREIGN KEY (event_id) REFERENCES chimera_change_event(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chimera_change_event_finished_at_idx ON chimera_change_event(finished_at);
CREATE INDEX IF NOT EXISTS chimera_change_event_origin_idx ON chimera_change_event(origin, provenance_strength);
CREATE INDEX IF NOT EXISTS chimera_change_file_graph_path_idx ON chimera_change_file(graph_path);

CREATE TABLE IF NOT EXISTS chimera_audit_run (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  provenance_id TEXT,
  changed_files_json TEXT NOT NULL,
  snapshot_revision TEXT NOT NULL,
  seed_nodes_json TEXT NOT NULL,
  obligations_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chimera_audit_obligation (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  fingerprint TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  target TEXT NOT NULL,
  risk TEXT NOT NULL,
  classification TEXT,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES chimera_audit_run(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS chimera_audit_obligation_status_idx ON chimera_audit_obligation(status);
CREATE INDEX IF NOT EXISTS chimera_audit_obligation_updated_at_idx ON chimera_audit_obligation(updated_at);
`

export function databaseStorePath(projectRoot: string) {
  return getDatabasePath(projectRoot)
}

function safeJson(input: unknown) {
  try {
    return JSON.stringify(input)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function parseJson<T>(input: string) {
  try {
    return [JSON.parse(input) as T]
  } catch {
    return []
  }
}

function ensureSchema(db: ChimeraDb) {
  db.exec(CHIMERA_SCHEMA)
}

async function withDb<T>(projectRoot: string, fn: (db: ChimeraDb, dbPath: string) => T) {
  const dbPath = databaseStorePath(projectRoot)
  if (!(await Bun.file(dbPath).exists())) return undefined
  try {
    const connection = DatabaseConnection.open(dbPath)
    try {
      const db = connection.getDb()
      ensureSchema(db)
      return fn(db, dbPath)
    } finally {
      connection.close()
    }
  } catch {
    return undefined
  }
}

async function readJsonl<T>(file: string) {
  if (!(await Bun.file(file).exists())) return [] as T[]
  const text = await Bun.file(file).text()
  if (!text.trim()) return [] as T[]
  return text
    .trim()
    .split("\n")
    .flatMap((line) => parseJson<T>(line))
}

async function readJson<T>(file: string, fallback: T) {
  if (!(await Bun.file(file).exists())) return fallback
  try {
    return (await Bun.file(file).json()) as T
  } catch {
    return fallback
  }
}

async function appendJsonl(file: string, record: ToolMutationRecord) {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${safeJson(record)}\n`, "utf8")
}

export async function readLegacyProvenanceRecords(file: string) {
  return readJsonl<ToolMutationRecord>(file)
}

function normalizeProvenanceRecord(record: ToolMutationRecord): ToolMutationRecord {
  const origin = record.origin ?? "tool"
  const provenanceStrength = record.provenanceStrength ?? (origin === "tool" ? "strong" : "weak")
  const actor = record.actor ?? (origin === "tool" ? {
    sessionID: record.tool.sessionID,
    messageID: record.tool.messageID,
    callID: record.tool.callID,
    agent: record.tool.agent,
  } : undefined)
  const observer = record.observer ?? (origin === "tool" ? undefined : {
    id: "codegraph.watch",
    agent: record.tool.agent,
  })
  return {
    ...record,
    origin,
    provenanceStrength,
    ...(actor ? { actor } : {}),
    ...(observer ? { observer } : {}),
  }
}

function changedStatus(record: ToolMutationRecord, graphPath: string | undefined) {
  if (!graphPath) return undefined
  return record.graph.sync.changedFiles?.find((file) => file.path === graphPath)?.status
}

function writeProvenanceRecordToDb(db: ChimeraDb, input: ToolMutationRecord, migratedFrom?: string) {
  const record = normalizeProvenanceRecord(input)
  db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO chimera_change_event (
        id,
        origin,
        provenance_strength,
        tool_id,
        status,
        project_root,
        worktree,
        directory,
        started_at,
        finished_at,
        before_revision,
        after_revision,
        actor_session_id,
        actor_message_id,
        actor_call_id,
        actor_agent,
        observer_id,
        observer_session_id,
        observer_agent,
        metadata_json,
        payload_json,
        migrated_from,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.origin ?? "tool",
      record.provenanceStrength ?? "strong",
      record.tool.id,
      record.status,
      record.project.root,
      record.project.worktree,
      record.project.directory,
      record.startedAt,
      record.finishedAt,
      record.graph.before.revision,
      record.graph.after.revision,
      record.actor?.sessionID ?? null,
      record.actor?.messageID ?? null,
      record.actor?.callID ?? null,
      record.actor?.agent ?? null,
      record.observer?.id ?? null,
      record.observer?.sessionID ?? null,
      record.observer?.agent ?? null,
      record.metadata ? safeJson(record.metadata) : null,
      safeJson(record),
      migratedFrom ?? null,
      Date.now(),
    )
    db.prepare("DELETE FROM chimera_change_file WHERE event_id = ?").run(record.id)
    record.files.forEach((file, index) => {
      db.prepare(`
        INSERT INTO chimera_change_file (
          event_id,
          file_index,
          absolute_path,
          graph_path,
          inside_graph,
          status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        index,
        file.absolutePath,
        file.graphPath ?? null,
        file.insideGraph ? 1 : 0,
        changedStatus(record, file.graphPath) ?? null,
      )
    })
  })()
}

export async function appendProvenanceRecord(projectRoot: string, artifact: string, record: ToolMutationRecord) {
  const wrote = await withDb(projectRoot, (db) => {
    writeProvenanceRecordToDb(db, record)
    return true
  })
  if (wrote) return
  await appendJsonl(artifact, normalizeProvenanceRecord(record))
}

export async function readProvenanceRecords(projectRoot: string, artifact: string) {
  const legacy = (await readLegacyProvenanceRecords(artifact)).map(normalizeProvenanceRecord)
  const records = await withDb(projectRoot, (db) => {
    for (const record of legacy) writeProvenanceRecordToDb(db, record, artifact)
    return (db.prepare("SELECT payload_json FROM chimera_change_event ORDER BY finished_at ASC, id ASC").all() as PayloadRow[])
      .flatMap((row) => parseJson<ToolMutationRecord>(row.payload_json))
      .map(normalizeProvenanceRecord)
  })
  return records ?? legacy
}

export async function provenanceRecordCount(projectRoot: string, artifact: string) {
  const legacy = (await readLegacyProvenanceRecords(artifact)).map(normalizeProvenanceRecord)
  const count = await withDb(projectRoot, (db) => {
    for (const record of legacy) writeProvenanceRecordToDb(db, record, artifact)
    const row = db.prepare("SELECT COUNT(*) AS count FROM chimera_change_event").get() as CountRow | undefined
    return row?.count ?? 0
  })
  return count ?? legacy.length
}

export async function recordAuditRun(projectRoot: string, input: AuditRunInput) {
  const createdAt = new Date().toISOString()
  const payload = safeJson(input.payload)
  const id = `audit_${createHash("sha256").update(`${createdAt}:${payload}`).digest("hex").slice(0, 16)}`
  await withDb(projectRoot, (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO chimera_audit_run (
        id,
        source,
        provenance_id,
        changed_files_json,
        snapshot_revision,
        seed_nodes_json,
        obligations_json,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.source,
      input.provenanceID ?? null,
      safeJson(input.changedFiles),
      input.snapshotRevision,
      safeJson(input.seedNodes),
      safeJson(input.obligations),
      payload,
      createdAt,
    )
    return true
  })
  return id
}

function writeObligationToDb<T extends ObligationLike>(db: ChimeraDb, item: T, runID?: string, mode: "ignore" | "replace" = "replace") {
  db.prepare(`
    INSERT OR ${mode === "ignore" ? "IGNORE" : "REPLACE"} INTO chimera_audit_obligation (
      id,
      run_id,
      fingerprint,
      status,
      target,
      risk,
      classification,
      reason,
      evidence,
      payload_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    runID ?? null,
    item.fingerprint,
    item.status,
    item.target,
    item.risk,
    item.classification ?? null,
    item.reason,
    item.evidence,
    safeJson(item),
    item.createdAt,
    item.updatedAt,
  )
}

export async function readPersistentObligationStore<T extends ObligationLike>(
  projectRoot: string,
  artifact: string,
  fallback: ObligationStoreLike<T>,
) {
  const legacy = await readJson<ObligationStoreLike<T>>(artifact, fallback)
  const store = await withDb(projectRoot, (db) => {
    for (const item of legacy.obligations ?? []) writeObligationToDb(db, item, undefined, "ignore")
    return {
      schemaVersion: 1 as const,
      obligations: (db.prepare("SELECT payload_json FROM chimera_audit_obligation ORDER BY created_at ASC, id ASC").all() as PayloadRow[])
        .flatMap((row) => parseJson<T>(row.payload_json)),
    }
  })
  return store ?? legacy
}

export async function writePersistentObligationStore<T extends ObligationLike>(
  projectRoot: string,
  artifact: string,
  store: ObligationStoreLike<T>,
  runID?: string,
) {
  const wrote = await withDb(projectRoot, (db) => {
    db.transaction(() => {
      db.prepare("DELETE FROM chimera_audit_obligation").run()
      for (const item of store.obligations) writeObligationToDb(db, item, runID)
    })()
    return true
  })
  if (wrote) return
  await mkdir(path.dirname(artifact), { recursive: true })
  await Bun.write(artifact, `${safeJson(store)}\n`)
}

export * as ChimeraStore from "./store"
