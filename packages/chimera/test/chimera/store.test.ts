import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { DatabaseConnection, getDatabasePath, type FrozenRelation, type FrozenSemanticObject } from "@/graph"
import { appendProvenanceRecord, compactCommittedChangeEvidence, readChangeFacts, readCommitChangeSummaries, readPersistentObligationStore, recordOracleResult, writeChangeFacts } from "../../src/chimera/store"
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

async function git(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  return stdout.trim()
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
      expect(db.getStorageExtensionVersion("chimera")).toBe(4)
      expect(tables).toContain("chimera_change_event")
      expect(tables).toContain("chimera_semantic_snapshot")
      expect(tables).toContain("chimera_semantic_object")
      expect(tables).toContain("chimera_semantic_snapshot_ref")
      expect(tables).toContain("chimera_oracle_result")
      expect(tables).toContain("chimera_commit_change_summary")
    } finally {
      db.close()
    }
  })

  test("stores raw change evidence outside payload_json to avoid duplicating large relation payloads", async () => {
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
      const row = db.getDb().prepare("SELECT payload_json, evidence_json FROM chimera_change_fact WHERE id = ?").get("fact_store_test") as { payload_json: string; evidence_json: string }
      const payload = JSON.parse(row.payload_json) as ChangeFact
      const evidence = JSON.parse(row.evidence_json) as ChangeFact["evidence"]
      expect(payload.evidence.beforeNode).toBeUndefined()
      expect(payload.evidence.relationDelta).toBeUndefined()
      expect(payload.evidence.semanticSnapshots?.beforeRelationHashes).toHaveLength(1)
      expect(evidence.beforeNode?.payload.name).toBe("target")
      expect(evidence.relationDelta?.removedRelations).toHaveLength(1)
      expect(row.payload_json.length).toBeLessThan(row.evidence_json.length)
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
    expect(stored?.evidence.replayLifecycle?.status).toBe("replayable")
    expect(stored?.evidence.replayLifecycle?.expectedRefs).toBe(1)
    expect(stored?.evidence.replayLifecycle?.foundRefs).toBe(1)
    expect(stored?.evidence.signals).toContain("replay_lifecycle:replayable")
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
      const row = db.getDb().prepare("SELECT payload_json, evidence_json FROM chimera_change_fact WHERE id = ?").get("fact_store_test") as { payload_json: string; evidence_json: string }
      const payload = JSON.parse(row.payload_json) as ChangeFact
      payload.evidence = JSON.parse(row.evidence_json) as ChangeFact["evidence"]
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

  test("marks semantic snapshot refs missing when compact objects are absent", async () => {
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
      delete payload.evidence.relationDelta
      db.getDb().prepare("UPDATE chimera_change_fact SET payload_json = ?, evidence_json = ? WHERE id = ?").run(
        JSON.stringify(payload),
        JSON.stringify(payload.evidence),
        payload.id,
      )
      db.getDb().prepare("DELETE FROM chimera_semantic_object WHERE kind = 'relation'").run()
    } finally {
      db.close()
    }

    const [stored] = await readChangeFacts(tmp.path, ["event:store-test"])
    expect(stored?.evidence.relationDelta).toBeUndefined()
    expect(stored?.evidence.replayLifecycle?.status).toBe("missing_snapshot_refs")
    expect(stored?.evidence.replayLifecycle?.expectedRefs).toBe(1)
    expect(stored?.evidence.replayLifecycle?.foundRefs).toBe(0)
    expect(stored?.evidence.signals).toContain("replay_lifecycle:missing_snapshot_refs")
  })

  test("compacts trusted oracle-passed committed evidence into commit summaries", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    await fs.writeFile(path.join(tmp.path, "sample.ts"), "new\n")
    await git(tmp.path, ["init"])
    await git(tmp.path, ["config", "user.email", "chimera-test@example.com"])
    await git(tmp.path, ["config", "user.name", "Chimera Test"])
    await git(tmp.path, ["add", "sample.ts"])
    await git(tmp.path, ["commit", "-m", "commit sample"])

    const mutation = record(tmp.path)
    await appendProvenanceRecord(
      tmp.path,
      path.join(tmp.path, ".codegraph", "chimera", "tool-provenance.jsonl"),
      mutation,
    )

    const focal = node("focal", "target")
    const caller = node("caller", "caller")
    await writeChangeFacts(tmp.path, [fact({ eventID: mutation.id, beforeNode: focal, relation: relation(focal, caller) })])
    await recordOracleResult(tmp.path, path.join(tmp.path, ".codegraph", "chimera", "oracle-results.jsonl"), {
      kind: "lsp",
      status: "pass",
      tool: {
        id: "edit",
        messageID: "oracle-msg",
        sessionID: "session",
        callID: "oracle-call",
        agent: "test",
      },
      project: {
        root: tmp.path,
        worktree: tmp.path,
        directory: tmp.path,
      },
      finishedAt: "2026-01-01T00:00:02.000Z",
      linkWindow: {
        source: "same_session_preceding_mutations",
        sessionID: "session",
        projectRoot: tmp.path,
        finishedBefore: "2026-01-01T00:00:02.000Z",
        maxChanges: 20,
      },
      linkedChanges: [{
        id: mutation.id,
        toolID: "write",
        status: "success",
        finishedAt: mutation.finishedAt,
        beforeRevision: mutation.graph.before.revision,
        afterRevision: mutation.graph.after.revision,
        files: ["sample.ts"],
        changeID: "chg_store_test",
      }],
      payload: {
        lsp: {
          diagnostics: {},
          files: [path.join(tmp.path, "sample.ts")],
          diagnosticCount: 0,
        },
      },
    })

    const result = await compactCommittedChangeEvidence(tmp.path, { now: "2026-01-01T00:00:03.000Z" })
    expect(result.candidateEvents).toBe(1)
    expect(result.compactedEvents).toBe(1)
    expect(result.deletedFacts).toBe(1)
    expect(result.deletedSemanticSnapshots).toBe(1)
    expect(result.summariesWritten).toBe(1)

    expect(await readChangeFacts(tmp.path, [mutation.id])).toHaveLength(0)
    const [summary] = await readCommitChangeSummaries(tmp.path)
    expect(summary?.commit).toBe(await git(tmp.path, ["rev-parse", "HEAD"]))
    expect(summary?.mutationIDs).toContain(mutation.id)
    expect(summary?.oracleIDs).toHaveLength(1)
    expect(summary?.changeIDs).toContain("chg_store_test")
    expect(summary?.files).toContain("sample.ts")
    expect(summary?.subjectCounts.signature).toBe(1)

    const db = DatabaseConnection.open(getDatabasePath(tmp.path))
    try {
      const facts = db.getDb().prepare("SELECT COUNT(*) AS count FROM chimera_change_fact").get() as { count: number }
      const objects = db.getDb().prepare("SELECT COUNT(*) AS count FROM chimera_semantic_object").get() as { count: number }
      const events = db.getDb().prepare("SELECT COUNT(*) AS count FROM chimera_change_event").get() as { count: number }
      expect(facts.count).toBe(0)
      expect(objects.count).toBe(0)
      expect(events.count).toBe(1)
    } finally {
      db.close()
    }
  })

  test("imports legacy persistent obligations into the database store", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    const artifact = path.join(tmp.path, ".codegraph", "chimera", "obligations.json")
    const obligation = {
      id: "obl_legacy",
      fingerprint: "legacy:fingerprint",
      status: "pending",
      target: "legacy.ts",
      risk: "behavior",
      classification: "source",
      reason: "legacy obligation artifact",
      evidence: "legacy:evidence",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }

    await fs.mkdir(path.dirname(artifact), { recursive: true })
    await Bun.write(artifact, `${JSON.stringify({ schemaVersion: 1, obligations: [obligation] })}\n`)

    const store = await readPersistentObligationStore<typeof obligation>(tmp.path, artifact, { schemaVersion: 1, obligations: [] })
    expect(store.obligations).toHaveLength(1)
    expect(store.obligations[0]).toMatchObject({ id: "obl_legacy", target: "legacy.ts", status: "pending" })

    const db = DatabaseConnection.open(getDatabasePath(tmp.path))
    try {
      const row = db.getDb().prepare("SELECT COUNT(*) as count FROM chimera_audit_obligation WHERE id = ?").get(obligation.id) as { count: number }
      expect(row.count).toBe(1)
    } finally {
      db.close()
    }
  })
})
