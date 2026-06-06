import path from "path"
import { createHash } from "crypto"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import {
  Chimera,
  NODE_KINDS,
  classifyChangeRecord,
  classifyFileBoundary,
  collectFileProjections,
  collectIncidentRelations,
  type ChangeFact,
  type CodeGraphIndexProgress,
  type CodeGraphNode,
  type CodeGraphRelation,
  type CodeGraphSnapshot,
  type FileClassification,
  type FrozenRelation,
  type FrozenSemanticObject,
  type ProjectGraphState,
  type RelationKind,
  type ToolMutationRecord,
} from "@/chimera"
import {
  provenanceRecordCount as storedProvenanceRecordCount,
  readChangeFacts,
  readProvenanceRecords,
  readPersistentObligationStore,
  recordAuditRun,
  writePersistentObligationStore,
} from "@/chimera/store"
import * as Tool from "./tool"
import STATUS_DESCRIPTION from "./chimera_status.txt"
import SEARCH_DESCRIPTION from "./chimera_search.txt"
import FILE_SYMBOLS_DESCRIPTION from "./chimera_file_symbols.txt"
import IMPACT_DESCRIPTION from "./chimera_impact.txt"
import CONTEXT_DESCRIPTION from "./chimera_context.txt"
import AUDIT_RECENT_DESCRIPTION from "./chimera_audit_recent.txt"
import AUDIT_DESCRIPTION from "./chimera_audit.txt"
import OBLIGATIONS_LIST_DESCRIPTION from "./chimera_obligations_list.txt"
import OBLIGATIONS_SYNC_DESCRIPTION from "./chimera_obligations_sync.txt"
import OBLIGATION_CLAIM_DESCRIPTION from "./chimera_obligation_claim.txt"
import OBLIGATION_RESOLVE_DESCRIPTION from "./chimera_obligation_resolve.txt"
import OBLIGATION_IGNORE_DESCRIPTION from "./chimera_obligation_ignore.txt"

const NodeKind = Schema.Union(NODE_KINDS.map((kind) => Schema.Literal(kind)))

const ContextMode = Schema.Union([
  Schema.Literal("arch"),
  Schema.Literal("search"),
  Schema.Literal("impact"),
  Schema.Literal("audit"),
])

const ObligationStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("claimed"),
  Schema.Literal("resolved"),
  Schema.Literal("ignored"),
  Schema.Literal("stale"),
])

const Range = Schema.Struct({
  startLine: Schema.Number.annotate({ description: "1-based start line for the source range." }),
  endLine: Schema.optional(Schema.Number).annotate({
    description: "Optional 1-based end line for the source range. Defaults to the start line when omitted.",
  }),
  startColumn: Schema.optional(Schema.Number).annotate({
    description: "Optional 1-based start column within startLine.",
  }),
  endColumn: Schema.optional(Schema.Number).annotate({
    description: "Optional 1-based end column within endLine.",
  }),
})

const RefreshDescription =
  "Refresh CodeGraph when stale: the index is empty, watcher has pending files, or git reports dirty source files. Defaults to true."

export const StatusParameters = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const SearchParameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Symbol or CodeGraph-indexed text query. This is not raw literal/code-string search; use Grep for arbitrary source text.",
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional CodeGraph node kind filter.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum results to return. Defaults to 10, capped at 50.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const FileSymbolsParameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "File path to list indexed symbols from, absolute or project-relative.",
  }),
  range: Schema.optional(Range).annotate({
    description: "Optional source range inside filePath; returns intersecting symbols.",
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional CodeGraph node kind filter.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum results to return. Defaults to 10, capped at 50.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const ImpactParameters = Schema.Struct({
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to analyze. Used when nodeID is not supplied.",
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Exact CodeGraph node id to analyze.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "File to analyze for file-level dependents; absolute or project-relative.",
  }),
  range: Schema.optional(Range).annotate({
    description: "Optional source range inside filePath; seed symbols are nodes intersecting this range.",
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional node kind filter when resolving symbol or range seeds.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Graph traversal depth for symbol impact. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum impacted symbols/files to return. Defaults to 20, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide at least one impact seed: nodeID, symbol, or filePath. Use range only with filePath.",
})

export const ContextParameters = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description: "Natural-language or symbol/file query for context.",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to use as the context query when query is omitted.",
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Exact CodeGraph node id to use as the context focus when query and symbol are omitted.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "File path to use as the context query when query, symbol, and nodeID are omitted.",
  }),
  mode: Schema.optional(ContextMode).annotate({
    description: "Context mode. arch produces an architecture-oriented query; defaults to search.",
  }),
  includeCode: Schema.optional(Schema.Boolean).annotate({
    description: "Include source snippets in context. Defaults to true.",
  }),
  maxNodes: Schema.optional(Schema.Number).annotate({
    description: "Maximum graph nodes in context. Defaults to 30.",
  }),
  maxCodeBlocks: Schema.optional(Schema.Number).annotate({
    description: "Maximum code blocks in context. Defaults to 8.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide query, symbol, nodeID, filePath, or mode=arch.",
})

export const RecentAuditParameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum candidate obligations to return. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const AuditParameters = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Changed files to audit, absolute or project-relative.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Single changed file to audit, absolute or project-relative.",
  }),
  range: Schema.optional(Range).annotate({
    description: "Optional changed source range inside filePath.",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Changed symbol to audit when file/range is not precise enough.",
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Exact CodeGraph node id to use as an audit seed.",
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional node kind filter when resolving audit seed symbols.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Impact traversal depth. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum candidate obligations to return. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide at least one explicit audit seed: files, filePath, symbol, or nodeID. Use chimera_audit_recent for the latest mutation.",
})

export const ObligationsListParameters = Schema.Struct({
  status: Schema.optional(ObligationStatus).annotate({
    description: "Optional status filter for list.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum obligations to list. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const ObligationsSyncParameters = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Changed files to audit and sync into obligations.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Single changed file to audit and sync into obligations.",
  }),
  range: Schema.optional(Range).annotate({
    description: "Optional changed source range inside filePath for sync.",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Changed symbol to audit and sync into obligations.",
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Exact CodeGraph node id to audit and sync into obligations.",
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional CodeGraph node kind filter when resolving sync seed symbols.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Impact traversal depth for sync. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum obligations to list or sync. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide explicit sync seeds or omit them to sync from recent mutation or git diff fallback.",
})

export const ObligationClaimParameters = Schema.Struct({
  obligationID: Schema.String.annotate({
    description: "Obligation id to claim.",
  }),
})

export const ObligationResolveParameters = Schema.Struct({
  obligationID: Schema.String.annotate({
    description: "Obligation id to resolve.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Optional short note stating the evidence or update that resolved the obligation.",
  }),
})

export const ObligationIgnoreParameters = Schema.Struct({
  obligationID: Schema.String.annotate({
    description: "Obligation id to ignore.",
  }),
  reason: Schema.String.annotate({
    description: "Required reason for ignoring the obligation.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Optional additional context.",
  }),
})

type StatusMetadata = {
  projectRoot: string
  artifact: string
  storePath: string
  obligationsArtifact: string
  snapshot: CodeGraphSnapshot
  stats: unknown
  backend: string
  journalMode: string
  provenanceRecords: number
  obligationCounts: ObligationCounts
  pendingObligations: number
}

type SearchMetadata = {
  projectRoot: string
  snapshot: CodeGraphSnapshot
  results: Array<{ score?: number; node: CodeGraphNode; projection: FrozenSemanticObject | null }>
}

type ImpactMetadata = {
  projectRoot: string
  snapshot: CodeGraphSnapshot
  seeds: Array<FrozenSemanticObject | null>
  impacted: Array<FrozenSemanticObject | null>
  fileDependents: string[]
  evidence: AuditCandidate[]
}

type ContextMetadata = {
  projectRoot: string
  snapshot: CodeGraphSnapshot
  mode: "arch" | "search" | "impact" | "audit"
  query: string
  overlay: ContextOverlay
}

type ChangeClassification = FileClassification

type RiskCategory =
  | "api_contract"
  | "behavior_boundary"
  | "test"
  | "documentation"
  | "configuration"
  | "dependency"
  | "importer"
  | "call_flow"
  | "entrypoint"
  | "unknown"

type CauseLink = {
  type:
    | "changed_file"
    | "changed_seed"
    | "change_fact"
    | "file_dependency"
    | "relation"
    | "before_relation"
    | "after_relation"
    | "added_relation"
    | "removed_relation"
    | "impact_radius"
    | "context_selection"
  target: string
  evidence: string
}

type AuditCandidate = {
  target: string
  targetNode?: FrozenSemanticObject | null
  reason: string
  risk: RiskCategory
  classification: ChangeClassification
  requiredAction: "review_or_update"
  evidence: string
  causeChain: CauseLink[]
}

type AuditMetadata = {
  projectRoot: string
  snapshot: CodeGraphSnapshot
  source: "input" | "recent_provenance" | "git_diff"
  changedFiles: string[]
  classifications: Array<{ file: string; classification: ChangeClassification; reason: string }>
  changeFacts: ChangeFact[]
  seedNodes: Array<FrozenSemanticObject | null>
  impactedNodes: Array<FrozenSemanticObject | null>
  fileDependents: string[]
  obligations: AuditCandidate[]
  provenance?: ToolMutationRecord
}

type ObligationStatusValue = "pending" | "claimed" | "resolved" | "ignored" | "stale"

type ObligationActor = {
  sessionID: string
  messageID: string
  callID?: string
  agent: string
  at: string
}

type PersistentObligation = {
  schemaVersion: 1
  id: string
  fingerprint: string
  status: ObligationStatusValue
  target: string
  targetNode?: FrozenSemanticObject | null
  reason: string
  risk: RiskCategory
  classification?: ChangeClassification
  requiredAction: "review_or_update"
  evidence: string
  causeChain?: CauseLink[]
  source: {
    type: AuditMetadata["source"]
    provenanceID?: string
    changedFiles: string[]
    snapshotRevision: string
    seedNodes: Array<FrozenSemanticObject | null>
    changeFacts?: ChangeFact[]
  }
  createdAt: string
  updatedAt: string
  claimedBy?: ObligationActor
  resolvedBy?: ObligationActor & { note?: string }
  ignoredBy?: ObligationActor & { reason: string; note?: string }
}

type ObligationStore = {
  schemaVersion: 1
  obligations: PersistentObligation[]
}

type ObligationCounts = Record<ObligationStatusValue, number>

type ObligationsMetadata = {
  projectRoot: string
  artifact: string
  storePath: string
  action: "list" | "sync" | "claim" | "resolve" | "ignore"
  counts: ObligationCounts
  obligations: PersistentObligation[]
  synced?: number
  updated?: number
  audit?: AuditMetadata
}

type ContextOverlay = {
  provenance?: {
    id: string
    toolID: string
    status: ToolMutationRecord["status"]
    finishedAt: string
    beforeRevision: string
    afterRevision: string
    files: string[]
  }
  selectedImpact: {
    seeds: Array<FrozenSemanticObject | null>
    impacted: Array<FrozenSemanticObject | null>
    fileDependents: string[]
    evidence: AuditCandidate[]
  }
  obligations: {
    artifact: string
    storePath?: string
    counts: ObligationCounts
    active: PersistentObligation[]
  }
}

type ChimeraSyncProgress = {
  operation: "full_sync"
  status: "starting" | "running" | "complete"
  phase?: CodeGraphIndexProgress["phase"]
  current?: number
  total?: number
  currentFile?: string
  elapsedMs: number
  message: string
}

const SYNC_PROGRESS_DELAY_MS = 1_500
const SYNC_PROGRESS_INTERVAL_MS = 1_000

function compactProgressFile(file: string | undefined) {
  if (!file) return undefined
  if (file.length <= 80) return file
  return `...${file.slice(-77)}`
}

function formatProgressMessage(progress: ChimeraSyncProgress) {
  const count = progress.total && progress.total > 0 ? ` ${progress.current ?? 0}/${progress.total}` : ""
  const phase = progress.phase ? ` ${progress.phase}` : ""
  if (progress.status === "complete") return `Chimera refresh complete${phase}${count}`
  if (progress.status === "starting") return "Chimera refresh is still running"
  return `Chimera refresh${phase}${count}`
}

function createSyncProgressReporter(ctx: Tool.Context, enabled: boolean) {
  if (!enabled) return { onProgress: undefined, done() {} }

  const startedAt = Date.now()
  let latest: CodeGraphIndexProgress | undefined
  let lastEmittedAt = 0
  let visible = false
  let finished = false

  const emit = (status: ChimeraSyncProgress["status"]) => {
    if (finished && status !== "complete") return
    const payload: ChimeraSyncProgress = {
      operation: "full_sync",
      status,
      phase: latest?.phase,
      current: latest?.current,
      total: latest?.total,
      currentFile: compactProgressFile(latest?.currentFile),
      elapsedMs: Date.now() - startedAt,
      message: "",
    }
    payload.message = formatProgressMessage(payload)
    visible = true
    lastEmittedAt = Date.now()
    void Effect.runPromise(
      ctx.metadata({
        title: payload.message,
        metadata: { chimeraSyncProgress: payload },
      }),
    ).catch(() => undefined)
  }

  const timer = setTimeout(() => emit("starting"), SYNC_PROGRESS_DELAY_MS)

  return {
    onProgress(progress: CodeGraphIndexProgress) {
      latest = progress
      const now = Date.now()
      if (now - startedAt < SYNC_PROGRESS_DELAY_MS) return
      const phaseDone = progress.total > 0 && progress.current >= progress.total
      if (!phaseDone && now - lastEmittedAt < SYNC_PROGRESS_INTERVAL_MS) return
      emit("running")
    },
    done() {
      clearTimeout(timer)
      finished = true
      if (visible) emit("complete")
    },
  }
}

function openProjectGraphForTool(ctx: Tool.Context, refresh: boolean) {
  const reporter = createSyncProgressReporter(ctx, refresh)
  return Chimera.openProjectGraph({ sync: refresh, onProgress: reporter.onProgress }).pipe(
    Effect.ensuring(Effect.sync(() => reporter.done())),
  )
}

function bounded(value: number | undefined, fallback: number, max: number) {
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)))
}

function graphPath(root: string, base: string, filePath: string) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath)
  const relative = path.relative(root, absolute).replaceAll("\\", "/")
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative
  return filePath.replaceAll("\\", "/")
}

function formatNode(node: CodeGraphNode) {
  return [
    `- ${node.qualifiedName || node.name} (${node.kind})`,
    `  ${node.filePath}:${node.startLine}-${node.endLine}`,
    node.signature ? `  ${node.signature}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function nodeMatchesQuery(node: CodeGraphNode, query: string | undefined) {
  const normalizedQuery = query?.trim().toLowerCase()
  if (!normalizedQuery) return true
  const searchable = [node.name, node.qualifiedName, node.signature, node.filePath, node.docstring, node.kind, node.language]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
  return normalizedQuery.split(/\s+/).every((term) => searchable.includes(term))
}

function uniqueNodes(nodes: CodeGraphNode[]) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()]
}

function uniqueStrings(items: string[]) {
  return [...new Set(items)]
}

const DependentRelations: RelationKind[] = [
  "CalledBy",
  "ImportedBy",
  "UsedBy",
  "InstantiatedBy",
  "BaseClassOf",
  "OverriddenBy",
  "DecoratedBy",
]

function nodeTarget(node: CodeGraphNode) {
  return `${node.filePath}:${node.startLine} ${node.qualifiedName || node.name}`
}

function relationEvidence(relation: CodeGraphRelation) {
  return `codegraph:relation:${relation.relation}:${relation.edgeKind}:${relation.quality}`
}

function classifyFile(filePath: string): { classification: ChangeClassification; reason: string } {
  const boundary = classifyFileBoundary(filePath)
  return { classification: boundary.classification, reason: boundary.reason }
}

function riskForClassification(classification: ChangeClassification): RiskCategory {
  if (classification === "dependency") return "dependency"
  if (classification === "test") return "test"
  if (classification === "docs") return "documentation"
  if (classification === "config") return "configuration"
  if (classification === "api_route") return "api_contract"
  if (classification === "source") return "behavior_boundary"
  if (classification === "generated") return "unknown"
  return "unknown"
}

function riskForFile(filePath: string) {
  return riskForClassification(classifyFile(filePath).classification)
}

function riskForNode(node: CodeGraphNode): RiskCategory {
  const classification = classifyFile(node.filePath).classification
  if (node.kind === "route") return "api_contract"
  if (classification === "test") return "test"
  if (classification === "docs") return "documentation"
  if (classification === "config") return "configuration"
  if (classification === "dependency") return "dependency"
  if (classification === "api_route") return "api_contract"
  if (classification === "generated") return "unknown"
  if (node.kind === "import" || node.kind === "export") return "importer"
  if (node.kind === "function" || node.kind === "method" || node.kind === "component") return "call_flow"
  return "unknown"
}

function riskReasonForNode(node: CodeGraphNode) {
  const classification = classifyFile(node.filePath)
  if (node.kind === "route") return "route node can expose API contract behavior"
  if (node.kind === "import" || node.kind === "export") return "import/export node can propagate module boundary changes"
  if (node.kind === "function" || node.kind === "method" || node.kind === "component") {
    return `callable ${node.kind} inside ${classification.reason}`
  }
  return classification.reason
}

function frozenRelationNodeTarget(node: FrozenRelation["payload"]["otherNode"]) {
  return `${node.filePath}:${node.range.startLine} ${node.qualifiedName || node.name}`
}

function riskForFrozenRelationNode(node: FrozenRelation["payload"]["otherNode"]): RiskCategory {
  const classification = classifyFile(node.filePath).classification
  if (node.kind === "route") return "api_contract"
  if (node.kind === "import" || node.kind === "export") return "importer"
  if (node.kind === "function" || node.kind === "method" || node.kind === "component") return "call_flow"
  return riskForClassification(classification)
}

function frozenRelationEvidence(relation: FrozenRelation, type: "added_relation" | "removed_relation") {
  return `codegraph:${type}:${relation.payload.relation}:${relation.payload.edgeKind}:${relation.payload.quality}`
}

function formatCauseChain(causeChain: CauseLink[]) {
  return causeChain.map((item) => `${item.type}:${item.target} (${item.evidence})`).join(" -> ")
}

function formatClassification(item: { file: string; classification: ChangeClassification; reason: string }) {
  return `- ${item.file}: ${item.classification}\n  reason: ${item.reason}`
}

function formatChangeFact(fact: ChangeFact) {
  const relationDelta = fact.evidence.relationDelta
  return [
    `- ${fact.id}: ${fact.subjectKind}/${fact.changeKind} ${fact.filePath}`,
    fact.nodeKey ? `  node: ${fact.nodeKey}` : undefined,
    `  confidence: ${fact.confidence}`,
    `  rule: ${fact.evidence.rule}`,
    `  reason: ${fact.evidence.confidenceReason}`,
    relationDelta
      ? `  relation_delta: +${relationDelta.addedRelations.length} -${relationDelta.removedRelations.length} before:${relationDelta.beforeRelations.length} after:${relationDelta.afterRelations.length}`
      : undefined,
    fact.evidence.signals.length ? `  signals: ${fact.evidence.signals.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function sourceCause(source: AuditMetadata["source"] | "context_selection", changedFiles: string[], seedNames: string[]) {
  if (changedFiles.length) {
    return {
      type: "changed_file" as const,
      target: changedFiles.slice(0, 5).join(", "),
      evidence: source === "git_diff" ? "git:status" : `chimera:${source}`,
    }
  }
  return {
    type: "changed_seed" as const,
    target: seedNames.slice(0, 5).join(", ") || "unknown seed",
    evidence: source === "context_selection" ? "chimera:context_selection" : `chimera:${source}`,
  }
}

function factCause(changeFacts: ChangeFact[]) {
  const fact = changeFacts[0]
  if (!fact) return undefined
  return {
    type: "change_fact" as const,
    target: `${fact.subjectKind}/${fact.changeKind} ${fact.filePath}`,
    evidence: `chimera_change_fact:${fact.id} confidence:${fact.confidence}`,
  }
}

function relationDeltaCandidate(input: {
  state: ProjectGraphState
  snapshot: CodeGraphSnapshot
  relation: FrozenRelation
  type: "added_relation" | "removed_relation"
  baseCauseChain: CauseLink[]
}): AuditCandidate {
  const current = input.state.graph.node(input.relation.payload.otherNode.codegraphId)
  const target = current ? nodeTarget(current) : frozenRelationNodeTarget(input.relation.payload.otherNode)
  const classification = classifyFile(current?.filePath ?? input.relation.payload.otherNode.filePath).classification
  const change = input.type === "added_relation" ? "added" : "removed"
  const graphSide = input.type === "added_relation" ? "after graph" : "before graph"
  return {
    target,
    targetNode: current ? input.state.graph.projectNode(current, input.snapshot) : undefined,
    reason: `${current ? riskReasonForNode(current) : classifyFile(input.relation.payload.otherNode.filePath).reason}; relation ${input.relation.payload.relation} (${input.relation.payload.edgeKind}) was ${change} in CodeGraph ${graphSide} evidence for ${input.relation.payload.focalNode.nodeKey}`,
    risk: current ? riskForNode(current) : riskForFrozenRelationNode(input.relation.payload.otherNode),
    classification,
    requiredAction: "review_or_update",
    evidence: `codegraph:relation_delta:${change}:${input.relation.payload.relation}`,
    causeChain: [
      ...input.baseCauseChain,
      { type: input.type, target, evidence: frozenRelationEvidence(input.relation, input.type) },
    ],
  }
}

function relationDeltaCandidates(input: {
  state: ProjectGraphState
  snapshot: CodeGraphSnapshot
  changeFacts: ChangeFact[]
  sourceCause: CauseLink
}) {
  const dependentRelation = (relation: FrozenRelation) => DependentRelations.includes(relation.payload.relation)
  return input.changeFacts.flatMap((fact) => {
    const delta = fact.evidence.relationDelta
    if (!delta) return []
    const factLink = factCause([fact])
    const baseCauseChain = factLink ? [input.sourceCause, factLink] : [input.sourceCause]
    return [
      ...delta.removedRelations.filter(dependentRelation).map((relation) =>
        relationDeltaCandidate({ state: input.state, snapshot: input.snapshot, relation, type: "removed_relation", baseCauseChain }),
      ),
      ...delta.addedRelations.filter(dependentRelation).map((relation) =>
        relationDeltaCandidate({ state: input.state, snapshot: input.snapshot, relation, type: "added_relation", baseCauseChain }),
      ),
    ]
  })
}

function buildImpactEvidence(input: {
  state: ProjectGraphState
  snapshot: CodeGraphSnapshot
  seedNodes: CodeGraphNode[]
  changedFiles: string[]
  changeFacts: ChangeFact[]
  normalizedFile?: string
  source: AuditMetadata["source"] | "context_selection"
  depth: number
  limit: number
}) {
  const incomingRelations = input.seedNodes.flatMap((node) =>
    input.state.graph.incomingRelations(node.id, { relations: DependentRelations }),
  ).slice(0, input.limit)
  const relationNodes = uniqueNodes(incomingRelations.map((relation) => relation.otherNode))
  const relationNodeIDs = new Set(relationNodes.map((node) => node.id))
  const impactedNodes = uniqueNodes([
    ...relationNodes,
    ...input.seedNodes.flatMap((node) => [...input.state.graph.impactRadius(node.id, input.depth).nodes.values()]),
  ].slice(0, input.limit)).filter((node) => !input.seedNodes.some((seed) => seed.id === node.id) && !relationNodeIDs.has(node.id))
  const selectedImpactNodes = uniqueNodes([...relationNodes, ...impactedNodes]).filter((node) => !input.seedNodes.some((seed) => seed.id === node.id))
  const fileDependents = uniqueStrings(
    [
      ...(input.normalizedFile ? input.state.graph.fileDependents(input.normalizedFile) : []),
      ...input.changedFiles.flatMap((file) => input.state.graph.fileDependents(file)),
      ...input.seedNodes.flatMap((node) => input.state.graph.fileDependents(node.filePath)),
    ].slice(0, input.limit),
  )
  const seedNames = input.seedNodes.map((node) => node.qualifiedName || node.name).slice(0, 5)
  const cause = sourceCause(input.source, input.changedFiles, seedNames)
  const changeFactCause = factCause(input.changeFacts)
  const baseCauseChain = changeFactCause ? [cause, changeFactCause] : [cause]
  const evidence = uniqueCandidates([
    ...relationDeltaCandidates({ state: input.state, snapshot: input.snapshot, changeFacts: input.changeFacts, sourceCause: cause }),
    ...incomingRelations.map((relation) => {
      const node = relation.otherNode
      const classification = classifyFile(node.filePath).classification
      const target = nodeTarget(node)
      const relationLabel = relationEvidence(relation)
      return {
        target,
        targetNode: input.state.graph.projectNode(node, input.snapshot),
        reason: `${riskReasonForNode(node)}; relation ${relation.relation} (${relation.edgeKind}) points from ${target} to ${seedNames.join(", ") || "the changed seed"}`,
        risk: riskForNode(node),
        classification,
        requiredAction: "review_or_update" as const,
        evidence: `codegraph:relation:${relation.relation}`,
        causeChain: [...baseCauseChain, { type: "relation" as const, target, evidence: relationLabel }],
      }
    }),
    ...fileDependents.map((file) => {
      const classification = classifyFile(file).classification
      return {
        target: file,
        reason: `dependent file may need review because it imports or depends on ${input.changedFiles.slice(0, 3).join(", ") || seedNames.join(", ") || "the changed seed"}`,
        risk: riskForFile(file),
        classification,
        requiredAction: "review_or_update" as const,
        evidence: "codegraph:file_dependents",
        causeChain: [...baseCauseChain, { type: "file_dependency" as const, target: file, evidence: "codegraph:file_dependents" }],
      }
    }),
    ...impactedNodes.map((node) => {
      const classification = classifyFile(node.filePath).classification
      const target = nodeTarget(node)
      return {
        target,
        targetNode: input.state.graph.projectNode(node, input.snapshot),
        reason: `${riskReasonForNode(node)}; symbol is inside impact radius of ${seedNames.join(", ") || input.changedFiles.slice(0, 3).join(", ") || "the changed seed"}`,
        risk: riskForNode(node),
        classification,
        requiredAction: "review_or_update" as const,
        evidence: "codegraph:impact_radius",
        causeChain: [
          ...baseCauseChain,
          {
            type: "impact_radius" as const,
            target,
            evidence: "codegraph:impact_radius",
          },
        ],
      }
    }),
  ]).slice(0, input.limit)
  return { impactedNodes: selectedImpactNodes, fileDependents, evidence }
}

function permission(ctx: Tool.Context, toolID: string, metadata: Record<string, unknown>) {
  return ctx.ask({
    permission: toolID,
    patterns: ["*"],
    always: ["*"],
    metadata,
  })
}

function provenanceRecordCount(projectRoot: string, artifact: string) {
  return Effect.promise(() => storedProvenanceRecordCount(projectRoot, artifact))
}

function provenanceRecords(projectRoot: string, artifact: string) {
  return Effect.promise(() => readProvenanceRecords(projectRoot, artifact))
}

function latestSuccessfulProvenance(records: ToolMutationRecord[]) {
  return records.toReversed().find((record) => record.status === "success")
}

function provenanceGraphFiles(record: ToolMutationRecord | undefined) {
  if (!record) return []
  return record.files.flatMap((file) => (file.insideGraph && file.graphPath ? [file.graphPath] : []))
}

function gitStatusFiles(root: string) {
  return Effect.promise(async () => {
    const result = await Bun.$`git status --porcelain=v1 --untracked-files=all --no-renames -z -- .`
      .cwd(root)
      .quiet()
      .nothrow()
    if (result.exitCode !== 0) return [] as string[]
    return uniqueStrings(
      new TextDecoder()
        .decode(result.stdout)
        .split("\0")
        .flatMap((item) => {
          const file = item.slice(3).replaceAll("\\", "/")
          if (!file || file.startsWith(".codegraph/")) return []
          return [file]
        }),
    )
  })
}

function syntheticAuditRecord(input: {
  projectRoot: string
  directory: string
  source: AuditMetadata["source"]
  changedFiles: string[]
  snapshot: CodeGraphSnapshot
}): ToolMutationRecord {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: `audit:${createHash("sha256").update(`${now}:${input.changedFiles.join(",")}`).digest("hex").slice(0, 16)}`,
    origin: input.source === "git_diff" ? "git" : "tool",
    provenanceStrength: input.source === "git_diff" ? "weak" : "strong",
    tool: {
      id: "chimera_audit",
      messageID: "audit",
      sessionID: "audit",
      agent: "chimera",
    },
    project: {
      root: input.projectRoot,
      worktree: input.projectRoot,
      directory: input.directory,
    },
    status: "success",
    startedAt: now,
    finishedAt: now,
    graph: {
      before: input.snapshot,
      after: input.snapshot,
      sync: {
        filesChecked: input.changedFiles.length,
        filesAdded: 0,
        filesModified: input.changedFiles.length,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 0,
        changedFiles: input.changedFiles.map((file) => ({ path: file, status: "modified" as const })),
      },
    },
    files: input.changedFiles.map((file) => ({
      absolutePath: path.isAbsolute(file) ? file : path.join(input.projectRoot, file),
      graphPath: file,
      insideGraph: true,
    })),
    metadata: {
      classifierSource: input.source === "git_diff" ? "git_diff" : "explicit_input",
    },
  }
}

function candidateKey(candidate: AuditCandidate) {
  return `${candidate.target}:${candidate.evidence}:${candidate.classification}:${candidate.reason}`
}

function uniqueCandidates(candidates: AuditCandidate[]) {
  return [...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values()]
}

type AuditParams = Schema.Schema.Type<typeof AuditParameters>
type RecentAuditParams = Schema.Schema.Type<typeof RecentAuditParameters>
type BuildAuditParams = AuditParams & RecentAuditParams & { recent?: boolean }

type BuildAuditOptions = {
  ctx?: Tool.Context
  state?: ProjectGraphState
}

type ObligationsListParams = Schema.Schema.Type<typeof ObligationsListParameters>
type ObligationsSyncParams = Schema.Schema.Type<typeof ObligationsSyncParameters>
type ObligationClaimParams = Schema.Schema.Type<typeof ObligationClaimParameters>
type ObligationResolveParams = Schema.Schema.Type<typeof ObligationResolveParameters>
type ObligationIgnoreParams = Schema.Schema.Type<typeof ObligationIgnoreParameters>

function obligationsArtifact(provenanceArtifact: string) {
  return path.join(path.dirname(provenanceArtifact), "obligations.json")
}

function emptyObligationStore(): ObligationStore {
  return { schemaVersion: 1, obligations: [] }
}

function readObligationStore(projectRoot: string, artifact: string) {
  return Effect.promise(() => readPersistentObligationStore<PersistentObligation>(projectRoot, artifact, emptyObligationStore()))
}

function readObligationSummary(projectRoot: string, provenanceArtifact: string, storePath: string, limit = 10) {
  return Effect.gen(function* () {
    const artifact = obligationsArtifact(provenanceArtifact)
    const store = yield* readObligationStore(projectRoot, artifact)
    return {
      artifact,
      storePath,
      counts: obligationCounts(store.obligations),
      active: activeObligations(store.obligations).slice(0, limit),
    }
  })
}

function writeObligationStore(projectRoot: string, artifact: string, store: ObligationStore, runID?: string) {
  return Effect.promise(() => writePersistentObligationStore(projectRoot, artifact, store, runID))
}

function obligationCounts(obligations: PersistentObligation[]): ObligationCounts {
  return {
    pending: obligations.filter((item) => item.status === "pending").length,
    claimed: obligations.filter((item) => item.status === "claimed").length,
    resolved: obligations.filter((item) => item.status === "resolved").length,
    ignored: obligations.filter((item) => item.status === "ignored").length,
    stale: obligations.filter((item) => item.status === "stale").length,
  }
}

function formatCounts(counts: ObligationCounts) {
  return `Counts: pending ${counts.pending}, claimed ${counts.claimed}, stale ${counts.stale}, resolved ${counts.resolved}, ignored ${counts.ignored}`
}

function actor(ctx: Tool.Context, at: string): ObligationActor {
  return {
    sessionID: String(ctx.sessionID),
    messageID: String(ctx.messageID),
    callID: ctx.callID,
    agent: ctx.agent,
    at,
  }
}

function obligationFingerprint(audit: AuditMetadata, candidate: AuditCandidate) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: audit.provenance?.id ?? audit.changedFiles,
        target: candidate.target,
        evidence: candidate.evidence,
        reason: candidate.reason,
      }),
    )
    .digest("hex")
}

function makeObligation(audit: AuditMetadata, candidate: AuditCandidate, now: string): PersistentObligation {
  const fingerprint = obligationFingerprint(audit, candidate)
  return {
    schemaVersion: 1,
    id: `obl_${fingerprint.slice(0, 16)}`,
    fingerprint,
    status: "pending",
    target: candidate.target,
    targetNode: candidate.targetNode,
    reason: candidate.reason,
    risk: candidate.risk,
    classification: candidate.classification,
    requiredAction: candidate.requiredAction,
    evidence: candidate.evidence,
    causeChain: candidate.causeChain,
    source: {
      type: audit.source,
      provenanceID: audit.provenance?.id,
      changedFiles: audit.changedFiles,
      snapshotRevision: audit.snapshot.revision,
      seedNodes: audit.seedNodes,
      changeFacts: audit.changeFacts,
    },
    createdAt: now,
    updatedAt: now,
  }
}

function upsertObligations(store: ObligationStore, audit: AuditMetadata, now: string) {
  let synced = 0
  let updated = 0
  const byID = new Map(store.obligations.map((item) => [item.id, item]))
  const touched = audit.obligations.map((candidate) => {
    const next = makeObligation(audit, candidate, now)
    const existing = byID.get(next.id)
    if (!existing) {
      synced++
      byID.set(next.id, next)
      return next
    }
    updated++
    const merged = {
      ...existing,
      target: next.target,
      targetNode: next.targetNode,
      reason: next.reason,
      risk: next.risk,
      classification: next.classification,
      requiredAction: next.requiredAction,
      evidence: next.evidence,
      causeChain: next.causeChain,
      source: next.source,
      updatedAt: now,
    }
    byID.set(next.id, merged)
    return merged
  })
  return {
    store: { schemaVersion: 1 as const, obligations: [...byID.values()] },
    touched,
    synced,
    updated,
  }
}

function refreshStaleObligations(
  store: ObligationStore,
  state: { graph: { node: (id: string) => CodeGraphNode | null | undefined } },
  now: string,
) {
  return {
    schemaVersion: 1 as const,
    obligations: store.obligations.map((item) => {
      const codegraphID = item.targetNode?.source.codegraphId
      if (!codegraphID || item.status === "resolved" || item.status === "ignored") return item
      if (state.graph.node(codegraphID)) return item
      return { ...item, status: "stale" as const, updatedAt: now }
    }),
  }
}

function activeObligations(obligations: PersistentObligation[]) {
  return obligations.filter((item) => item.status !== "resolved" && item.status !== "ignored")
}

function filterObligations(obligations: PersistentObligation[], params: ObligationsListParams) {
  return (params.status ? obligations.filter((item) => item.status === params.status) : activeObligations(obligations)).slice(
    0,
    bounded(params.limit, 30, 100),
  )
}

function obligationContext(ctx: Tool.Context, refresh: boolean) {
  return Effect.gen(function* () {
    const state = yield* openProjectGraphForTool(ctx, refresh)
    const artifact = obligationsArtifact(state.artifact)
    const now = new Date().toISOString()
    const store = yield* readObligationStore(state.projectRoot, artifact)
    const refreshed = refresh ? refreshStaleObligations(store, state, now) : store
    if (refresh) yield* writeObligationStore(state.projectRoot, artifact, refreshed)
    return { state, artifact, now, store, refreshed }
  })
}

function formatObligation(item: PersistentObligation) {
  return [
    `- ${item.id} [${item.status}] ${item.target}`,
    `  reason: ${item.reason}`,
    `  risk: ${item.risk}`,
    item.classification ? `  classification: ${item.classification}` : undefined,
    `  required_action: ${item.requiredAction}`,
    `  evidence: ${item.evidence}`,
    item.causeChain?.length ? `  cause_chain: ${formatCauseChain(item.causeChain)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function formatEvidence(item: AuditCandidate) {
  return [
    `- target: ${item.target}`,
    `  reason: ${item.reason}`,
    `  risk: ${item.risk}`,
    `  classification: ${item.classification}`,
    `  required_action: ${item.requiredAction}`,
    `  evidence: ${item.evidence}`,
    `  cause_chain: ${formatCauseChain(item.causeChain)}`,
  ].join("\n")
}

function formatProvenance(record: ContextOverlay["provenance"]) {
  if (!record) return ["Current provenance:", "- None recorded."].join("\n")
  return [
    "Current provenance:",
    `- ${record.id}`,
    `  tool: ${record.toolID}`,
    `  status: ${record.status}`,
    `  finished_at: ${record.finishedAt}`,
    `  revisions: ${record.beforeRevision} -> ${record.afterRevision}`,
    `  files: ${record.files.join(", ") || "none"}`,
  ].join("\n")
}

function formatContextOverlay(overlay: ContextOverlay) {
  return [
    "## Chimera Overlay",
    formatProvenance(overlay.provenance),
    "",
    "Selected impact:",
    `- Seed symbols: ${overlay.selectedImpact.seeds.length}`,
    `- File dependents: ${overlay.selectedImpact.fileDependents.length}`,
    `- Impacted symbols: ${overlay.selectedImpact.impacted.length}`,
    ...(overlay.selectedImpact.evidence.length ? overlay.selectedImpact.evidence.slice(0, 10).map(formatEvidence) : ["- None selected."]),
    "",
    "Future obligations:",
    `- Store: ${overlay.obligations.storePath ?? overlay.obligations.artifact}`,
    `- Fallback artifact: ${overlay.obligations.artifact}`,
    `- ${formatCounts(overlay.obligations.counts)}`,
    ...(overlay.obligations.active.length ? overlay.obligations.active.map(formatObligation) : ["- None active."]),
  ].join("\n")
}

function formatAuditOutput(audit: AuditMetadata) {
  return [
    "Chimera propagation audit (non-persistent first pass).",
    `Source: ${audit.source}`,
    `Graph revision: ${audit.snapshot.revision}`,
    "",
    `Changed files (${audit.changedFiles.length}):`,
    ...(audit.changedFiles.length ? audit.changedFiles.map((file) => `- ${file}`) : ["- None supplied or found."]),
    "",
    "Change classification:",
    ...(audit.classifications.length ? audit.classifications.map(formatClassification) : ["- No changed files to classify."]),
    "",
    `Change facts (${audit.changeFacts.length}):`,
    ...(audit.changeFacts.length ? audit.changeFacts.map(formatChangeFact) : ["- None generated."]),
    "",
    `Changed seed symbols (${audit.seedNodes.length}):`,
    ...(audit.seedNodes.length
      ? audit.seedNodes.map((node) =>
          node
            ? `- ${node.payload.qualifiedName || node.payload.name} (${node.payload.kind})\n  ${node.payload.filePath}:${node.payload.range.startLine}-${node.payload.range.endLine}${node.payload.signature ? `\n  ${node.payload.signature}` : ""}`
            : "- Unknown projected seed",
        )
      : ["- No symbol seeds; file-level audit only."]),
    "",
    "Static graph evidence:",
    `- File dependents: ${audit.fileDependents.length}`,
    `- Impacted symbols: ${audit.impactedNodes.length}`,
    "",
    "Behavior-boundary evidence:",
    ...(audit.obligations.length
      ? audit.obligations.map((item) => `- ${item.target}: ${item.classification} / ${item.risk}`)
      : ["- None found."]),
    "",
    `Candidate obligations (${audit.obligations.length}):`,
    ...(audit.obligations.length ? audit.obligations.map(formatEvidence) : ["- None found."]),
    "",
    "Required action:",
    "- Review or update each candidate obligation before claiming completion.",
    "- Run build/typecheck/test as oracle verification; this audit is structural graph evidence, not correctness proof.",
  ].join("\n")
}

function hasExplicitAuditSeed(params: AuditParams) {
  return Boolean(params.files?.length || params.filePath || params.symbol || params.nodeID)
}

const buildAudit = Effect.fn("ChimeraTool.buildAudit")(function* (params: BuildAuditParams, options: BuildAuditOptions = {}) {
  const instance = yield* InstanceState.context
  const state = options.state ?? (options.ctx ? yield* openProjectGraphForTool(options.ctx, params.refresh !== false) : yield* Chimera.openProjectGraph({ sync: params.refresh !== false }))
  const records = yield* provenanceRecords(state.projectRoot, state.artifact)
  const recent = latestSuccessfulProvenance(records)
  const explicitFiles = uniqueStrings([...(params.files ?? []), ...(params.filePath ? [params.filePath] : [])]).map((file) =>
    graphPath(state.projectRoot, instance.directory, file),
  )
  const recentFiles = params.recent === false || explicitFiles.length || params.symbol || params.nodeID ? [] : uniqueStrings(provenanceGraphFiles(recent))
  const gitFiles = params.recent === false || explicitFiles.length || params.symbol || params.nodeID || recentFiles.length ? [] : yield* gitStatusFiles(state.projectRoot)
  const changedFiles = explicitFiles.length ? explicitFiles : recentFiles.length ? recentFiles : gitFiles
  const source: AuditMetadata["source"] =
    explicitFiles.length || params.symbol || params.nodeID ? "input" : recentFiles.length ? "recent_provenance" : "git_diff"
  const depth = bounded(params.depth, 2, 5)
  const limit = bounded(params.limit, 30, 100)
  const snapshot = state.graph.snapshot()
  const storedChangeFacts = source === "recent_provenance" && recent ? yield* Effect.promise(() => readChangeFacts(state.projectRoot, [recent.id])) : []
  const ephemeralRecord = storedChangeFacts.length
    ? undefined
    : recent ?? syntheticAuditRecord({ projectRoot: state.projectRoot, directory: instance.directory, source, changedFiles, snapshot })
  const ephemeralAfterNodes = ephemeralRecord ? collectFileProjections(state.graph, ephemeralRecord.files, snapshot) : []
  const ephemeralAfterRelations = ephemeralRecord ? collectIncidentRelations(state.graph, ephemeralAfterNodes, snapshot) : []
  const changeFacts = storedChangeFacts.length
    ? storedChangeFacts
    : ephemeralRecord
      ? classifyChangeRecord({
          record: ephemeralRecord,
          afterNodes: ephemeralAfterNodes,
          afterRelations: ephemeralAfterRelations,
        })
      : []
  const kinds = params.kind ? [params.kind] : undefined
  const rangeFile = params.filePath ? graphPath(state.projectRoot, instance.directory, params.filePath) : undefined
  const fileSeedBudget = Math.max(1, Math.min(10, Math.floor(limit / Math.max(changedFiles.length, 1))))
  const fileSeedNodes = changedFiles.flatMap((file) =>
    params.range && file === rangeFile
      ? state.graph.nodesIntersectingRange(file, params.range, { kinds, smallestOnly: false })
      : state.graph
          .nodesInFile(file)
          .filter((node) => !params.kind || node.kind === params.kind)
          .slice(0, fileSeedBudget),
  )
  const seedNodes = uniqueNodes([
    ...(params.nodeID ? [state.graph.node(params.nodeID)].filter((node): node is CodeGraphNode => Boolean(node)) : []),
    ...(params.symbol ? state.graph.searchNodes(params.symbol, { kinds, limit: 5 }).map((result) => result.node) : []),
    ...fileSeedNodes,
  ])

  if (changedFiles.length === 0 && seedNodes.length === 0) {
    throw new Error("chimera_audit requires files/filePath, symbol/nodeID, a recent successful Chimera tool mutation, or git diff changes")
  }

  const impact = buildImpactEvidence({ state, snapshot, seedNodes, changedFiles, changeFacts, source, depth, limit })

  return {
    projectRoot: state.projectRoot,
    snapshot,
    source,
    changedFiles,
    classifications: changedFiles.map((file) => ({ file, ...classifyFile(file) })),
    changeFacts,
    seedNodes: seedNodes.map((node) => state.graph.projectNode(node, snapshot)),
    impactedNodes: impact.impactedNodes.map((node) => state.graph.projectNode(node, snapshot)),
    fileDependents: impact.fileDependents,
    obligations: impact.evidence,
    ...(source === "recent_provenance" && recent ? { provenance: recent } : {}),
  }
})

export const ChimeraStatusTool = Tool.define<typeof StatusParameters, StatusMetadata, never>(
  "chimera_status",
  Effect.succeed({
    description: STATUS_DESCRIPTION,
    parameters: StatusParameters,
    execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context<StatusMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_status", { refresh: params.refresh !== false })
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const snapshot = state.graph.snapshot()
        const stats = state.graph.stats()
        const provenanceRecords = yield* provenanceRecordCount(state.projectRoot, state.artifact)
        const obligations = yield* readObligationSummary(state.projectRoot, state.artifact, state.storePath, 0)

        return {
          title: "Chimera status",
          output: [
            "Chimera graph surface is ready.",
            `Project: ${state.projectRoot}`,
            `Files: ${snapshot.fileCount}`,
            `Nodes: ${snapshot.nodeCount}`,
            `Edges: ${snapshot.edgeCount}`,
            `Revision: ${snapshot.revision}`,
            `Indexed at: ${snapshot.indexedAt}`,
            `Backend: ${state.graph.backend()}`,
            `Journal mode: ${state.graph.journalMode()}`,
            `Chimera store: ${state.storePath}`,
            `Tool provenance records: ${provenanceRecords}`,
            `Pending obligations: ${obligations.counts.pending}`,
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            artifact: state.artifact,
            storePath: state.storePath,
            obligationsArtifact: obligations.artifact,
            snapshot,
            stats,
            backend: String(state.graph.backend()),
            journalMode: state.graph.journalMode(),
            provenanceRecords,
            obligationCounts: obligations.counts,
            pendingObligations: obligations.counts.pending,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraSearchTool = Tool.define<typeof SearchParameters, SearchMetadata, never>(
  "chimera_search",
  Effect.succeed({
    description: SEARCH_DESCRIPTION,
    parameters: SearchParameters,
    execute: (params: Schema.Schema.Type<typeof SearchParameters>, ctx: Tool.Context<SearchMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_search", {
          query: params.query,
          refresh: params.refresh !== false,
        })
        if (!params.query.trim()) throw new Error("chimera_search requires a non-empty query")
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const limit = bounded(params.limit, 10, 50)
        const snapshot = state.graph.snapshot()
        const kinds = params.kind ? [params.kind] : undefined
        const results = state.graph.searchNodes(params.query, { kinds, limit })

        return {
          title: "Chimera search",
          output: [
            `Static graph evidence (${results.length} result${results.length === 1 ? "" : "s"}):`,
            ...results.map((result) => formatNode(result.node)),
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            snapshot,
            results: results.map((result) => ({
              ...result,
              projection: state.graph.projectNode(result.node, snapshot),
            })),
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraFileSymbolsTool = Tool.define<typeof FileSymbolsParameters, SearchMetadata, never>(
  "chimera_file_symbols",
  Effect.succeed({
    description: FILE_SYMBOLS_DESCRIPTION,
    parameters: FileSymbolsParameters,
    execute: (params: Schema.Schema.Type<typeof FileSymbolsParameters>, ctx: Tool.Context<SearchMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_file_symbols", {
          filePath: params.filePath,
          refresh: params.refresh !== false,
        })
        const instance = yield* InstanceState.context
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const limit = bounded(params.limit, 10, 50)
        const snapshot = state.graph.snapshot()
        const kinds = params.kind ? [params.kind] : undefined
        const normalizedFile = graphPath(state.projectRoot, instance.directory, params.filePath)
        const results = (params.range
          ? state.graph.nodesIntersectingRange(normalizedFile, params.range, { kinds, smallestOnly: false })
          : state.graph.nodesInFile(normalizedFile).filter((node) => !params.kind || node.kind === params.kind)
        )
          .slice(0, limit)
          .map((node) => ({ node }))

        return {
          title: "Chimera file symbols",
          output: [
            `Static graph evidence (${results.length} result${results.length === 1 ? "" : "s"}):`,
            ...results.map((result) => formatNode(result.node)),
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            snapshot,
            results: results.map((result) => ({
              ...result,
              projection: state.graph.projectNode(result.node, snapshot),
            })),
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraImpactTool = Tool.define<typeof ImpactParameters, ImpactMetadata, never>(
  "chimera_impact",
  Effect.succeed({
    description: IMPACT_DESCRIPTION,
    parameters: ImpactParameters,
    execute: (params: Schema.Schema.Type<typeof ImpactParameters>, ctx: Tool.Context<ImpactMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_impact", {
          symbol: params.symbol,
          nodeID: params.nodeID,
          filePath: params.filePath,
          refresh: params.refresh !== false,
        })
        const instance = yield* InstanceState.context
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const depth = bounded(params.depth, 2, 5)
        const limit = bounded(params.limit, 20, 100)
        const snapshot = state.graph.snapshot()
        const normalizedFile = params.filePath ? graphPath(state.projectRoot, instance.directory, params.filePath) : undefined
        const kinds = params.kind ? [params.kind] : undefined
        const seedNodes = uniqueNodes(
          params.nodeID
            ? [state.graph.node(params.nodeID)].filter((node): node is CodeGraphNode => Boolean(node))
            : normalizedFile && params.range
              ? state.graph.nodesIntersectingRange(normalizedFile, params.range, { kinds, smallestOnly: false })
              : params.symbol
                ? state.graph.searchNodes(params.symbol, { kinds, limit: 5 }).map((result) => result.node)
                : normalizedFile
                  ? state.graph.nodesInFile(normalizedFile).filter((node) => !params.kind || node.kind === params.kind).slice(0, 5)
                  : [],
        )
        if (seedNodes.length === 0 && !normalizedFile) {
          throw new Error("chimera_impact requires nodeID, symbol, or filePath that resolves to at least one graph seed")
        }

        const impact = buildImpactEvidence({
          state,
          snapshot,
          seedNodes,
          changedFiles: normalizedFile ? [normalizedFile] : [],
          changeFacts: [],
          normalizedFile,
          source: "input",
          depth,
          limit,
        })

        return {
          title: "Chimera impact",
          output: [
            "Static graph evidence:",
            "",
            "Seed symbols:",
            ...(seedNodes.length ? seedNodes.map((node) => formatNode(node)) : ["- No symbol seeds; file-level impact only."]),
            "",
            "Change classification:",
            ...(normalizedFile ? [formatClassification({ file: normalizedFile, ...classifyFile(normalizedFile) })] : ["- No changed file supplied."]),
            "",
            `File dependents (${impact.fileDependents.length}):`,
            ...(impact.fileDependents.length ? impact.fileDependents.map((file) => `- ${file}`) : ["- None found."]),
            "",
            `Impacted symbols (${impact.impactedNodes.length}):`,
            ...(impact.impactedNodes.length
              ? impact.impactedNodes.map((node) => `${formatNode(node)}\n  risk: ${riskForNode(node)}\n  risk_reason: ${riskReasonForNode(node)}`)
              : ["- None found."]),
            "",
            "Impact evidence:",
            ...(impact.evidence.length ? impact.evidence.map(formatEvidence) : ["- None found."]),
            "",
            "Required action:",
            "- Review impacted symbols/files before claiming the change is complete. This is graph evidence, not test/build verification.",
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            snapshot,
            seeds: seedNodes.map((node) => state.graph.projectNode(node, snapshot)),
            impacted: impact.impactedNodes.map((node) => state.graph.projectNode(node, snapshot)),
            fileDependents: impact.fileDependents,
            evidence: impact.evidence,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraAuditTool = Tool.define<typeof AuditParameters, AuditMetadata, never>(
  "chimera_audit",
  Effect.succeed({
    description: AUDIT_DESCRIPTION,
    parameters: AuditParameters,
    execute: (params: Schema.Schema.Type<typeof AuditParameters>, ctx: Tool.Context<AuditMetadata>) =>
      Effect.gen(function* () {
        if (!hasExplicitAuditSeed(params)) {
          throw new Error("chimera_audit requires files/filePath, symbol, or nodeID. Use chimera_audit_recent after a tool mutation.")
        }
        yield* permission(ctx, "chimera_audit", {
          files: params.files,
          filePath: params.filePath,
          symbol: params.symbol,
          nodeID: params.nodeID,
          refresh: params.refresh !== false,
        })
        const audit = yield* buildAudit({ ...params, recent: false }, { ctx: ctx as Tool.Context })

        return {
          title: "Chimera audit",
          output: formatAuditOutput(audit),
          metadata: audit,
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraAuditRecentTool = Tool.define<typeof RecentAuditParameters, AuditMetadata, never>(
  "chimera_audit_recent",
  Effect.succeed({
    description: AUDIT_RECENT_DESCRIPTION,
    parameters: RecentAuditParameters,
    execute: (params: Schema.Schema.Type<typeof RecentAuditParameters>, ctx: Tool.Context<AuditMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_audit_recent", {
          refresh: params.refresh !== false,
        })
        const audit = yield* buildAudit(params, { ctx: ctx as Tool.Context })

        return {
          title: "Chimera audit",
          output: formatAuditOutput(audit),
          metadata: audit,
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraObligationsListTool = Tool.define<typeof ObligationsListParameters, ObligationsMetadata, never>(
  "chimera_obligations_list",
  Effect.succeed({
    description: OBLIGATIONS_LIST_DESCRIPTION,
    parameters: ObligationsListParameters,
    execute: (params: ObligationsListParams, ctx: Tool.Context<ObligationsMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_obligations_list", {
          status: params.status,
          refresh: params.refresh !== false,
        })
        const current = yield* obligationContext(ctx as Tool.Context, params.refresh !== false)
        const obligations = filterObligations(current.refreshed.obligations, params)
        const counts = obligationCounts(current.refreshed.obligations)
        return {
          title: "Chimera obligations",
          output: [
            "Chimera obligations.",
            `Store: ${current.state.storePath}`,
            `Fallback artifact: ${current.artifact}`,
            formatCounts(counts),
            "",
            `Obligations (${obligations.length}):`,
            ...(obligations.length ? obligations.map(formatObligation) : ["- None found."]),
            "",
            "Required action:",
            "- Active obligations should be reviewed, updated, resolved, or ignored with a reason before closeout.",
          ].join("\n"),
          metadata: {
            projectRoot: current.state.projectRoot,
            artifact: current.artifact,
            storePath: current.state.storePath,
            action: "list" as const,
            counts,
            obligations,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraObligationsSyncTool = Tool.define<typeof ObligationsSyncParameters, ObligationsMetadata, never>(
  "chimera_obligations_sync",
  Effect.succeed({
    description: OBLIGATIONS_SYNC_DESCRIPTION,
    parameters: ObligationsSyncParameters,
    execute: (params: ObligationsSyncParams, ctx: Tool.Context<ObligationsMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_obligations_sync", {
          files: params.files,
          filePath: params.filePath,
          symbol: params.symbol,
          nodeID: params.nodeID,
          refresh: params.refresh !== false,
        })
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const artifact = obligationsArtifact(state.artifact)
        const store = yield* readObligationStore(state.projectRoot, artifact)
        const audit = yield* buildAudit(params, { ctx: ctx as Tool.Context, state })
        const auditRunID = yield* Effect.promise(() =>
          recordAuditRun(state.projectRoot, {
            source: audit.source,
            provenanceID: audit.provenance?.id,
            changedFiles: audit.changedFiles,
            snapshotRevision: audit.snapshot.revision,
            seedNodes: audit.seedNodes,
            obligations: audit.obligations,
            payload: audit,
          }),
        )
        const result = upsertObligations(store, audit, new Date().toISOString())
        yield* writeObligationStore(state.projectRoot, artifact, result.store, auditRunID)
        const obligations = result.touched.slice(0, bounded(params.limit, 30, 100))
        const counts = obligationCounts(result.store.obligations)
        return {
          title: "Chimera obligations",
          output: [
            "Chimera obligations synced from propagation audit.",
            `Store: ${state.storePath}`,
            `Fallback artifact: ${artifact}`,
            `Synced: ${result.synced} new, ${result.updated} updated`,
            formatCounts(counts),
            "",
            `Obligations (${obligations.length}):`,
            ...(obligations.length ? obligations.map(formatObligation) : ["- None found."]),
            "",
            "Required action:",
            "- Claim, resolve, or ignore each active obligation as you review the propagation surface.",
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            artifact,
            storePath: state.storePath,
            action: "sync" as const,
            counts,
            obligations,
            synced: result.synced,
            updated: result.updated,
            audit,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraObligationClaimTool = Tool.define<typeof ObligationClaimParameters, ObligationsMetadata, never>(
  "chimera_obligation_claim",
  Effect.succeed({
    description: OBLIGATION_CLAIM_DESCRIPTION,
    parameters: ObligationClaimParameters,
    execute: (params: ObligationClaimParams, ctx: Tool.Context<ObligationsMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_obligation_claim", { obligationID: params.obligationID })
        const current = yield* obligationContext(ctx as Tool.Context, true)
        const next = {
          schemaVersion: 1 as const,
          obligations: current.refreshed.obligations.map((item) =>
            item.id === params.obligationID
              ? { ...item, status: "claimed" as const, claimedBy: actor(ctx, current.now), updatedAt: current.now }
              : item,
          ),
        }
        if (!current.refreshed.obligations.some((item) => item.id === params.obligationID)) {
          throw new Error(`unknown Chimera obligation: ${params.obligationID}`)
        }
        yield* writeObligationStore(current.state.projectRoot, current.artifact, next)
        const obligations = next.obligations.filter((item) => item.id === params.obligationID)
        return {
          title: "Chimera obligations",
          output: ["Chimera obligation claimed.", `Artifact: ${current.artifact}`, "", ...obligations.map(formatObligation)].join("\n"),
          metadata: {
            projectRoot: current.state.projectRoot,
            artifact: current.artifact,
            storePath: current.state.storePath,
            action: "claim" as const,
            counts: obligationCounts(next.obligations),
            obligations,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraObligationResolveTool = Tool.define<typeof ObligationResolveParameters, ObligationsMetadata, never>(
  "chimera_obligation_resolve",
  Effect.succeed({
    description: OBLIGATION_RESOLVE_DESCRIPTION,
    parameters: ObligationResolveParameters,
    execute: (params: ObligationResolveParams, ctx: Tool.Context<ObligationsMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_obligation_resolve", { obligationID: params.obligationID })
        const current = yield* obligationContext(ctx as Tool.Context, true)
        const next = {
          schemaVersion: 1 as const,
          obligations: current.refreshed.obligations.map((item) =>
            item.id === params.obligationID
              ? {
                  ...item,
                  status: "resolved" as const,
                  resolvedBy: { ...actor(ctx, current.now), note: params.note },
                  updatedAt: current.now,
                }
              : item,
          ),
        }
        if (!current.refreshed.obligations.some((item) => item.id === params.obligationID)) {
          throw new Error(`unknown Chimera obligation: ${params.obligationID}`)
        }
        yield* writeObligationStore(current.state.projectRoot, current.artifact, next)
        const obligations = next.obligations.filter((item) => item.id === params.obligationID)
        return {
          title: "Chimera obligations",
          output: ["Chimera obligation resolved.", `Artifact: ${current.artifact}`, "", ...obligations.map(formatObligation)].join("\n"),
          metadata: {
            projectRoot: current.state.projectRoot,
            artifact: current.artifact,
            storePath: current.state.storePath,
            action: "resolve" as const,
            counts: obligationCounts(next.obligations),
            obligations,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraObligationIgnoreTool = Tool.define<typeof ObligationIgnoreParameters, ObligationsMetadata, never>(
  "chimera_obligation_ignore",
  Effect.succeed({
    description: OBLIGATION_IGNORE_DESCRIPTION,
    parameters: ObligationIgnoreParameters,
    execute: (params: ObligationIgnoreParams, ctx: Tool.Context<ObligationsMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_obligation_ignore", { obligationID: params.obligationID })
        const current = yield* obligationContext(ctx as Tool.Context, true)
        const next = {
          schemaVersion: 1 as const,
          obligations: current.refreshed.obligations.map((item) =>
            item.id === params.obligationID
              ? {
                  ...item,
                  status: "ignored" as const,
                  ignoredBy: { ...actor(ctx, current.now), reason: params.reason, note: params.note },
                  updatedAt: current.now,
                }
              : item,
          ),
        }
        if (!current.refreshed.obligations.some((item) => item.id === params.obligationID)) {
          throw new Error(`unknown Chimera obligation: ${params.obligationID}`)
        }
        yield* writeObligationStore(current.state.projectRoot, current.artifact, next)
        const obligations = next.obligations.filter((item) => item.id === params.obligationID)
        return {
          title: "Chimera obligations",
          output: ["Chimera obligation ignored.", `Artifact: ${current.artifact}`, "", ...obligations.map(formatObligation)].join("\n"),
          metadata: {
            projectRoot: current.state.projectRoot,
            artifact: current.artifact,
            storePath: current.state.storePath,
            action: "ignore" as const,
            counts: obligationCounts(next.obligations),
            obligations,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraContextTool = Tool.define<typeof ContextParameters, ContextMetadata, never>(
  "chimera_context",
  Effect.succeed({
    description: CONTEXT_DESCRIPTION,
    parameters: ContextParameters,
    execute: (params: Schema.Schema.Type<typeof ContextParameters>, ctx: Tool.Context<ContextMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_context", {
          query: params.query,
          symbol: params.symbol,
          nodeID: params.nodeID,
          filePath: params.filePath,
          mode: params.mode ?? "search",
          refresh: params.refresh !== false,
        })
        const instance = yield* InstanceState.context
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const mode: ContextMetadata["mode"] = params.mode ?? "search"
        const node = params.nodeID ? state.graph.node(params.nodeID) : undefined
        const normalizedFile = params.filePath ? graphPath(state.projectRoot, instance.directory, params.filePath) : undefined
        const query =
          params.query ??
          params.symbol ??
          node?.qualifiedName ??
          normalizedFile ??
          (mode === "arch" ? "architecture overview main modules project structure" : undefined)

        if (!query) throw new Error("chimera_context requires query, symbol, nodeID, filePath, or mode=arch")

        const snapshot = state.graph.snapshot()
        const context = yield* Effect.promise(() =>
          state.graph.buildContext(query, {
            format: "markdown",
            includeCode: params.includeCode ?? true,
            maxNodes: bounded(params.maxNodes, 30, 100),
            maxCodeBlocks: bounded(params.maxCodeBlocks, 8, 30),
          }),
        ).pipe(Effect.orDie)
        const records = yield* provenanceRecords(state.projectRoot, state.artifact)
        const recent = latestSuccessfulProvenance(records)
        const overlaySeeds = uniqueNodes([
          ...(node ? [node] : []),
          ...(params.symbol ? state.graph.searchNodes(params.symbol, { limit: 5 }).map((result) => result.node) : []),
          ...(normalizedFile ? state.graph.nodesInFile(normalizedFile).slice(0, 5) : []),
          ...(!node && !params.symbol && !normalizedFile ? state.graph.searchNodes(query, { limit: 5 }).map((result) => result.node) : []),
        ]).slice(0, 5)
        const selectedImpact = buildImpactEvidence({
          state,
          snapshot,
          seedNodes: overlaySeeds,
          changedFiles: normalizedFile ? [normalizedFile] : [],
          changeFacts: [],
          normalizedFile,
          source: "context_selection",
          depth: 2,
          limit: bounded(params.maxNodes, 30, 100),
        })
        const obligations = yield* readObligationSummary(state.projectRoot, state.artifact, state.storePath, 10)
        const overlay: ContextOverlay = {
          ...(recent
            ? {
                provenance: {
                  id: recent.id,
                  toolID: recent.tool.id,
                  status: recent.status,
                  finishedAt: recent.finishedAt,
                  beforeRevision: recent.graph.before.revision,
                  afterRevision: recent.graph.after.revision,
                  files: recent.files.map((file) => file.graphPath ?? file.absolutePath),
                },
              }
            : {}),
          selectedImpact: {
            seeds: overlaySeeds.map((item) => state.graph.projectNode(item, snapshot)),
            impacted: selectedImpact.impactedNodes.map((item) => state.graph.projectNode(item, snapshot)),
            fileDependents: selectedImpact.fileDependents,
            evidence: selectedImpact.evidence,
          },
          obligations,
        }

        return {
          title: "Chimera context",
          output: [
            `Chimera context mode: ${mode}`,
            `Query: ${query}`,
            `Graph revision: ${snapshot.revision}`,
            "",
            formatContextOverlay(overlay),
            "",
            typeof context === "string" ? context : JSON.stringify(context, null, 2),
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            snapshot,
            mode,
            query,
            overlay,
          },
        }
      }).pipe(Effect.orDie),
  }),
)
