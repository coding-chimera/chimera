import { describe, expect, test } from "bun:test"
import path from "path"
import { DatabaseConnection, getDatabasePath, type FrozenRelation, type FrozenSemanticObject } from "@/graph"
import { appendProvenanceRecord, readChangeFacts, writeChangeFacts } from "../../src/chimera/store"
import type { ChangeFact } from "../../src/chimera/change-classifier"
import type { ToolMutationRecord } from "../../src/chimera/provenance"
import { tmpdir } from "../fixture/fixture"

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

function record(projectRoot: string): ToolMutationRecord {
  return {
    schemaVersion: 1,
    id: "event:store-test",
    origin: "tool",
    provenanceStrength: "strong",
    tool: {
      id: "write",
      messageID: "msg",
      sessionID: "session",
      callID: "call",
      agent: "test",
    },
    project: {
      root: projectRoot,
      worktree: projectRoot,
      directory: projectRoot,
    },
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    graph: {
      before: snapshot("before"),
      after: snapshot("after"),
      sync: {
        filesChecked: 1,
        filesAdded: 0,
        filesModified: 1,
        filesRemoved: 0,
        nodesUpdated: 1,
        durationMs: 1,
        changedFiles: [{ path: "sample.ts", status: "modified" }],
      },
    },
    files: [{ absolutePath: path.join(projectRoot, "sample.ts"), graphPath: "sample.ts", insideGraph: true }],
    metadata: {
      exists: true,
      filePath: path.join(projectRoot, "sample.ts"),
      diff: "--- sample.ts\n+++ sample.ts\n@@ -1 +1 @@\n-old\n+new\n",
    },
  }
}

function node(id: string, name: string): FrozenSemanticObject {
  return {
    schemaVersion: 1,
    objectType: "node",
    source: {
      system: "codegraph",
      codegraphVersion: "test",
      graphRevision: "before",
      schemaVersion: 1,
      codegraphId: id,
    },
    payload: {
      kind: "function",
      name,
      qualifiedName: name,
      filePath: "sample.ts",
      language: "typescript",
      range: { startLine: 1, endLine: 3, startColumn: 0, endColumn: 1 },
    },
  }
}

function relation(focal: FrozenSemanticObject, other: FrozenSemanticObject): FrozenRelation {
  const frozenNode = (input: FrozenSemanticObject) => ({
    codegraphId: input.source.codegraphId,
    graphRevision: input.source.graphRevision,
    nodeKey: `${input.payload.filePath}:${input.payload.kind}:${input.payload.qualifiedName}`,
    filePath: input.payload.filePath,
    kind: input.payload.kind,
    name: input.payload.name,
    qualifiedName: input.payload.qualifiedName,
    range: input.payload.range,
  })
  return {
    schemaVersion: 1,
    objectType: "relation",
    source: {
      system: "codegraph",
      codegraphVersion: "test",
      graphRevision: "before",
      schemaVersion: 1,
    },
    payload: {
      relation: "CalledBy",
      direction: "incoming",
      edgeKind: "calls",
      focalNode: frozenNode(focal),
      otherNode: frozenNode(other),
      sourceNode: frozenNode(other),
      targetNode: frozenNode(focal),
      quality: "exact",
    },
  }
}

function fact(input: { eventID: string; beforeNode: FrozenSemanticObject; relation: FrozenRelation }): ChangeFact {
  return {
    schemaVersion: 1,
    id: "fact_store_test",
    eventID: input.eventID,
    filePath: "sample.ts",
    nodeID: input.beforeNode.source.codegraphId,
    nodeKey: `${input.beforeNode.payload.filePath}:${input.beforeNode.payload.kind}:${input.beforeNode.payload.qualifiedName}`,
    changeKind: "delete",
    subjectKind: "signature",
    confidence: 0.9,
    createdAt: "2026-01-01T00:00:01.000Z",
    evidence: {
      version: 1,
      source: "tool_diff",
      rule: "range.node.deleted",
      confidenceReason: "test relation delta",
      graph: {
        beforeRevision: "before",
        afterRevision: "after",
      },
      file: {
        path: "sample.ts",
        status: "modified",
      },
      beforeNode: input.beforeNode,
      relationDelta: {
        schemaVersion: 1,
        source: {
          system: "codegraph",
          beforeRevision: "before",
          afterRevision: "after",
        },
        beforeRelations: [input.relation],
        afterRelations: [],
        addedRelations: [],
        removedRelations: [input.relation],
      },
      signals: ["before_node"],
    },
  }
}

describe("Chimera store", () => {
  test("creates audit, semantic snapshot, and oracle tables through CodeGraph storage extension", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()

    await appendProvenanceRecord(
      tmp.path,
      path.join(tmp.path, ".codegraph", "chimera", "tool-provenance.jsonl"),
      record(tmp.path),
    )

    const db = DatabaseConnection.open(getDatabasePath(tmp.path))
    try {
      const tables = (db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
      expect(db.getStorageExtensionVersion("chimera")).toBe(3)
      expect(tables).toContain("chimera_change_event")
      expect(tables).toContain("chimera_semantic_snapshot")
      expect(tables).toContain("chimera_semantic_object")
      expect(tables).toContain("chimera_semantic_snapshot_ref")
      expect(tables).toContain("chimera_oracle_result")
    } finally {
      db.close()
    }
  })

  test("hydrates relation delta from semantic snapshot refs when compact evidence is absent", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    await appendProvenanceRecord(
      tmp.path,
      path.join(tmp.path, ".codegraph", "chimera", "tool-provenance.jsonl"),
      record(tmp.path),
    )

    const focal = node("focal", "target")
    const caller = node("caller", "caller")
    await writeChangeFacts(tmp.path, [fact({ eventID: "event:store-test", beforeNode: focal, relation: relation(focal, caller) })])

    const db = DatabaseConnection.open(getDatabasePath(tmp.path))
    try {
      const row = db.getDb().prepare("SELECT payload_json FROM chimera_change_fact WHERE id = ?").get("fact_store_test") as { payload_json: string }
      const payload = JSON.parse(row.payload_json) as ChangeFact
      expect(payload.evidence.semanticSnapshots?.beforeSnapshotID).toBeTruthy()
      expect(payload.evidence.semanticSnapshots?.beforeRelationHashes).toHaveLength(1)
      delete payload.evidence.relationDelta
      db.getDb().prepare("UPDATE chimera_change_fact SET payload_json = ?, evidence_json = ? WHERE id = ?").run(
        JSON.stringify(payload),
        JSON.stringify(payload.evidence),
        payload.id,
      )
    } finally {
      db.close()
    }

    const [stored] = await readChangeFacts(tmp.path, ["event:store-test"])
    expect(stored?.evidence.signals).toContain("semantic_snapshot_refs")
    expect(stored?.evidence.relationDelta?.removedRelations).toHaveLength(1)
    expect(stored?.evidence.relationDelta?.removedRelations[0]?.payload.otherNode.name).toBe("caller")
  })

  test("keeps legacy compact relation evidence when semantic snapshot refs are absent", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    await appendProvenanceRecord(
      tmp.path,
      path.join(tmp.path, ".codegraph", "chimera", "tool-provenance.jsonl"),
      record(tmp.path),
    )

    const focal = node("focal", "target")
    const caller = node("caller", "caller")
    await writeChangeFacts(tmp.path, [fact({ eventID: "event:store-test", beforeNode: focal, relation: relation(focal, caller) })])

    const db = DatabaseConnection.open(getDatabasePath(tmp.path))
    try {
      const row = db.getDb().prepare("SELECT payload_json FROM chimera_change_fact WHERE id = ?").get("fact_store_test") as { payload_json: string }
      const payload = JSON.parse(row.payload_json) as ChangeFact
      delete payload.evidence.semanticSnapshots
      payload.evidence.signals = payload.evidence.signals.filter((signal) => signal !== "semantic_snapshot_refs")
      db.getDb().prepare("UPDATE chimera_change_fact SET payload_json = ?, evidence_json = ? WHERE id = ?").run(
        JSON.stringify(payload),
        JSON.stringify(payload.evidence),
        payload.id,
      )
    } finally {
      db.close()
    }

    const [stored] = await readChangeFacts(tmp.path, ["event:store-test"])
    expect(stored?.evidence.signals).not.toContain("semantic_snapshot_refs")
    expect(stored?.evidence.relationDelta?.removedRelations).toHaveLength(1)
    expect(stored?.evidence.relationDelta?.removedRelations[0]?.payload.otherNode.name).toBe("caller")
  })
})
