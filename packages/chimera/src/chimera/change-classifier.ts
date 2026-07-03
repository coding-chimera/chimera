import path from "path"
import { createHash } from "crypto"
import type { CodeGraphAdapter } from "./codegraph-adapter"
import { ProjectionMemo } from "./projection-memo"
import {
  diffFileSemantics,
  diffNodeLanguageSignals,
  diffNodeSemantics,
  diffRelations,
  getFileSemanticInfo,
  type CodeGraphSnapshot,
  type CodePlanStatementEffectEvidence,
  type CodePlanStatementEffectKind,
  type CodePlanStatementEffectNode,
  type FileSemanticInfo,
  type FileSemanticInputNode,
  type FileSemanticSignal,
  type FrozenRelation,
  type FrozenSemanticObject,
  type LanguageAwareSignal,
  type NodeSemanticDiff,
  type RelationDeltaEvidence,
  type SourceRange,
} from "@/graph"
import type { ProvenanceFile, ToolMutationRecord } from "./provenance"

export type ChangeKind = "add" | "modify" | "delete" | "move"
export type ChangeSubjectKind =
  | "file"
  | "body"
  | "signature"
  | "import"
  | "export"
  | "route"
  | "schema"
  | "config"
  | "test"
  | "doc"
  | "unknown"

export type FileClassification = "source" | "test" | "docs" | "config" | "dependency" | "api_route" | "generated" | "unknown"

export type SourceHunk = {
  oldRange?: SourceRange
  newRange?: SourceRange
  addedLines?: number
  removedLines?: number
  diffHash?: string
}

export type ChangeFactEvidence = {
  version: 1
  source: "tool_diff" | "watcher" | "git_diff" | "explicit_input"
  rule: string
  confidenceReason: string
  graph: {
    beforeRevision?: string
    afterRevision: string
  }
  file: {
    path: string
    oldPath?: string
    status?: string
  }
  hunk?: SourceHunk
  beforeNode?: FrozenSemanticObject | null
  afterNode?: FrozenSemanticObject | null
  semanticDiff?: NodeSemanticDiff
  relationDelta?: RelationDeltaEvidence
  languageSignals?: LanguageAwareSignal[]
  statementEffect?: CodePlanStatementEffectEvidence
  fileSemantic?: FileSemanticInfo
  semanticSnapshots?: {
    version: 1
    source: "chimera_semantic_snapshot"
    beforeSnapshotID?: string
    afterSnapshotID?: string
    beforeObjectHashes?: string[]
    afterObjectHashes?: string[]
    beforeRelationHashes?: string[]
    afterRelationHashes?: string[]
  }
  replayLifecycle?: {
    version: 1
    status: "current" | "replayable" | "missing_snapshot_refs" | "stale_revision" | "missing_target"
    reason: string
    sourceRevision?: string
    currentRevision?: string
    expectedRefs?: number
    foundRefs?: number
  }
  signals: string[]
}

export type ChangeFact = {
  schemaVersion: 1
  id: string
  eventID: string
  filePath: string
  oldPath?: string
  nodeID?: string
  nodeKey?: string
  changeKind: ChangeKind
  subjectKind: ChangeSubjectKind
  confidence: number
  evidence: ChangeFactEvidence
  createdAt: string
}

type DiffInfo = {
  filePath: string
  oldPath?: string
  status?: string
  patch: string
  hunks: SourceHunk[]
}

type ProjectionGraph = Pick<CodeGraphAdapter, "nodesInFile" | "projectNode" | "projectNodeWithMemo" | "incidentRelations">

const CALLABLE_KINDS = new Set(["function", "method", "component"])
const CONTAINER_KINDS = new Set(["file", "module"])
const SCHEMA_KINDS = new Set(["interface", "type_alias", "enum", "field", "class", "struct", "property"])

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringValue(input: unknown) {
  return typeof input === "string" && input ? input : undefined
}

function numberValue(input: string | undefined, fallback: number) {
  if (!input) return fallback
  const parsed = Number(input)
  return Number.isFinite(parsed) ? parsed : fallback
}

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function graphPath(root: string, filePath: string | undefined) {
  if (!filePath) return undefined
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
  const relative = path.relative(root, absolute).replaceAll("\\", "/")
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative
  return filePath.replaceAll("\\", "/")
}

function sourceForRecord(record: ToolMutationRecord): ChangeFactEvidence["source"] {
  if (isRecord(record.metadata) && record.metadata.classifierSource === "explicit_input") return "explicit_input"
  if ((record.origin ?? "tool") === "tool") return "tool_diff"
  if (record.origin === "git") return "git_diff"
  return "watcher"
}

function statusToKind(status: string | undefined): ChangeKind {
  if (status === "added" || status === "add" || status === "create") return "add"
  if (status === "removed" || status === "delete" || status === "deleted" || status === "unlink") return "delete"
  if (status === "move" || status === "renamed" || status === "rename") return "move"
  return "modify"
}

function syncStatus(record: ToolMutationRecord, filePath: string) {
  return record.graph.sync.changedFiles?.find((file) => file.path === filePath)?.status
}

function metadataStatus(record: ToolMutationRecord, filePath: string) {
  if ((record.origin ?? "tool") !== "tool") return undefined
  const metadata = record.metadata
  if (!isRecord(metadata)) return undefined

  const fileStatus = Array.isArray(metadata.files)
    ? metadata.files.flatMap((item) => {
        if (!isRecord(item)) return []
        const status = stringValue(item.type)
        if (!status) return []
        const paths = [
          graphPath(record.project.root, stringValue(item.filePath)),
          graphPath(record.project.root, stringValue(item.relativePath)),
          graphPath(record.project.root, stringValue(item.movePath)),
        ].filter((item): item is string => Boolean(item))
        return paths.includes(filePath) ? [status] : []
      })[0]
    : undefined
  if (fileStatus) return fileStatus

  const directPath = graphPath(record.project.root, stringValue(metadata.filePath))
  if (directPath && directPath !== filePath) return undefined
  if (record.tool.id === "write" && typeof metadata.exists === "boolean") return metadata.exists ? "modify" : "add"
  if (record.tool.id === "edit" && typeof metadata.create === "boolean") return metadata.create ? "add" : "modify"
  return undefined
}

function classifiedStatus(record: ToolMutationRecord, filePath: string) {
  const metadata = metadataStatus(record, filePath)
  if (metadata) return { status: metadata, source: "tool_metadata" }
  const sync = syncStatus(record, filePath)
  if (sync) return { status: sync, source: "codegraph_sync" }
  return { status: undefined, source: "unknown" }
}

function classificationForFileRole(role: FileSemanticInfo["role"]): FileClassification {
  if (role === "dependency_manifest") return "dependency"
  if (role === "docs") return "docs"
  if (role === "api_route") return "api_route"
  if (role === "generated") return "generated"
  if (role === "source" || role === "test" || role === "config") return role
  return "unknown"
}

function subjectForFileRole(role: FileSemanticInfo["role"]): ChangeSubjectKind {
  if (role === "dependency_manifest" || role === "config") return "config"
  if (role === "test") return "test"
  if (role === "docs") return "doc"
  if (role === "api_route") return "route"
  return "unknown"
}

function fileSemanticConfidence(semantic: FileSemanticInfo, classification: FileClassification) {
  if (semantic.confidence === "exact") return 0.95
  if (semantic.confidence === "unknown") return 0.35
  if (classification === "api_route") return 0.65
  if (classification === "generated") return 0.45
  return 0.75
}

export function classifyFileBoundary(filePath: string, semantic = getFileSemanticInfo(filePath)): {
  classification: FileClassification
  role: FileSemanticInfo["role"]
  source: FileSemanticInfo["source"]
  confidence: number
  subjectKind: ChangeSubjectKind
  reason: string
  signals: string[]
  semantic: FileSemanticInfo
} {
  const classification = classificationForFileRole(semantic.role)
  return {
    classification,
    role: semantic.role,
    source: semantic.source,
    confidence: fileSemanticConfidence(semantic, classification),
    subjectKind: subjectForFileRole(semantic.role),
    reason: semantic.reason,
    semantic,
    signals: [
      `codegraph_file_role:${semantic.role}`,
      `source:${semantic.source}`,
      `confidence:${semantic.confidence}`,
      ...semantic.signals,
    ],
  }
}

function range(startLine: number, count: number): SourceRange {
  return {
    startLine,
    endLine: startLine + Math.max(count, 1) - 1,
    startColumn: 0,
    endColumn: 0,
  }
}

function optionalRange(startLine: number | undefined, count: number) {
  if (startLine === undefined || count <= 0) return undefined
  return range(startLine, count)
}

function parseHunks(patch: string): SourceHunk[] {
  const diffHash = hash(patch)
  const hunks: SourceHunk[] = []
  let oldLine = 0
  let newLine = 0
  let oldStart: number | undefined
  let newStart: number | undefined
  let removedLines = 0
  let addedLines = 0
  const flush = () => {
    if (removedLines === 0 && addedLines === 0) return
    hunks.push({
      oldRange: optionalRange(oldStart, removedLines),
      newRange: optionalRange(newStart, addedLines),
      removedLines: removedLines || undefined,
      addedLines: addedLines || undefined,
      diffHash,
    })
    oldStart = undefined
    newStart = undefined
    removedLines = 0
    addedLines = 0
  }

  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      flush()
      oldLine = numberValue(header[1], 1)
      newLine = numberValue(header[3], 1)
      continue
    }
    if (oldLine === 0 && newLine === 0) continue
    if (line.startsWith("\\")) continue
    if (line.startsWith("-") && !line.startsWith("---")) {
      oldStart = oldStart ?? oldLine
      removedLines++
      oldLine++
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newStart = newStart ?? newLine
      addedLines++
      newLine++
      continue
    }
    flush()
    if (line.startsWith(" ")) {
      oldLine++
      newLine++
    }
  }
  flush()
  return hunks
}

function metadataDiffs(record: ToolMutationRecord): DiffInfo[] {
  const metadata = record.metadata
  if (!isRecord(metadata)) return []
  const firstFile = record.files.find((file) => file.graphPath)?.graphPath
  const direct = stringValue(metadata.diff)
  const directDiffs = direct && firstFile ? [{ filePath: firstFile, status: metadataStatus(record, firstFile), patch: direct, hunks: parseHunks(direct) }] : []
  const fileDiffs = Array.isArray(metadata.files)
    ? metadata.files.flatMap((item) => {
        if (!isRecord(item)) return []
        const patch = stringValue(item.patch)
        if (!patch) return []
        const filePath = graphPath(record.project.root, stringValue(item.movePath) ?? stringValue(item.filePath) ?? stringValue(item.relativePath))
        if (!filePath) return []
        return [{
          filePath,
          oldPath: graphPath(record.project.root, stringValue(item.filePath)),
          status: stringValue(item.type),
          patch,
          hunks: parseHunks(patch),
        }]
      })
    : []
  return [...directDiffs, ...fileDiffs]
}

export function collectFileProjections(graph: ProjectionGraph, files: ProvenanceFile[], snapshot: CodeGraphSnapshot, memo?: ProjectionMemo) {
  return files.flatMap((file) =>
    file.graphPath
      ? graph.nodesInFile(file.graphPath).flatMap((node) => {
          if (memo) {
            const projection = graph.projectNodeWithMemo(node, memo, snapshot)
            return projection ? [projection] : []
          }
          return graph.projectNode(node, snapshot) ?? []
        })
      : [],
  )
}

export function collectIncidentRelations(graph: ProjectionGraph, nodes: FrozenSemanticObject[], snapshot: CodeGraphSnapshot) {
  return nodes.flatMap((node) => graph.incidentRelations(node, snapshot))
}

function nodeKey(node: FrozenSemanticObject) {
  return `${node.payload.filePath}:${node.payload.kind}:${node.payload.qualifiedName || node.payload.name}`
}

function nodeID(node: FrozenSemanticObject | undefined) {
  return node?.source.codegraphId
}

function relationsForNode(relations: FrozenRelation[], node: FrozenSemanticObject | null | undefined) {
  if (!node) return []
  const key = nodeKey(node)
  return relations.filter((relation) => relation.payload.focalNode.nodeKey === key)
}

function fileNode(nodes: FrozenSemanticObject[], filePath: string | undefined) {
  if (!filePath) return undefined
  return nodes.find((node) => node.payload.kind === "file" && node.payload.filePath === filePath)
}

function hasRelationDelta(delta: RelationDeltaEvidence) {
  return delta.addedRelations.length > 0 || delta.removedRelations.length > 0
}

function nodeRangeIntersects(node: FrozenSemanticObject, sourceRange: SourceRange | undefined) {
  if (!sourceRange) return false
  return node.payload.range.startLine <= (sourceRange.endLine ?? sourceRange.startLine) && node.payload.range.endLine >= sourceRange.startLine
}

function isCallableNode(node: FrozenSemanticObject) {
  return node.payload.semantic?.attributes.isCallable ?? CALLABLE_KINDS.has(node.payload.kind)
}

const DEFAULT_LANGUAGE_SIGNAL_KINDS = new Set<LanguageAwareSignal["kind"]>([
  "constructor_like",
  "override_like",
  "route_handler_like",
])

function languageSignalSignals(signals: LanguageAwareSignal[] | undefined) {
  return (signals ?? []).filter((signal) => DEFAULT_LANGUAGE_SIGNAL_KINDS.has(signal.kind)).flatMap((signal) => [
    `codegraph_language_signal:${signal.kind}`,
    `language:${signal.language}`,
    `source:${signal.source}`,
    `quality:${signal.quality}`,
    ...signal.signals.filter((item) => !item.startsWith("codegraph_language_signal:") || item === `codegraph_language_signal:${signal.kind}`),
  ])
}

function nodeLanguageSignals(node: FrozenSemanticObject | null | undefined) {
  return node?.payload.languageSignals ?? []
}

function bodyLanguageSignals(before: FrozenSemanticObject | null | undefined, after: FrozenSemanticObject | null | undefined, hunk: SourceHunk | undefined) {
  return diffNodeLanguageSignals({ before, after, hunk: hunk ? { oldRange: hunk.oldRange, newRange: hunk.newRange } : undefined })
}

function bodyLanguageContext(node: FrozenSemanticObject | null | undefined) {
  const context = new Set(["constructor_like", "override_like", "route_handler_like"])
  return nodeLanguageSignals(node).filter((signal) => context.has(signal.kind))
}

function bodySignalConfidence(signals: LanguageAwareSignal[], node: FrozenSemanticObject | null | undefined, statementEffect?: CodePlanStatementEffectEvidence) {
  if (statementEffect?.effect === "local_only") return 0.25
  if (statementEffect?.effect === "unknown_fallback") return 0.5
  const kinds = new Set(signals.map((signal) => signal.kind))
  if (kinds.has("local_only_change")) return 0.25
  if (kinds.has("unknown_body_effect")) return 0.5
  const callerVisible = signals.length > 0
  if (callerVisible && bodyLanguageContext(node).length > 0) return 0.9
  if (callerVisible) return Math.max(0.85, statementEffect?.confidence ?? 0)
  return statementEffect?.confidence ?? 0.5
}

function bodySignalRule(signals: LanguageAwareSignal[], statementEffect?: CodePlanStatementEffectEvidence) {
  if (statementEffect?.effect === "local_only") return "method_body.self_review"
  if (statementEffect?.effect === "unknown_fallback") return "method_body.fallback"
  if (statementEffect) return "method_body.statement_effect"
  const kinds = new Set(signals.map((signal) => signal.kind))
  if (kinds.has("local_only_change")) return "method_body.self_review"
  if (kinds.has("unknown_body_effect")) return "method_body.fallback"
  if (signals.length > 0) return "method_body.relations"
  return "range.node.body"
}

function bodySignalReason(signals: LanguageAwareSignal[], node: FrozenSemanticObject | null | undefined, fallback: string, statementEffect?: CodePlanStatementEffectEvidence) {
  if (signals.length === 0 && !statementEffect) return fallback
  const context = bodyLanguageContext(node).map((signal) => signal.kind)
  return [
    statementEffect?.reason,
    signals.map((signal) => signal.reason).join("; "),
    context.length ? `node context: ${context.join(", ")}` : undefined,
  ].filter(Boolean).join("; ")
}

function isContainerNode(node: FrozenSemanticObject) {
  return node.payload.semantic?.attributes.isContainer ?? CONTAINER_KINDS.has(node.payload.kind)
}

function semanticSignals(node: FrozenSemanticObject) {
  const semantic = node.payload.semantic
  const languageSignals = languageSignalSignals(node.payload.languageSignals)
  if (!semantic) return [`node_kind:${node.payload.kind}`, ...languageSignals]
  return [`codegraph_role:${semantic.role}`, `codegraph_subject:${semantic.changeSubject}`, ...languageSignals]
}

function semanticDiffSignals(diff: NodeSemanticDiff) {
  return [`codegraph_semantic_diff:${diff.changeKind}`, ...diff.changedFields.map((field) => `changed:${field}`)]
}

function fileSemanticInputNodes(nodes: FrozenSemanticObject[]): FileSemanticInputNode[] {
  return nodes.map((node) => ({ kind: node.payload.kind, filePath: node.payload.filePath, range: node.payload.range }))
}

function subjectForFileSignal(signal: FileSemanticSignal): Extract<ChangeSubjectKind, "import" | "export"> {
  return signal.kind === "import_statement" ? "import" : "export"
}

function fileSignalChangeKind(signal: FileSemanticSignal, fallback: ChangeKind): ChangeKind {
  if (signal.changeKind === "add" || signal.changeKind === "delete" || signal.changeKind === "modify") return signal.changeKind
  return fallback
}

function fileSignalHunk(signal: FileSemanticSignal, fallback: SourceHunk | undefined): SourceHunk | undefined {
  if (!signal.range) return fallback
  if (signal.changeKind === "delete") return { oldRange: signal.range }
  return { newRange: signal.range }
}

function fileSignalSignals(signal: FileSemanticSignal) {
  return [
    `codegraph_file_semantic_signal:${signal.kind}`,
    `source:${signal.source}`,
    ...signal.signals,
  ]
}

function hasSemanticDelta(diff: NodeSemanticDiff) {
  return diff.changedFields.length > 0 && diff.changeSubject !== "unknown" && diff.changeSubject !== "body"
}

function subjectForNode(node: FrozenSemanticObject): ChangeSubjectKind {
  if (node.payload.semantic?.changeSubject && node.payload.semantic.changeSubject !== "unknown" && node.payload.semantic.changeSubject !== "body") return node.payload.semantic.changeSubject
  if (node.payload.kind === "import") return "import"
  if (node.payload.kind === "export") return "export"
  if (node.payload.kind === "route") return "route"
  if (node.payload.isExported) return "export"
  if (SCHEMA_KINDS.has(node.payload.kind)) return "schema"
  if (isCallableNode(node)) return "signature"
  return "unknown"
}

function containsNode(outer: FrozenSemanticObject, inner: FrozenSemanticObject) {
  return outer.payload.range.startLine <= inner.payload.range.startLine && outer.payload.range.endLine >= inner.payload.range.endLine
}

function nodeSpan(node: FrozenSemanticObject) {
  return node.payload.range.endLine - node.payload.range.startLine
}

function actionableNode(node: FrozenSemanticObject) {
  if (isContainerNode(node)) return false
  return isCallableNode(node) || subjectForNode(node) !== "unknown"
}

function touched(nodes: FrozenSemanticObject[], filePath: string, sourceRange: SourceRange | undefined) {
  const candidates = nodes.filter((node) => node.payload.filePath === filePath && actionableNode(node) && nodeRangeIntersects(node, sourceRange))
  return candidates.filter(
    (node) => !candidates.some((other) => other !== node && containsNode(node, other) && nodeSpan(other) < nodeSpan(node)),
  )
}

const BODY_EFFECT_BY_SIGNAL = {
  local_only_change: "local_only",
  this_field_write: "receiver_field_write",
  parameter_mutation: "parameter_object_mutation",
  global_or_module_state_write: "module_or_global_state_write",
  return_value_changed: "return_value_change",
  unknown_body_effect: "unknown_fallback",
} satisfies Partial<Record<LanguageAwareSignal["kind"], CodePlanStatementEffectKind>>

function statementEffectKind(signals: LanguageAwareSignal[]): CodePlanStatementEffectKind {
  const kinds = new Set(signals.map((signal) => signal.kind))
  if (kinds.has("unknown_body_effect")) return "unknown_fallback"
  if (kinds.has("this_field_write")) return "receiver_field_write"
  if (kinds.has("parameter_mutation")) return "parameter_object_mutation"
  if (kinds.has("global_or_module_state_write")) return "module_or_global_state_write"
  if (kinds.has("return_value_changed")) return "return_value_change"
  if (kinds.has("local_only_change")) return "local_only"
  return "unknown_fallback"
}

function statementEffectNodes(nodes: FrozenSemanticObject[], filePath: string, hunk: SourceHunk | undefined): CodePlanStatementEffectNode[] {
  const oldRange = hunk?.oldRange
  const newRange = hunk?.newRange
  return nodes
    .filter((node) => node.payload.kind === "statement" && node.payload.filePath === filePath && (nodeRangeIntersects(node, newRange) || nodeRangeIntersects(node, oldRange)))
    .map((node) => ({
      nodeKey: nodeKey(node),
      filePath: node.payload.filePath,
      range: node.payload.range,
      signature: node.payload.signature,
    }))
}

function codePlanStatementEffect(input: {
  beforeNodes: FrozenSemanticObject[]
  afterNodes: FrozenSemanticObject[]
  filePath: string
  hunk: SourceHunk | undefined
  languageSignals: LanguageAwareSignal[]
}): CodePlanStatementEffectEvidence {
  const effect = statementEffectKind(input.languageSignals)
  const nodes = statementEffectNodes([...input.beforeNodes, ...input.afterNodes], input.filePath, input.hunk)
  const signalKinds = input.languageSignals.flatMap((signal) => signal.kind in BODY_EFFECT_BY_SIGNAL ? [signal.kind] : [])
  return {
    schemaVersion: 1,
    source: "codegraph:statement_effect",
    effect,
    graphBacked: nodes.length > 0 || input.languageSignals.some((signal) => signal.source.startsWith("codegraph:")),
    confidence: input.languageSignals.reduce((max, signal) => Math.max(max, signal.confidence), effect === "unknown_fallback" ? 0.45 : 0.7),
    signalKinds,
    statementNodes: nodes,
    reason: nodes.length
      ? `CodeGraph statement nodes and language signals classify method body effect as ${effect}`
      : `CodeGraph language signals classify method body effect as ${effect}`,
    signals: [
      `codeplan_statement_effect:${effect}`,
      `source:codegraph:statement_effect`,
      `graph_backed:${nodes.length > 0 || input.languageSignals.some((signal) => signal.source.startsWith("codegraph:"))}`,
      ...nodes.map((node) => `codegraph_statement_node:${node.nodeKey}`),
    ],
  }
}

function evidence(input: {
  record: ToolMutationRecord
  rule: string
  confidenceReason: string
  filePath: string
  oldPath?: string
  status?: string
  hunk?: SourceHunk
  beforeNode?: FrozenSemanticObject | null
  afterNode?: FrozenSemanticObject | null
  semanticDiff?: NodeSemanticDiff
  relationDelta?: RelationDeltaEvidence
  languageSignals?: LanguageAwareSignal[]
  statementEffect?: CodePlanStatementEffectEvidence
  fileSemantic?: FileSemanticInfo
  signals: string[]
}): ChangeFactEvidence {
  return {
    version: 1,
    source: sourceForRecord(input.record),
    rule: input.rule,
    confidenceReason: input.confidenceReason,
    graph: {
      beforeRevision: input.record.graph.before.revision,
      afterRevision: input.record.graph.after.revision,
    },
    file: {
      path: input.filePath,
      oldPath: input.oldPath,
      status: input.status,
    },
    hunk: input.hunk,
    beforeNode: input.beforeNode,
    afterNode: input.afterNode,
    semanticDiff: input.semanticDiff,
    relationDelta: input.relationDelta,
    languageSignals: input.languageSignals,
    statementEffect: input.statementEffect,
    fileSemantic: input.fileSemantic,
    signals: input.signals,
  }
}

function fact(input: {
  record: ToolMutationRecord
  filePath: string
  oldPath?: string
  node?: FrozenSemanticObject
  beforeNode?: FrozenSemanticObject | null
  afterNode?: FrozenSemanticObject | null
  changeKind: ChangeKind
  subjectKind: ChangeSubjectKind
  confidence: number
  rule: string
  confidenceReason: string
  status?: string
  hunk?: SourceHunk
  semanticDiff?: NodeSemanticDiff
  relationDelta?: RelationDeltaEvidence
  languageSignals?: LanguageAwareSignal[]
  statementEffect?: CodePlanStatementEffectEvidence
  fileSemantic?: FileSemanticInfo
  signals: string[]
}): ChangeFact {
  const key = input.node ? nodeKey(input.node) : undefined
  const node = input.afterNode ?? input.beforeNode ?? input.node
  const id = hash(JSON.stringify({
    eventID: input.record.id,
    filePath: input.filePath,
    key,
    changeKind: input.changeKind,
    subjectKind: input.subjectKind,
    rule: input.rule,
  })).slice(0, 16)
  return {
    schemaVersion: 1,
    id: `fact_${id}`,
    eventID: input.record.id,
    filePath: input.filePath,
    oldPath: input.oldPath,
    nodeID: nodeID(node),
    nodeKey: key,
    changeKind: input.changeKind,
    subjectKind: input.subjectKind,
    confidence: input.confidence,
    evidence: evidence({
      record: input.record,
      rule: input.rule,
      confidenceReason: input.confidenceReason,
      filePath: input.filePath,
      oldPath: input.oldPath,
      status: input.status,
      hunk: input.hunk,
      beforeNode: input.beforeNode,
      afterNode: input.afterNode,
      semanticDiff: input.semanticDiff,
      relationDelta: input.relationDelta,
      languageSignals: input.languageSignals,
      statementEffect: input.statementEffect,
      fileSemantic: input.fileSemantic,
      signals: input.signals,
    }),
    createdAt: input.record.finishedAt,
  }
}

function uniqueFacts(facts: ChangeFact[]) {
  return [...new Map(facts.map((item) => [item.id, item])).values()]
}

export function classifyChangeRecord(input: {
  record: ToolMutationRecord
  beforeNodes?: FrozenSemanticObject[]
  afterNodes?: FrozenSemanticObject[]
  beforeRelations?: FrozenRelation[]
  afterRelations?: FrozenRelation[]
}) {
  const record = input.record
  if (record.status !== "success") return [] as ChangeFact[]

  const beforeNodes = input.beforeNodes ?? []
  const afterNodes = input.afterNodes ?? []
  const beforeRelations = input.beforeRelations ?? []
  const afterRelations = input.afterRelations ?? []
  const beforeByKey = new Map(beforeNodes.map((node) => [nodeKey(node), node]))
  const afterByKey = new Map(afterNodes.map((node) => [nodeKey(node), node]))
  const diffs = metadataDiffs(record)
  const facts: ChangeFact[] = []

  const relationDeltaFor = (
    before: FrozenSemanticObject | null | undefined,
    after: FrozenSemanticObject | null | undefined,
    options: { includeStable?: boolean } = {},
  ) => {
    const delta = diffRelations(relationsForNode(beforeRelations, before), relationsForNode(afterRelations, after))
    if (hasRelationDelta(delta)) return delta
    if (options.includeStable && (delta.beforeRelations.length > 0 || delta.afterRelations.length > 0)) return delta
    return undefined
  }

  for (const file of record.files) {
    if (!file.graphPath) continue
    const classified = classifiedStatus(record, file.graphPath)
    const status = classified.status
    const changeKind = statusToKind(status)
    const fileRelationDelta = relationDeltaFor(fileNode(beforeNodes, file.graphPath), fileNode(afterNodes, file.graphPath))
    facts.push(fact({
      record,
      filePath: file.graphPath,
      changeKind,
      subjectKind: "file",
      confidence: record.provenanceStrength === "weak" ? 0.35 : 0.95,
      rule: "file.status",
      confidenceReason: classified.source === "tool_metadata"
        ? "file status came from tool mutation metadata"
        : classified.source === "codegraph_sync"
          ? "file status came from CodeGraph sync result"
          : "file changed without explicit sync status",
      status,
      relationDelta: fileRelationDelta,
      signals: [status ? `status:${status}` : "status:unknown", `status_source:${classified.source}`],
    }))

    const boundary = classifyFileBoundary(file.graphPath)
      if (boundary.subjectKind !== "unknown") {
        facts.push(fact({
          record,
          filePath: file.graphPath,
          changeKind,
          subjectKind: boundary.subjectKind,
          confidence: boundary.confidence,
          rule: `codegraph.file_role.${boundary.role}`,
          confidenceReason: boundary.reason,
          status,
          relationDelta: fileRelationDelta,
          fileSemantic: boundary.semantic,
          signals: boundary.signals,
      }))
    }
  }

  for (const diff of diffs) {
    const classified = classifiedStatus(record, diff.filePath)
    const status = diff.status ?? classified.status
    const changeKind = statusToKind(status)
    const diffFacts = facts.length
    const fileRelationDelta = relationDeltaFor(fileNode(beforeNodes, diff.oldPath ?? diff.filePath), fileNode(afterNodes, diff.filePath))

    for (const hunk of diff.hunks) {
      const emitted = new Set<string>()
      const beforeTouched = touched(beforeNodes, diff.oldPath ?? diff.filePath, hunk.oldRange)
      const afterTouched = touched(afterNodes, diff.filePath, hunk.newRange)
      const hasBoundaryNode = [...beforeTouched, ...afterTouched].some((node) =>
        node.payload.kind === "import" || node.payload.kind === "export" || node.payload.kind === "route"
      )

      for (const after of afterTouched) {
        const before = beforeByKey.get(nodeKey(after))
        const subject = subjectForNode(after)
        if (!before) {
          const semanticDiff = diffNodeSemantics(null, after)
          facts.push(fact({
            record,
            filePath: diff.filePath,
            oldPath: diff.oldPath,
            node: after,
            afterNode: after,
            changeKind: changeKind === "delete" ? "modify" : changeKind,
            subjectKind: semanticDiff.changeSubject === "unknown" ? subject : semanticDiff.changeSubject,
            confidence: semanticDiff.confidence,
            rule: `range.node.${subject}`,
            confidenceReason: semanticDiff.confidenceReason,
            status,
            hunk,
            semanticDiff,
            relationDelta: relationDeltaFor(null, after),
            signals: ["after_node", "missing_before_projection", ...semanticDiffSignals(semanticDiff), ...semanticSignals(after)],
          }))
          emitted.add(nodeKey(after))
          continue
        }

        const semanticDiff = diffNodeSemantics(before, after)
        if (hasSemanticDelta(semanticDiff)) {
          facts.push(fact({
            record,
            filePath: diff.filePath,
            oldPath: diff.oldPath,
            node: after,
            beforeNode: before,
            afterNode: after,
            changeKind: "modify",
            subjectKind: semanticDiff.changeSubject,
            confidence: semanticDiff.confidence,
            rule: "codegraph.semantic.diff",
            confidenceReason: semanticDiff.confidenceReason,
            status,
            hunk,
            semanticDiff,
            relationDelta: relationDeltaFor(before, after, { includeStable: true }),
            signals: [...semanticDiffSignals(semanticDiff), ...semanticSignals(after)],
          }))
          emitted.add(nodeKey(after))
          continue
        }

        const isBody = isCallableNode(after)
        if (isBody && hasBoundaryNode) {
          emitted.add(nodeKey(after))
          continue
        }
        const languageSignals = isBody ? bodyLanguageSignals(before, after, hunk) : []
        const statementEffect = isBody ? codePlanStatementEffect({ beforeNodes, afterNodes, filePath: diff.filePath, hunk, languageSignals }) : undefined
        facts.push(fact({
          record,
          filePath: diff.filePath,
          oldPath: diff.oldPath,
          node: after,
          beforeNode: before,
          afterNode: after,
          changeKind: "modify",
          subjectKind: isBody ? "body" : subject,
          confidence: isBody ? bodySignalConfidence(languageSignals, after, statementEffect) : 0.85,
          rule: isBody ? bodySignalRule(languageSignals, statementEffect) : `range.node.${subject}`,
          confidenceReason: isBody
            ? bodySignalReason(languageSignals, after, "changed hunk intersects callable node but CodeGraph semantic diff fields were stable", statementEffect)
            : "changed hunk intersects a CodeGraph node",
          status,
          hunk,
          semanticDiff,
          relationDelta: relationDeltaFor(before, after),
          languageSignals: isBody ? languageSignals : undefined,
          statementEffect,
          signals: isBody ? [...semanticSignals(after), ...(statementEffect?.signals ?? []), ...languageSignalSignals(languageSignals)] : semanticSignals(after),
        }))
        emitted.add(nodeKey(after))
      }

      for (const before of beforeTouched) {
        const after = afterByKey.get(nodeKey(before))
        if (after && !emitted.has(nodeKey(before))) {
          const semanticDiff = diffNodeSemantics(before, after)
          if (hasSemanticDelta(semanticDiff)) {
            facts.push(fact({
              record,
              filePath: diff.filePath,
              oldPath: diff.oldPath,
              node: after,
              beforeNode: before,
              afterNode: after,
              changeKind: "modify",
              subjectKind: semanticDiff.changeSubject,
              confidence: semanticDiff.confidence,
              rule: "codegraph.semantic.diff",
              confidenceReason: semanticDiff.confidenceReason,
              status,
              hunk,
              semanticDiff,
              relationDelta: relationDeltaFor(before, after, { includeStable: true }),
              signals: [...semanticDiffSignals(semanticDiff), ...semanticSignals(after)],
            }))
            continue
          }
          if (isCallableNode(after) && !hasBoundaryNode) {
            const languageSignals = bodyLanguageSignals(before, after, hunk)
            const statementEffect = codePlanStatementEffect({ beforeNodes, afterNodes, filePath: diff.filePath, hunk, languageSignals })
            facts.push(fact({
              record,
              filePath: diff.filePath,
              oldPath: diff.oldPath,
              node: after,
              beforeNode: before,
              afterNode: after,
              changeKind: "modify",
              subjectKind: "body",
              confidence: bodySignalConfidence(languageSignals, after, statementEffect),
              rule: bodySignalRule(languageSignals, statementEffect),
              confidenceReason: bodySignalReason(languageSignals, after, "deleted changed lines intersect callable node but CodeGraph semantic diff fields were stable", statementEffect),
              status,
              hunk,
              semanticDiff,
              relationDelta: relationDeltaFor(before, after),
              languageSignals,
              statementEffect,
              signals: [...semanticSignals(after), ...statementEffect.signals, ...languageSignalSignals(languageSignals)],
            }))
          }
          continue
        }
        if (after) continue
        const semanticDiff = diffNodeSemantics(before, null)
        facts.push(fact({
          record,
          filePath: diff.filePath,
          oldPath: diff.oldPath,
          node: before,
          beforeNode: before,
          changeKind: "delete",
          subjectKind: semanticDiff.changeSubject === "unknown" ? subjectForNode(before) : semanticDiff.changeSubject,
          confidence: semanticDiff.confidence,
          rule: "range.node.deleted",
          confidenceReason: semanticDiff.confidenceReason,
          status,
          hunk,
          semanticDiff,
          relationDelta: relationDeltaFor(before, null),
          signals: ["before_node", "missing_after_projection", ...semanticDiffSignals(semanticDiff), ...semanticSignals(before)],
        }))
      }
    }

    const firstHunk = diff.hunks[0]
    const fileSignals = diffFileSemantics({
      filePath: diff.filePath,
      oldPath: diff.oldPath,
      patch: diff.patch,
      hunks: diff.hunks,
      nodes: fileSemanticInputNodes([...beforeNodes, ...afterNodes].filter((node) => node.payload.filePath === diff.filePath || node.payload.filePath === diff.oldPath)),
    })

    for (const signal of fileSignals) {
      const subjectKind = subjectForFileSignal(signal)
      if (facts.some((item) => item.filePath === diff.filePath && item.subjectKind === subjectKind)) continue
      facts.push(fact({
        record,
        filePath: diff.filePath,
        oldPath: diff.oldPath,
        changeKind: fileSignalChangeKind(signal, changeKind),
        subjectKind,
        confidence: signal.confidence,
        rule: `codegraph.file_semantic.${signal.kind}`,
        confidenceReason: signal.reason,
        status,
        hunk: fileSignalHunk(signal, firstHunk),
        relationDelta: fileRelationDelta,
        signals: fileSignalSignals(signal),
      }))
    }

    if (diff.hunks.length > 0 && diffFacts === facts.length) {
      const boundary = classifyFileBoundary(diff.filePath)
      if (boundary.subjectKind === "unknown") {
        facts.push(fact({
          record,
          filePath: diff.filePath,
          oldPath: diff.oldPath,
          changeKind,
          subjectKind: "unknown",
          confidence: 0.35,
          rule: "diff.hunk.unmatched",
          confidenceReason: "changed lines did not intersect a non-container CodeGraph node",
          status,
          hunk: firstHunk,
          signals: ["hunk_unmatched"],
        }))
      }
    }
  }

  return uniqueFacts(facts)
}

export * as ChangeClassifier from "./change-classifier"
