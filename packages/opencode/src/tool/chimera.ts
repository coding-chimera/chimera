import path from "path"
import { createHash } from "crypto"
import { mkdir } from "fs/promises"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import {
  Chimera,
  type CodeGraphNode,
  type CodeGraphSnapshot,
  type FrozenSemanticObject,
  type ProjectGraphState,
  type ToolMutationRecord,
} from "@/chimera"
import * as Tool from "./tool"

const NodeKind = Schema.Union([
  Schema.Literal("file"),
  Schema.Literal("module"),
  Schema.Literal("class"),
  Schema.Literal("struct"),
  Schema.Literal("interface"),
  Schema.Literal("trait"),
  Schema.Literal("protocol"),
  Schema.Literal("function"),
  Schema.Literal("method"),
  Schema.Literal("property"),
  Schema.Literal("field"),
  Schema.Literal("variable"),
  Schema.Literal("constant"),
  Schema.Literal("enum"),
  Schema.Literal("enum_member"),
  Schema.Literal("type_alias"),
  Schema.Literal("namespace"),
  Schema.Literal("parameter"),
  Schema.Literal("import"),
  Schema.Literal("export"),
  Schema.Literal("route"),
  Schema.Literal("component"),
])

const ContextMode = Schema.Union([
  Schema.Literal("arch"),
  Schema.Literal("search"),
  Schema.Literal("impact"),
  Schema.Literal("audit"),
])

const ObligationAction = Schema.Union([
  Schema.Literal("list"),
  Schema.Literal("sync"),
  Schema.Literal("claim"),
  Schema.Literal("resolve"),
  Schema.Literal("ignore"),
])

const ObligationStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("claimed"),
  Schema.Literal("resolved"),
  Schema.Literal("ignored"),
  Schema.Literal("stale"),
])

const Range = Schema.Struct({
  startLine: Schema.Number,
  endLine: Schema.optional(Schema.Number),
  startColumn: Schema.optional(Schema.Number),
  endColumn: Schema.optional(Schema.Number),
})

export const StatusParameters = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "Sync CodeGraph before returning status. Defaults to true.",
  }),
})

export const SearchParameters = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description: "Symbol or text query to search in the CodeGraph index.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Optional file path to list indexed symbols from, absolute or project-relative.",
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
    description: "Sync CodeGraph before searching. Defaults to true.",
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
    description: "Sync CodeGraph before impact analysis. Defaults to true.",
  }),
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
    description: "Sync CodeGraph before building context. Defaults to true.",
  }),
})

export const AuditParameters = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Changed files to audit, absolute or project-relative. If omitted, audit can use the latest tool mutation.",
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
  recent: Schema.optional(Schema.Boolean).annotate({
    description: "Use the latest successful Chimera tool mutation when files/symbol/nodeID are omitted. Defaults to true.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Impact traversal depth. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum candidate obligations to return. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "Sync CodeGraph before auditing. Defaults to true.",
  }),
})

export const ObligationsParameters = Schema.Struct({
  action: Schema.optional(ObligationAction).annotate({
    description: "Obligation operation. Defaults to list.",
  }),
  obligationID: Schema.optional(Schema.String).annotate({
    description: "Obligation id for claim, resolve, or ignore actions.",
  }),
  status: Schema.optional(ObligationStatus).annotate({
    description: "Optional status filter for list.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Resolution note for resolve, or additional context for ignore.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Required reason for ignore.",
  }),
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
  recent: Schema.optional(Schema.Boolean).annotate({
    description: "Use the latest successful Chimera tool mutation for sync when no files/symbol/nodeID are supplied. Defaults to true.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Impact traversal depth for sync. Defaults to 2, capped at 5.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum obligations to list or sync. Defaults to 30, capped at 100.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "Sync CodeGraph before listing or syncing obligations. Defaults to true.",
  }),
})

type StatusMetadata = {
  projectRoot: string
  artifact: string
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

type ChangeClassification = "source" | "test" | "docs" | "config" | "dependency" | "api_route" | "unknown"

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
  type: "changed_file" | "changed_seed" | "file_dependency" | "impact_radius" | "context_selection"
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
    counts: ObligationCounts
    active: PersistentObligation[]
  }
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

function uniqueNodes(nodes: CodeGraphNode[]) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()]
}

function uniqueStrings(items: string[]) {
  return [...new Set(items)]
}

function classifyFile(filePath: string): { classification: ChangeClassification; reason: string } {
  const lower = filePath.toLowerCase()
  const basename = path.basename(lower)
  if (
    basename === "package.json" ||
    basename.endsWith(".lock") ||
    basename === "bun.lockb" ||
    basename === "cargo.toml" ||
    basename === "go.mod" ||
    basename === "requirements.txt"
  ) {
    return { classification: "dependency", reason: "dependency manifest or lockfile boundary" }
  }
  if (lower.includes("/test/") || lower.includes("/tests/") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    return { classification: "test", reason: "test or spec file boundary" }
  }
  if (/\.(md|mdx|rst|adoc|txt)$/.test(lower) || lower.includes("/docs/") || lower.includes("/specs/")) {
    return { classification: "docs", reason: "documentation or specification boundary" }
  }
  if (
    lower.includes("/route") ||
    lower.includes("/routes/") ||
    lower.includes("/api/") ||
    lower.includes("/httpapi/") ||
    lower.includes("/server/")
  ) {
    return { classification: "api_route", reason: "route/server/API boundary" }
  }
  if (
    basename.startsWith(".") ||
    basename.includes("config") ||
    basename === "tsconfig.json" ||
    basename === "vite.config.ts" ||
    basename === "drizzle.config.ts"
  ) {
    return { classification: "config", reason: "configuration boundary" }
  }
  if (/\.[cm]?[jt]sx?$|\.tsx?$|\.rs$|\.go$|\.py$|\.java$|\.kt$|\.swift$/.test(lower)) {
    return { classification: "source", reason: "source implementation file" }
  }
  return { classification: "unknown", reason: "unclassified file boundary" }
}

function riskForClassification(classification: ChangeClassification): RiskCategory {
  if (classification === "dependency") return "dependency"
  if (classification === "test") return "test"
  if (classification === "docs") return "documentation"
  if (classification === "config") return "configuration"
  if (classification === "api_route") return "api_contract"
  if (classification === "source") return "behavior_boundary"
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

function formatCauseChain(causeChain: CauseLink[]) {
  return causeChain.map((item) => `${item.type}:${item.target} (${item.evidence})`).join(" -> ")
}

function formatClassification(item: { file: string; classification: ChangeClassification; reason: string }) {
  return `- ${item.file}: ${item.classification}\n  reason: ${item.reason}`
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

function buildImpactEvidence(input: {
  state: ProjectGraphState
  snapshot: CodeGraphSnapshot
  seedNodes: CodeGraphNode[]
  changedFiles: string[]
  normalizedFile?: string
  source: AuditMetadata["source"] | "context_selection"
  depth: number
  limit: number
}) {
  const impactedNodes = uniqueNodes(
    input.seedNodes.flatMap((node) => [...input.state.graph.impactRadius(node.id, input.depth).nodes.values()]).slice(0, input.limit),
  ).filter((node) => !input.seedNodes.some((seed) => seed.id === node.id))
  const fileDependents = uniqueStrings(
    [
      ...(input.normalizedFile ? input.state.graph.fileDependents(input.normalizedFile) : []),
      ...input.changedFiles.flatMap((file) => input.state.graph.fileDependents(file)),
      ...input.seedNodes.flatMap((node) => input.state.graph.fileDependents(node.filePath)),
    ].slice(0, input.limit),
  )
  const seedNames = input.seedNodes.map((node) => node.qualifiedName || node.name).slice(0, 5)
  const cause = sourceCause(input.source, input.changedFiles, seedNames)
  const evidence = uniqueCandidates([
    ...fileDependents.map((file) => {
      const classification = classifyFile(file).classification
      return {
        target: file,
        reason: `dependent file may need review because it imports or depends on ${input.changedFiles.slice(0, 3).join(", ") || seedNames.join(", ") || "the changed seed"}`,
        risk: riskForFile(file),
        classification,
        requiredAction: "review_or_update" as const,
        evidence: "codegraph:file_dependents",
        causeChain: [cause, { type: "file_dependency" as const, target: file, evidence: "codegraph:file_dependents" }],
      }
    }),
    ...impactedNodes.map((node) => {
      const classification = classifyFile(node.filePath).classification
      return {
        target: `${node.filePath}:${node.startLine} ${node.qualifiedName || node.name}`,
        targetNode: input.state.graph.projectNode(node, input.snapshot),
        reason: `${riskReasonForNode(node)}; symbol is inside impact radius of ${seedNames.join(", ") || input.changedFiles.slice(0, 3).join(", ") || "the changed seed"}`,
        risk: riskForNode(node),
        classification,
        requiredAction: "review_or_update" as const,
        evidence: "codegraph:impact_radius",
        causeChain: [
          cause,
          {
            type: "impact_radius" as const,
            target: `${node.filePath}:${node.startLine} ${node.qualifiedName || node.name}`,
            evidence: "codegraph:impact_radius",
          },
        ],
      }
    }),
  ]).slice(0, input.limit)
  return { impactedNodes, fileDependents, evidence }
}

function permission(ctx: Tool.Context, toolID: string, metadata: Record<string, unknown>) {
  return ctx.ask({
    permission: toolID,
    patterns: ["*"],
    always: ["*"],
    metadata,
  })
}

function provenanceRecordCount(artifact: string) {
  return Effect.promise(async () => {
    if (!(await Bun.file(artifact).exists())) return 0
    const text = await Bun.file(artifact).text()
    return text.trim() ? text.trim().split("\n").length : 0
  })
}

function provenanceRecords(artifact: string) {
  return Effect.promise(async () => {
    if (!(await Bun.file(artifact).exists())) return [] as ToolMutationRecord[]
    const text = await Bun.file(artifact).text()
    if (!text.trim()) return [] as ToolMutationRecord[]
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ToolMutationRecord)
  })
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

function candidateKey(candidate: AuditCandidate) {
  return `${candidate.target}:${candidate.evidence}:${candidate.classification}:${candidate.reason}`
}

function uniqueCandidates(candidates: AuditCandidate[]) {
  return [...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values()]
}

type AuditParams = Schema.Schema.Type<typeof AuditParameters>

type ObligationsParams = Schema.Schema.Type<typeof ObligationsParameters>

function obligationsArtifact(provenanceArtifact: string) {
  return path.join(path.dirname(provenanceArtifact), "obligations.json")
}

function emptyObligationStore(): ObligationStore {
  return { schemaVersion: 1, obligations: [] }
}

function readObligationStore(artifact: string) {
  return Effect.promise(async () => {
    if (!(await Bun.file(artifact).exists())) return emptyObligationStore()
    return (await Bun.file(artifact).json()) as ObligationStore
  })
}

function readObligationSummary(provenanceArtifact: string, limit = 10) {
  return Effect.gen(function* () {
    const artifact = obligationsArtifact(provenanceArtifact)
    const store = yield* readObligationStore(artifact)
    return {
      artifact,
      counts: obligationCounts(store.obligations),
      active: activeObligations(store.obligations).slice(0, limit),
    }
  })
}

function writeObligationStore(artifact: string, store: ObligationStore) {
  return Effect.promise(async () => {
    await mkdir(path.dirname(artifact), { recursive: true })
    await Bun.write(artifact, `${JSON.stringify(store, null, 2)}\n`)
  })
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

function filterObligations(obligations: PersistentObligation[], params: ObligationsParams) {
  return (params.status ? obligations.filter((item) => item.status === params.status) : activeObligations(obligations)).slice(
    0,
    bounded(params.limit, 30, 100),
  )
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
    `- Artifact: ${overlay.obligations.artifact}`,
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

const buildAudit = Effect.fn("ChimeraTool.buildAudit")(function* (params: AuditParams) {
  const instance = yield* InstanceState.context
  const state = yield* Chimera.openProjectGraph({ sync: params.refresh !== false })
  const records = yield* provenanceRecords(state.artifact)
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

  const impact = buildImpactEvidence({ state, snapshot, seedNodes, changedFiles, source, depth, limit })

  return {
    projectRoot: state.projectRoot,
    snapshot,
    source,
    changedFiles,
    classifications: changedFiles.map((file) => ({ file, ...classifyFile(file) })),
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
    description:
      "Show Chimera/CodeGraph graph readiness, snapshot, backend, freshness, and provenance status. May initialize or sync .codegraph.",
    parameters: StatusParameters,
    execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context<StatusMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_status", { refresh: params.refresh !== false })
        const state = yield* Chimera.openProjectGraph({ sync: params.refresh !== false })
        const snapshot = state.graph.snapshot()
        const stats = state.graph.stats()
        const provenanceRecords = yield* provenanceRecordCount(state.artifact)
        const obligations = yield* readObligationSummary(state.artifact, 0)

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
            `Tool provenance records: ${provenanceRecords}`,
            `Pending obligations: ${obligations.counts.pending}`,
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            artifact: state.artifact,
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
    description:
      "Search Chimera's CodeGraph-backed graph surface by symbol/text, file, or source range. Returns graph evidence, not raw file reads.",
    parameters: SearchParameters,
    execute: (params: Schema.Schema.Type<typeof SearchParameters>, ctx: Tool.Context<SearchMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_search", {
          query: params.query,
          filePath: params.filePath,
          refresh: params.refresh !== false,
        })
        const instance = yield* InstanceState.context
        const state = yield* Chimera.openProjectGraph({ sync: params.refresh !== false })
        const limit = bounded(params.limit, 10, 50)
        const snapshot = state.graph.snapshot()
        const kinds = params.kind ? [params.kind] : undefined
        const normalizedFile = params.filePath ? graphPath(state.projectRoot, instance.directory, params.filePath) : undefined
        const results = normalizedFile
          ? (params.range
              ? state.graph.nodesIntersectingRange(normalizedFile, params.range, { kinds, smallestOnly: false })
              : state.graph.nodesInFile(normalizedFile).filter((node) => !params.kind || node.kind === params.kind)
            )
              .slice(0, limit)
              .map((node) => ({ node }))
          : params.query
            ? state.graph.searchNodes(params.query, { kinds, limit })
            : []

        if (!normalizedFile && !params.query) throw new Error("chimera_search requires either query or filePath")

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

export const ChimeraImpactTool = Tool.define<typeof ImpactParameters, ImpactMetadata, never>(
  "chimera_impact",
  Effect.succeed({
    description:
      "Analyze bounded file and symbol impact through Chimera's CodeGraph-backed graph surface. Returns static evidence plus initial risk categories.",
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
        const state = yield* Chimera.openProjectGraph({ sync: params.refresh !== false })
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
    description:
      "Run a first-pass Chimera propagation audit for changed files, a changed symbol, or the latest tool mutation. Produces non-persistent candidate obligations.",
    parameters: AuditParameters,
    execute: (params: Schema.Schema.Type<typeof AuditParameters>, ctx: Tool.Context<AuditMetadata>) =>
      Effect.gen(function* () {
        yield* permission(ctx, "chimera_audit", {
          files: params.files,
          filePath: params.filePath,
          symbol: params.symbol,
          nodeID: params.nodeID,
          recent: params.recent !== false,
          refresh: params.refresh !== false,
        })
        const audit = yield* buildAudit(params)

        return {
          title: "Chimera audit",
          output: formatAuditOutput(audit),
          metadata: audit,
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraObligationsTool = Tool.define<typeof ObligationsParameters, ObligationsMetadata, never>(
  "chimera_obligations",
  Effect.succeed({
    description:
      "Persist and manage Chimera audit obligations. Sync converts CodeGraph-backed audit candidates into trackable pending/claimed/resolved/ignored/stale obligations.",
    parameters: ObligationsParameters,
    execute: (params: ObligationsParams, ctx: Tool.Context<ObligationsMetadata>) =>
      Effect.gen(function* () {
        const action = params.action ?? "list"
        yield* permission(ctx, "chimera_obligations", {
          action,
          obligationID: params.obligationID,
          status: params.status,
          files: params.files,
          filePath: params.filePath,
          symbol: params.symbol,
          nodeID: params.nodeID,
          recent: params.recent !== false,
          refresh: params.refresh !== false,
        })
        const state = yield* Chimera.openProjectGraph({ sync: params.refresh !== false })
        const artifact = obligationsArtifact(state.artifact)
        const now = new Date().toISOString()
        const store = yield* readObligationStore(artifact)

        if (action === "sync") {
          const audit = yield* buildAudit(params)
          const result = upsertObligations(store, audit, now)
          yield* writeObligationStore(artifact, result.store)
          const obligations = result.touched.slice(0, bounded(params.limit, 30, 100))
          const counts = obligationCounts(result.store.obligations)
          return {
            title: "Chimera obligations",
            output: [
              "Chimera obligations synced from propagation audit.",
              `Artifact: ${artifact}`,
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
              action,
              counts,
              obligations,
              synced: result.synced,
              updated: result.updated,
              audit,
            },
          }
        }

        const refreshed = params.refresh === false ? store : refreshStaleObligations(store, state, now)
        if (params.refresh !== false) yield* writeObligationStore(artifact, refreshed)

        if (action === "claim") {
          if (!params.obligationID) throw new Error("chimera_obligations action=claim requires obligationID")
          const next = {
            schemaVersion: 1 as const,
            obligations: refreshed.obligations.map((item) =>
              item.id === params.obligationID
                ? { ...item, status: "claimed" as const, claimedBy: actor(ctx, now), updatedAt: now }
                : item,
            ),
          }
          if (!refreshed.obligations.some((item) => item.id === params.obligationID)) {
            throw new Error(`unknown Chimera obligation: ${params.obligationID}`)
          }
          yield* writeObligationStore(artifact, next)
          const obligations = next.obligations.filter((item) => item.id === params.obligationID)
          return {
            title: "Chimera obligations",
            output: [
              "Chimera obligation claimed.",
              `Artifact: ${artifact}`,
              "",
              ...obligations.map(formatObligation),
            ].join("\n"),
            metadata: {
              projectRoot: state.projectRoot,
              artifact,
              action,
              counts: obligationCounts(next.obligations),
              obligations,
            },
          }
        }

        if (action === "resolve") {
          if (!params.obligationID) throw new Error("chimera_obligations action=resolve requires obligationID")
          const next = {
            schemaVersion: 1 as const,
            obligations: refreshed.obligations.map((item) =>
              item.id === params.obligationID
                ? { ...item, status: "resolved" as const, resolvedBy: { ...actor(ctx, now), note: params.note }, updatedAt: now }
                : item,
            ),
          }
          if (!refreshed.obligations.some((item) => item.id === params.obligationID)) {
            throw new Error(`unknown Chimera obligation: ${params.obligationID}`)
          }
          yield* writeObligationStore(artifact, next)
          const obligations = next.obligations.filter((item) => item.id === params.obligationID)
          return {
            title: "Chimera obligations",
            output: [
              "Chimera obligation resolved.",
              `Artifact: ${artifact}`,
              "",
              ...obligations.map(formatObligation),
            ].join("\n"),
            metadata: {
              projectRoot: state.projectRoot,
              artifact,
              action,
              counts: obligationCounts(next.obligations),
              obligations,
            },
          }
        }

        if (action === "ignore") {
          const reason = params.reason ?? params.note
          if (!params.obligationID) throw new Error("chimera_obligations action=ignore requires obligationID")
          if (!reason) throw new Error("chimera_obligations action=ignore requires reason")
          const next = {
            schemaVersion: 1 as const,
            obligations: refreshed.obligations.map((item) =>
              item.id === params.obligationID
                ? { ...item, status: "ignored" as const, ignoredBy: { ...actor(ctx, now), reason, note: params.note }, updatedAt: now }
                : item,
            ),
          }
          if (!refreshed.obligations.some((item) => item.id === params.obligationID)) {
            throw new Error(`unknown Chimera obligation: ${params.obligationID}`)
          }
          yield* writeObligationStore(artifact, next)
          const obligations = next.obligations.filter((item) => item.id === params.obligationID)
          return {
            title: "Chimera obligations",
            output: [
              "Chimera obligation ignored.",
              `Artifact: ${artifact}`,
              "",
              ...obligations.map(formatObligation),
            ].join("\n"),
            metadata: {
              projectRoot: state.projectRoot,
              artifact,
              action,
              counts: obligationCounts(next.obligations),
              obligations,
            },
          }
        }

        const obligations = filterObligations(refreshed.obligations, params)
        const counts = obligationCounts(refreshed.obligations)
        return {
          title: "Chimera obligations",
          output: [
            "Chimera obligations.",
            `Artifact: ${artifact}`,
            formatCounts(counts),
            "",
            `Obligations (${obligations.length}):`,
            ...(obligations.length ? obligations.map(formatObligation) : ["- None found."]),
            "",
            "Required action:",
            "- Active obligations should be reviewed, updated, resolved, or ignored with a reason before closeout.",
          ].join("\n"),
          metadata: {
            projectRoot: state.projectRoot,
            artifact,
            action,
            counts,
            obligations,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

export const ChimeraContextTool = Tool.define<typeof ContextParameters, ContextMetadata, never>(
  "chimera_context",
  Effect.succeed({
    description:
      "Build compact Chimera graph context for architecture, search, impact, or audit work. Uses CodeGraph context plus Chimera surface metadata.",
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
        const state = yield* Chimera.openProjectGraph({ sync: params.refresh !== false })
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
        const records = yield* provenanceRecords(state.artifact)
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
          normalizedFile,
          source: "context_selection",
          depth: 2,
          limit: bounded(params.maxNodes, 30, 100),
        })
        const obligations = yield* readObligationSummary(state.artifact, 10)
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
