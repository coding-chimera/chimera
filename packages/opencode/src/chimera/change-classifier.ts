import path from "path"
import { createHash } from "crypto"
import type { CodeGraphAdapter, CodeGraphSnapshot, FrozenSemanticObject, SourceRange } from "./codegraph-adapter"
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

export type FileClassification = "source" | "test" | "docs" | "config" | "dependency" | "api_route" | "unknown"

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

type ProjectionGraph = Pick<CodeGraphAdapter, "nodesInFile" | "projectNode">

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

export function classifyFileBoundary(filePath: string): {
  classification: FileClassification
  subjectKind: ChangeSubjectKind
  reason: string
  signals: string[]
} {
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
    return {
      classification: "dependency",
      subjectKind: "config",
      reason: "dependency manifest or lockfile boundary",
      signals: ["dependency_manifest"],
    }
  }
  if (lower.includes("/test/") || lower.includes("/tests/") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    return { classification: "test", subjectKind: "test", reason: "test or spec file boundary", signals: ["test_path"] }
  }
  if (/\.(md|mdx|rst|adoc|txt)$/.test(lower) || lower.includes("/docs/") || lower.includes("/specs/")) {
    return { classification: "docs", subjectKind: "doc", reason: "documentation or specification boundary", signals: ["doc_path"] }
  }
  if (lower.includes("/route") || lower.includes("/routes/") || lower.includes("/api/") || lower.includes("/httpapi/") || lower.includes("/server/")) {
    return { classification: "api_route", subjectKind: "route", reason: "route/server/API boundary", signals: ["route_path"] }
  }
  if (basename.startsWith(".") || basename.includes("config") || basename === "tsconfig.json" || basename === "vite.config.ts" || basename === "drizzle.config.ts") {
    return { classification: "config", subjectKind: "config", reason: "configuration boundary", signals: ["config_path"] }
  }
  if (/\.[cm]?[jt]sx?$|\.tsx?$|\.rs$|\.go$|\.py$|\.java$|\.kt$|\.swift$/.test(lower)) {
    return { classification: "source", subjectKind: "unknown", reason: "source implementation file", signals: ["source_path"] }
  }
  return { classification: "unknown", subjectKind: "unknown", reason: "unclassified file boundary", signals: ["unknown_path"] }
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

export function collectFileProjections(graph: ProjectionGraph, files: ProvenanceFile[], snapshot: CodeGraphSnapshot) {
  return files.flatMap((file) =>
    file.graphPath ? graph.nodesInFile(file.graphPath).flatMap((node) => graph.projectNode(node, snapshot) ?? []) : [],
  )
}

function nodeKey(node: FrozenSemanticObject) {
  return `${node.payload.filePath}:${node.payload.kind}:${node.payload.qualifiedName || node.payload.name}`
}

function nodeID(node: FrozenSemanticObject | undefined) {
  return node?.source.codegraphId
}

function nodeRangeIntersects(node: FrozenSemanticObject, sourceRange: SourceRange | undefined) {
  if (!sourceRange) return false
  return node.payload.range.startLine <= (sourceRange.endLine ?? sourceRange.startLine) && node.payload.range.endLine >= sourceRange.startLine
}

function subjectForNode(node: FrozenSemanticObject): ChangeSubjectKind {
  if (node.payload.kind === "import") return "import"
  if (node.payload.kind === "export") return "export"
  if (node.payload.kind === "route") return "route"
  if (node.payload.isExported) return "export"
  if (SCHEMA_KINDS.has(node.payload.kind)) return "schema"
  if (CALLABLE_KINDS.has(node.payload.kind)) return "signature"
  return "unknown"
}

function containsNode(outer: FrozenSemanticObject, inner: FrozenSemanticObject) {
  return outer.payload.range.startLine <= inner.payload.range.startLine && outer.payload.range.endLine >= inner.payload.range.endLine
}

function nodeSpan(node: FrozenSemanticObject) {
  return node.payload.range.endLine - node.payload.range.startLine
}

function actionableNode(node: FrozenSemanticObject) {
  if (CONTAINER_KINDS.has(node.payload.kind)) return false
  return CALLABLE_KINDS.has(node.payload.kind) || subjectForNode(node) !== "unknown"
}

function touched(nodes: FrozenSemanticObject[], filePath: string, sourceRange: SourceRange | undefined) {
  const candidates = nodes.filter((node) => node.payload.filePath === filePath && actionableNode(node) && nodeRangeIntersects(node, sourceRange))
  return candidates.filter(
    (node) => !candidates.some((other) => other !== node && containsNode(node, other) && nodeSpan(other) < nodeSpan(node)),
  )
}

function signatureDelta(before: FrozenSemanticObject, after: FrozenSemanticObject) {
  return [
    before.payload.signature !== after.payload.signature ? "signature" : undefined,
    before.payload.name !== after.payload.name ? "name" : undefined,
    before.payload.qualifiedName !== after.payload.qualifiedName ? "qualifiedName" : undefined,
    before.payload.visibility !== after.payload.visibility ? "visibility" : undefined,
    before.payload.isExported !== after.payload.isExported ? "isExported" : undefined,
    JSON.stringify(before.payload.typeParameters ?? []) !== JSON.stringify(after.payload.typeParameters ?? []) ? "typeParameters" : undefined,
    JSON.stringify(before.payload.decorators ?? []) !== JSON.stringify(after.payload.decorators ?? []) ? "decorators" : undefined,
  ].filter((item): item is string => Boolean(item))
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
      signals: input.signals,
    }),
    createdAt: input.record.finishedAt,
  }
}

function uniqueFacts(facts: ChangeFact[]) {
  return [...new Map(facts.map((item) => [item.id, item])).values()]
}

function lineHeuristic(patch: string, kind: "import" | "export") {
  if (kind === "import") return /^[+-]\s*(import\s|from\s+.+\s+import\s)/m.test(patch)
  return /^[+-]\s*export\s/m.test(patch)
}

export function classifyChangeRecord(input: {
  record: ToolMutationRecord
  beforeNodes?: FrozenSemanticObject[]
  afterNodes?: FrozenSemanticObject[]
}) {
  const record = input.record
  if (record.status !== "success") return [] as ChangeFact[]

  const beforeNodes = input.beforeNodes ?? []
  const afterNodes = input.afterNodes ?? []
  const beforeByKey = new Map(beforeNodes.map((node) => [nodeKey(node), node]))
  const afterByKey = new Map(afterNodes.map((node) => [nodeKey(node), node]))
  const diffs = metadataDiffs(record)
  const facts: ChangeFact[] = []

  for (const file of record.files) {
    if (!file.graphPath) continue
    const classified = classifiedStatus(record, file.graphPath)
    const status = classified.status
    const changeKind = statusToKind(status)
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
      signals: [status ? `status:${status}` : "status:unknown", `status_source:${classified.source}`],
    }))

    const boundary = classifyFileBoundary(file.graphPath)
    if (boundary.subjectKind !== "unknown") {
      facts.push(fact({
        record,
        filePath: file.graphPath,
        changeKind,
        subjectKind: boundary.subjectKind,
        confidence: boundary.classification === "api_route" ? 0.65 : 0.75,
        rule: `path.boundary.${boundary.classification}`,
        confidenceReason: boundary.reason,
        status,
        signals: boundary.signals,
      }))
    }
  }

  for (const diff of diffs) {
    const classified = classifiedStatus(record, diff.filePath)
    const status = diff.status ?? classified.status
    const changeKind = statusToKind(status)
    const diffFacts = facts.length

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
          facts.push(fact({
            record,
            filePath: diff.filePath,
            oldPath: diff.oldPath,
            node: after,
            afterNode: after,
            changeKind: changeKind === "delete" ? "modify" : changeKind,
            subjectKind: subject,
            confidence: 0.85,
            rule: `range.node.${subject}`,
            confidenceReason: "changed hunk intersects an after-sync CodeGraph node without a matching before projection",
            status,
            hunk,
            signals: ["after_node", "missing_before_projection", `node_kind:${after.payload.kind}`],
          }))
          emitted.add(nodeKey(after))
          continue
        }

        const signatureSignals = signatureDelta(before, after)
        if (signatureSignals.length > 0 && CALLABLE_KINDS.has(after.payload.kind)) {
          facts.push(fact({
            record,
            filePath: diff.filePath,
            oldPath: diff.oldPath,
            node: after,
            beforeNode: before,
            afterNode: after,
            changeKind: "modify",
            subjectKind: "signature",
            confidence: 0.95,
            rule: "projection.signature.delta",
            confidenceReason: "before/after CodeGraph projections changed signature-like fields",
            status,
            hunk,
            signals: signatureSignals.map((signal) => `changed:${signal}`),
          }))
          emitted.add(nodeKey(after))
          continue
        }

        if (before.payload.isExported !== after.payload.isExported) {
          facts.push(fact({
            record,
            filePath: diff.filePath,
            oldPath: diff.oldPath,
            node: after,
            beforeNode: before,
            afterNode: after,
            changeKind: "modify",
            subjectKind: "export",
            confidence: 0.95,
            rule: "projection.export.delta",
            confidenceReason: "before/after CodeGraph projections changed export state",
            status,
            hunk,
            signals: ["changed:isExported"],
          }))
          emitted.add(nodeKey(after))
          continue
        }

        const isBody = CALLABLE_KINDS.has(after.payload.kind)
        if (isBody && hasBoundaryNode) {
          emitted.add(nodeKey(after))
          continue
        }
        facts.push(fact({
          record,
          filePath: diff.filePath,
          oldPath: diff.oldPath,
          node: after,
          beforeNode: before,
          afterNode: after,
          changeKind: "modify",
          subjectKind: isBody ? "body" : subject,
          confidence: isBody ? 0.5 : 0.85,
          rule: isBody ? "range.node.body" : `range.node.${subject}`,
          confidenceReason: isBody
            ? "changed hunk intersects callable node but signature-like projection fields were stable"
            : "changed hunk intersects a CodeGraph node",
          status,
          hunk,
          signals: [`node_kind:${after.payload.kind}`],
        }))
        emitted.add(nodeKey(after))
      }

      for (const before of beforeTouched) {
        const after = afterByKey.get(nodeKey(before))
        if (after && !emitted.has(nodeKey(before))) {
          const signatureSignals = signatureDelta(before, after)
          if (signatureSignals.length > 0 && CALLABLE_KINDS.has(after.payload.kind)) {
            facts.push(fact({
              record,
              filePath: diff.filePath,
              oldPath: diff.oldPath,
              node: after,
              beforeNode: before,
              afterNode: after,
              changeKind: "modify",
              subjectKind: "signature",
              confidence: 0.95,
              rule: "projection.signature.delta",
              confidenceReason: "before/after CodeGraph projections changed signature-like fields",
              status,
              hunk,
              signals: signatureSignals.map((signal) => `changed:${signal}`),
            }))
            continue
          }
          if (before.payload.isExported !== after.payload.isExported) {
            facts.push(fact({
              record,
              filePath: diff.filePath,
              oldPath: diff.oldPath,
              node: after,
              beforeNode: before,
              afterNode: after,
              changeKind: "modify",
              subjectKind: "export",
              confidence: 0.95,
              rule: "projection.export.delta",
              confidenceReason: "before/after CodeGraph projections changed export state",
              status,
              hunk,
              signals: ["changed:isExported"],
            }))
            continue
          }
          if (CALLABLE_KINDS.has(after.payload.kind) && !hasBoundaryNode) {
            facts.push(fact({
              record,
              filePath: diff.filePath,
              oldPath: diff.oldPath,
              node: after,
              beforeNode: before,
              afterNode: after,
              changeKind: "modify",
              subjectKind: "body",
              confidence: 0.5,
              rule: "range.node.body",
              confidenceReason: "deleted changed lines intersect callable node but signature-like projection fields were stable",
              status,
              hunk,
              signals: [`node_kind:${after.payload.kind}`],
            }))
          }
          continue
        }
        if (after) continue
        facts.push(fact({
          record,
          filePath: diff.filePath,
          oldPath: diff.oldPath,
          node: before,
          beforeNode: before,
          changeKind: "delete",
          subjectKind: subjectForNode(before),
          confidence: 0.85,
          rule: "range.node.deleted",
          confidenceReason: "changed hunk intersects a before-sync CodeGraph node with no matching after projection",
          status,
          hunk,
          signals: ["before_node", "missing_after_projection", `node_kind:${before.payload.kind}`],
        }))
      }
    }

    const firstHunk = diff.hunks[0]
    if (lineHeuristic(diff.patch, "import") && !facts.some((item) => item.filePath === diff.filePath && item.subjectKind === "import")) {
      facts.push(fact({
        record,
        filePath: diff.filePath,
        oldPath: diff.oldPath,
        changeKind,
        subjectKind: "import",
        confidence: 0.65,
        rule: "diff.line.import",
        confidenceReason: "diff line matches language import syntax without CodeGraph node confirmation",
        status,
        hunk: firstHunk,
        signals: ["diff_import_syntax"],
      }))
    }

    if (lineHeuristic(diff.patch, "export") && !facts.some((item) => item.filePath === diff.filePath && item.subjectKind === "export")) {
      facts.push(fact({
        record,
        filePath: diff.filePath,
        oldPath: diff.oldPath,
        changeKind,
        subjectKind: "export",
        confidence: 0.65,
        rule: "diff.line.export",
        confidenceReason: "diff line matches language export syntax without CodeGraph node confirmation",
        status,
        hunk: firstHunk,
        signals: ["diff_export_syntax"],
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
