import { describe, expect, test } from "bun:test"
import { classifyChangeRecord } from "../../src/chimera/change-classifier"
import type { FrozenSemanticObject } from "../../src/chimera/codegraph-adapter"
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
} = {}): ToolMutationRecord {
  const filePath = input.filePath ?? "sample.ts"
  return {
    schemaVersion: 1,
    id: `event:${filePath}`,
    origin: "tool",
    provenanceStrength: "strong",
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
      language: "typescript" as FrozenSemanticObject["payload"]["language"],
      range: {
        startLine: input.startLine,
        endLine: input.endLine,
        startColumn: 0,
        endColumn: 0,
      },
      signature: input.signature,
      isExported: input.isExported ?? false,
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

  test("does not add unknown fallback when line heuristics classify the diff", () => {
    const patch = `--- sample.ts
+++ sample.ts
@@ -1,1 +1,1 @@
-import { oldValue } from "./old"
+import { newValue } from "./new"
`
    const facts = classifyChangeRecord({ record: record({ patch }) })

    expect(facts.some((fact) => fact.subjectKind === "import")).toBe(true)
    expect(facts.some((fact) => fact.subjectKind === "unknown")).toBe(false)
  })
})
