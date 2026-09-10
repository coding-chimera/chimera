import path from "path"
import { createHash } from "crypto"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"
import {
  Chimera,
  classifyChangeRecord,
  classifyFileBoundary,
  collectFileProjections,
  collectIncidentRelations,
  type ChangeFact,
  type FileClassification,
  type ProjectGraphState,
  type ToolMutationRecord,
} from "@/chimera"
import {
  CodeGraph,
  getGraphDataRootInfo,
  GraphSchemaMigrationRequiredError,
  readIndexJob,
  NODE_KINDS,
  type CodeGraphSnapshot,
  type CodePlanAtomicLabel,
  type CodePlanRelationGraphLabel,
  type CodePlanRelationKind,
  type CodePlanStatementEffectKind,
  type FrozenCodePlanRelation,
  type FrozenRelation,
  type FrozenSemanticObject,
  type IndexProgress as CodeGraphIndexProgress,
  type Node as CodeGraphNode,
  type RelationEvidence as CodeGraphRelation,
  type RelationKind,
} from "@/graph"
import { ProjectionMemo } from "@/chimera/projection-memo"
import { deriveImpactLabels, type ImpactLabelResult } from "@/chimera/impact-label"
import { dispatchMayImpactRule, mayImpactRuleEvidence, type MayImpactRule } from "@/chimera/may-impact-rules"
import {
  provenanceRecordCount as storedProvenanceRecordCount,
  provenanceRecordCountReadOnly as storedProvenanceRecordCountReadOnly,
  readChangeFacts,
  recordPredesignRun,
  readProvenanceRecords,
  readOracleResult,
  readOracleResults,
  readPersistentObligationStore,
  readPersistentObligationStoreReadOnly,
  recordAuditRun,
  writePersistentObligationStore,
  type OracleRecord,
} from "@/chimera/store"
import { DiscoveryNudge } from "@/chimera/discovery-nudge"
import * as Tool from "./tool"
import INIT_GRAPH_DESCRIPTION from "./chimera_init_graph.txt"
import STATUS_DESCRIPTION from "./chimera_status.txt"
import SEARCH_DESCRIPTION from "./chimera_search.txt"
import FILE_SYMBOLS_DESCRIPTION from "./chimera_file_symbols.txt"
import PREDESIGN_DESCRIPTION from "./chimera_predesign.txt"
import IMPACT_DESCRIPTION from "./chimera_impact.txt"
import CONTEXT_DESCRIPTION from "./chimera_context.txt"
import AUDIT_RECENT_DESCRIPTION from "./chimera_audit_recent.txt"
import AUDIT_DESCRIPTION from "./chimera_audit.txt"
import ORACLE_RECENT_DESCRIPTION from "./chimera_oracle_recent.txt"
import ORACLE_GET_DESCRIPTION from "./chimera_oracle_get.txt"
import OBLIGATIONS_LIST_DESCRIPTION from "./chimera_obligations_list.txt"
import OBLIGATIONS_SYNC_DESCRIPTION from "./chimera_obligations_sync.txt"
import OBLIGATION_CLAIM_DESCRIPTION from "./chimera_obligation_claim.txt"
import OBLIGATION_RESOLVE_DESCRIPTION from "./chimera_obligation_resolve.txt"
import OBLIGATION_IGNORE_DESCRIPTION from "./chimera_obligation_ignore.txt"

const log = Log.create({ service: "chimera.tool" })
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
  "Refresh CodeGraph when stale (empty index, pending watcher files, or dirty git sources). Defaults to true."
const ChimeraRefDescription =
  "Typed Chimera ref from a previous tool output, formatted like `node:<id>`, `audit:<id>`, `predesign:<id>`, `oracle:<id>`, `obligation:<id>`, or `change:<id>`."
const ChimeraRefsDescription =
  "Typed Chimera refs from previous tool outputs; currently `node:<id>` refs are accepted here."
export const InitGraphParameters = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const StatusParameters = Schema.Struct({
  projectPath: Schema.optional(Schema.String).annotate({
    description: "Optional path to another initialized Chimera project (or a subdirectory of it) for read-only cross-project queries."
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const SearchParameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Symbol or CodeGraph-indexed text query."
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional CodeGraph node kind filter.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum results to return. Defaults to 10, capped at 50.",
  }),
  projectPath: Schema.optional(Schema.String).annotate({
    description: "Optional path to another initialized Chimera project (or a subdirectory of it) for read-only cross-project queries."
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
  projectPath: Schema.optional(Schema.String).annotate({
    description: "Optional path to another initialized Chimera project (or a subdirectory of it) for read-only cross-project queries."
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const PredesignParameters = Schema.Struct({
  intent: Schema.String.annotate({
    description: "Brief statement of the intended mutation and why it is needed.",
  }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Known or likely files that the upcoming mutation will touch.",
  }),
  symbols: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Known relevant symbols to resolve as pre-edit graph seeds.",
  }),
  refs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: ChimeraRefsDescription,
  }),
  nodeIDs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Legacy exact CodeGraph node ids to use as pre-edit graph seeds."
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Graph traversal depth for pre-edit impact discovery. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum seeds, impacted symbols, and evidence items to return. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Record pre-edit Chimera evidence before a risky mutation.",
})

export const ImpactParameters = Schema.Struct({
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to analyze. Used when ref/nodeID is not supplied.",
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Legacy exact CodeGraph node id to analyze."
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
  projectPath: Schema.optional(Schema.String).annotate({
    description: "Optional path to another initialized Chimera project (or a subdirectory of it) for read-only cross-project queries."
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide at least one impact seed: ref, nodeID, symbol, or filePath."
})

export const ContextParameters = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description: "Natural-language or symbol/file query for context.",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to use as the context query when query is omitted.",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Legacy exact CodeGraph node id to use as context focus when query and symbol are omitted."
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "File path to use as the context query when query, symbol, and ref/nodeID are omitted.",
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
  description: "Provide query, symbol, ref, nodeID, filePath, or mode=arch.",
})

export const RecentAuditParameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum propagation findings to return. Defaults to 10, capped at 100."
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
})

export const OracleRecentParameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum oracle records to return. Defaults to 20, capped at 100.",
  }),
  includePassing: Schema.optional(Schema.Boolean).annotate({
    description: "Include passing oracle records. Defaults to false, which returns failing and unknown records.",
  }),
})

export const OracleGetParameters = Schema.Struct({
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  oracleID: Schema.optional(Schema.String).annotate({
    description: "Legacy oracle record id to retrieve."
  }),
  maxOutputChars: Schema.optional(Schema.Number).annotate({
    description: "Maximum shell output characters to include in structured output. Defaults to 20000, capped at 200000.",
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
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Legacy exact CodeGraph node id to use as an audit seed."
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional node kind filter when resolving audit seed symbols.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Impact traversal depth. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum propagation findings to return. Defaults to 10, capped at 100."
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide at least one explicit audit seed: files, filePath, symbol, ref, or nodeID."
})

export const ObligationsListParameters = Schema.Struct({
  status: Schema.optional(ObligationStatus).annotate({
    description: "Optional status filter for list.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum obligations to list. Defaults to 20, capped at 100."
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
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  nodeID: Schema.optional(Schema.String).annotate({
    description: "Legacy exact CodeGraph node id to audit and sync into obligations."
  }),
  kind: Schema.optional(NodeKind).annotate({
    description: "Optional CodeGraph node kind filter when resolving sync seed symbols.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Impact traversal depth for sync. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum obligations to list or sync. Defaults to 20, capped at 100."
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: RefreshDescription,
  }),
}).annotate({
  description: "Provide explicit sync seeds or omit them to sync from recent mutation or git diff fallback.",
})

export const ObligationClaimParameters = Schema.Struct({
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  obligationID: Schema.optional(Schema.String).annotate({
    description: "Legacy obligation id to claim."
  }),
})

export const ObligationResolveParameters = Schema.Struct({
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  obligationID: Schema.optional(Schema.String).annotate({
    description: "Legacy obligation id to resolve."
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Optional short note stating the evidence or update that resolved the obligation.",
  }),
})

export const ObligationIgnoreParameters = Schema.Struct({
  ref: Schema.optional(Schema.String).annotate({
    description: ChimeraRefDescription,
  }),
  obligationID: Schema.optional(Schema.String).annotate({
    description: "Legacy obligation id to ignore."
  }),
  reason: Schema.String.annotate({
    description: "Required reason for ignoring the obligation.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Optional additional context.",
  }),
})

type InitGraphMetadata = {
  projectRoot: string
  initialized: boolean
  dataRoot: string
  dataRootStatus: string
  revision: string
  fileCount: number
  nodeCount: number
  edgeCount: number
}

type StatusMetadata = {
  projectRoot: string
  crossProject?: boolean
  artifact: string
  storePath: string
  obligationsArtifact: string
  initialized?: boolean
  needsMigration?: boolean
  schemaVersion?: number
  requiredVersion?: number
  dataRoot?: string
  dataRootStatus?: string
  jobStatus?: unknown
  snapshot?: CodeGraphSnapshot
  stats?: unknown
  backend?: string
  journalMode?: string
  missingFiles?: number
  provenanceRecords: number
  obligationCounts: ObligationCounts
  pendingObligations: number
}

type SearchMetadata = {
  projectRoot: string
  crossProject?: boolean
  initialized?: boolean
  needsMigration?: boolean
  schemaVersion?: number
  requiredVersion?: number
  dataRoot?: string
  dataRootStatus?: string
  jobStatus?: unknown
  snapshot?: CodeGraphSnapshot
  results: Array<{ score?: number; node: CodeGraphNode; projection: FrozenSemanticObject | null }>
}

type PredesignStageMetadata = {
  stage: string
  status: "running" | "complete" | "error"
  startedAt: string
  elapsedMs: number
  timeoutMs: number
  error?: string
}

type PredesignMetadata = {
  projectRoot: string
  snapshot: CodeGraphSnapshot
  runID: string
  ref: string
  intent: string
  files: string[]
  seeds: Array<FrozenSemanticObject | null>
  impacted: Array<FrozenSemanticObject | null>
  fileDependents: string[]
  evidence: AuditCandidate[]
  coverage: {
    files: number
    symbols: number
    nodeIDs: number
    preciseFiles: boolean
  }
  chimeraPredesignStage?: PredesignStageMetadata
}

type ImpactMetadata = {
  projectRoot: string
  crossProject?: boolean
  needsMigration?: boolean
  schemaVersion?: number
  requiredVersion?: number
  snapshot?: CodeGraphSnapshot
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
    | "relation_clause"
    | "before_relation"
    | "after_relation"
    | "added_relation"
    | "removed_relation"
    | "impact_radius"
    | "impact_label"
    | "may_impact_rule"
    | "self_review"
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
  evidence: string
  causeChain: CauseLink[]
  atomicLabel?: CodePlanAtomicLabel
  statementEffect?: CodePlanStatementEffectKind
  relationClause?: string
  impactedBlock?: string
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
  auditRunID?: string
  ref?: string
}

type OracleMetadata = {
  projectRoot: string
  artifact: string
  action: "recent" | "get"
  oracles: OracleRecord[]
  oracle?: OracleRecord
}

type ObligationStatusValue = "pending" | "claimed" | "resolved" | "ignored" | "stale"

type ObligationActor = {
  sessionID: string
  messageID: string
  callID?: string
  agent: string
  at: string
}

type ObligationReplayLifecycle = {
  version: 1
  status: "current" | "replayable" | "missing_target" | "stale_revision"
  reason: string
  sourceRevision?: string
  currentRevision?: string
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
  evidence: string
  causeChain?: CauseLink[]
  atomicLabel?: CodePlanAtomicLabel
  statementEffect?: CodePlanStatementEffectKind
  relationClause?: string
  impactedBlock?: string
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
  staleReason?: string
  replayLifecycle?: ObligationReplayLifecycle
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
const PREDESIGN_OUTPUT_PREVIEW_LIMIT = 12
const PREDESIGN_TEXT_PREVIEW_CHARS = 240

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

function openProjectGraphForTool(ctx: Tool.Context, refresh: boolean, options: { init?: boolean; readOnly?: boolean; projectPath?: string } = {}) {
  const reporter = createSyncProgressReporter(ctx, refresh && !options.readOnly && !options.projectPath)
  return Chimera.openProjectGraph({
    init: options.init ?? false,
    readOnly: options.readOnly,
    sync: refresh && !options.readOnly,
    watch: false,
    onProgress: reporter.onProgress,
    projectPath: options.projectPath,
  }).pipe(
    Effect.ensuring(Effect.sync(() => reporter.done())),
  )
}

function withProjectGraphForTool<A, E, R>(
  ctx: Tool.Context,
  refresh: boolean,
  options: { init?: boolean; readOnly?: boolean; projectPath?: string },
  use: (state: ProjectGraphState) => Effect.Effect<A, E, R>,
) {
  const reporter = createSyncProgressReporter(ctx, refresh && !options.readOnly && !options.projectPath)
  return Chimera.withProjectGraph(
    {
      init: options.init ?? false,
      readOnly: options.readOnly,
      sync: refresh && !options.readOnly,
      watch: false,
      onProgress: reporter.onProgress,
      projectPath: options.projectPath,
    },
    use,
  ).pipe(
    Effect.ensuring(Effect.sync(() => reporter.done())),
  )
}

function schemaMigrationGuidance(crossProject: boolean) {
  return crossProject
    ? "Ask the user to run `chimera graph index` in that project to migrate the graph database; do not migrate another project's graph from this session."
    : "Run `chimera graph index` in this project to migrate the graph database."
}

function schemaMigrationStatusLine(error: GraphSchemaMigrationRequiredError) {
  return `Chimera graph database schema version ${error.currentVersion} is outdated (requires ${error.requiredVersion}); the read-only graph surface cannot migrate it.`
}

function catchSchemaMigrationRequired<A, E, R, B>(
  effect: Effect.Effect<A, E, R>,
  fallback: (error: GraphSchemaMigrationRequiredError) => B,
): Effect.Effect<A | B, E, R> {
  return effect.pipe(
    Effect.catchDefect((defect) =>
      defect instanceof GraphSchemaMigrationRequiredError ? Effect.succeed(fallback(defect)) : Effect.die(defect),
    ),
  )
}

function contextProjectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

const PREDESIGN_STAGE_TIMEOUT_MS = 120_000
const PREDESIGN_PERMISSION_TIMEOUT_MS = 300_000

function predesignStage<A, E, R>(
  ctx: Tool.Context<PredesignMetadata>,
  stage: string,
  effect: Effect.Effect<A, E, R>,
  timeoutMs = PREDESIGN_STAGE_TIMEOUT_MS,
) {
  return Effect.gen(function* () {
    const started = Date.now()
    const startedAt = new Date(started).toISOString()
    const metadata = (status: PredesignStageMetadata["status"], error?: string): PredesignStageMetadata => ({
      stage,
      status,
      startedAt,
      elapsedMs: Date.now() - started,
      timeoutMs,
      ...(error ? { error } : {}),
    })
    const emit = (status: PredesignStageMetadata["status"], error?: string) =>
      ctx
        .metadata({
          title: `Chimera pre-design: ${stage} ${status}`,
          metadata: { chimeraPredesignStage: metadata(status, error) } as PredesignMetadata,
        })
        .pipe(Effect.ignore)

    log.info("predesign stage start", { stage, sessionID: ctx.sessionID, callID: ctx.callID, timeoutMs })
    yield* emit("running")
    const exit = yield* effect.pipe(
      Effect.raceFirst(
        Effect.sleep(timeoutMs).pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error(`chimera_predesign timed out during ${stage} after ${timeoutMs}ms`)),
          ),
        ),
      ),
      Effect.exit,
    )
    if (Exit.isSuccess(exit)) {
      log.info("predesign stage complete", {
        stage,
        sessionID: ctx.sessionID,
        callID: ctx.callID,
        elapsedMs: Date.now() - started,
      })
      yield* emit("complete")
      return exit.value
    }
    const error = Cause.squash(exit.cause)
    const message = error instanceof Error ? error.message : String(error)
    log.error("predesign stage failed", {
      stage,
      sessionID: ctx.sessionID,
      callID: ctx.callID,
      elapsedMs: Date.now() - started,
      error: message,
    })
    yield* emit("error", message)
    return yield* Effect.failCause(exit.cause)
  })
}

function bounded(value: number | undefined, fallback: number, max: number) {
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)))
}

function graphPath(root: string, base: string, filePath: string) {
  return graphFile(root, base, filePath).graphPath
}

type GraphFileSeed = {
  absolutePath: string
  graphPath: string
  insideGraph: boolean
}

function graphFile(root: string, base: string, filePath: string): GraphFileSeed {
  const absolute = path.resolve(base, filePath)
  const relative = path.relative(root, absolute).replaceAll("\\", "/")
  const insideGraph = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  return {
    absolutePath: absolute,
    graphPath: insideGraph ? relative : absolute.replaceAll("\\", "/"),
    insideGraph,
  }
}

function uniqueGraphFiles(files: GraphFileSeed[]) {
  return [...new Map(files.map((file) => [file.graphPath, file])).values()]
}

async function existingGraphFiles(files: GraphFileSeed[]) {
  const checked = await Promise.all(
    uniqueGraphFiles(files)
      .filter((file) => file.insideGraph)
      .map(async (file) => ({ file, exists: await Bun.file(file.absolutePath).exists() })),
  )
  return checked.flatMap((item) => (item.exists ? [item.file] : []))
}

async function syncExistingGraphFiles(state: ProjectGraphState, files: GraphFileSeed[], mode: "force" | "missing" = "force") {
  const existing = await existingGraphFiles(files)
  const indexed = mode === "force"
    ? existing
    : existing.filter((file) => {
        const hasFileRecord = state.graph.files().some((record) => record.path === file.graphPath)
        return !hasFileRecord || state.graph.nodesInFile(file.graphPath).length === 0
      })
  if (indexed.length > 0) await state.graph.syncFiles(indexed.map((file) => file.absolutePath))
  return indexed.map((file) => file.graphPath)
}

function graphFilesFromPaths(root: string, base: string, files: string[]) {
  return uniqueGraphFiles(files.map((file) => graphFile(root, base, file)))
}

function formatNode(node: CodeGraphNode) {
  return [
    `- ${node.qualifiedName || node.name} (${node.kind})`,
    `  Ref: ${chimeraRef("node", node.id)}`,
    `  ${node.filePath}:${node.startLine}-${node.endLine}`,
    node.signature ? `  ${node.signature}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function compactText(text: string, limit = PREDESIGN_TEXT_PREVIEW_CHARS) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`
}

function inlinePreview(items: string[]) {
  if (!items.length) return "none"
  return [
    items.slice(0, PREDESIGN_OUTPUT_PREVIEW_LIMIT).join(", "),
    items.length > PREDESIGN_OUTPUT_PREVIEW_LIMIT
      ? `... ${items.length - PREDESIGN_OUTPUT_PREVIEW_LIMIT} more`
      : undefined,
  ]
    .filter(Boolean)
    .join(", ")
}

function previewList<T>(items: T[], empty: string, label: string, format: (item: T) => string) {
  const shown = items.slice(0, PREDESIGN_OUTPUT_PREVIEW_LIMIT).map(format)
  if (items.length > PREDESIGN_OUTPUT_PREVIEW_LIMIT) {
    shown.push(
      `- ... ${items.length - PREDESIGN_OUTPUT_PREVIEW_LIMIT} more ${label} omitted from pre-design output; full data remains in metadata and the recorded run.`,
    )
  }
  return shown.length ? shown : [empty]
}

function formatNodePreview(node: CodeGraphNode) {
  return `- ${node.qualifiedName || node.name} (${node.kind}) ${node.filePath}:${node.startLine}-${node.endLine}\n  Ref: ${chimeraRef("node", node.id)}`
}

// -- search / file-symbols output enrichment (definition excerpts + Tests hints + Refs) --
//
// Both `chimera_search` and `chimera_file_symbols` append, in the formatting layer only:
//   1. a <=3-line source excerpt for the first 5 symbol-kind hits whose file is on disk,
//   2. a `Tests: <path>` line (up to 2 paths) at the tail of each host file's last hit block,
//      probing companion test files via the graph's file records first and a bounded fs fallback, and
//   3. (search only) a `Refs(<N>):` block for the top 3 definition hits listing cross-file
//      call/reference sites with trimmed source lines.
// Total bytes added by these features is capped at SEARCH_ENRICH_BUDGET_BYTES per response.

const SYMBOL_EXCERPT_KINDS: ReadonlySet<CodeGraphNode["kind"]> = new Set([
  "class",
  "component",
  "constant",
  "enum",
  "field",
  "function",
  "interface",
  "method",
  "property",
  "protocol",
  "struct",
  "trait",
  "type_alias",
  "variable",
])

const SEARCH_ENRICH_BUDGET_BYTES = 4096
const SEARCH_EXCERPT_HITS = 5
const SEARCH_TESTS_PER_FILE = 2
// Refs block bounds (search only).
const SEARCH_REFS_HITS = 3
const SEARCH_REFS_MAX = 5
const SEARCH_REFS_FILE_LEVEL_MAX = 3
const SEARCH_REFS_SOURCE_CHARS = 100
const SEARCH_REFS_TIMEOUT_MS = 300

/** Incoming relations that make a search hit worth a Refs block (same set impact's callers chain uses). */
const DependentRelations: RelationKind[] = [
  "CalledBy",
  "ImportedBy",
  "UsedBy",
  "InstantiatedBy",
  "BaseClassOf",
  "OverriddenBy",
  "DecoratedBy",
]

/** Companion-test marker in a graph path: `__tests__/` dir segment or `.test.`/`.spec.` suffix. */
const TEST_PATH = /__tests__|\.(test|spec)\./i

function utf8ByteLength(text: string) {
  return new TextEncoder().encode(text).length
}

function sourceStem(sourcePath: string) {
  return path.posix.basename(sourcePath, path.posix.extname(sourcePath))
}

/** Closeness of a companion-test candidate to its host file; lower is better. */
function companionTestScore(host: string, candidate: string) {
  const dir = path.posix.dirname(host)
  const stem = sourceStem(host)
  const ext = path.posix.extname(host)
  const sameDir = candidate.startsWith(`${dir}/__tests__/`)
    ? 0
    : candidate.startsWith(`${dir}/`)
      ? 1
      : candidate.startsWith("test/")
        ? 2
        : 4
  const extMatch = candidate.includes(`${stem}.test${ext}`)
    ? 1
    : candidate.includes(`${stem}.spec${ext}`)
      ? 2
      : 4
  return Math.min(sameDir, extMatch)
}

/** Graph-backed companion test lookup: indexed files containing the host stem that look testish. */
function companionTestsFromGraph(hostFiles: string[], graphFiles: string[]) {
  const found = new Map(hostFiles.map((file) => [file, [] as string[]]))
  for (const candidate of graphFiles) {
    if (!TEST_PATH.test(candidate)) continue
    for (const host of hostFiles) {
      const list = found.get(host) ?? []
      if (list.length >= SEARCH_TESTS_PER_FILE || candidate === host || !candidate.includes(sourceStem(host))) continue
      list.push(candidate)
    }
  }
  for (const [host, list] of found) {
    list.sort((a, b) => companionTestScore(host, a) - companionTestScore(host, b) || a.localeCompare(b))
  }
  return found
}

/** Bounded fs fallback (at most 6 candidates) mirroring common test-file conventions. */
function companionTestFileCandidates(sourcePath: string) {
  const ext = path.posix.extname(sourcePath)
  const stem = sourceStem(sourcePath)
  const dir = path.posix.dirname(sourcePath)
  return [
    path.posix.join(dir, "__tests__", `${stem}.test${ext}`),
    path.posix.join(dir, `${stem}.test${ext}`),
    path.posix.join(dir, "__tests__", `${stem}${ext}`),
    path.posix.join("test", path.posix.basename(dir), `${stem}.test${ext}`),
    path.posix.join("test", dir, `${stem}.test${ext}`),
    `${stem}.test${ext}`,
  ]
}

async function companionTestsOnDisk(root: string, sourcePath: string) {
  const found: string[] = []
  for (const candidate of companionTestFileCandidates(sourcePath)) {
    if (found.length >= SEARCH_TESTS_PER_FILE) break
    const exists = await Bun.file(path.join(root, candidate)).exists().catch(() => false)
    if (exists) found.push(candidate)
  }
  return found
}

/** <=3 trimmed source lines from the node's definition start; silently skipped when unavailable. */
async function definitionExcerpt(node: CodeGraphNode, root: string) {
  if (!SYMBOL_EXCERPT_KINDS.has(node.kind) || node.startLine <= 0) return undefined
  const file = Bun.file(path.join(root, node.filePath))
  const exists = await file.exists().catch(() => false)
  if (!exists) return undefined
  const text = await file.text().catch(() => undefined)
  if (text === undefined) return undefined
  const lines = text.split("\n")
  if (node.startLine > lines.length) return undefined
  return lines
    .slice(node.startLine - 1, node.startLine + 2)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => `  ${line.slice(0, 120)}`)
}

export interface EnrichQueryOptions {
  /** Append `Refs(<N>):` caller/reference-site blocks for the top definition hits (chimera_search only). */
  refs?: boolean
  /** Per-response enrichment byte cap override (test seam); defaults to SEARCH_ENRICH_BUDGET_BYTES. */
  budgetBytes?: number
}

interface RefSite {
  path: string
  line: number
  fileLevel: boolean
  source?: string
}

/** One rendered Refs line plus the state needed to drop its source text when over budget. */
interface RenderedRefsLine {
  line: string
  bare: string
  sourceBytes: number
}

/** Incoming caller/reference sites for one symbol — the same callers chain `chimera_impact` uses. */
async function refSitesForNode(state: ProjectGraphState, node: CodeGraphNode): Promise<RefSite[]> {
  let relations: CodeGraphRelation[]
  try {
    relations = state.graph.incomingRelations(node.id, { relations: [...DependentRelations] })
  } catch {
    return []
  }
  if (relations.length === 0) return []
  const ownSpan = node.startLine > 0 && node.endLine >= node.startLine
  const sites: RefSite[] = []
  const seen = new Set<string>()
  for (const relation of relations) {
    const other = relation.otherNode
    if (!other.filePath) continue
    const line = relation.edge?.line ?? other.startLine
    if (line <= 0) continue
    // Skip the hit symbol's own definition span in its own file.
    if (ownSpan && other.filePath === node.filePath && line >= node.startLine && line <= node.endLine) continue
    const fileLevel = relation.relation === "ImportedBy"
    const key = `${other.filePath}:${line}:${fileLevel ? "file" : "symbol"}`
    if (seen.has(key)) continue
    seen.add(key)
    sites.push({ path: other.filePath, line, fileLevel })
  }
  await attachRefSources(state, sites)
  sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return sites
}

/** Trimmed source line (<=100 chars) for each RefSite, read once per referenced file. */
async function attachRefSources(state: ProjectGraphState, sites: RefSite[]) {
  const linesByFile = new Map<string, Set<number>>()
  for (const site of sites) {
    const lines = linesByFile.get(site.path) ?? new Set<number>()
    lines.add(site.line)
    linesByFile.set(site.path, lines)
  }
  const sourcesByFile = new Map<string, Map<number, string>>()
  for (const [file, lineNumbers] of linesByFile) {
    const fileLines = await readSourceLines(state.projectRoot, file)
    if (!fileLines) continue
    const found = new Map<number, string>()
    for (const line of lineNumbers) {
      const text = fileLines[line - 1]?.trim().slice(0, SEARCH_REFS_SOURCE_CHARS)
      if (text) found.set(line, text)
    }
    if (found.size > 0) sourcesByFile.set(file, found)
  }
  for (const site of sites) {
    site.source = sourcesByFile.get(site.path)?.get(site.line)
  }
}

async function readSourceLines(root: string, file: string) {
  try {
    return (await Bun.file(path.join(root, file)).text()).split("\n")
  } catch {
    return undefined
  }
}

/**
 * Compact `Refs(<N>):` block: symbol-level call/reference sites first, then up to 3 file-level
 * imports tagged `(file-level)`; more than the display cap keeps a `+N more` impact hint.
 */
function renderRefsBlock(node: CodeGraphNode, sites: RefSite[]): RenderedRefsLine[] {
  if (sites.length === 0) return []
  const head = `  Refs(${sites.length}):`
  const out: RenderedRefsLine[] = [{ line: head, bare: head, sourceBytes: 0 }]
  const symbolSites = sites.filter((site) => !site.fileLevel)
  const fileSites = sites.filter((site) => site.fileLevel)
  const shown: RefSite[] = []
  for (const site of symbolSites) {
    if (shown.length >= SEARCH_REFS_MAX) break
    shown.push(site)
  }
  for (const site of fileSites) {
    if (shown.length >= SEARCH_REFS_MAX || shown.filter((s) => s.fileLevel).length >= SEARCH_REFS_FILE_LEVEL_MAX) break
    shown.push(site)
  }
  for (const site of shown) {
    const bare = `  ${site.path}:${site.line}${site.fileLevel ? " (file-level)" : ""}`
    out.push(site.source
      ? { line: `${bare} ${site.source}`, bare, sourceBytes: utf8ByteLength(` ${site.source}`) }
      : { line: bare, bare, sourceBytes: 0 })
  }
  const more = sites.length - shown.length
  if (more > 0) {
    const hint = `  +${more} more (chimera_impact ref:${chimeraRef("node", node.id)} 可展开)`
    out.push({ line: hint, bare: hint, sourceBytes: 0 })
  }
  return out
}

async function refsForHits(state: ProjectGraphState, nodes: CodeGraphNode[]) {
  const out = new Map<string, RefSite[]>()
  for (const node of nodes) {
    out.set(node.id, await refSitesForNode(state, node))
  }
  return out
}

/** Refs queries are best-effort: a hard 300ms wall budget degrades to no Refs output. */
async function refsWithBudget(state: ProjectGraphState, nodes: CodeGraphNode[]) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<Map<string, RefSite[]>>((resolve) => {
    timer = setTimeout(() => resolve(new Map()), SEARCH_REFS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([refsForHits(state, nodes), timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Formatting-layer enrichment shared by chimera_search and chimera_file_symbols.
 * Returns the enriched per-hit block lines plus the byte cost of the new content.
 * With `options.refs` (search only), top definition hits additionally gain a compact
 * `Refs(<N>):` block of cross-file call/reference sites with trimmed source lines.
 */
export async function enrichQueryOutput(state: ProjectGraphState, nodes: CodeGraphNode[], options: EnrichQueryOptions = {}) {
  if (nodes.length === 0) return { lines: [], addedBytes: 0 }
  const budget = options.budgetBytes ?? SEARCH_ENRICH_BUDGET_BYTES
  const graphFiles = state.graph.files().map((record) => record.path)
  const hostFiles = uniqueStrings(nodes.map((node) => node.filePath))
  const graphHints = companionTestsFromGraph(hostFiles, graphFiles)

  // Tests hint per host file: graph records first, bounded fs check as fallback.
  const testsPerFile = new Map<string, string[]>()
  for (const host of hostFiles) {
    const graphMatch = graphHints.get(host) ?? []
    const tests = graphMatch.length > 0 ? graphMatch : await companionTestsOnDisk(state.projectRoot, host)
    if (tests.length > 0) testsPerFile.set(host, tests)
  }

  // Definition excerpts for the first few symbol-kind hits.
  const excerptLineByIndex = new Map<number, { index: number; line: string }[]>()
  let symbolHits = 0
  for (let index = 0; index < nodes.length && symbolHits < SEARCH_EXCERPT_HITS; index++) {
    if (!SYMBOL_EXCERPT_KINDS.has(nodes[index]!.kind)) continue
    symbolHits++
    const excerpt = await definitionExcerpt(nodes[index]!, state.projectRoot)
    if (excerpt) excerptLineByIndex.set(index, excerpt.map((line) => ({ index, line })))
  }

  // Append each file's Tests line at the tail of its last hit block.
  const testsTailIndex = new Map<string, number>()
  nodes.forEach((node, index) => {
    if (testsPerFile.has(node.filePath)) testsTailIndex.set(node.filePath, index)
  })
  const testsLines: { index: number; line: string }[] = []
  for (const [file, tests] of testsPerFile) {
    testsLines.push({ index: testsTailIndex.get(file)!, line: `  Tests: ${tests.join(", ")}` })
  }

  // Refs blocks: incoming caller/reference sites for the top definition hits (search only).
  const refsLineByIndex = new Map<number, RenderedRefsLine[]>()
  if (options.refs) {
    const topSymbols = nodes
      .map((node, index) => ({ node, index }))
      .filter((item) => SYMBOL_EXCERPT_KINDS.has(item.node.kind))
      .slice(0, SEARCH_REFS_HITS)
    const sitesByNode = await refsWithBudget(state, topSymbols.map((item) => item.node))
    for (const item of topSymbols) {
      const block = renderRefsBlock(item.node, sitesByNode.get(item.node.id) ?? [])
      if (block.length > 0) refsLineByIndex.set(item.index, block)
    }
  }

  // Budget guard: total bytes added <= SEARCH_ENRICH_BUDGET_BYTES. Drop order: Refs source text
  // (keeping `path:line` sites), then lower-ranked Refs blocks, then excerpts (5th hit backward),
  // then Tests lines (cheapest and most useful, dropped last).
  let addedBytes = 0
  const addLine = (line: string) => { addedBytes += 1 + utf8ByteLength(line) }
  const removeLine = (line: string) => { addedBytes -= 1 + utf8ByteLength(line) }
  for (const lines of excerptLineByIndex.values()) for (const item of lines) addLine(item.line)
  for (const item of testsLines) addLine(item.line)
  for (const lines of refsLineByIndex.values()) for (const item of lines) addLine(item.line)

  if (addedBytes > budget) {
    for (const lines of refsLineByIndex.values()) {
      for (const item of lines) {
        if (item.sourceBytes > 0) {
          removeLine(item.line)
          item.line = item.bare
          addLine(item.line)
          item.sourceBytes = 0
        }
        if (addedBytes <= budget) break
      }
      if (addedBytes <= budget) break
    }
  }
  for (const index of [...refsLineByIndex.keys()].sort((a, b) => b - a)) {
    if (addedBytes <= budget) break
    for (const item of refsLineByIndex.get(index) ?? []) removeLine(item.line)
    refsLineByIndex.delete(index)
  }
  for (const index of [...excerptLineByIndex.keys()].sort((a, b) => b - a)) {
    if (addedBytes <= budget) break
    for (const item of excerptLineByIndex.get(index) ?? []) removeLine(item.line)
    excerptLineByIndex.delete(index)
  }
  for (const item of [...testsLines].reverse()) {
    if (addedBytes <= budget) break
    removeLine(item.line)
    testsLines.splice(testsLines.indexOf(item), 1)
  }

  const combined = nodes.map((node) => formatNode(node).split("\n"))
  for (const [index, lines] of excerptLineByIndex) {
    for (const item of lines) combined[index]!.push(item.line)
  }
  for (const [index, lines] of refsLineByIndex) {
    for (const item of lines) combined[index]!.push(item.line)
  }
  for (const item of testsLines) combined[item.index]!.push(item.line)
  return { lines: combined.flat(), addedBytes }
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

function symbolCandidateTerms(symbol: string) {
  return uniqueStrings(
    symbol
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && term.toLowerCase() !== symbol.toLowerCase()),
  )
}

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

function codePlanAtomicLabelLine(label: ImpactLabelResult["codePlanAtomicLabel"] | undefined) {
  return label ? `  codeplan_atomic_label: ${label}` : undefined
}
function formatChangeFact(fact: ChangeFact) {
  const relationDelta = fact.evidence.relationDelta
  const defaultRule = fact.subjectKind === "body" ? undefined : `  rule: ${fact.evidence.rule}`
  const label = deriveImpactLabels([fact])[0]
  return [
    `- ${fact.id}: ${fact.subjectKind}/${fact.changeKind} ${fact.filePath}`,
    fact.nodeKey ? `  node: ${fact.nodeKey}` : undefined,
    `  confidence: ${fact.confidence}`,
    defaultRule,
    codePlanAtomicLabelLine(label?.codePlanAtomicLabel),
    fact.evidence.statementEffect ? `  statement_effect: ${fact.evidence.statementEffect.effect}` : undefined,
    relationDelta
      ? `  relation_delta: +${relationDelta.addedRelations.length} -${relationDelta.removedRelations.length} before:${relationDelta.beforeRelations.length} after:${relationDelta.afterRelations.length}`
      : undefined,
    fact.evidence.replayLifecycle
      ? `  replay_lifecycle: ${fact.evidence.replayLifecycle.status} (${fact.evidence.replayLifecycle.reason})`
      : undefined,
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

function ruleFacts(changeFacts: ChangeFact[]) {
  const precise = changeFacts.filter((fact) => fact.subjectKind !== "file")
  return precise.length ? precise : changeFacts
}

function impactLabelCause(label: ImpactLabelResult): CauseLink {
  return {
    type: "impact_label",
    target: `${label.label} ${label.fact.filePath}`,
    evidence: `chimera:impact_label:${label.label}${label.codePlanAtomicLabel ? `:codeplan_atomic:${label.codePlanAtomicLabel}` : ""}:confidence:${label.confidence}`,
  }
}

function mayImpactRuleCause(rule: MayImpactRule, target: string): CauseLink {
  return { type: "may_impact_rule", target, evidence: mayImpactRuleEvidence(rule) }
}

function ruleCauseChain(source: CauseLink, label: ImpactLabelResult, rule: MayImpactRule, target: string) {
  return [source, factCause([label.fact]), impactLabelCause(label), mayImpactRuleCause(rule, target)].filter(
    (item): item is CauseLink => Boolean(item),
  )
}

function labelReason(label: ImpactLabelResult) {
  return label.fallbackReason ? `${label.reason}; fallback: ${label.fallbackReason}` : label.reason
}

function factReviewTarget(label: ImpactLabelResult) {
  return label.fact.nodeKey ?? label.fact.filePath
}

const CodePlanRelationKinds = new Set<CodePlanRelationKind>([
  "ParentOf",
  "ChildOf",
  "Construct",
  "ConstructedBy",
  "Imports",
  "ImportedBy",
  "BaseClassOf",
  "DerivedClassOf",
  "Overrides",
  "OverriddenBy",
  "Calls",
  "CalledBy",
  "Instantiates",
  "InstantiatedBy",
  "Uses",
  "UsedBy",
])

function codePlanRelationKind(relation: string): CodePlanRelationKind | undefined {
  return CodePlanRelationKinds.has(relation as CodePlanRelationKind) ? relation as CodePlanRelationKind : undefined
}

function relationClauseExpression(graph: CodePlanRelationGraphLabel, blockNode: { nodeKey: string }, relation: CodePlanRelationKind) {
  return `Rel(${graph}, ${blockNode.nodeKey}, ${relation})`
}

function relationClauseFromFrozen(relation: FrozenCodePlanRelation) {
  return relation.payload.clause.expression
}

function relationClauseCause(target: string, expression: string, evidence: string): CauseLink {
  return { type: "relation_clause", target, evidence: `${evidence}:${expression}` }
}

function codePlanRelationEvidence(relation: FrozenCodePlanRelation) {
  return `codegraph:relation_clause:${relation.payload.clause.expression}:${relation.payload.edgeKind}:${relation.payload.quality}`
}

function codePlanRelationCandidate(input: {
  state: ProjectGraphState
  snapshot: CodeGraphSnapshot
  label: ImpactLabelResult
  rule: MayImpactRule
  relation: FrozenCodePlanRelation
  sourceCause: CauseLink
  seedNames: string[]
}): AuditCandidate {
  const node = input.state.graph.node(input.relation.payload.otherNode.codegraphId)
  const target = node ? nodeTarget(node) : frozenRelationNodeTarget(input.relation.payload.otherNode)
  const classification = classifyFile(node?.filePath ?? input.relation.payload.otherNode.filePath).classification
  const expression = relationClauseFromFrozen(input.relation)
  return {
    target,
    targetNode: node ? input.state.graph.projectNode(node, input.snapshot) : undefined,
    reason: `${node ? riskReasonForNode(node) : classifyFile(input.relation.payload.otherNode.filePath).reason}; ${input.rule.id} selected ${expression}`,
    risk: node ? riskForNode(node) : riskForFrozenRelationNode(input.relation.payload.otherNode),
    classification,
    evidence: `${mayImpactRuleEvidence(input.rule)}:relation_clause:${expression}`,
    causeChain: [
      ...ruleCauseChain(input.sourceCause, input.label, input.rule, target),
      relationClauseCause(target, expression, codePlanRelationEvidence(input.relation)),
    ],
    atomicLabel: input.label.codePlanAtomicLabel,
    statementEffect: input.label.fact.evidence.statementEffect?.effect,
    relationClause: expression,
    impactedBlock: target,
  }
}

function relationClauseCandidates(input: {
  state: ProjectGraphState
  snapshot: CodeGraphSnapshot
  seedNodes: CodeGraphNode[]
  ruleItems: Array<{ label: ImpactLabelResult; rule: MayImpactRule }>
  sourceCause: CauseLink
  seedNames: string[]
  limit: number
}) {
  return input.ruleItems.flatMap((item) =>
    item.rule.relationClauses.flatMap((clause) =>
      input.seedNodes.flatMap((node) =>
        input.state.graph.incidentCodePlanRelations(node.id, input.snapshot, {
          directions: ["incoming"],
          graphSide: clause.graph === "D" ? "before" : "after",
          relations: [clause.relation],
        }).map((relation) => codePlanRelationCandidate({
          state: input.state,
          snapshot: input.snapshot,
          label: item.label,
          rule: item.rule,
          relation,
          sourceCause: input.sourceCause,
          seedNames: input.seedNames,
        })),
      ),
    ),
  ).slice(0, input.limit)
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
  const relationKind = codePlanRelationKind(input.relation.payload.relation)
  const relationClause = relationKind ? relationClauseExpression(input.type === "added_relation" ? "D'" : "D", input.relation.payload.focalNode, relationKind) : undefined
  return {
    target,
    targetNode: current ? input.state.graph.projectNode(current, input.snapshot) : undefined,
    reason: `${current ? riskReasonForNode(current) : classifyFile(input.relation.payload.otherNode.filePath).reason}; relation ${input.relation.payload.relation} (${input.relation.payload.edgeKind}) was ${change} in CodeGraph ${graphSide} evidence for ${input.relation.payload.focalNode.nodeKey}`,
    risk: current ? riskForNode(current) : riskForFrozenRelationNode(input.relation.payload.otherNode),
    classification,
    evidence: `codegraph:relation_delta:${change}:${input.relation.payload.relation}`,
    causeChain: [
      ...input.baseCauseChain,
      { type: input.type, target, evidence: frozenRelationEvidence(input.relation, input.type) },
      ...(relationClause ? [relationClauseCause(target, relationClause, `codegraph:relation_delta:${change}`)] : []),
    ],
    relationClause,
    impactedBlock: target,
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
  const seedNames = input.seedNodes.map((node) => node.qualifiedName || node.name).slice(0, 5)
  const cause = sourceCause(input.source, input.changedFiles, seedNames)
  const labels = deriveImpactLabels(ruleFacts(input.changeFacts))
  if (labels.length === 0) {
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
          evidence: "codegraph:impact_radius",
          causeChain: [...baseCauseChain, { type: "impact_radius" as const, target, evidence: "codegraph:impact_radius" }],
        }
      }),
    ]).slice(0, input.limit)
    return { impactedNodes: selectedImpactNodes, fileDependents, evidence }
  }
  const ruleItems = labels.map((label) => ({ label, rule: dispatchMayImpactRule(label) }))
  const ruleRelations = ruleItems.flatMap((item) =>
    item.rule.relationKinds.length
      ? input.seedNodes.flatMap((node) =>
          input.state.graph.incomingRelations(node.id, { relations: item.rule.relationKinds }).map((relation) => ({ ...item, relation })),
        )
      : [],
  ).slice(0, input.limit)
  const ruleClauseEvidence = relationClauseCandidates({ state: input.state, snapshot: input.snapshot, seedNodes: input.seedNodes, ruleItems, sourceCause: cause, seedNames, limit: input.limit })
  const ruleClauseNodes = uniqueNodes(ruleClauseEvidence.flatMap((item) => {
    const id = item.targetNode?.source.codegraphId
    const node = id ? input.state.graph.node(id) : undefined
    return node ? [node] : []
  }))
  const relationNodes = uniqueNodes([...ruleRelations.map((item) => item.relation.otherNode), ...ruleClauseNodes])
  const relationNodeIDs = new Set(relationNodes.map((node) => node.id))
  const includeImpactRadius = ruleItems.some((item) => item.rule.includeImpactRadius)
  const impactedNodes = includeImpactRadius
    ? uniqueNodes([
        ...relationNodes,
        ...input.seedNodes.flatMap((node) => [...input.state.graph.impactRadius(node.id, input.depth).nodes.values()]),
      ].slice(0, input.limit)).filter((node) => !input.seedNodes.some((seed) => seed.id === node.id) && !relationNodeIDs.has(node.id))
    : []
  const selectedImpactNodes = uniqueNodes([...relationNodes, ...impactedNodes]).filter((node) => !input.seedNodes.some((seed) => seed.id === node.id))
  const includeFileDependents = ruleItems.some((item) => item.rule.includeFileDependents)
  const fileDependents = includeFileDependents
    ? uniqueStrings(
        [
          ...(input.normalizedFile ? input.state.graph.fileDependents(input.normalizedFile) : []),
          ...input.changedFiles.flatMap((file) => input.state.graph.fileDependents(file)),
          ...input.seedNodes.flatMap((node) => input.state.graph.fileDependents(node.filePath)),
        ].slice(0, input.limit),
      )
    : []
  const evidence = uniqueCandidates([
    ...relationDeltaCandidates({ state: input.state, snapshot: input.snapshot, changeFacts: input.changeFacts, sourceCause: cause }),
    ...ruleClauseEvidence,
    ...ruleItems.filter((item) => item.rule.selfReviewOnly).map((item) => {
      const target = factReviewTarget(item.label)
      const classification = classifyFile(item.label.fact.filePath).classification
      return {
        target,
        reason: `impact label ${item.label.label} matched rule ${item.rule.id}; ${item.rule.reason}; ${labelReason(item.label)}`,
        risk: riskForFile(item.label.fact.filePath),
        classification,
        evidence: `${mayImpactRuleEvidence(item.rule)}:self_review`,
        causeChain: [...ruleCauseChain(cause, item.label, item.rule, target), { type: "self_review" as const, target, evidence: "chimera:self_review" }],
        atomicLabel: item.label.codePlanAtomicLabel,
        statementEffect: item.label.fact.evidence.statementEffect?.effect,
        impactedBlock: target,
      }
    }),
    ...ruleRelations.map((item) => {
      const relation = item.relation
      const node = relation.otherNode
      const classification = classifyFile(node.filePath).classification
      const target = nodeTarget(node)
      const relationLabel = relationEvidence(relation)
      return {
        target,
        targetNode: input.state.graph.projectNode(node, input.snapshot),
        reason: `${riskReasonForNode(node)}; impact label ${item.label.label} matched rule ${item.rule.id}; relation ${relation.relation} (${relation.edgeKind}) points from ${target} to ${seedNames.join(", ") || "the changed seed"}; ${labelReason(item.label)}`,
        risk: riskForNode(node),
        classification,
        evidence: `${mayImpactRuleEvidence(item.rule)}:relation:${relation.relation}`,
        causeChain: [...ruleCauseChain(cause, item.label, item.rule, target), { type: "relation" as const, target, evidence: relationLabel }],
        atomicLabel: item.label.codePlanAtomicLabel,
        statementEffect: item.label.fact.evidence.statementEffect?.effect,
        impactedBlock: target,
      }
    }),
    ...ruleItems.filter((item) => item.rule.includeFileDependents).flatMap((item) =>
      fileDependents.map((file) => {
        const classification = classifyFile(file).classification
        return {
          target: file,
          reason: `impact label ${item.label.label} matched rule ${item.rule.id}; dependent file may need review because it imports or depends on ${input.changedFiles.slice(0, 3).join(", ") || seedNames.join(", ") || "the changed seed"}; ${labelReason(item.label)}`,
          risk: riskForFile(file),
          classification,
          evidence: `${mayImpactRuleEvidence(item.rule)}:file_dependents`,
          causeChain: [...ruleCauseChain(cause, item.label, item.rule, file), { type: "file_dependency" as const, target: file, evidence: "codegraph:file_dependents" }],
          atomicLabel: item.label.codePlanAtomicLabel,
          statementEffect: item.label.fact.evidence.statementEffect?.effect,
          impactedBlock: file,
        }
      }),
    ),
    ...ruleItems.filter((item) => item.rule.includeImpactRadius).flatMap((item) =>
      impactedNodes.map((node) => {
        const classification = classifyFile(node.filePath).classification
        const target = nodeTarget(node)
        return {
          target,
          targetNode: input.state.graph.projectNode(node, input.snapshot),
          reason: `${riskReasonForNode(node)}; impact label ${item.label.label} matched rule ${item.rule.id}; symbol is inside impact radius of ${seedNames.join(", ") || input.changedFiles.slice(0, 3).join(", ") || "the changed seed"}; ${labelReason(item.label)}`,
          risk: riskForNode(node),
          classification,
          evidence: `${mayImpactRuleEvidence(item.rule)}:impact_radius`,
          causeChain: [...ruleCauseChain(cause, item.label, item.rule, target), { type: "impact_radius" as const, target, evidence: "codegraph:impact_radius" }],
          atomicLabel: item.label.codePlanAtomicLabel,
          statementEffect: item.label.fact.evidence.statementEffect?.effect,
          impactedBlock: target,
        }
      }),
    ),
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
          if (!file || file.startsWith(".chimera/") || file.startsWith(".codegraph/")) return []
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
type OracleRecentParams = Schema.Schema.Type<typeof OracleRecentParameters>
type OracleGetParams = Schema.Schema.Type<typeof OracleGetParameters>
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

function oracleArtifact(provenanceArtifact: string) {
  return path.join(path.dirname(provenanceArtifact), "oracle-results.jsonl")
}

function predesignArtifact(provenanceArtifact: string) {
  return path.join(path.dirname(provenanceArtifact), "predesign-runs.jsonl")
}

function cleanStrings(items: readonly string[] | undefined) {
  return uniqueStrings((items ?? []).map((item) => item.trim()).filter(Boolean))
}

const ChimeraRefKinds = ["node", "audit", "predesign", "oracle", "obligation", "change"] as const

type ChimeraRefKind = (typeof ChimeraRefKinds)[number]

function chimeraRef(kind: ChimeraRefKind, id: string) {
  return `${kind}:${id}`
}

function parseChimeraRef(ref: string | undefined, expected: ChimeraRefKind[]) {
  const value = ref?.trim()
  if (!value) return undefined
  const separator = value.indexOf(":")
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid Chimera ref: ${value}. Expected ${expected.map((kind) => `${kind}:<id>`).join(" or ")}`)
  }
  const kind = value.slice(0, separator) as ChimeraRefKind
  const id = value.slice(separator + 1)
  if (!ChimeraRefKinds.includes(kind)) {
    throw new Error(`unknown Chimera ref kind: ${kind}`)
  }
  if (!expected.includes(kind)) {
    throw new Error(`Chimera ref ${value} is not valid here; expected ${expected.map((item) => `${item}:<id>`).join(" or ")}`)
  }
  return { kind, id, raw: value }
}

function chimeraRefID(ref: string | undefined, expected: ChimeraRefKind[]) {
  return parseChimeraRef(ref, expected)?.id
}

function chimeraRefIDs(refs: readonly string[] | undefined, expected: ChimeraRefKind[]) {
  return cleanStrings(refs).flatMap((ref) => {
    const parsed = parseChimeraRef(ref, expected)
    return parsed ? [parsed.id] : []
  })
}

function requiredChimeraID(input: { ref?: string; legacy?: string; legacyName: string; expected: ChimeraRefKind; label: string }) {
  const id = chimeraRefID(input.ref, [input.expected]) ?? input.legacy?.trim()
  if (id) return id
  throw new Error(`${input.label} requires ref (${input.expected}:<id>) or ${input.legacyName}`)
}

function emptyObligationStore(): ObligationStore {
  return { schemaVersion: 1, obligations: [] }
}

function readObligationStore(projectRoot: string, artifact: string, readOnly = false) {
  return Effect.promise(() =>
    readOnly
      ? readPersistentObligationStoreReadOnly(projectRoot, artifact, emptyObligationStore())
      : readPersistentObligationStore(projectRoot, artifact, emptyObligationStore()),
  )
}

function readObligationSummary(projectRoot: string, provenanceArtifact: string, storePath: string, limit = 10, readOnly = false) {
  return Effect.gen(function* () {
    const artifact = obligationsArtifact(provenanceArtifact)
    const store = yield* readObligationStore(projectRoot, artifact, readOnly)
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

function swarmFollowupData(input: { count: number; source: "audit" | "obligation" | "oracle"; preset: "audit-followup" | "audit-review" | "oracle-followup" }) {
  if (input.count < 2) return undefined
  const source = input.source === "oracle" ? "failing/unknown oracles" : input.source === "obligation" ? "active obligations" : "propagation findings"
  const from = input.source === "oracle" ? "failing_or_unknown_oracles" : input.source === "obligation" ? "active_obligations" : undefined
  return {
    tool: "chimera_swarm",
    preset: input.preset,
    from,
    reason: `${input.count} ${source} look like an independent follow-up frontier; consider chimera_swarm with preset: "${input.preset}" instead of serial manual handling.`,
    guidance: "Keep each item scoped; workers may edit only when the preset/prompt allows it, while the parent reruns audit/tests/oracles and handles conflicts.",
  }
}

function swarmFollowupGuidance(input: { count: number; source: "audit" | "obligation" | "oracle"; preset: "audit-followup" | "audit-review" | "oracle-followup" }) {
  const data = swarmFollowupData(input)
  if (!data) return []
  return [
    "",
    "Swarm follow-up:",
    `- ${data.reason}`,
    data.from ? `- Source shortcut: \`from: \"${data.from}\"\`.` : "- For transient audit findings, pass selected findings as explicit `items`.",
    `- ${data.guidance}`,
  ]
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
    evidence: candidate.evidence,
    causeChain: candidate.causeChain,
    atomicLabel: candidate.atomicLabel,
    statementEffect: candidate.statementEffect,
    relationClause: candidate.relationClause,
    impactedBlock: candidate.impactedBlock,
    source: {
      type: audit.source,
      provenanceID: audit.provenance?.id,
      changedFiles: audit.changedFiles,
      snapshotRevision: audit.snapshot.revision,
      seedNodes: audit.seedNodes,
      changeFacts: audit.changeFacts,
    },
    replayLifecycle: {
      version: 1,
      status: "current",
      reason: "obligation was created from the current audit snapshot",
      sourceRevision: audit.snapshot.revision,
      currentRevision: audit.snapshot.revision,
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
      evidence: next.evidence,
      causeChain: next.causeChain,
      atomicLabel: next.atomicLabel,
      statementEffect: next.statementEffect,
      relationClause: next.relationClause,
      impactedBlock: next.impactedBlock,
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
  state: { graph: { node: (id: string) => CodeGraphNode | null | undefined; snapshot: () => CodeGraphSnapshot } },
  now: string,
) {
  const currentRevision = state.graph.snapshot().revision
  return {
    schemaVersion: 1 as const,
    obligations: store.obligations.map((item) => {
      const codegraphID = item.targetNode?.source.codegraphId
      if (!codegraphID || item.status === "resolved" || item.status === "ignored") return item
      if (!state.graph.node(codegraphID)) {
        return {
          ...item,
          status: "stale" as const,
          staleReason: "target node is missing from the current CodeGraph index",
          replayLifecycle: {
            version: 1 as const,
            status: "missing_target" as const,
            reason: "target node is missing from the current CodeGraph index",
            sourceRevision: item.source.snapshotRevision,
            currentRevision,
          },
          updatedAt: now,
        }
      }
      const lifecycleStatus: ObligationReplayLifecycle["status"] = item.source.snapshotRevision === currentRevision ? "current" : "replayable"
      return {
        ...item,
        staleReason: lifecycleStatus === "current" ? undefined : item.staleReason,
        replayLifecycle: {
          version: 1 as const,
          status: lifecycleStatus,
          reason: lifecycleStatus === "current"
            ? "source audit snapshot matches the current graph revision"
            : "source audit snapshot differs, but target node still resolves in the current graph",
          sourceRevision: item.source.snapshotRevision,
          currentRevision,
        },
      }
    }),
  }
}

function activeObligations(obligations: PersistentObligation[]) {
  return obligations.filter((item) => item.status !== "resolved" && item.status !== "ignored")
}

function filterObligations(obligations: PersistentObligation[], params: ObligationsListParams) {
  return (params.status ? obligations.filter((item) => item.status === params.status) : activeObligations(obligations)).slice(
    0,
    bounded(params.limit, 20, 100),
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
    `  Ref: ${chimeraRef("obligation", item.id)}`,
    item.atomicLabel ? `  codeplan_atomic_label: ${item.atomicLabel}` : undefined,
    item.statementEffect ? `  statement_effect: ${item.statementEffect}` : undefined,
    item.relationClause ? `  relation_clause: ${item.relationClause}` : undefined,
    item.impactedBlock ? `  impacted_block: ${item.impactedBlock}` : undefined,
    `  risk: ${item.risk}`,
    item.classification ? `  classification: ${item.classification}` : undefined,
    `  evidence: ${item.evidence}`,
    item.replayLifecycle ? `  lifecycle: ${item.replayLifecycle.status} (${item.replayLifecycle.reason})` : undefined,
    item.staleReason ? `  stale_reason: ${item.staleReason}` : undefined,
    item.causeChain?.length ? `  cause_chain: ${formatCauseChain(item.causeChain)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function formatEvidence(item: AuditCandidate) {
  return [
    `- target: ${item.target}`,
    item.atomicLabel ? `  codeplan_atomic_label: ${item.atomicLabel}` : undefined,
    item.statementEffect ? `  statement_effect: ${item.statementEffect}` : undefined,
    item.relationClause ? `  relation_clause: ${item.relationClause}` : undefined,
    item.impactedBlock ? `  impacted_block: ${item.impactedBlock}` : undefined,
    `  risk: ${item.risk}`,
    `  classification: ${item.classification}`,
    `  evidence: ${item.evidence}`,
    `  cause_chain: ${formatCauseChain(item.causeChain)}`,
  ].filter(Boolean).join("\n")
}

function formatPredesignEvidence(item: AuditCandidate) {
  return [
    `- ${item.target}: ${item.classification} / ${item.risk}`,
    `  evidence: ${item.evidence}`,
    `  cause_chain: ${compactText(formatCauseChain(item.causeChain))}`,
  ].join("\n")
}

function formatProvenance(record: ContextOverlay["provenance"]) {
  if (!record) return ["Current provenance:", "- None recorded."].join("\n")
  return [
    "Current provenance:",
    `- ${record.id}`,
    `  Ref: ${chimeraRef("change", record.id)}`,
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
    audit.auditRunID ? `Audit run: ${audit.auditRunID}` : undefined,
    audit.auditRunID ? `Ref: ${chimeraRef("audit", audit.auditRunID)}` : undefined,
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
            ? `- ${node.payload.qualifiedName || node.payload.name} (${node.payload.kind})\n  Ref: ${chimeraRef("node", node.source.codegraphId)}\n  ${node.payload.filePath}:${node.payload.range.startLine}-${node.payload.range.endLine}${node.payload.signature ? `\n  ${node.payload.signature}` : ""}`
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
      ? audit.obligations.map((item) => `- ${item.target}: ${[item.atomicLabel ? `atomic ${item.atomicLabel}` : undefined, item.relationClause, item.impactedBlock ? `block ${item.impactedBlock}` : undefined].filter(Boolean).join(" / ") || `${item.classification} / ${item.risk}`}`)
      : ["- None found."]),
    "",
    `Propagation findings (${audit.obligations.length}):`,
    ...(audit.obligations.length ? audit.obligations.map(formatEvidence) : ["- None found."]),
    ...swarmFollowupGuidance({ count: audit.obligations.length, source: "audit", preset: "audit-followup" }),
  ].join("\n")
}

function outputCharLimit(value: number | undefined) {
  return Math.max(1, Math.min(200_000, Math.floor(value ?? 20_000)))
}

function objectRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function compactOraclePayload(input: unknown, maxOutputChars: number) {
  if (!objectRecord(input)) return input
  if (!objectRecord(input.shell)) return input
  if (typeof input.shell.output !== "string") return input
  if (input.shell.output.length <= maxOutputChars) return input
  return {
    ...input,
    shell: {
      ...input.shell,
      output: input.shell.output.slice(0, maxOutputChars),
      outputTruncatedForDisplay: true,
      outputOriginalChars: input.shell.output.length,
    },
  }
}

function oracleLinkedChangeLifecycle(change: OracleRecord["linkedChanges"][number], currentRevision?: string) {
  if (!currentRevision) return undefined
  const status = change.afterRevision === currentRevision ? "current" : "replayable"
  return {
    version: 1,
    status,
    reason: status === "current"
      ? "linked mutation after-revision matches the current graph revision"
      : "linked mutation revision differs, but oracle provenance remains replayable evidence",
    sourceRevision: change.afterRevision,
    currentRevision,
  }
}

function oracleEnvelope(record: OracleRecord, maxOutputChars: number, currentRevision?: string) {
  return {
    oracle: {
      id: record.id,
      ref: chimeraRef("oracle", record.id),
      kind: record.kind,
      status: record.status,
      tool: record.tool,
      project: record.project,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      createdAt: record.createdAt,
      payload: compactOraclePayload(record.payload, maxOutputChars),
    },
    linkWindow: record.linkWindow,
    linkedChanges: record.linkedChanges.map((change) => ({
      ...change,
      ref: chimeraRef("change", change.id),
      ...(change.changeID ? { changeRef: chimeraRef("change", change.changeID) } : {}),
      replayLifecycle: oracleLinkedChangeLifecycle(change, currentRevision),
    })),
  }
}

function hasExplicitAuditSeed(params: AuditParams) {
  return Boolean(params.files?.length || params.filePath || params.symbol || params.ref || params.nodeID)
}

const buildAudit = Effect.fn("ChimeraTool.buildAudit")(function* (params: BuildAuditParams, options: BuildAuditOptions = {}) {
  const instance = yield* InstanceState.context
  const state = options.state ?? (options.ctx ? yield* openProjectGraphForTool(options.ctx, params.refresh !== false) : yield* Chimera.openProjectGraph({ sync: params.refresh !== false }))
  const records = yield* provenanceRecords(state.projectRoot, state.artifact)
  const recent = latestSuccessfulProvenance(records)
  const explicitFileSeeds = graphFilesFromPaths(state.projectRoot, instance.directory, [...(params.files ?? []), ...(params.filePath ? [params.filePath] : [])])
  const explicitFiles = explicitFileSeeds.map((file) => file.graphPath)
  const nodeID = chimeraRefID(params.ref, ["node"]) ?? params.nodeID?.trim()
  const recentFiles = params.recent === false || explicitFiles.length || params.symbol || nodeID ? [] : uniqueStrings(provenanceGraphFiles(recent))
  const gitFiles = params.recent === false || explicitFiles.length || params.symbol || nodeID || recentFiles.length ? [] : yield* gitStatusFiles(state.projectRoot)
  const changedFiles = explicitFiles.length ? explicitFiles : recentFiles.length ? recentFiles : gitFiles
  const source: AuditMetadata["source"] =
    explicitFiles.length || params.symbol || nodeID ? "input" : recentFiles.length ? "recent_provenance" : "git_diff"
  const depth = bounded(params.depth, 2, 5)
  const limit = bounded(params.limit, 10, 100)
  if (explicitFileSeeds.length > 0) {
    yield* Effect.promise(() => syncExistingGraphFiles(state, explicitFileSeeds, "force")).pipe(Effect.orDie)
  } else if (recentFiles.length > 0) {
    yield* Effect.promise(() => syncExistingGraphFiles(state, graphFilesFromPaths(state.projectRoot, state.projectRoot, recentFiles), "missing")).pipe(Effect.orDie)
  }
  const snapshot = state.graph.snapshot()
  const storedChangeFacts = source === "recent_provenance" && recent ? yield* Effect.promise(() => readChangeFacts(state.projectRoot, [recent.id])) : []
  const ephemeralRecord = storedChangeFacts.length
    ? undefined
    : source === "recent_provenance" && recent
      ? recent
      : syntheticAuditRecord({ projectRoot: state.projectRoot, directory: instance.directory, source, changedFiles, snapshot })
  const projectionMemo = new ProjectionMemo()
  const ephemeralAfterNodes = ephemeralRecord ? collectFileProjections(state.graph, ephemeralRecord.files, snapshot, projectionMemo) : []
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
    ...(nodeID ? [state.graph.node(nodeID)].filter((node): node is CodeGraphNode => Boolean(node)) : []),
    ...(params.symbol ? state.graph.searchNodes(params.symbol, { kinds, limit: 5 }).map((result) => result.node) : []),
    ...fileSeedNodes,
  ])

  if (changedFiles.length === 0 && seedNodes.length === 0) {
    throw new Error("chimera_audit requires files/filePath, symbol/ref/nodeID, a recent successful Chimera tool mutation, or git diff changes")
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

function persistAuditRun(audit: AuditMetadata) {
  return Effect.promise(() =>
    recordAuditRun(audit.projectRoot, {
      source: audit.source,
      provenanceID: audit.provenance?.id,
      changedFiles: audit.changedFiles,
      snapshotRevision: audit.snapshot.revision,
      seedNodes: audit.seedNodes,
      obligations: audit.obligations,
      payload: audit,
    }),
  )
}

export const ChimeraInitGraphTool = Tool.define<typeof InitGraphParameters, InitGraphMetadata, never>(
  "chimera_init_graph",
  Effect.succeed({
    description: INIT_GRAPH_DESCRIPTION,
    parameters: InitGraphParameters,
    execute: (params: Schema.Schema.Type<typeof InitGraphParameters>, ctx: Tool.Context<InitGraphMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_init_graph", { refresh: params.refresh !== false })
        const instance = yield* InstanceState.context
        const root = contextProjectRoot(instance)
        const dataRoot = getGraphDataRootInfo(root)
        const reporter = createSyncProgressReporter(ctx, true)
        const snapshot = yield* Chimera.initProjectGraph({
          source: "tool.chimera_init_graph",
          sessionID: ctx.sessionID,
          watch: false,
          onProgress: reporter.onProgress,
        }).pipe(Effect.ensuring(Effect.sync(() => reporter.done())))
        return {
          title: "Chimera init graph",
          output: [
            "Chimera graph initialized.",
            `Project root: ${root}`,
            `Data root: ${dataRoot.dataRoot}`,
            `Data root status: ${dataRoot.dataRootStatus}`,
            `Revision: ${snapshot.revision}`,
            `Files: ${snapshot.fileCount}`,
            `Nodes: ${snapshot.nodeCount}`,
            `Edges: ${snapshot.edgeCount}`,
          ].join("\n"),
          metadata: {
            projectRoot: root,
            initialized: true,
            dataRoot: dataRoot.dataRoot,
            dataRootStatus: dataRoot.dataRootStatus,
            revision: snapshot.revision,
            fileCount: snapshot.fileCount,
            nodeCount: snapshot.nodeCount,
            edgeCount: snapshot.edgeCount,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraStatusTool = Tool.define<typeof StatusParameters, StatusMetadata, never>(
  "chimera_status",
  Effect.succeed({
    description: STATUS_DESCRIPTION,
    parameters: StatusParameters,
    execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context<StatusMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_status", { refresh: params.refresh !== false, projectPath: params.projectPath })
        const instance = yield* InstanceState.context
        const target = Chimera.resolveProjectGraphTarget(params.projectPath, contextProjectRoot(instance))
        const root = target.root
        const dataRoot = getGraphDataRootInfo(root)
        const job = readIndexJob(root)
        if (!CodeGraph.isInitialized(root)) {
          return {
            title: "Chimera status",
            output: [
              "Chimera graph surface is not initialized.",
              `Project: ${root}${target.crossProject ? " (cross-project, read-only)" : ""}`,
              `Data root: ${dataRoot.dataRoot}`,
              `Data root status: ${dataRoot.dataRootStatus}`,
              job ? `Graph job: ${job.kind} ${job.status}` : undefined,
              target.crossProject
                ? "Ask the user to run `chimera graph init` and then `chimera graph index` in that project (indexing large repositories can take a long time); do not initialize another project's graph from this session."
                : undefined,
            ].filter(Boolean).join("\n"),
            metadata: {
              initialized: false,
              projectRoot: root,
              crossProject: target.crossProject,
              dataRoot: dataRoot.dataRoot,
              dataRootStatus: dataRoot.dataRootStatus,
              jobStatus: job,
              artifact: "",
              storePath: dataRoot.databasePath,
              obligationsArtifact: "",
              provenanceRecords: 0,
              obligationCounts: { pending: 0, claimed: 0, resolved: 0, ignored: 0, stale: 0 },
              pendingObligations: 0,
            },
          }
        }
        return yield* catchSchemaMigrationRequired(
          withProjectGraphForTool(
            ctx as Tool.Context,
            params.refresh !== false,
            { init: false, readOnly: true, projectPath: params.projectPath },
          (state) =>
            Effect.gen(function* () {
              const snapshot = state.graph.snapshot()
              const stats = state.graph.stats()
              const provenanceRecords = state.crossProject
                ? yield* Effect.promise(() => storedProvenanceRecordCountReadOnly(state.projectRoot, state.artifact))
                : yield* provenanceRecordCount(state.projectRoot, state.artifact)
              const obligations = yield* readObligationSummary(state.projectRoot, state.artifact, state.storePath, 0, state.crossProject === true)
              const missingFiles = state.crossProject ? 0 : state.graph.missingTrackedFiles().length

              return {
                title: "Chimera status",
                output: [
                  "Chimera graph surface is ready.",
                  `Project: ${state.projectRoot}${state.crossProject ? " (cross-project, read-only)" : ""}`,
                  `Data root: ${dataRoot.dataRoot}`,
                  `Data root status: ${dataRoot.dataRootStatus}`,
                  job ? `Graph job: ${job.kind} ${job.status}${job.phase ? ` — ${job.phase}` : ""}` : undefined,
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
                  ...(missingFiles > 0
                    ? [`Graph is missing ${missingFiles} git-tracked file${missingFiles === 1 ? "" : "s"} from the index; run a refresh or full sync to reconcile.`]
                    : []),
                ].filter(Boolean).join("\n"),
                metadata: {
                  initialized: true,
                  projectRoot: state.projectRoot,
                  crossProject: state.crossProject === true,
                  dataRoot: dataRoot.dataRoot,
                  dataRootStatus: dataRoot.dataRootStatus,
                  jobStatus: job,
                  artifact: state.artifact,
                  storePath: state.storePath,
                  obligationsArtifact: obligations.artifact,
                  snapshot,
                  stats,
                  backend: String(state.graph.backend()),
                  journalMode: state.graph.journalMode(),
                  missingFiles,
                  provenanceRecords,
                  obligationCounts: obligations.counts,
                  pendingObligations: obligations.counts.pending,
                },
              }
            }),
          ),
          (error) => ({
            title: "Chimera status",
            output: [
              schemaMigrationStatusLine(error),
              `Project: ${root}${target.crossProject ? " (cross-project, read-only)" : ""}`,
              `Data root: ${dataRoot.dataRoot}`,
              `Data root status: ${dataRoot.dataRootStatus}`,
              job ? `Graph job: ${job.kind} ${job.status}` : undefined,
              schemaMigrationGuidance(target.crossProject === true),
            ].filter(Boolean).join("\n"),
            metadata: {
              initialized: true,
              needsMigration: true,
              schemaVersion: error.currentVersion,
              requiredVersion: error.requiredVersion,
              projectRoot: root,
              crossProject: target.crossProject,
              dataRoot: dataRoot.dataRoot,
              dataRootStatus: dataRoot.dataRootStatus,
              jobStatus: job,
              artifact: "",
              storePath: dataRoot.databasePath,
              obligationsArtifact: "",
              provenanceRecords: 0,
              obligationCounts: { pending: 0, claimed: 0, resolved: 0, ignored: 0, stale: 0 },
              pendingObligations: 0,
            },
          }),
        )
      }).pipe(Effect.orDie),
  }),
)

// Sentence-shaped queries (>=3 free-text plain-lowercase words with no code
// shape) are low-confidence against the prefix-OR search core: weak-model bench
// runs showed whole-prompt queries returning generated-SDK and unrelated-util
// symbols, flooding ~3KB of noise into the context. Truncate those to the top 3
// results and prepend a correction guide. Identifier, path, filter, and short
// concept queries ("system prompt") are untouched.
const SENTENCE_QUERY_MIN_FREE_TERMS = 3
const SENTENCE_QUERY_TRUNCATED_RESULTS = 3
export function isSentenceLikeQuery(query: string) {
  const freeTerms = query.split(/\s+/).filter((term) => term.length > 0 && !term.includes(":"))
  if (freeTerms.length < SENTENCE_QUERY_MIN_FREE_TERMS) return false
  return !freeTerms.some((term) => /[A-Z_/.`]/.test(term))
}

export const ChimeraSearchTool = Tool.define<typeof SearchParameters, SearchMetadata, never>(
  "chimera_search",
  Effect.succeed({
    description: SEARCH_DESCRIPTION,
    parameters: SearchParameters,
    execute: (params: Schema.Schema.Type<typeof SearchParameters>, ctx: Tool.Context<SearchMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_search", {
          query: params.query,
          projectPath: params.projectPath,
          refresh: params.refresh !== false,
        })
        if (!params.query.trim()) throw new Error("chimera_search requires a non-empty query")
        yield* DiscoveryNudge.noteGraphQuery(ctx.sessionID)
        const instance = yield* InstanceState.context
        const target = Chimera.resolveProjectGraphTarget(params.projectPath, contextProjectRoot(instance))
        const root = target.root
        const dataRoot = getGraphDataRootInfo(root)
        const job = readIndexJob(root)
        if (!CodeGraph.isInitialized(root)) {
          return {
            title: "Chimera search",
            output: [
              ...(target.crossProject ? [`Project: ${root} (cross-project, read-only)`] : []),
              "Static graph evidence (0 results):",
              target.crossProject
                ? "- Chimera graph is not initialized for the projectPath target. Tell the user to run `chimera graph init` and then `chimera graph index` in that project — indexing large repositories can take a long time. Do not initialize another project's graph from this session."
                : "- Chimera graph is not initialized; call `chimera_init_graph` to initialize it for this project.",
            ].join("\n"),
            metadata: {
              initialized: false,
              projectRoot: root,
              crossProject: target.crossProject,
              dataRoot: dataRoot.dataRoot,
              dataRootStatus: dataRoot.dataRootStatus,
              jobStatus: job,
              results: [],
            },
          }
        }
        return yield* catchSchemaMigrationRequired(
          withProjectGraphForTool(
            ctx as Tool.Context,
            params.refresh !== false,
            { init: false, readOnly: true, projectPath: params.projectPath },
          (state) =>
            Effect.gen(function* () {
              const limit = bounded(params.limit, 10, 50)
              const sentenceLike = isSentenceLikeQuery(params.query)
              const effectiveLimit = sentenceLike ? Math.min(limit, SENTENCE_QUERY_TRUNCATED_RESULTS) : limit
              const snapshot = state.graph.snapshot()
              const kinds = params.kind ? [params.kind] : undefined
              const detailed = state.graph.searchNodesDetailed(params.query, { kinds, limit: effectiveLimit })
              // The search core guarantees per-term quota slots, so a multi-word
              // sentence query can exceed effectiveLimit; enforce the cap explicitly.
              const results = sentenceLike ? detailed.results.slice(0, SENTENCE_QUERY_TRUNCATED_RESULTS) : detailed.results
              const enriched = yield* Effect.promise(() => enrichQueryOutput(state, results.map((result) => result.node), { refs: true })).pipe(
                Effect.orDie,
              )

              return {
                title: "Chimera search",
                output: [
                  ...(state.crossProject ? [`Project: ${state.projectRoot} (cross-project, read-only)`] : []),
                  ...(sentenceLike
                    ? [`Query shape: this reads like a natural-language sentence; graph search matches symbol/path prefixes, so only the top ${results.length} loose match(es) are shown. Re-search with identifier, symbol, or path terms for precise evidence, or use grep for literal text.`]
                    : []),
                  `Static graph evidence (${results.length} result${results.length === 1 ? "" : "s"}):`,
                  ...enriched.lines,
                  ...(detailed.terms.length
                    ? [`terms: ${detailed.terms.map((term) => `${term.term}(${term.count})`).join(" ")} · ${detailed.total} candidates before limit`]
                    : []),
                ].join("\n"),
                metadata: {
                  projectRoot: state.projectRoot,
                  crossProject: state.crossProject === true,
                  initialized: true,
                  dataRoot: dataRoot.dataRoot,
                  dataRootStatus: dataRoot.dataRootStatus,
                  jobStatus: job,
                  snapshot,
                  results: results.map((result) => ({
                    ...result,
                    projection: state.graph.projectNode(result.node, snapshot),
                  })),
                },
              }
            }),
          ),
          (error) => ({
            title: "Chimera search",
            output: [
              ...(target.crossProject ? [`Project: ${root} (cross-project, read-only)`] : []),
              "Static graph evidence (0 results):",
              `- ${schemaMigrationStatusLine(error)} ${schemaMigrationGuidance(target.crossProject === true)}`,
            ].join("\n"),
            metadata: {
              initialized: true,
              needsMigration: true,
              schemaVersion: error.currentVersion,
              requiredVersion: error.requiredVersion,
              projectRoot: root,
              crossProject: target.crossProject,
              dataRoot: dataRoot.dataRoot,
              dataRootStatus: dataRoot.dataRootStatus,
              jobStatus: job,
              results: [],
            },
          }),
        )
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
          projectPath: params.projectPath,
          refresh: params.refresh !== false,
        })
        yield* DiscoveryNudge.noteGraphQuery(ctx.sessionID)
        const instance = yield* InstanceState.context
        return yield* catchSchemaMigrationRequired(
          withProjectGraphForTool(
            ctx as Tool.Context,
            params.refresh !== false,
            { init: false, projectPath: params.projectPath },
          (state) =>
            Effect.gen(function* () {
              const limit = bounded(params.limit, 10, 50)
              const kinds = params.kind ? [params.kind] : undefined
              const file = graphFile(state.projectRoot, state.crossProject ? state.projectRoot : instance.directory, params.filePath)
              if (!state.crossProject) {
                yield* Effect.promise(() => syncExistingGraphFiles(state, [file], "force")).pipe(Effect.orDie)
              }
              const fileExists = yield* Effect.promise(() => Bun.file(file.absolutePath).exists()).pipe(Effect.orDie)
              const snapshot = state.graph.snapshot()
              const normalizedFile = file.graphPath
              const results = (params.range
                ? state.graph.nodesIntersectingRange(normalizedFile, params.range, { kinds, smallestOnly: false })
                : state.graph.nodesInFile(normalizedFile).filter((node) => !params.kind || node.kind === params.kind)
              )
                .slice(0, limit)
                .map((node) => ({ node }))
              const enriched = yield* Effect.promise(() => enrichQueryOutput(state, results.map((result) => result.node))).pipe(
                Effect.orDie,
              )

              return {
                title: "Chimera file symbols",
                output: [
                  ...(state.crossProject ? [`Project: ${state.projectRoot} (cross-project, read-only)`] : []),
                  `Static graph evidence (${results.length} result${results.length === 1 ? "" : "s"}):`,
                  ...(results.length === 0 && file.insideGraph && fileExists
                    ? ["- No indexed symbols found. File exists; possible unsupported parser, excluded path, or non-source file."]
                    : []),
                  ...enriched.lines,
                ].join("\n"),
                metadata: {
                  projectRoot: state.projectRoot,
                  crossProject: state.crossProject === true,
                  snapshot,
                  results: results.map((result) => ({
                    ...result,
                    projection: state.graph.projectNode(result.node, snapshot),
                  })),
                },
              }
            }),
          ),
          (error) => {
            const target = Chimera.resolveProjectGraphTarget(params.projectPath, contextProjectRoot(instance))
            return {
              title: "Chimera file symbols",
              output: [
                ...(target.crossProject ? [`Project: ${target.root} (cross-project, read-only)`] : []),
                "Static graph evidence (0 results):",
                `- ${schemaMigrationStatusLine(error)} ${schemaMigrationGuidance(target.crossProject === true)}`,
              ].join("\n"),
              metadata: {
                initialized: true,
                needsMigration: true,
                schemaVersion: error.currentVersion,
                requiredVersion: error.requiredVersion,
                projectRoot: target.root,
                crossProject: target.crossProject,
                results: [],
              },
            }
          },
        )
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraPredesignTool = Tool.define<typeof PredesignParameters, PredesignMetadata, never>(
  "chimera_predesign",
  Effect.succeed({
    description: PREDESIGN_DESCRIPTION,
    parameters: PredesignParameters,
    execute: (params: Schema.Schema.Type<typeof PredesignParameters>, ctx: Tool.Context<PredesignMetadata>) =>
      Effect.gen(function* () {
        const intent = params.intent.trim()
        if (!intent) throw new Error("chimera_predesign requires a non-empty intent")
        const files = cleanStrings(params.files)
        const symbols = cleanStrings(params.symbols)
        const refs = cleanStrings(params.refs)
        const nodeIDs = uniqueStrings([...cleanStrings(params.nodeIDs), ...chimeraRefIDs(refs, ["node"])])
        yield* predesignStage(
          ctx,
          "permission",
          permission(ctx, "chimera_predesign", {
            intent,
            files,
            symbols,
            refs,
            nodeIDs,
            refresh: params.refresh !== false,
          }),
          PREDESIGN_PERMISSION_TIMEOUT_MS,
        )
        const instance = yield* InstanceState.context
        const state = yield* predesignStage(
          ctx,
          "open graph",
          openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false),
        )
        const depth = bounded(params.depth, 2, 5)
        const limit = bounded(params.limit, 30, 100)
        const graphFiles = graphFilesFromPaths(state.projectRoot, instance.directory, files)
        yield* predesignStage(
          ctx,
          "sync files",
          graphFiles.length
            ? Effect.promise(() => syncExistingGraphFiles(state, graphFiles, "force")).pipe(Effect.orDie)
            : Effect.void,
        )
        const normalizedFiles = graphFiles.map((file) => file.graphPath)
        const snapshot = state.graph.snapshot()
        const { seedNodes, impact } = yield* predesignStage(
          ctx,
          "build impact",
          Effect.sync(() => {
            const seedNodes = uniqueNodes([
              ...nodeIDs.flatMap((nodeID) => {
                const node = state.graph.node(nodeID)
                return node ? [node] : []
              }),
              ...symbols.flatMap((symbol) => state.graph.searchNodes(symbol, { limit: 5 }).map((result) => result.node)),
              ...normalizedFiles.flatMap((file) => state.graph.nodesInFile(file).slice(0, 5)),
            ]).slice(0, limit)
            return {
              seedNodes,
              impact: buildImpactEvidence({
                state,
                snapshot,
                seedNodes,
                changedFiles: normalizedFiles,
                changeFacts: [],
                normalizedFile: normalizedFiles[0],
                source: "input",
                depth,
                limit,
              }),
            }
          }),
        )
        const projectedSeeds = seedNodes.map((node) => state.graph.projectNode(node, snapshot))
        const projectedImpacted = impact.impactedNodes.map((node) => state.graph.projectNode(node, snapshot))
        const coverage = {
          files: normalizedFiles.length,
          symbols: symbols.length,
          nodeIDs: nodeIDs.length,
          preciseFiles: normalizedFiles.length > 0,
        }
        const record = yield* predesignStage(
          ctx,
          "record run",
          Effect.promise(() =>
            recordPredesignRun(state.projectRoot, predesignArtifact(state.artifact), {
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              agent: ctx.agent,
              intent,
              files: normalizedFiles,
              seedNodes: projectedSeeds,
              impactedNodes: projectedImpacted,
              fileDependents: impact.fileDependents,
              evidence: impact.evidence,
              snapshotRevision: snapshot.revision,
              payload: {
                coverage,
                depth,
                limit,
                symbols,
                refs,
                nodeIDs,
                sessionMetadata: { snapshot, coverage },
              },
            }),
          ).pipe(Effect.orDie),
        )

        return yield* predesignStage(
          ctx,
          "return result",
          Effect.sync(() => ({
            title: "Chimera pre-design",
            output: [
              "Chimera pre-design evidence recorded.",
              `Run: ${record.id}`,
              `Ref: ${chimeraRef("predesign", record.id)}`,
              `Intent: ${intent}`,
              `Graph revision: ${snapshot.revision}`,
              "",
              "Coverage:",
              `- files: ${inlinePreview(normalizedFiles)}`,
              `- symbols: ${inlinePreview(symbols)}`,
              `- refs: ${inlinePreview(refs)}`,
              `- nodeIDs: ${inlinePreview(nodeIDs)}`,
              coverage.preciseFiles ? "- file coverage: explicit" : "- file coverage: session-level only; rerun with files for stricter coverage.",
              "",
              "Evidence summary:",
              `- seeds: ${seedNodes.length} symbol(s); file dependents: ${impact.fileDependents.length}; impacted symbols: ${impact.impactedNodes.length}; evidence items: ${impact.evidence.length}`,
              ...(impact.fileDependents.length ? [`- top dependents: ${impact.fileDependents.slice(0, 3).join(", ")}`] : []),
              ...(impact.impactedNodes.length
                ? [`- top impacted: ${impact.impactedNodes.slice(0, 3).map((node) => `${node.qualifiedName || node.name} (${node.kind})`).join("; ")}`]
                : []),
              "- Full evidence is stored in this run; mutations covered by this pre-design are audited automatically at edit time.",
              "- Drill down only when a dependent needs inspection: chimera_impact with the refs above, or chimera_predesign rerun with narrower files.",
            ].join("\n"),
            metadata: {
              projectRoot: state.projectRoot,
              snapshot,
              runID: record.id,
              ref: chimeraRef("predesign", record.id),
              intent,
              files: normalizedFiles,
              seeds: projectedSeeds,
              impacted: projectedImpacted,
              fileDependents: impact.fileDependents,
              evidence: impact.evidence,
              coverage,
            },
          })),
        )
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
          ref: params.ref,
          symbol: params.symbol,
          nodeID: params.nodeID,
          filePath: params.filePath,
          projectPath: params.projectPath,
          refresh: params.refresh !== false,
        })
        yield* DiscoveryNudge.noteGraphQuery(ctx.sessionID)
        const instance = yield* InstanceState.context
        return yield* catchSchemaMigrationRequired(
          withProjectGraphForTool(
            ctx as Tool.Context,
            params.refresh !== false,
            { init: false, projectPath: params.projectPath },
          (state) =>
            Effect.gen(function* () {
              const depth = bounded(params.depth, 2, 5)
              const limit = bounded(params.limit, 20, 100)
              const file = params.filePath ? graphFile(state.projectRoot, state.crossProject ? state.projectRoot : instance.directory, params.filePath) : undefined
              if (file && !state.crossProject) {
                yield* Effect.promise(() => syncExistingGraphFiles(state, [file], "force")).pipe(Effect.orDie)
              }
              const snapshot = state.graph.snapshot()
              const normalizedFile = file?.graphPath
              const kinds = params.kind ? [params.kind] : undefined
              const nodeID = chimeraRefID(params.ref, ["node"]) ?? params.nodeID?.trim()
              const symbolResults = params.symbol ? state.graph.searchNodes(params.symbol, { kinds, limit: 5 }) : []
              const seedNodes = uniqueNodes(
                nodeID
                  ? [state.graph.node(nodeID)].filter((node): node is CodeGraphNode => Boolean(node))
                  : normalizedFile && params.range
                    ? state.graph.nodesIntersectingRange(normalizedFile, params.range, { kinds, smallestOnly: false })
                    : params.symbol
                      ? symbolResults.map((result) => result.node)
                      : normalizedFile
                        ? state.graph.nodesInFile(normalizedFile).filter((node) => !params.kind || node.kind === params.kind).slice(0, 5)
                        : [],
              )
              if (seedNodes.length === 0 && !normalizedFile) {
                const candidates = uniqueNodes([
                  ...symbolResults.map((result) => result.node),
                  ...(symbolResults.length === 0 && params.symbol
                    ? symbolCandidateTerms(params.symbol).flatMap((term) =>
                        state.graph.searchNodes(term, { kinds, limit: 5 }).map((result) => result.node),
                      )
                    : []),
                ]).slice(0, 5)
                return {
                  title: "Chimera impact",
                  output: [
                    ...(state.crossProject ? [`Project: ${state.projectRoot} (cross-project, read-only)`, ""] : []),
                    "Static graph evidence:",
                    "",
                    "Seed symbols:",
                    "- No graph seed resolved for the provided ref/nodeID/symbol.",
                    "",
                    `Closest symbol candidates (${candidates.length}):`,
                    ...(candidates.length ? candidates.map((node) => formatNode(node)) : ["- None found."]),
                  ].join("\n"),
                  metadata: {
                    projectRoot: state.projectRoot,
                    crossProject: state.crossProject === true,
                    snapshot,
                    seeds: [],
                    impacted: [],
                    fileDependents: [],
                    evidence: [],
                  },
                }
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
                  ...(state.crossProject ? [`Project: ${state.projectRoot} (cross-project, read-only)`, ""] : []),
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
                ].join("\n"),
                metadata: {
                  projectRoot: state.projectRoot,
                  crossProject: state.crossProject === true,
                  snapshot,
                  seeds: seedNodes.map((node) => state.graph.projectNode(node, snapshot)),
                  impacted: impact.impactedNodes.map((node) => state.graph.projectNode(node, snapshot)),
                  fileDependents: impact.fileDependents,
                  evidence: impact.evidence,
                },
              }
            }),
          ),
          (error) => {
            const target = Chimera.resolveProjectGraphTarget(params.projectPath, contextProjectRoot(instance))
            return {
              title: "Chimera impact",
              output: [
                ...(target.crossProject ? [`Project: ${target.root} (cross-project, read-only)`] : []),
                "Static graph evidence:",
                `- ${schemaMigrationStatusLine(error)} ${schemaMigrationGuidance(target.crossProject === true)}`,
              ].join("\n"),
              metadata: {
                needsMigration: true,
                schemaVersion: error.currentVersion,
                requiredVersion: error.requiredVersion,
                projectRoot: target.root,
                crossProject: target.crossProject,
                seeds: [],
                impacted: [],
                fileDependents: [],
                evidence: [],
              },
            }
          },
        )
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
          throw new Error("chimera_audit requires files/filePath, symbol, ref, or nodeID. Use chimera_audit_recent after a tool mutation.")
        }
        yield* permission(ctx, "chimera_audit", {
          files: params.files,
          filePath: params.filePath,
          symbol: params.symbol,
          ref: params.ref,
          nodeID: params.nodeID,
          refresh: params.refresh !== false,
        })
        const audit = yield* buildAudit({ ...params, recent: false }, { ctx: ctx as Tool.Context })
        const auditRunID = yield* persistAuditRun(audit)
        const recorded = { ...audit, auditRunID, ref: chimeraRef("audit", auditRunID) }

        return {
          title: "Chimera audit",
          output: formatAuditOutput(recorded),
          metadata: recorded,
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
        const auditRunID = yield* persistAuditRun(audit)
        const recorded = { ...audit, auditRunID, ref: chimeraRef("audit", auditRunID) }

        return {
          title: "Chimera audit",
          output: formatAuditOutput(recorded),
          metadata: recorded,
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraOracleRecentTool = Tool.define<typeof OracleRecentParameters, OracleMetadata, never>(
  "chimera_oracle_recent",
  Effect.succeed({
    description: ORACLE_RECENT_DESCRIPTION,
    parameters: OracleRecentParameters,
    execute: (params: OracleRecentParams, ctx: Tool.Context<OracleMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_oracle_recent", {
          limit: params.limit,
          includePassing: params.includePassing ?? false,
        })
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, false)
        const artifact = oracleArtifact(state.artifact)
        const oracles = yield* Effect.promise(() =>
          readOracleResults(state.projectRoot, artifact, {
            sessionID: ctx.sessionID,
            limit: bounded(params.limit, 20, 100),
            includePassing: params.includePassing ?? false,
          }),
        ).pipe(Effect.orDie)
        const currentRevision = state.graph.snapshot().revision
        const failingOrUnknown = oracles.filter((oracle) => oracle.status === "fail" || oracle.status === "unknown")
        const followup = swarmFollowupData({ count: failingOrUnknown.length, source: "oracle", preset: "oracle-followup" })
        const output = {
          oracles: oracles.map((record) => oracleEnvelope(record, 2_000, currentRevision)),
          ...(followup ? { swarmFollowup: followup } : {}),
        }
        return {
          title: "Chimera oracle results",
          output: JSON.stringify(output, null, 2),
          metadata: {
            projectRoot: state.projectRoot,
            artifact,
            action: "recent" as const,
            oracles,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraOracleGetTool = Tool.define<typeof OracleGetParameters, OracleMetadata, never>(
  "chimera_oracle_get",
  Effect.succeed({
    description: ORACLE_GET_DESCRIPTION,
    parameters: OracleGetParameters,
    execute: (params: OracleGetParams, ctx: Tool.Context<OracleMetadata>) =>
      Effect.gen(function* () {
        const oracleID = requiredChimeraID({
          ref: params.ref,
          legacy: params.oracleID,
          legacyName: "oracleID",
          expected: "oracle",
          label: "chimera_oracle_get",
        })
        yield* permission(ctx, "chimera_oracle_get", { ref: params.ref, oracleID: params.oracleID })
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, false)
        const artifact = oracleArtifact(state.artifact)
        const oracle = yield* Effect.promise(() => readOracleResult(state.projectRoot, artifact, oracleID)).pipe(Effect.orDie)
        if (!oracle) throw new Error(`unknown Chimera oracle result: ${oracleID}`)
        const output = oracleEnvelope(oracle, outputCharLimit(params.maxOutputChars), state.graph.snapshot().revision)
        return {
          title: "Chimera oracle result",
          output: JSON.stringify(output, null, 2),
          metadata: {
            projectRoot: state.projectRoot,
            artifact,
            action: "get" as const,
            oracle,
            oracles: [oracle],
          },
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
            ...swarmFollowupGuidance({ count: obligations.filter((item) => item.status !== "stale").length, source: "obligation", preset: "audit-followup" }),
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
          ref: params.ref,
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
        const obligations = result.touched.slice(0, bounded(params.limit, 20, 100))
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
            ...swarmFollowupGuidance({ count: obligations.filter((item) => item.status !== "stale").length, source: "obligation", preset: "audit-followup" }),
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
        const obligationID = requiredChimeraID({
          ref: params.ref,
          legacy: params.obligationID,
          legacyName: "obligationID",
          expected: "obligation",
          label: "chimera_obligation_claim",
        })
        yield* permission(ctx, "chimera_obligation_claim", { ref: params.ref, obligationID: params.obligationID })
        const current = yield* obligationContext(ctx as Tool.Context, true)
        const next = {
          schemaVersion: 1 as const,
          obligations: current.refreshed.obligations.map((item) =>
            item.id === obligationID
              ? { ...item, status: "claimed" as const, claimedBy: actor(ctx, current.now), updatedAt: current.now }
              : item,
          ),
        }
        if (!current.refreshed.obligations.some((item) => item.id === obligationID)) {
          throw new Error(`unknown Chimera obligation: ${obligationID}`)
        }
        yield* writeObligationStore(current.state.projectRoot, current.artifact, next)
        const obligations = next.obligations.filter((item) => item.id === obligationID)
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
        const obligationID = requiredChimeraID({
          ref: params.ref,
          legacy: params.obligationID,
          legacyName: "obligationID",
          expected: "obligation",
          label: "chimera_obligation_resolve",
        })
        yield* permission(ctx, "chimera_obligation_resolve", { ref: params.ref, obligationID: params.obligationID })
        const current = yield* obligationContext(ctx as Tool.Context, true)
        const next = {
          schemaVersion: 1 as const,
          obligations: current.refreshed.obligations.map((item) =>
            item.id === obligationID
              ? {
                  ...item,
                  status: "resolved" as const,
                  resolvedBy: { ...actor(ctx, current.now), note: params.note },
                  updatedAt: current.now,
                }
              : item,
          ),
        }
        if (!current.refreshed.obligations.some((item) => item.id === obligationID)) {
          throw new Error(`unknown Chimera obligation: ${obligationID}`)
        }
        yield* writeObligationStore(current.state.projectRoot, current.artifact, next)
        const obligations = next.obligations.filter((item) => item.id === obligationID)
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
        const obligationID = requiredChimeraID({
          ref: params.ref,
          legacy: params.obligationID,
          legacyName: "obligationID",
          expected: "obligation",
          label: "chimera_obligation_ignore",
        })
        yield* permission(ctx, "chimera_obligation_ignore", { ref: params.ref, obligationID: params.obligationID })
        const current = yield* obligationContext(ctx as Tool.Context, true)
        const next = {
          schemaVersion: 1 as const,
          obligations: current.refreshed.obligations.map((item) =>
            item.id === obligationID
              ? {
                  ...item,
                  status: "ignored" as const,
                  ignoredBy: { ...actor(ctx, current.now), reason: params.reason, note: params.note },
                  updatedAt: current.now,
                }
              : item,
          ),
        }
        if (!current.refreshed.obligations.some((item) => item.id === obligationID)) {
          throw new Error(`unknown Chimera obligation: ${obligationID}`)
        }
        yield* writeObligationStore(current.state.projectRoot, current.artifact, next)
        const obligations = next.obligations.filter((item) => item.id === obligationID)
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
          ref: params.ref,
          nodeID: params.nodeID,
          filePath: params.filePath,
          mode: params.mode ?? "search",
          refresh: params.refresh !== false,
        })
        const instance = yield* InstanceState.context
        const state = yield* openProjectGraphForTool(ctx as Tool.Context, params.refresh !== false)
        const mode: ContextMetadata["mode"] = params.mode ?? "search"
        const nodeID = chimeraRefID(params.ref, ["node"]) ?? params.nodeID?.trim()
        const node = nodeID ? state.graph.node(nodeID) : undefined
        const file = params.filePath ? graphFile(state.projectRoot, instance.directory, params.filePath) : undefined
        if (file) yield* Effect.promise(() => syncExistingGraphFiles(state, [file], "force")).pipe(Effect.orDie)
        const normalizedFile = file?.graphPath
        const query =
          params.query ??
          params.symbol ??
          node?.qualifiedName ??
          normalizedFile ??
          (mode === "arch" ? "architecture overview main modules project structure" : undefined)

        if (!query) throw new Error("chimera_context requires query, symbol, ref, nodeID, filePath, or mode=arch")

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
