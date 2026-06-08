import path from "path"
import { createHash } from "crypto"
import { appendFile, mkdir } from "fs/promises"
import { DatabaseConnection, diffRelations, getDatabasePath, type FrozenRelation, type FrozenSemanticObject, type StorageExtension } from "@colbymchenry/codegraph"
import type { ChangeFact } from "./change-classifier"
import type { ToolMutationRecord } from "./provenance"

type ChimeraDb = ReturnType<DatabaseConnection["getDb"]>

type PayloadRow = {
  payload_json: string
}

type CountRow = {
  count: number
}

type SemanticObjectKind = "file" | "node" | "relation" | "snippet" | "tombstone"
type SemanticSnapshotSide = "before" | "after"
type SemanticSnapshotRole = "touched" | "neighbor" | "impact_seed" | "deleted" | "created"

type SemanticObjectRecord = {
  hash: string
  kind: SemanticObjectKind
  codegraphID?: string
  filePath?: string
  payload: FrozenSemanticObject | FrozenRelation
}

type SemanticSnapshotRefRecord = {
  objectHash: string
  role: SemanticSnapshotRole
  rank?: number
}

type SemanticSnapshotSideRecord = {
  id?: string
  refs: Map<string, SemanticSnapshotRefRecord>
}

type SemanticObjectRow = {
  payload_json: string
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

export type PredesignRunInput = {
  sessionID: string
  messageID: string
  callID?: string
  agent: string
  intent: string
  files: string[]
  seedNodes: unknown[]
  impactedNodes: unknown[]
  fileDependents: string[]
  evidence: unknown[]
  snapshotRevision: string
  payload: unknown
}

export type PredesignRunRecord = PredesignRunInput & {
  schemaVersion: 1
  id: string
  createdAt: string
}

const CHIMERA_STORAGE_EXTENSION: StorageExtension = {
  id: "chimera",
  namespace: "chimera_",
  migrations: [
    {
      version: 1,
      description: "Create Chimera audit overlay and semantic snapshot tables",
      sql: `
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

CREATE TABLE IF NOT EXISTS chimera_change_fact (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  old_path TEXT,
  node_id TEXT,
  node_key TEXT,
  change_kind TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES chimera_change_event(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chimera_change_fact_event_id_idx ON chimera_change_fact(event_id);
CREATE INDEX IF NOT EXISTS chimera_change_fact_file_path_idx ON chimera_change_fact(file_path);
CREATE INDEX IF NOT EXISTS chimera_change_fact_subject_confidence_idx ON chimera_change_fact(subject_kind, confidence);

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

CREATE TABLE IF NOT EXISTS chimera_semantic_snapshot (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('before', 'after')),
  file_snapshot TEXT NOT NULL,
  graph_revision TEXT NOT NULL,
  root_hash TEXT NOT NULL,
  hash_version TEXT NOT NULL DEFAULT 'chimera-tree:v1',
  parent_snapshot_id TEXT,
  previous_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES chimera_change_event(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_snapshot_id) REFERENCES chimera_semantic_snapshot(id) ON DELETE SET NULL,
  FOREIGN KEY (previous_snapshot_id) REFERENCES chimera_semantic_snapshot(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS chimera_semantic_snapshot_event_side_idx ON chimera_semantic_snapshot(event_id, side);
CREATE INDEX IF NOT EXISTS chimera_semantic_snapshot_root_hash_idx ON chimera_semantic_snapshot(root_hash);
CREATE INDEX IF NOT EXISTS chimera_semantic_snapshot_graph_revision_idx ON chimera_semantic_snapshot(graph_revision);

CREATE TABLE IF NOT EXISTS chimera_semantic_object (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'node', 'relation', 'snippet', 'tombstone')),
  codegraph_id TEXT,
  file_path TEXT,
  payload_json TEXT NOT NULL,
  hash_version TEXT NOT NULL DEFAULT 'chimera-object:v1',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chimera_semantic_object_kind_idx ON chimera_semantic_object(kind);
CREATE INDEX IF NOT EXISTS chimera_semantic_object_file_path_idx ON chimera_semantic_object(file_path);
CREATE INDEX IF NOT EXISTS chimera_semantic_object_codegraph_id_idx ON chimera_semantic_object(codegraph_id);

CREATE TABLE IF NOT EXISTS chimera_semantic_snapshot_ref (
  snapshot_id TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('touched', 'neighbor', 'impact_seed', 'deleted', 'created')),
  rank INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, object_hash, role),
  FOREIGN KEY (snapshot_id) REFERENCES chimera_semantic_snapshot(id) ON DELETE CASCADE,
  FOREIGN KEY (object_hash) REFERENCES chimera_semantic_object(hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chimera_semantic_snapshot_ref_object_hash_idx ON chimera_semantic_snapshot_ref(object_hash);
CREATE INDEX IF NOT EXISTS chimera_semantic_snapshot_ref_role_rank_idx ON chimera_semantic_snapshot_ref(role, rank);
`,
    },
    {
      version: 2,
      description: "Create Chimera predesign evidence table",
      sql: `
CREATE TABLE IF NOT EXISTS chimera_predesign_run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  call_id TEXT,
  agent TEXT NOT NULL,
  intent TEXT NOT NULL,
  files_json TEXT NOT NULL,
  seed_nodes_json TEXT NOT NULL,
  impacted_nodes_json TEXT NOT NULL,
  file_dependents_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  snapshot_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chimera_predesign_run_session_created_idx ON chimera_predesign_run(session_id, created_at);
CREATE INDEX IF NOT EXISTS chimera_predesign_run_snapshot_idx ON chimera_predesign_run(snapshot_revision);
`,
    },
  ],
}

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

function stableJson(input: unknown): string {
  if (input === undefined) return "null"
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map((item) => stableJson(item)).join(",")}]`
  return `{${Object.keys(input)
    .sort()
    .flatMap((key) => {
      const value = (input as Record<string, unknown>)[key]
      return value === undefined ? [] : [`${JSON.stringify(key)}:${stableJson(value)}`]
    })
    .join(",")}}`
}

function hashBytes(prefix: string, payload: string) {
  return createHash("sha256")
    .update(`${prefix} ${new TextEncoder().encode(payload).length}\0${payload}`)
    .digest("hex")
}

function semanticObjectKind(input: FrozenSemanticObject | FrozenRelation): SemanticObjectKind {
  if (input.objectType === "relation") return "relation"
  return input.payload.kind === "file" ? "file" : "node"
}

function semanticObjectCodegraphID(input: FrozenSemanticObject | FrozenRelation) {
  if (input.objectType === "relation") return undefined
  return input.source.codegraphId
}

function semanticObjectFilePath(input: FrozenSemanticObject | FrozenRelation) {
  if (input.objectType === "relation") return input.payload.focalNode.filePath
  return input.payload.filePath
}

function semanticObject(input: FrozenSemanticObject | FrozenRelation): SemanticObjectRecord {
  const kind = semanticObjectKind(input)
  return {
    hash: hashBytes(`chimera-object:v1 ${kind}`, stableJson(input)),
    kind,
    codegraphID: semanticObjectCodegraphID(input),
    filePath: semanticObjectFilePath(input),
    payload: input,
  }
}

function semanticSnapshotRootHash(refs: SemanticSnapshotRefRecord[]) {
  return hashBytes("chimera-tree:v1", stableJson(refs
    .map((ref) => ({ role: ref.role, objectHash: ref.objectHash, rank: ref.rank }))
    .sort((a, b) => a.role.localeCompare(b.role) || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.objectHash.localeCompare(b.objectHash))))
}

function semanticSnapshotID(eventID: string, side: SemanticSnapshotSide, rootHash: string) {
  return `snapshot_${hashBytes("chimera-snapshot:v1", stableJson({ eventID, side, rootHash })).slice(0, 16)}`
}

function parseJson<T>(input: string) {
  try {
    return [JSON.parse(input) as T]
  } catch {
    return []
  }
}

async function withDb<T>(projectRoot: string, fn: (db: ChimeraDb, dbPath: string) => T) {
  const dbPath = databaseStorePath(projectRoot)
  if (!(await Bun.file(dbPath).exists())) return undefined
  try {
    const connection = DatabaseConnection.open(dbPath, { storageExtensions: [CHIMERA_STORAGE_EXTENSION] })
    try {
      const db = connection.getDb()
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

async function appendJsonl<T>(file: string, record: T) {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${safeJson(record)}\n`, "utf8")
}

function emptySnapshotSide(): SemanticSnapshotSideRecord {
  return { refs: new Map() }
}

function semanticEventSnapshots() {
  return { before: emptySnapshotSide(), after: emptySnapshotSide() }
}

function appendSemanticRef(side: SemanticSnapshotSideRecord, object: SemanticObjectRecord, role: SemanticSnapshotRole) {
  const key = `${object.hash}:${role}`
  if (side.refs.has(key)) return
  side.refs.set(key, { objectHash: object.hash, role, rank: side.refs.size })
}

function unique(items: string[]) {
  return [...new Set(items)]
}

function writeSemanticObject(db: ChimeraDb, object: SemanticObjectRecord, createdAt: string) {
  db.prepare(`
    INSERT OR IGNORE INTO chimera_semantic_object (
      hash,
      kind,
      codegraph_id,
      file_path,
      payload_json,
      hash_version,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    object.hash,
    object.kind,
    object.codegraphID ?? null,
    object.filePath ?? null,
    stableJson(object.payload),
    "chimera-object:v1",
    createdAt,
  )
}

function writeSemanticSnapshot(input: {
  db: ChimeraDb
  eventID: string
  side: SemanticSnapshotSide
  graphRevision?: string
  snapshot: SemanticSnapshotSideRecord
  createdAt: string
}) {
  const refs = [...input.snapshot.refs.values()]
  if (refs.length === 0) return undefined
  const rootHash = semanticSnapshotRootHash(refs)
  const id = semanticSnapshotID(input.eventID, input.side, rootHash)
  input.db.prepare(`
    INSERT OR REPLACE INTO chimera_semantic_snapshot (
      id,
      event_id,
      side,
      file_snapshot,
      graph_revision,
      root_hash,
      hash_version,
      parent_snapshot_id,
      previous_snapshot_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.eventID,
    input.side,
    `codegraph:${input.graphRevision ?? "unknown"}`,
    input.graphRevision ?? "unknown",
    rootHash,
    "chimera-tree:v1",
    null,
    null,
    input.createdAt,
  )
  input.db.prepare("DELETE FROM chimera_semantic_snapshot_ref WHERE snapshot_id = ?").run(id)
  for (const ref of refs) {
    input.db.prepare(`
      INSERT INTO chimera_semantic_snapshot_ref (
        snapshot_id,
        object_hash,
        role,
        rank,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(id, ref.objectHash, ref.role, ref.rank ?? null, input.createdAt)
  }
  input.snapshot.id = id
  return id
}

function enrichFactsWithSemanticSnapshots(db: ChimeraDb, facts: ChangeFact[]) {
  if (facts.length === 0) return facts
  const objects = new Map<string, SemanticObjectRecord>()
  const events = new Map<string, ReturnType<typeof semanticEventSnapshots>>()
  const refsByFact = new Map<string, {
    beforeObjectHashes: string[]
    afterObjectHashes: string[]
    beforeRelationHashes: string[]
    afterRelationHashes: string[]
  }>()

  const eventFor = (eventID: string) => {
    const existing = events.get(eventID)
    if (existing) return existing
    const next = semanticEventSnapshots()
    events.set(eventID, next)
    return next
  }
  const addObject = (input: FrozenSemanticObject | FrozenRelation, side: SemanticSnapshotSideRecord, role: SemanticSnapshotRole) => {
    const object = semanticObject(input)
    objects.set(object.hash, object)
    appendSemanticRef(side, object, role)
    return object.hash
  }

  for (const fact of facts) {
    const event = eventFor(fact.eventID)
    const beforeObjectHashes: string[] = []
    const afterObjectHashes: string[] = []
    const beforeRelationHashes: string[] = []
    const afterRelationHashes: string[] = []
    const removedRelationHashes = new Set((fact.evidence.relationDelta?.removedRelations ?? []).map((relation) => semanticObject(relation).hash))
    const addedRelationHashes = new Set((fact.evidence.relationDelta?.addedRelations ?? []).map((relation) => semanticObject(relation).hash))

    if (fact.evidence.beforeNode) beforeObjectHashes.push(addObject(fact.evidence.beforeNode, event.before, "touched"))
    if (fact.evidence.afterNode) afterObjectHashes.push(addObject(fact.evidence.afterNode, event.after, "touched"))
    for (const relation of fact.evidence.relationDelta?.beforeRelations ?? []) {
      const hash = addObject(relation, event.before, removedRelationHashes.has(semanticObject(relation).hash) ? "deleted" : "neighbor")
      beforeObjectHashes.push(hash)
      beforeRelationHashes.push(hash)
    }
    for (const relation of fact.evidence.relationDelta?.afterRelations ?? []) {
      const hash = addObject(relation, event.after, addedRelationHashes.has(semanticObject(relation).hash) ? "created" : "neighbor")
      afterObjectHashes.push(hash)
      afterRelationHashes.push(hash)
    }
    refsByFact.set(fact.id, {
      beforeObjectHashes: unique(beforeObjectHashes),
      afterObjectHashes: unique(afterObjectHashes),
      beforeRelationHashes: unique(beforeRelationHashes),
      afterRelationHashes: unique(afterRelationHashes),
    })
  }

  const createdAt = facts[0]?.createdAt ?? new Date().toISOString()
  for (const object of objects.values()) writeSemanticObject(db, object, createdAt)
  for (const [eventID, snapshots] of events) {
    const fact = facts.find((item) => item.eventID === eventID)
    writeSemanticSnapshot({ db, eventID, side: "before", graphRevision: fact?.evidence.graph.beforeRevision, snapshot: snapshots.before, createdAt })
    writeSemanticSnapshot({ db, eventID, side: "after", graphRevision: fact?.evidence.graph.afterRevision, snapshot: snapshots.after, createdAt })
  }

  return facts.map((fact) => {
    const snapshots = events.get(fact.eventID)
    const refs = refsByFact.get(fact.id)
    if (!snapshots || !refs) return fact
    return {
      ...fact,
      evidence: {
        ...fact.evidence,
        semanticSnapshots: {
          version: 1 as const,
          source: "chimera_semantic_snapshot" as const,
          beforeSnapshotID: snapshots.before.id,
          afterSnapshotID: snapshots.after.id,
          beforeObjectHashes: refs.beforeObjectHashes,
          afterObjectHashes: refs.afterObjectHashes,
          beforeRelationHashes: refs.beforeRelationHashes,
          afterRelationHashes: refs.afterRelationHashes,
        },
        signals: unique([...fact.evidence.signals, "semantic_snapshot_refs"]),
      },
    }
  })
}

function readSemanticRelations(db: ChimeraDb, hashes: string[] | undefined) {
  return unique(hashes ?? []).flatMap((hash) => {
    const row = db.prepare("SELECT payload_json FROM chimera_semantic_object WHERE hash = ? AND kind = 'relation'").get(hash) as SemanticObjectRow | undefined
    return row ? parseJson<FrozenRelation>(row.payload_json) : []
  })
}

function hydrateFactFromSemanticSnapshots(db: ChimeraDb, fact: ChangeFact): ChangeFact {
  const refs = fact.evidence.semanticSnapshots
  if (!refs) return fact
  const expectedRelations = (refs.beforeRelationHashes?.length ?? 0) + (refs.afterRelationHashes?.length ?? 0)
  if (expectedRelations === 0) return fact
  const beforeRelations = readSemanticRelations(db, refs.beforeRelationHashes)
  const afterRelations = readSemanticRelations(db, refs.afterRelationHashes)
  if (beforeRelations.length + afterRelations.length !== expectedRelations) return fact
  return {
    ...fact,
    evidence: {
      ...fact.evidence,
      relationDelta: diffRelations(beforeRelations, afterRelations),
      signals: unique(["semantic_snapshot_refs", ...fact.evidence.signals]),
    },
  }
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

export async function writeChangeFacts(projectRoot: string, facts: ChangeFact[]) {
  if (facts.length === 0) return
  await withDb(projectRoot, (db) => {
    const eventIDs = [...new Set(facts.map((fact) => fact.eventID))]
    db.transaction(() => {
      for (const eventID of eventIDs) db.prepare("DELETE FROM chimera_change_fact WHERE event_id = ?").run(eventID)
      const enrichedFacts = enrichFactsWithSemanticSnapshots(db, facts)
      for (const fact of enrichedFacts) {
        db.prepare(`
          INSERT OR REPLACE INTO chimera_change_fact (
            id,
            event_id,
            file_path,
            old_path,
            node_id,
            node_key,
            change_kind,
            subject_kind,
            confidence,
            evidence_json,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          fact.id,
          fact.eventID,
          fact.filePath,
          fact.oldPath ?? null,
          fact.nodeID ?? null,
          fact.nodeKey ?? null,
          fact.changeKind,
          fact.subjectKind,
          fact.confidence,
          safeJson(fact.evidence),
          safeJson(fact),
          fact.createdAt,
        )
      }
    })()
    return true
  })
}

export async function readChangeFacts(projectRoot: string, eventIDs?: string[]) {
  const filter = eventIDs ? new Set(eventIDs) : undefined
  const facts = await withDb(projectRoot, (db) =>
    (db.prepare("SELECT payload_json FROM chimera_change_fact ORDER BY created_at ASC, id ASC").all() as PayloadRow[])
      .flatMap((row) => parseJson<ChangeFact>(row.payload_json))
      .map((fact) => hydrateFactFromSemanticSnapshots(db, fact))
      .filter((fact) => !filter || filter.has(fact.eventID)),
  )
  return facts ?? []
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

export async function recordPredesignRun(projectRoot: string, artifact: string, input: PredesignRunInput) {
  const createdAt = new Date().toISOString()
  const inputPayload = safeJson(input.payload)
  const record: PredesignRunRecord = {
    schemaVersion: 1,
    id: `predesign_${createHash("sha256").update(`${createdAt}:${inputPayload}`).digest("hex").slice(0, 16)}`,
    ...input,
    createdAt,
  }
  const payload = safeJson(record)
  const wrote = await withDb(projectRoot, (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO chimera_predesign_run (
        id,
        session_id,
        message_id,
        call_id,
        agent,
        intent,
        files_json,
        seed_nodes_json,
        impacted_nodes_json,
        file_dependents_json,
        evidence_json,
        snapshot_revision,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionID,
      record.messageID,
      record.callID ?? null,
      record.agent,
      record.intent,
      safeJson(record.files),
      safeJson(record.seedNodes),
      safeJson(record.impactedNodes),
      safeJson(record.fileDependents),
      safeJson(record.evidence),
      record.snapshotRevision,
      payload,
      record.createdAt,
    )
    return true
  })
  if (!wrote) await appendJsonl(artifact, record)
  return record
}

export async function readPredesignRuns(projectRoot: string, artifact: string, options: { sessionID?: string; limit?: number } = {}) {
  const legacy = await readJsonl<PredesignRunRecord>(artifact)
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
  const records = await withDb(projectRoot, (db) => {
    for (const record of legacy) {
      db.prepare(`
        INSERT OR IGNORE INTO chimera_predesign_run (
          id,
          session_id,
          message_id,
          call_id,
          agent,
          intent,
          files_json,
          seed_nodes_json,
          impacted_nodes_json,
          file_dependents_json,
          evidence_json,
          snapshot_revision,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.sessionID,
        record.messageID,
        record.callID ?? null,
        record.agent,
        record.intent,
        safeJson(record.files),
        safeJson(record.seedNodes),
        safeJson(record.impactedNodes),
        safeJson(record.fileDependents),
        safeJson(record.evidence),
        record.snapshotRevision,
        safeJson(record),
        record.createdAt,
      )
    }
    const rows = options.sessionID
      ? db.prepare("SELECT payload_json FROM chimera_predesign_run WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(options.sessionID, limit)
      : db.prepare("SELECT payload_json FROM chimera_predesign_run ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
    return (rows as PayloadRow[]).flatMap((row) => parseJson<PredesignRunRecord>(row.payload_json))
  })
  const fallback = legacy
    .filter((record) => !options.sessionID || record.sessionID === options.sessionID)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit)
  return records ?? fallback
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
