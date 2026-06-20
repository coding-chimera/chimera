import { describe, expect, test } from "bun:test"
import { classifyChangeRecord } from "../../src/chimera/change-classifier"
import type { FrozenRelation, FrozenSemanticObject, LanguageAwareSignal } from "@/graph"
import type { ToolMutationRecord } from "../../src/chimera/provenance"

const bodyPatch = `--- sample.ts
+++ sample.ts
@@ -1,3 +1,3 @@
 export function one() {
-return 1
+return 2
 }
`

function snapshot(revision: string) {
  return {
    schemaVersion: 1,
    codegraphVersion: "test",
    revision,
    indexedAt: 1,
    fileCount: 1,
    nodeCount: 1,
    edgeCount: 0,
    dbSizeBytes: 0,
  }
}

function record(input: {
  filePath?: string
  patch?: string
  metadata?: Record<string, unknown>
  syncStatus?: "added" | "modified" | "removed"
  origin?: ToolMutationRecord["origin"]
  provenanceStrength?: ToolMutationRecord["provenanceStrength"]
} = {}): ToolMutationRecord {
  const filePath = input.filePath ?? "sample.ts"
  return {
    schemaVersion: 1,
    id: `event:${filePath}`,
    origin: input.origin ?? "tool",
    provenanceStrength: input.provenanceStrength ?? "strong",
    tool: {
      id: "write",
      messageID: "msg",
      sessionID: "ses",
      agent: "test",
    },
    project: {
      root: "/project",
      worktree: "/project",
      directory: "/project",
    },
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    graph: {
      before: snapshot("before"),
      after: snapshot("after"),
      sync: {
        filesChecked: 1,
        filesAdded: input.syncStatus === "added" ? 1 : 0,
        filesModified: input.syncStatus === "modified" ? 1 : 0,
        filesRemoved: input.syncStatus === "removed" ? 1 : 0,
        nodesUpdated: 1,
        durationMs: 1,
        changedFiles: input.syncStatus ? [{ path: filePath, status: input.syncStatus }] : undefined,
      },
    },
    files: [{ absolutePath: `/project/${filePath}`, graphPath: filePath, insideGraph: true }],
    metadata: {
      exists: true,
      filePath: `/project/${filePath}`,
      diff: input.patch ?? bodyPatch,
      ...input.metadata,
    },
  }
}

function node(input: {
  id: string
  kind: FrozenSemanticObject["payload"]["kind"]
  name: string
  qualifiedName?: string
  filePath?: string
  startLine: number
  endLine: number
  signature?: string
  isExported?: boolean
  language?: FrozenSemanticObject["payload"]["language"]
  languageSignals?: LanguageAwareSignal[]
}): FrozenSemanticObject {
  return {
    schemaVersion: 1,
    objectType: "node",
    source: {
      system: "codegraph",
      codegraphVersion: "test",
      graphRevision: "revision",
      schemaVersion: 1,
      codegraphId: input.id,
    },
    payload: {
      kind: input.kind,
      name: input.name,
      qualifiedName: input.qualifiedName ?? input.name,
      filePath: input.filePath ?? "sample.ts",
      language: input.language ?? "typescript" as FrozenSemanticObject["payload"]["language"],
      range: {
        startLine: input.startLine,
        endLine: input.endLine,
        startColumn: 0,
        endColumn: 0,
      },
      signature: input.signature,
      isExported: input.isExported ?? false,
      languageSignals: input.languageSignals,
    },
  }
}

function languageSignal(input: {
  kind: LanguageAwareSignal["kind"]
  line: number
  language?: LanguageAwareSignal["language"]
  source?: LanguageAwareSignal["source"]
  quality?: LanguageAwareSignal["quality"]
  confidence?: number
}): LanguageAwareSignal {
  const language = input.language ?? "typescript"
  const source = input.source ?? "codegraph:language_analyzer"
  const quality = input.quality ?? (input.kind === "unknown_body_effect" ? "unknown" : "heuristic")
  return {
    schemaVersion: 1,
    kind: input.kind,
    language,
    source,
    quality,
    confidence: input.confidence ?? (quality === "unknown" ? 0.45 : quality === "exact" ? 0.95 : 0.75),
    range: { startLine: input.line, endLine: input.line, startColumn: 0, endColumn: 0 },
    reason: `test ${input.kind}`,
    signals: [`language:${language}`, `source:${source}`, `quality:${quality}`, `codegraph_language_signal:${input.kind}`],
  }
}

function relationNode(node: FrozenSemanticObject): FrozenRelation["payload"]["focalNode"] {
  return {
    codegraphId: node.source.codegraphId,
    graphRevision: node.source.graphRevision,
    nodeKey: `${node.payload.filePath}:${node.payload.kind}:${node.payload.qualifiedName || node.payload.name}`,
    filePath: node.payload.filePath,
    kind: node.payload.kind,
    name: node.payload.name,
    qualifiedName: node.payload.qualifiedName,
    range: node.payload.range,
  }
}

function relation(input: { focal: FrozenSemanticObject; other: FrozenSemanticObject }): FrozenRelation {
  return {
    schemaVersion: 1,
    objectType: "relation",
    source: {
      system: "codegraph",
      codegraphVersion: "test",
      graphRevision: input.focal.source.graphRevision,
      schemaVersion: 1,
    },
    payload: {
      relation: "CalledBy",
      direction: "incoming",
      edgeKind: "calls",
      focalNode: relationNode(input.focal),
      otherNode: relationNode(input.other),
      sourceNode: relationNode(input.other),
      targetNode: relationNode(input.focal),
      provenance: "tree-sitter",
      quality: "exact",
    },
  }
}

describe("change classifier", () => {
  test("uses tool metadata status instead of untracked sync status", () => {
    const before = node({ id: "before-one", kind: "function", name: "one", startLine: 1, endLine: 3, signature: "function one()" })
    const after = node({ id: "after-one", kind: "function", name: "one", startLine: 1, endLine: 3, signature: "function one()" })
    const facts = classifyChangeRecord({
      record: record({ syncStatus: "added", metadata: { exists: true } }),
      beforeNodes: [before],
      afterNodes: [after],
    })

    const file = facts.find((fact) => fact.subjectKind === "file")
    expect(file?.changeKind).toBe("modify")
    expect(file?.evidence.file.status).toBe("modify")
    expect(file?.evidence.signals).toContain("status_source:tool_metadata")
  })

  test("ignores file and module container nodes when semantic facts exist", () => {
    const before = node({ id: "before-one", kind: "function", name: "one", startLine: 1, endLine: 3, signature: "function one()" })
    const after = node({ id: "after-one", kind: "function", name: "one", startLine: 1, endLine: 3, signature: "function one()" })
    const container = [
      node({ id: "file", kind: "file", name: "sample.ts", startLine: 1, endLine: 3 }),
      node({ id: "module", kind: "module", name: "sample", startLine: 1, endLine: 3 }),
    ]
    const facts = classifyChangeRecord({
      record: record(),
      beforeNodes: [before, ...container],
      afterNodes: [after, ...container],
    })

    expect(facts.some((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:one"))).toBe(true)
    expect(facts.some((fact) => fact.subjectKind === "unknown")).toBe(false)
    expect(facts.some((fact) => fact.evidence.signals.includes("node_kind:file"))).toBe(false)
    expect(facts.some((fact) => fact.evidence.signals.includes("node_kind:module"))).toBe(false)
  })

  test("matches actual changed lines instead of whole hunk context", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,7 +1,7 @@
 function a() {
-return 1
+return 2
 }
 
 function b() {
 return 3
 }
`
    const beforeA = node({ id: "before-a", kind: "function", name: "a", startLine: 1, endLine: 3, signature: "function a()" })
    const afterA = node({ id: "after-a", kind: "function", name: "a", startLine: 1, endLine: 3, signature: "function a()" })
    const beforeB = node({ id: "before-b", kind: "function", name: "b", startLine: 5, endLine: 7, signature: "function b()" })
    const afterB = node({ id: "after-b", kind: "function", name: "b", startLine: 5, endLine: 7, signature: "function b()" })
    const facts = classifyChangeRecord({
      record: record({ patch }),
      beforeNodes: [beforeA, beforeB],
      afterNodes: [afterA, afterB],
    })

    expect(facts.some((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:a"))).toBe(true)
    expect(facts.some((fact) => fact.nodeKey?.includes(":function:b"))).toBe(false)
  })

  test("keeps body facts on the smallest callable node", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,7 +1,7 @@
 class Sample {
 value() {
-return 1
+return 2
 }
 }
`
    const beforeClass = node({ id: "before-class", kind: "class", name: "Sample", startLine: 1, endLine: 5 })
    const afterClass = node({ id: "after-class", kind: "class", name: "Sample", startLine: 1, endLine: 5 })
    const beforeMethod = node({ id: "before-method", kind: "method", name: "value", qualifiedName: "Sample.value", startLine: 2, endLine: 4, signature: "value()" })
    const afterMethod = node({ id: "after-method", kind: "method", name: "value", qualifiedName: "Sample.value", startLine: 2, endLine: 4, signature: "value()" })
    const facts = classifyChangeRecord({
      record: record({ patch }),
      beforeNodes: [beforeClass, beforeMethod],
      afterNodes: [afterClass, afterMethod],
    })

    expect(facts.some((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":method:Sample.value"))).toBe(true)
    expect(facts.some((fact) => fact.subjectKind === "schema" && fact.nodeKey?.includes(":class:Sample"))).toBe(false)
  })

  test("uses CodeGraph local-only language signals for body confidence", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,4 +1,4 @@
 export function calculate(value: number) {
-const local = value + 1
+const local = value + 2
 return value
 }
`
    const languageSignals = [languageSignal({ kind: "return_value_changed", line: 3 })]
    const before = node({ id: "before-calculate", kind: "function", name: "calculate", startLine: 1, endLine: 4, signature: "function calculate(value: number)", languageSignals })
    const after = node({ id: "after-calculate", kind: "function", name: "calculate", startLine: 1, endLine: 4, signature: "function calculate(value: number)", languageSignals })
    const facts = classifyChangeRecord({ record: record({ patch }), beforeNodes: [before], afterNodes: [after] })

    const body = facts.find((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:calculate"))
    expect(body?.confidence).toBe(0.25)
    expect(body?.evidence.rule).toBe("codegraph.language.body.local_only")
    expect(body?.evidence.languageSignals?.map((signal) => signal.kind)).toEqual(["local_only_change"])
    expect(body?.evidence.signals).toContain("codegraph_language_signal:local_only_change")
  })

  test("uses caller-visible language signals and preserves constructor override route context", () => {
    const languageSignals = [
      languageSignal({ kind: "return_value_changed", line: 2 }),
      languageSignal({ kind: "constructor_like", line: 1, quality: "exact", confidence: 0.95 }),
      languageSignal({ kind: "override_like", line: 1, quality: "exact", confidence: 0.95 }),
      languageSignal({ kind: "route_handler_like", line: 1, quality: "exact", confidence: 0.95 }),
    ]
    const before = node({ id: "before-visible", kind: "function", name: "visible", startLine: 1, endLine: 3, signature: "function visible()", languageSignals })
    const after = node({ id: "after-visible", kind: "function", name: "visible", startLine: 1, endLine: 3, signature: "function visible()", languageSignals })
    const facts = classifyChangeRecord({ record: record(), beforeNodes: [before], afterNodes: [after] })

    const body = facts.find((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:visible"))
    expect(body?.confidence).toBe(0.9)
    expect(body?.evidence.rule).toBe("codegraph.language.body.caller_visible")
    expect(body?.evidence.confidenceReason).toContain("node context: constructor_like, override_like, route_handler_like")
    expect(body?.evidence.languageSignals?.map((signal) => signal.kind)).toEqual(["return_value_changed"])
    expect(body?.evidence.signals).toContain("codegraph_language_signal:constructor_like")
    expect(body?.evidence.signals).toContain("codegraph_language_signal:override_like")
    expect(body?.evidence.signals).toContain("codegraph_language_signal:route_handler_like")
  })

  test("keeps unknown body effects for unsupported languages", () => {
    const languageSignals = [languageSignal({ kind: "unknown_body_effect", line: 1, language: "python", source: "codegraph:fallback", quality: "unknown" })]
    const before = node({ id: "before-py", kind: "function", name: "calculate", startLine: 1, endLine: 3, signature: "def calculate()", language: "python", languageSignals })
    const after = node({ id: "after-py", kind: "function", name: "calculate", startLine: 1, endLine: 3, signature: "def calculate()", language: "python", languageSignals })
    const facts = classifyChangeRecord({ record: record(), beforeNodes: [before], afterNodes: [after] })

    const body = facts.find((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:calculate"))
    expect(body?.confidence).toBe(0.5)
    expect(body?.evidence.rule).toBe("codegraph.language.body.unknown")
    expect(body?.evidence.languageSignals?.map((signal) => signal.kind)).toEqual(["unknown_body_effect"])
    expect(body?.evidence.signals).not.toContain("codegraph_language_signal:local_only_change")
  })

  test("uses CodeGraph semantic diff evidence for signature deltas", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,3 +1,3 @@
-function value(input: string) {
+function value(input: number) {
 return input
 }
`
    const before = node({ id: "before-value", kind: "function", name: "value", startLine: 1, endLine: 3, signature: "function value(input: string)" })
    const after = node({ id: "after-value", kind: "function", name: "value", startLine: 1, endLine: 3, signature: "function value(input: number)" })
    const facts = classifyChangeRecord({
      record: record({ patch }),
      beforeNodes: [before],
      afterNodes: [after],
    })

    const signature = facts.find((fact) => fact.subjectKind === "signature" && fact.nodeKey?.includes(":function:value"))
    expect(signature?.evidence.rule).toBe("codegraph.semantic.diff")
    expect(signature?.evidence.semanticDiff?.changedFields).toEqual(["signature"])
    expect(signature?.evidence.signals).toContain("codegraph_semantic_diff:modify")
    expect(facts.some((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:value"))).toBe(false)
  })

  test("uses CodeGraph semantic diff evidence for export deltas", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,3 +1,3 @@
-function value() {
+export function value() {
 return 1
 }
`
    const before = node({ id: "before-value", kind: "function", name: "value", startLine: 1, endLine: 3, signature: "function value()", isExported: false })
    const after = node({ id: "after-value", kind: "function", name: "value", startLine: 1, endLine: 3, signature: "function value()", isExported: true })
    const facts = classifyChangeRecord({
      record: record({ patch }),
      beforeNodes: [before],
      afterNodes: [after],
    })

    const exported = facts.find((fact) => fact.subjectKind === "export" && fact.nodeKey?.includes(":function:value"))
    expect(exported?.evidence.rule).toBe("codegraph.semantic.diff")
    expect(exported?.evidence.semanticDiff?.changedFields).toEqual(["isExported"])
    expect(exported?.evidence.signals).toContain("changed:isExported")
  })

  test("uses CodeGraph file role evidence for file boundary facts", () => {
    const facts = classifyChangeRecord({ record: record({ filePath: "package.json" }) })

    const config = facts.find((fact) => fact.subjectKind === "config")
    expect(config?.evidence.rule).toBe("codegraph.file_role.dependency_manifest")
    expect(config?.evidence.fileSemantic?.role).toBe("dependency_manifest")
    expect(config?.evidence.fileSemantic?.classifierVersion).toBe(1)
    expect(config?.evidence.signals).toContain("codegraph_file_role:dependency_manifest")
    expect(config?.evidence.signals).toContain("source:codegraph:file_classifier")
  })

  test("uses CodeGraph file-level import semantic signals", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,1 +1,1 @@
-import { oldValue } from "./old"
+import { newValue } from "./new"
`
    const facts = classifyChangeRecord({ record: record({ patch }) })
    const imported = facts.find((fact) => fact.subjectKind === "import")

    expect(imported?.evidence.rule).toBe("codegraph.file_semantic.import_statement")
    expect(imported?.evidence.signals).toContain("source:codegraph:diff_classifier")
    expect(imported?.evidence.signals).not.toContain("temporary_heuristic")
    expect(facts.every((fact) => !fact.evidence.rule.startsWith("temporary_heuristic."))).toBe(true)
    expect(facts.some((fact) => fact.subjectKind === "unknown")).toBe(false)
  })

  test("uses CodeGraph file-level export semantic signals", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,1 +1,2 @@
 const value = 1
+export { value }
`
    const facts = classifyChangeRecord({ record: record({ patch }) })
    const exported = facts.find((fact) => fact.subjectKind === "export")

    expect(exported?.evidence.rule).toBe("codegraph.file_semantic.export_boundary")
    expect(exported?.evidence.signals).toContain("source:codegraph:diff_classifier")
    expect(exported?.evidence.signals).not.toContain("temporary_heuristic")
    expect(facts.every((fact) => !fact.evidence.rule.startsWith("temporary_heuristic."))).toBe(true)
  })

  test("classifies route node mutations as route facts", () => {
    const patch = `--- src/routes/users.ts
+++ src/routes/users.ts
@@ -1,1 +1,1 @@
-router.get('/users', listUsers)
+router.post('/users', listUsers)
`
    const before = node({ id: "before-route", kind: "route", name: "GET /users", filePath: "src/routes/users.ts", startLine: 1, endLine: 1 })
    const after = node({ id: "after-route", kind: "route", name: "POST /users", filePath: "src/routes/users.ts", startLine: 1, endLine: 1 })
    const facts = classifyChangeRecord({ record: record({ filePath: "src/routes/users.ts", patch }), beforeNodes: [before], afterNodes: [after] })

    const route = facts.find((fact) => fact.subjectKind === "route" && fact.evidence.rule === "range.node.route")
    expect(route?.subjectKind).toBe("route")
    expect(route?.evidence.rule).toBe("range.node.route")
    expect(route?.nodeKey).toContain(":route:POST /users")
    expect(route?.evidence.signals).toContain("node_kind:route")
  })

  test("classifies schema node mutations as schema facts", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,3 +1,3 @@
 interface User {
-name: string
+name: number
 }
`
    const before = node({ id: "before-user", kind: "interface", name: "User", startLine: 1, endLine: 3, signature: "interface User { name: string }" })
    const after = node({ id: "after-user", kind: "interface", name: "User", startLine: 1, endLine: 3, signature: "interface User { name: number }" })
    const facts = classifyChangeRecord({ record: record({ patch }), beforeNodes: [before], afterNodes: [after] })

    const schema = facts.find((fact) => fact.subjectKind === "schema")
    expect(schema?.evidence.rule).toBe("range.node.schema")
    expect(schema?.nodeKey).toContain(":interface:User")
  })


  test("classifies route path boundaries without route node projections", () => {
    const patch = `--- src/server/api/users/route.ts
+++ src/server/api/users/route.ts
@@ -1,1 +1,1 @@
-export const GET = listUsers
+export const POST = listUsers
`
    const facts = classifyChangeRecord({ record: record({ filePath: "src/server/api/users/route.ts", patch }) })

    const route = facts.find((fact) => fact.subjectKind === "route" && fact.evidence.rule === "codegraph.file_role.api_route")
    expect(route?.filePath).toBe("src/server/api/users/route.ts")
    expect(route?.confidence).toBe(0.65)
    expect(route?.evidence.fileSemantic?.role).toBe("api_route")
    expect(route?.evidence.fileSemantic?.source).toBe("codegraph:file_classifier")
    expect(route?.evidence.signals).toContain("codegraph_file_role:api_route")
    expect(route?.evidence.signals).toContain("route_path")
  })

  test("keeps route node facts precise without duplicating handler body facts", () => {
    const patch = `--- src/routes/users.ts
+++ src/routes/users.ts
@@ -1,1 +1,1 @@
-router.get('/users', listUsers)
+router.post('/users', listUsers)
`
    const beforeRoute = node({ id: "before-route", kind: "route", name: "GET /users", filePath: "src/routes/users.ts", startLine: 1, endLine: 1 })
    const afterRoute = node({ id: "after-route", kind: "route", name: "POST /users", filePath: "src/routes/users.ts", startLine: 1, endLine: 1 })
    const beforeHandler = node({ id: "before-handler", kind: "function", name: "listUsers", filePath: "src/routes/users.ts", startLine: 1, endLine: 1, signature: "function listUsers()" })
    const afterHandler = node({ id: "after-handler", kind: "function", name: "listUsers", filePath: "src/routes/users.ts", startLine: 1, endLine: 1, signature: "function listUsers()" })
    const facts = classifyChangeRecord({
      record: record({ filePath: "src/routes/users.ts", patch }),
      beforeNodes: [beforeRoute, beforeHandler],
      afterNodes: [afterRoute, afterHandler],
    })

    expect(facts.some((fact) => fact.subjectKind === "route" && fact.nodeKey?.includes(":route:POST /users"))).toBe(true)
    expect(facts.some((fact) => fact.subjectKind === "body" && fact.nodeKey?.includes(":function:listUsers"))).toBe(false)
  })

  test("preserves weak git rename old path from move metadata", () => {
    const patch = `--- old.ts
+++ new.ts
@@ -1,1 +1,1 @@
-const value = 1
+const value = 2
`
    const facts = classifyChangeRecord({
      record: record({
        filePath: "new.ts",
        patch: "",
        origin: "git",
        provenanceStrength: "weak",
        metadata: {
          files: [{ type: "renamed", filePath: "/project/old.ts", movePath: "/project/new.ts", patch }],
        },
      }),
    })

    const moved = facts.find((fact) => fact.oldPath === "old.ts" && fact.evidence.file.status === "renamed")
    expect(moved?.changeKind).toBe("move")
    expect(moved?.evidence.source).toBe("git_diff")
    expect(moved?.evidence.file.oldPath).toBe("old.ts")
    expect(moved?.evidence.signals).toContain("hunk_unmatched")
  })

  test("keeps weak watcher delete-node relation evidence for schema fields", () => {
    const patch = `--- models/user.ts
+++ models/user.ts
@@ -1,4 +1,3 @@
 interface User {
-  name: string
   id: string
 }
`
    const beforeField = node({ id: "before-name", kind: "property", name: "name", qualifiedName: "User.name", filePath: "models/user.ts", startLine: 2, endLine: 2 })
    const reader = node({ id: "reader", kind: "function", name: "readUserName", filePath: "reader.ts", startLine: 1, endLine: 3, signature: "function readUserName(user: User)" })
    const facts = classifyChangeRecord({
      record: record({ filePath: "models/user.ts", patch, origin: "filesystem", provenanceStrength: "weak", syncStatus: "modified" }),
      beforeNodes: [beforeField],
      afterNodes: [],
      beforeRelations: [relation({ focal: beforeField, other: reader })],
      afterRelations: [],
    })

    const deleted = facts.find((fact) => fact.changeKind === "delete" && fact.subjectKind === "schema" && fact.nodeKey?.includes(":property:User.name"))
    expect(deleted?.evidence.source).toBe("watcher")
    expect(deleted?.evidence.relationDelta?.removedRelations[0]?.payload.otherNode.name).toBe("readUserName")
    expect(deleted?.evidence.signals).toContain("missing_after_projection")
  })
  test("preserves tool move metadata old path and move status", () => {
    const patch = `--- old.ts
+++ new.ts
@@ -1,1 +1,1 @@
-export const value = 1
+export const value = 2
`
    const facts = classifyChangeRecord({
      record: record({
        filePath: "new.ts",
        metadata: {
          files: [{ type: "move", filePath: "/project/old.ts", movePath: "/project/new.ts", patch }],
        },
      }),
    })

    const file = facts.find((fact) => fact.filePath === "new.ts" && fact.subjectKind === "file")
    const moved = facts.find((fact) => fact.filePath === "new.ts" && fact.oldPath === "old.ts" && fact.evidence.file.status === "move")
    expect(file?.changeKind).toBe("move")
    expect(moved?.evidence.file.oldPath).toBe("old.ts")
    expect(moved?.evidence.file.status).toBe("move")
  })

  test("downgrades weak git provenance file facts", () => {
    const facts = classifyChangeRecord({
      record: record({ origin: "git", provenanceStrength: "weak", syncStatus: "modified" }),
    })

    const file = facts.find((fact) => fact.subjectKind === "file")
    expect(file?.confidence).toBe(0.35)
    expect(file?.evidence.source).toBe("git_diff")
    expect(file?.evidence.signals).toContain("status_source:codegraph_sync")
  })

  test("stores CodeGraph relation delta evidence for deleted node facts", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,3 +0,0 @@
-export function one() {
-return 1
-}
`
    const before = node({ id: "before-one", kind: "function", name: "one", startLine: 1, endLine: 3, signature: "function one()" })
    const caller = node({ id: "caller", kind: "function", name: "caller", filePath: "caller.ts", startLine: 1, endLine: 3, signature: "function caller()" })
    const facts = classifyChangeRecord({
      record: record({ patch }),
      beforeNodes: [before],
      afterNodes: [],
      beforeRelations: [relation({ focal: before, other: caller })],
      afterRelations: [],
    })

    const deleted = facts.find((fact) => fact.changeKind === "delete" && fact.nodeKey?.includes(":function:one"))
    expect(deleted?.evidence.relationDelta?.removedRelations[0]?.payload.relation).toBe("CalledBy")
    expect(deleted?.evidence.relationDelta?.removedRelations[0]?.payload.otherNode.name).toBe("caller")
  })
})
