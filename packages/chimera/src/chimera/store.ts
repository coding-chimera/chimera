import path from "path"
import { createHash } from "crypto"
import { appendFile, mkdir, stat } from "fs/promises"
import { DatabaseConnection, diffRelations, getDatabasePath, type FrozenRelation, type FrozenSemanticObject, type StorageExtension } from "@/graph"
import type { ChangeFact } from "./change-classifier"
import type { ToolMutationRecord } from "./provenance"

type ChimeraDb = ReturnType<DatabaseConnection["getDb"]>

type PayloadRow = {
  payload_json: string
}

const MAX_RECENT_JSONL_BYTES = 4 * 1024 * 1024

type ChangeFactRow = {
  id: string
  event_id: string
  file_path: string
  node_key: string | null
  change_kind: string
  subject_kind: string
  confidence: number
  evidence_json: string
  payload_json: string
  created_at: string
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

export type AuditRunRecord = AuditRunInput & {
  id: string
  createdAt: string
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

export type OracleStatus = "pass" | "fail" | "unknown"
export type OracleVerificationKind = "lsp" | "test" | "typecheck" | "lint" | "build" | "explicit" | "unclassified_shell" | "unknown"

export type OracleLinkedChange = {
  id: string
  toolID: string
  status: ToolMutationRecord["status"]
  finishedAt: string
  beforeRevision: string
  afterRevision: string
  files: string[]
  changeID?: string
}

export type OracleLinkWindow = {
  source: "same_session_preceding_mutations"
  sessionID: string
  projectRoot: string
  finishedBefore: string
  maxChanges: number
}

export type OracleRecordInput = {
  kind: "shell" | "lsp"
  status: OracleStatus
  tool: {
    id: string
    callID?: string
    messageID: string
    sessionID: string
    agent: string
  }
  project: {
    root: string
    worktree: string
    directory: string
  }
  startedAt?: string
  finishedAt: string
  linkWindow: OracleLinkWindow
  linkedChanges: OracleLinkedChange[]
  verificationKind?: OracleVerificationKind
  trusted?: boolean
  payload: unknown
}

export type OracleRecord = OracleRecordInput & {
  schemaVersion: 1
  id: string
  createdAt: string
}

export type CommitChangeSummary = {
  schemaVersion: 1
  id: string
  commit: string
  tree: string
  parents: string[]
  oracleIDs: string[]
  mutationIDs: string[]
  changeIDs: string[]
  files: string[]
  subjectCounts: Record<string, number>
  changeKindCounts: Record<string, number>
  riskLabels: string[]
  summary: string
  graphRevision?: string
  extractorVersion?: string
  compactedAt: string
}

export type CommittedEvidenceCompactionOptions = {
  activeSessionID?: string
  dryRun?: boolean
  vacuum?: boolean
  now?: string
}

export type CommittedEvidenceCompactionResult = {
  projectRoot: string
  dbPath: string
  dryRun: boolean
  vacuum: boolean
  commit?: string
  tree?: string
  candidateEvents: number
  compactedEvents: number
  deletedFacts: number
  deletedSemanticSnapshots: number
  deletedSemanticObjects: number
  rewrittenFactPayloads: number
  summariesWritten: number
  dbBytesBefore?: number
  dbBytesAfter?: number
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
    {
      version: 3,
      description: "Create Chimera oracle result table",
      sql: `
CREATE TABLE IF NOT EXISTS chimera_oracle_result (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  worktree TEXT NOT NULL,
  directory TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  call_id TEXT,
  agent TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chimera_oracle_result_session_finished_idx ON chimera_oracle_result(session_id, finished_at);
CREATE INDEX IF NOT EXISTS chimera_oracle_result_kind_status_idx ON chimera_oracle_result(kind, status);
CREATE INDEX IF NOT EXISTS chimera_oracle_result_tool_idx ON chimera_oracle_result(tool_id);
`,
    },
    {
      version: 4,
      description: "Add oracle verification metadata and commit-bound change summaries",
      sql: `
ALTER TABLE chimera_oracle_result ADD COLUMN verification_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE chimera_oracle_result ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS chimera_oracle_result_verification_idx ON chimera_oracle_result(status, trusted, verification_kind);

CREATE TABLE IF NOT EXISTS chimera_commit_change_summary (
  id TEXT PRIMARY KEY,
  commit_hash TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  parents_json TEXT NOT NULL,
  oracle_ids_json TEXT NOT NULL,
  mutation_ids_json TEXT NOT NULL,
  change_ids_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  subject_counts_json TEXT NOT NULL,
  change_kind_counts_json TEXT NOT NULL,
  risk_labels_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  graph_revision TEXT,
  extractor_version TEXT,
  payload_json TEXT NOT NULL,
  compacted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chimera_commit_change_summary_commit_idx ON chimera_commit_change_summary(commit_hash);
CREATE INDEX IF NOT EXISTS chimera_commit_change_summary_compacted_idx ON chimera_commit_change_summary(compacted_at);
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

function objectRecord(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function payloadShellCommand(payload: unknown) {
  const shell = objectRecord(payload)?.shell
  const command = objectRecord(shell)?.command
  return typeof command === "string" ? command : undefined
}

function shellVerificationKind(command: string | undefined): OracleVerificationKind {
  if (!command) return "unclassified_shell"
  const value = command.toLowerCase()
  if (/\b(typecheck|type-check|tsc|tsgo|mypy|pyright|flow|vue-tsc)\b/.test(value)) return "typecheck"
  if (/\b(lint|eslint|biome\s+lint|ruff|clippy|staticcheck|ktlint|swiftlint)\b/.test(value)) return "lint"
  if (/\b(build|compile|xcodebuild|gradle\s+assemble|mvn\s+package|cargo\s+build|go\s+build|swift\s+build)\b/.test(value)) return "build"
  if (/\b(test|pytest|vitest|jest|mocha|cargo\s+test|go\s+test|swift\s+test|xcodebuild\b[\s\S]*\btest\b|gradle\b[\s\S]*\btest\b|mvn\s+test|bun\s+test|pnpm\s+test|npm\s+test|yarn\s+test|just\s+test)\b/.test(value)) return "test"
  return "unclassified_shell"
}

function oracleVerification(input: Pick<OracleRecordInput, "kind" | "payload" | "verificationKind" | "trusted">) {
  const verificationKind =
    input.verificationKind ??
    (input.kind === "lsp" ? "lsp" : shellVerificationKind(payloadShellCommand(input.payload)))
  return {
    verificationKind,
    trusted: input.trusted ?? ["lsp", "test", "typecheck", "lint", "build", "explicit"].includes(verificationKind),
  }
}

function normalizeOracleRecord(record: OracleRecord): OracleRecord {
  const verification = oracleVerification(record)
  return {
    ...record,
    verificationKind: record.verificationKind ?? verification.verificationKind,
    trusted: record.trusted ?? verification.trusted,
  }
}

function compactEvidenceForPayload(evidence: ChangeFact["evidence"]): ChangeFact["evidence"] {
  return {
    version: evidence.version,
    source: evidence.source,
    rule: evidence.rule,
    confidenceReason: evidence.confidenceReason,
    graph: evidence.graph,
    file: evidence.file,
    hunk: evidence.hunk,
    languageSignals: evidence.languageSignals,
    fileSemantic: evidence.fileSemantic,
    semanticSnapshots: evidence.semanticSnapshots,
    replayLifecycle: evidence.replayLifecycle,
    signals: unique([...evidence.signals, "raw_evidence_stored_separately"]),
  }
}

function compactFactPayload(fact: ChangeFact): ChangeFact {
  return {
    ...fact,
    evidence: compactEvidenceForPayload(fact.evidence),
  }
}

function factFromStorageRow(db: ChimeraDb, row: Pick<ChangeFactRow, "payload_json" | "evidence_json">) {
  const payload = parseJson<ChangeFact>(row.payload_json)[0]
  if (!payload) return undefined
  const evidence = parseJson<ChangeFact["evidence"]>(row.evidence_json)[0]
  return hydrateFactFromSemanticSnapshots(db, evidence ? { ...payload, evidence } : payload)
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


async function readRecentJsonl<T>(file: string, limit: number) {
  if (!(await Bun.file(file).exists())) return [] as T[]
  const size = (await stat(file)).size
  if (size === 0) return [] as T[]
  const start = Math.max(0, size - MAX_RECENT_JSONL_BYTES)
  const text = await Bun.file(file).slice(start, size).text()
  const lines = text.trim().split("\n").filter(Boolean)
  return (start === 0 ? lines : lines.slice(1)).slice(-limit).flatMap((line) => parseJson<T>(line))
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

function withReplayLifecycle(fact: ChangeFact, input: NonNullable<ChangeFact["evidence"]["replayLifecycle"]>): ChangeFact {
  return {
    ...fact,
    evidence: {
      ...fact.evidence,
      replayLifecycle: input,
      signals: unique([...fact.evidence.signals, `replay_lifecycle:${input.status}`]),
    },
  }
}

function hydrateFactFromSemanticSnapshots(db: ChimeraDb, fact: ChangeFact): ChangeFact {
  const refs = fact.evidence.semanticSnapshots
  if (!refs) {
    if (!fact.evidence.relationDelta) return fact
    return withReplayLifecycle(fact, {
      version: 1,
      status: "replayable",
      reason: "legacy embedded relation evidence remains replayable without semantic snapshot refs",
      sourceRevision: fact.evidence.graph.beforeRevision ?? fact.evidence.graph.afterRevision,
    })
  }
  const expectedRelations = (refs.beforeRelationHashes?.length ?? 0) + (refs.afterRelationHashes?.length ?? 0)
  if (expectedRelations === 0) return fact
  const beforeRelations = readSemanticRelations(db, refs.beforeRelationHashes)
  const afterRelations = readSemanticRelations(db, refs.afterRelationHashes)
  const foundRelations = beforeRelations.length + afterRelations.length
  if (foundRelations !== expectedRelations) {
    return withReplayLifecycle(fact, {
      version: 1,
      status: "missing_snapshot_refs",
      reason: "semantic snapshot relation refs could not all be resolved from chimera_semantic_object",
      sourceRevision: fact.evidence.graph.beforeRevision ?? fact.evidence.graph.afterRevision,
      expectedRefs: expectedRelations,
      foundRefs: foundRelations,
    })
  }
  return {
    ...fact,
    evidence: {
      ...fact.evidence,
      relationDelta: diffRelations(beforeRelations, afterRelations),
      replayLifecycle: {
        version: 1 as const,
        status: "replayable" as const,
        reason: "relation delta hydrated from semantic snapshot refs",
        sourceRevision: fact.evidence.graph.beforeRevision ?? fact.evidence.graph.afterRevision,
        expectedRefs: expectedRelations,
        foundRefs: foundRelations,
      },
      signals: unique(["semantic_snapshot_refs", "semantic_snapshot_refs_hydrated", "replay_lifecycle:replayable", ...fact.evidence.signals]),
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

export async function readProvenanceRecords(projectRoot: string, artifact: string): Promise<ToolMutationRecord[]> {
  const legacy = (await readLegacyProvenanceRecords(artifact)).map(normalizeProvenanceRecord)
  const records = await withDb(projectRoot, (db) => {
    for (const record of legacy) writeProvenanceRecordToDb(db, record, artifact)
    return (db.prepare("SELECT payload_json FROM chimera_change_event ORDER BY finished_at ASC, id ASC").all() as PayloadRow[])
      .flatMap((row) => parseJson<ToolMutationRecord>(row.payload_json))
      .map(normalizeProvenanceRecord)
  })
  return records ?? legacy
}

export async function readRecentProvenanceRecords(
  projectRoot: string,
  artifact: string,
  options: { sessionID?: string; finishedBefore?: string; limit?: number } = {},
): Promise<ToolMutationRecord[]> {
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 20)))
  const records = await withDb(projectRoot, (db) => {
    const clauses: string[] = []
    const params: unknown[] = []
    if (options.sessionID) {
      clauses.push("(actor_session_id = ? OR json_extract(payload_json, '$.tool.sessionID') = ?)")
      params.push(options.sessionID, options.sessionID)
    }
    if (options.finishedBefore) {
      clauses.push("finished_at <= ?")
      params.push(options.finishedBefore)
    }
    const rows = db.prepare(`
      SELECT payload_json
      FROM chimera_change_event
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY finished_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit) as PayloadRow[]
    return rows.toReversed().flatMap((row) => parseJson<ToolMutationRecord>(row.payload_json)).map(normalizeProvenanceRecord)
  })
  if (records) return records
  return (await readRecentJsonl<ToolMutationRecord>(artifact, limit))
    .map(normalizeProvenanceRecord)
    .filter((record) => !options.sessionID || (record.actor?.sessionID ?? record.tool.sessionID) === options.sessionID)
    .filter((record) => !options.finishedBefore || record.finishedAt <= options.finishedBefore)
    .slice(-limit)
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
          safeJson(compactFactPayload(fact)),
          fact.createdAt,
        )
      }
    })()
    return true
  })
}

function readChangeFactsFromDb(db: ChimeraDb, eventIDs?: string[]) {
  const ids = eventIDs ? unique(eventIDs).filter(Boolean) : undefined
  if (ids && ids.length === 0) return [] as ChangeFact[]
  const rows = (ids
    ? db.prepare(`
        SELECT evidence_json, payload_json
        FROM chimera_change_fact
        WHERE event_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY created_at ASC, id ASC
      `).all(...ids)
    : db.prepare(`
        SELECT evidence_json, payload_json
        FROM chimera_change_fact
        ORDER BY created_at ASC, id ASC
      `).all()) as Array<Pick<ChangeFactRow, "evidence_json" | "payload_json">>
  return rows.flatMap((row) => {
    const fact = factFromStorageRow(db, row)
    return fact ? [fact] : []
  })
}

export async function readChangeFacts(projectRoot: string, eventIDs?: string[]) {
  const facts = await withDb(projectRoot, (db) => readChangeFactsFromDb(db, eventIDs))
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

export async function readAuditRuns(projectRoot: string, options: { provenanceID?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
  const records = await withDb(projectRoot, (db) => {
    const rows = options.provenanceID
      ? db.prepare(`
          SELECT id, source, provenance_id, changed_files_json, snapshot_revision, seed_nodes_json, obligations_json, payload_json, created_at
          FROM chimera_audit_run
          WHERE provenance_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(options.provenanceID, limit)
      : db.prepare(`
          SELECT id, source, provenance_id, changed_files_json, snapshot_revision, seed_nodes_json, obligations_json, payload_json, created_at
          FROM chimera_audit_run
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(limit)
    return (rows as Array<{
      id: string
      source: string
      provenance_id: string | null
      changed_files_json: string
      snapshot_revision: string
      seed_nodes_json: string
      obligations_json: string
      payload_json: string
      created_at: string
    }>).map((row): AuditRunRecord => ({
      id: row.id,
      source: row.source,
      provenanceID: row.provenance_id ?? undefined,
      changedFiles: parseJson<string[]>(row.changed_files_json)[0] ?? [],
      snapshotRevision: row.snapshot_revision,
      seedNodes: parseJson<unknown[]>(row.seed_nodes_json)[0] ?? [],
      obligations: parseJson<unknown[]>(row.obligations_json)[0] ?? [],
      payload: parseJson<unknown>(row.payload_json)[0],
      createdAt: row.created_at,
    }))
  })
  return records ?? []
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

function oracleID(createdAt: string, payload: string) {
  return `oracle_${createHash("sha256").update(`${createdAt}:${payload}`).digest("hex").slice(0, 16)}`
}

function writeOracleResultToDb(db: ChimeraDb, record: OracleRecord) {
  const normalized = normalizeOracleRecord(record)
  db.prepare(`
    INSERT OR REPLACE INTO chimera_oracle_result (
      id,
      kind,
      status,
      tool_id,
      project_root,
      worktree,
      directory,
      session_id,
      message_id,
      call_id,
      agent,
      started_at,
      finished_at,
      verification_kind,
      trusted,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalized.id,
    normalized.kind,
    normalized.status,
    normalized.tool.id,
    normalized.project.root,
    normalized.project.worktree,
    normalized.project.directory,
    normalized.tool.sessionID,
    normalized.tool.messageID,
    normalized.tool.callID ?? null,
    normalized.tool.agent,
    normalized.startedAt ?? null,
    normalized.finishedAt,
    normalized.verificationKind ?? "unknown",
    normalized.trusted ? 1 : 0,
    safeJson(normalized),
    normalized.createdAt,
  )
}

export async function recordOracleResult(projectRoot: string, artifact: string, input: OracleRecordInput) {
  const createdAt = new Date().toISOString()
  const payload = safeJson(input.payload)
  const record: OracleRecord = {
    schemaVersion: 1,
    id: oracleID(createdAt, payload),
    ...input,
    createdAt,
  }
  const normalized = normalizeOracleRecord(record)
  const wrote = await withDb(projectRoot, (db) => {
    writeOracleResultToDb(db, normalized)
    return true
  })
  if (!wrote) await appendJsonl(artifact, normalized)
  return normalized
}

export async function readOracleResults(
  projectRoot: string,
  artifact: string,
  options: { sessionID?: string; limit?: number; includePassing?: boolean } = {},
) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
  const legacy = await readRecentJsonl<OracleRecord>(artifact, Math.max(limit * 5, 100))
  const keep = (record: OracleRecord) =>
    (!options.sessionID || record.tool.sessionID === options.sessionID) &&
    (options.includePassing || record.status !== "pass")
  const records = await withDb(projectRoot, (db) => {
    for (const record of legacy) writeOracleResultToDb(db, record)
    const where = [
      ...(options.sessionID ? ["session_id = ?"] : []),
      ...(!options.includePassing ? ["status != 'pass'"] : []),
    ]
    const params = [
      ...(options.sessionID ? [options.sessionID] : []),
      limit,
    ]
    return (db.prepare(`
      SELECT payload_json
      FROM chimera_oracle_result
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY finished_at DESC, id DESC
      LIMIT ?
    `).all(...params) as PayloadRow[])
      .flatMap((row) => parseJson<OracleRecord>(row.payload_json))
      .map(normalizeOracleRecord)
  })
  return records ?? legacy.map(normalizeOracleRecord).filter(keep).toSorted((a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id.localeCompare(a.id)).slice(0, limit)
}

export async function readOracleResult(projectRoot: string, artifact: string, oracleID: string) {
  const legacy = await readJsonl<OracleRecord>(artifact)
  const record = await withDb(projectRoot, (db) => {
    for (const item of legacy) writeOracleResultToDb(db, item)
    const row = db.prepare("SELECT payload_json FROM chimera_oracle_result WHERE id = ?").get(oracleID) as PayloadRow | undefined
    return row ? parseJson<OracleRecord>(row.payload_json).map(normalizeOracleRecord)[0] : undefined
  })
  return record ?? legacy.map(normalizeOracleRecord).find((item) => item.id === oracleID)
}

async function fileBytes(file: string) {
  try {
    return (await stat(file)).size
  } catch {
    return undefined
  }
}

async function gitText(projectRoot: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [text, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
  return code === 0 ? text.trim() : undefined
}

async function gitOk(projectRoot: string, args: string[]) {
  return (await Bun.spawn(["git", ...args], {
    cwd: projectRoot,
    stdout: "ignore",
    stderr: "ignore",
  }).exited) === 0
}

async function gitHead(projectRoot: string) {
  const commit = await gitText(projectRoot, ["rev-parse", "HEAD"])
  const tree = commit ? await gitText(projectRoot, ["rev-parse", "HEAD^{tree}"]) : undefined
  const parents = commit ? await gitText(projectRoot, ["show", "-s", "--format=%P", "HEAD"]) : undefined
  if (!commit || !tree || parents === undefined) return undefined
  return {
    commit,
    tree,
    parents: parents ? parents.split(/\s+/).filter(Boolean) : [],
  }
}

function gitRelativePath(projectRoot: string, file: string) {
  if (!path.isAbsolute(file)) return file
  return path.relative(projectRoot, file).replaceAll("\\", "/")
}

async function gitFilesCommitted(projectRoot: string, files: string[]) {
  const paths = unique(files.map((file) => gitRelativePath(projectRoot, file)).filter((file) => file && !file.startsWith("..") && !path.isAbsolute(file)))
  if (paths.length === 0) return false
  if (!(await gitOk(projectRoot, ["diff", "--quiet", "HEAD", "--", ...paths]))) return false
  return gitOk(projectRoot, ["ls-files", "--error-unmatch", "--", ...paths])
}

function countBy(items: string[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1
    return counts
  }, {})
}

function firstDefined<T>(items: T[]) {
  return items.find((item) => item !== undefined && item !== null)
}

function compactSummaryID(summary: Omit<CommitChangeSummary, "schemaVersion" | "id">) {
  return `commit_summary_${hashBytes("chimera-commit-summary:v1", stableJson({
    commit: summary.commit,
    oracleIDs: summary.oracleIDs,
    mutationIDs: summary.mutationIDs,
  })).slice(0, 16)}`
}

function commitChangeSummary(input: {
  head: NonNullable<Awaited<ReturnType<typeof gitHead>>>
  oracleIDs: string[]
  mutationIDs: string[]
  changeIDs: string[]
  files: string[]
  facts: ChangeFact[]
  compactedAt: string
}): CommitChangeSummary {
  const graphRevision = firstDefined(input.facts.map((fact) => fact.evidence.graph.afterRevision))
  const extractorVersion = firstDefined(input.facts.flatMap((fact) => [
    fact.evidence.beforeNode?.source.codegraphVersion,
    fact.evidence.afterNode?.source.codegraphVersion,
  ]))
  const summary = {
    commit: input.head.commit,
    tree: input.head.tree,
    parents: input.head.parents,
    oracleIDs: unique(input.oracleIDs).sort(),
    mutationIDs: unique(input.mutationIDs).sort(),
    changeIDs: unique(input.changeIDs).sort(),
    files: unique(input.files).sort(),
    subjectCounts: countBy(input.facts.map((fact) => fact.subjectKind)),
    changeKindCounts: countBy(input.facts.map((fact) => fact.changeKind)),
    riskLabels: unique(input.facts.map((fact) => `${fact.subjectKind}:${fact.changeKind}`)).sort(),
    summary: `Verified committed Chimera changes for ${input.facts.length} fact(s), ${unique(input.files).length} file(s), ${unique(input.oracleIDs).length} oracle(s).`,
    graphRevision,
    extractorVersion,
    compactedAt: input.compactedAt,
  }
  return {
    schemaVersion: 1,
    id: compactSummaryID(summary),
    ...summary,
  }
}

function writeCommitChangeSummary(db: ChimeraDb, summary: CommitChangeSummary) {
  db.prepare(`
    INSERT OR REPLACE INTO chimera_commit_change_summary (
      id,
      commit_hash,
      tree_hash,
      parents_json,
      oracle_ids_json,
      mutation_ids_json,
      change_ids_json,
      files_json,
      subject_counts_json,
      change_kind_counts_json,
      risk_labels_json,
      summary,
      graph_revision,
      extractor_version,
      payload_json,
      compacted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summary.id,
    summary.commit,
    summary.tree,
    safeJson(summary.parents),
    safeJson(summary.oracleIDs),
    safeJson(summary.mutationIDs),
    safeJson(summary.changeIDs),
    safeJson(summary.files),
    safeJson(summary.subjectCounts),
    safeJson(summary.changeKindCounts),
    safeJson(summary.riskLabels),
    summary.summary,
    summary.graphRevision ?? null,
    summary.extractorVersion ?? null,
    safeJson(summary),
    summary.compactedAt,
  )
}

function oracleRecordsFromDb(db: ChimeraDb) {
  return (db.prepare("SELECT payload_json FROM chimera_oracle_result ORDER BY finished_at ASC, id ASC").all() as PayloadRow[])
    .flatMap((row) => parseJson<OracleRecord>(row.payload_json))
    .map(normalizeOracleRecord)
}

function activeObligationText(db: ChimeraDb) {
  return (db.prepare(`
    SELECT evidence, payload_json
    FROM chimera_audit_obligation
    WHERE status NOT IN ('resolved', 'ignored')
  `).all() as Array<{ evidence: string; payload_json: string }>)
    .map((row) => `${row.evidence}\n${row.payload_json}`)
    .join("\n")
}

function compactionCandidates(db: ChimeraDb, options: CommittedEvidenceCompactionOptions) {
  const records = oracleRecordsFromDb(db)
  const protectedEvents = new Set<string>()
  const candidates = new Map<string, { eventID: string; oracleIDs: Set<string>; changeIDs: Set<string>; files: Set<string> }>()
  for (const record of records) {
    if (record.status !== "pass" || record.linkWindow.sessionID === options.activeSessionID) {
      for (const change of record.linkedChanges) protectedEvents.add(change.id)
      continue
    }
    if (!record.trusted) continue
    for (const change of record.linkedChanges.filter((item) => item.status === "success")) {
      const existing = candidates.get(change.id) ?? { eventID: change.id, oracleIDs: new Set<string>(), changeIDs: new Set<string>(), files: new Set<string>() }
      existing.oracleIDs.add(record.id)
      if (change.changeID) existing.changeIDs.add(change.changeID)
      for (const file of change.files) existing.files.add(file)
      candidates.set(change.id, existing)
    }
  }
  for (const id of protectedEvents) candidates.delete(id)

  const eventIDs = [...candidates.keys()]
  if (eventIDs.length === 0) return []
  const eventRows = (db.prepare(`
    SELECT id, actor_session_id, after_revision
    FROM chimera_change_event
    WHERE id IN (${eventIDs.map(() => "?").join(", ")})
  `).all(...eventIDs) as Array<{ id: string; actor_session_id: string | null; after_revision: string }>)
  const eventIDsInStore = new Set(eventRows
    .filter((row) => row.actor_session_id !== options.activeSessionID)
    .map((row) => row.id))
  const obligationText = activeObligationText(db)
  return eventIDs
    .filter((id) => eventIDsInStore.has(id))
    .map((id) => {
      const candidate = candidates.get(id)
      if (!candidate) return undefined
      const facts = readChangeFactsFromDb(db, [id])
      if (facts.length === 0) return undefined
      if (facts.some((fact) => obligationText.includes(fact.id) || obligationText.includes(fact.eventID))) return undefined
      for (const fact of facts) candidate.files.add(fact.filePath)
      return {
        ...candidate,
        oracleIDs: [...candidate.oracleIDs],
        changeIDs: [...candidate.changeIDs],
        files: [...candidate.files],
        facts,
      }
    })
    .filter((item): item is {
      eventID: string
      oracleIDs: string[]
      changeIDs: string[]
      files: string[]
      facts: ChangeFact[]
    } => Boolean(item))
}

function deleteEvents(db: ChimeraDb, eventIDs: string[]) {
  if (eventIDs.length === 0) return { facts: 0, snapshots: 0, semanticObjects: 0 }
  const placeholders = eventIDs.map(() => "?").join(", ")
  const snapshotRows = db.prepare(`SELECT id FROM chimera_semantic_snapshot WHERE event_id IN (${placeholders})`).all(...eventIDs) as Array<{ id: string }>
  const snapshotIDs = snapshotRows.map((row) => row.id)
  if (snapshotIDs.length > 0) {
    db.prepare(`DELETE FROM chimera_semantic_snapshot_ref WHERE snapshot_id IN (${snapshotIDs.map(() => "?").join(", ")})`).run(...snapshotIDs)
  }
  const snapshots = (db.prepare(`DELETE FROM chimera_semantic_snapshot WHERE event_id IN (${placeholders})`).run(...eventIDs) as { changes?: number }).changes ?? 0
  const facts = (db.prepare(`DELETE FROM chimera_change_fact WHERE event_id IN (${placeholders})`).run(...eventIDs) as { changes?: number }).changes ?? 0
  const semanticObjects = (db.prepare(`
    DELETE FROM chimera_semantic_object
    WHERE hash NOT IN (SELECT object_hash FROM chimera_semantic_snapshot_ref)
  `).run() as { changes?: number }).changes ?? 0
  return { facts, snapshots, semanticObjects }
}

function rewriteStoredFactPayloads(db: ChimeraDb) {
  const rows = db.prepare("SELECT id, evidence_json, payload_json FROM chimera_change_fact").all() as Array<Pick<ChangeFactRow, "id" | "evidence_json" | "payload_json">>
  return rows.reduce((count, row) => {
    const payload = parseJson<ChangeFact>(row.payload_json)[0]
    if (!payload) return count
    const evidence = parseJson<ChangeFact["evidence"]>(row.evidence_json)[0]
    const compact = safeJson(compactFactPayload(evidence ? { ...payload, evidence } : payload))
    if (compact === row.payload_json) return count
    db.prepare("UPDATE chimera_change_fact SET payload_json = ? WHERE id = ?").run(compact, row.id)
    return count + 1
  }, 0)
}

export async function compactCommittedChangeEvidence(projectRoot: string, options: CommittedEvidenceCompactionOptions = {}): Promise<CommittedEvidenceCompactionResult> {
  const dbPath = databaseStorePath(projectRoot)
  const dryRun = options.dryRun ?? false
  const vacuum = !dryRun && (options.vacuum ?? false)
  const dbBytesBefore = await fileBytes(dbPath)
  const head = await gitHead(projectRoot)
  if (!head) {
    return {
      projectRoot,
      dbPath,
      dryRun,
      vacuum,
      candidateEvents: 0,
      compactedEvents: 0,
      deletedFacts: 0,
      deletedSemanticSnapshots: 0,
      deletedSemanticObjects: 0,
      rewrittenFactPayloads: 0,
      summariesWritten: 0,
      dbBytesBefore,
      dbBytesAfter: dbBytesBefore,
    }
  }

  const result = await withDb(projectRoot, (db) => {
    const candidates = compactionCandidates(db, options)
    return { candidates }
  })
  const candidates = result?.candidates ?? []
  const committed = [] as typeof candidates
  for (const candidate of candidates) {
    if (await gitFilesCommitted(projectRoot, candidate.files)) committed.push(candidate)
  }

  if (dryRun) {
    return {
      projectRoot,
      dbPath,
      dryRun,
      vacuum,
      commit: head.commit,
      tree: head.tree,
      candidateEvents: candidates.length,
      compactedEvents: committed.length,
      deletedFacts: 0,
      deletedSemanticSnapshots: 0,
      deletedSemanticObjects: 0,
      rewrittenFactPayloads: 0,
      summariesWritten: 0,
      dbBytesBefore,
      dbBytesAfter: dbBytesBefore,
    }
  }

  if (committed.length === 0) {
    const rewrittenFactPayloads = await withDb(projectRoot, (db) => db.transaction(() => rewriteStoredFactPayloads(db))()) ?? 0
    if (vacuum) {
      await withDb(projectRoot, (db) => {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        db.exec("VACUUM")
        return true
      })
    }
    return {
      projectRoot,
      dbPath,
      dryRun,
      vacuum,
      commit: head.commit,
      tree: head.tree,
      candidateEvents: candidates.length,
      compactedEvents: 0,
      deletedFacts: 0,
      deletedSemanticSnapshots: 0,
      deletedSemanticObjects: 0,
      rewrittenFactPayloads,
      summariesWritten: 0,
      dbBytesBefore,
      dbBytesAfter: await fileBytes(dbPath),
    }
  }

  const compactedAt = options.now ?? new Date().toISOString()
  const summary = commitChangeSummary({
    head,
    oracleIDs: committed.flatMap((candidate) => candidate.oracleIDs),
    mutationIDs: committed.map((candidate) => candidate.eventID),
    changeIDs: committed.flatMap((candidate) => candidate.changeIDs),
    files: committed.flatMap((candidate) => candidate.files),
    facts: committed.flatMap((candidate) => candidate.facts),
    compactedAt,
  })
  const cleanup = await withDb(projectRoot, (db) => {
    return db.transaction(() => {
      const rewrittenFactPayloads = rewriteStoredFactPayloads(db)
      writeCommitChangeSummary(db, summary)
      return {
        summariesWritten: 1,
        rewrittenFactPayloads,
        ...deleteEvents(db, committed.map((candidate) => candidate.eventID)),
      }
    })()
  })

  if (vacuum) {
    await withDb(projectRoot, (db) => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      db.exec("VACUUM")
      return true
    })
  }

  return {
    projectRoot,
    dbPath,
    dryRun,
    vacuum,
    commit: head.commit,
    tree: head.tree,
    candidateEvents: candidates.length,
    compactedEvents: committed.length,
    deletedFacts: cleanup?.facts ?? 0,
    deletedSemanticSnapshots: cleanup?.snapshots ?? 0,
    deletedSemanticObjects: cleanup?.semanticObjects ?? 0,
    rewrittenFactPayloads: cleanup?.rewrittenFactPayloads ?? 0,
    summariesWritten: cleanup?.summariesWritten ?? 0,
    dbBytesBefore,
    dbBytesAfter: await fileBytes(dbPath),
  }
}

export async function readCommitChangeSummaries(projectRoot: string, options: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
  const records = await withDb(projectRoot, (db) =>
    (db.prepare(`
      SELECT payload_json
      FROM chimera_commit_change_summary
      ORDER BY compacted_at DESC, id DESC
      LIMIT ?
    `).all(limit) as PayloadRow[])
      .flatMap((row) => parseJson<CommitChangeSummary>(row.payload_json)),
  )
  return records ?? []
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
