import { describe, expect, test } from "bun:test"
import path from "path"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { appendProvenanceRecord, closeStoreConnections, readProvenanceRecords } from "../../src/chimera/store"
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

function record(projectRoot: string, id = "event:store-busy-retry"): ToolMutationRecord {
  return {
    schemaVersion: 1,
    id,
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

// A cross-process writer holds BEGIN IMMEDIATE past the store connection's
// 5000ms busy_timeout, so the first write attempt is guaranteed to surface
// SQLITE_BUSY and the bounded backoff retry has to land it on a later attempt.
function lockHolderScript(dbPath: string, holdMs: number) {
  return `
import { Database } from "bun:sqlite"
const db = new Database(${JSON.stringify(dbPath)})
db.exec("PRAGMA busy_timeout = 5000")
db.exec("BEGIN IMMEDIATE")
process.stdout.write("locked\\n")
await Bun.sleep(${holdMs})
db.exec("COMMIT")
db.close()
`
}

async function waitForLocked(holder: ReturnType<typeof Bun.spawn>) {
  const stdout = holder.stdout
  if (!(stdout instanceof ReadableStream)) return ""
  const reader = stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  return new TextDecoder().decode(first.value ?? new Uint8Array())
}

describe("Chimera store busy retry (F2)", () => {
  test("real write-lock contention past busy_timeout still lands provenance in the db", async () => {
    await using tmp = await tmpdir()
    const dbPath = getDatabasePath(tmp.path)
    const artifact = path.join(tmp.path, ".chimera", "chimera", "tool-provenance.jsonl")
    DatabaseConnection.initialize(dbPath).close()
    closeStoreConnections()

    let holder: ReturnType<typeof Bun.spawn> | undefined
    try {
      // Warm the pooled writable connection (busy_timeout=5000) before the lock
      // is taken so opening it cannot race the holder's BEGIN IMMEDIATE.
      await readProvenanceRecords(tmp.path, artifact)

      holder = Bun.spawn(["bun", "-e", lockHolderScript(dbPath, 5500)], { stdout: "pipe", stderr: "pipe" })
      expect(await waitForLocked(holder)).toContain("locked")

      const startedAt = Date.now()
      await appendProvenanceRecord(tmp.path, artifact, record(tmp.path))
      const elapsed = Date.now() - startedAt

      // First attempt blocked on the lock for the full busy_timeout; the retry
      // (not the busy_timeout) is what landed after the holder released.
      expect(elapsed).toBeGreaterThanOrEqual(5000)

      const records = await readProvenanceRecords(tmp.path, artifact)
      expect(records.map((item) => item.id)).toContain("event:store-busy-retry")
      // The DB write won, so the JSONL fallback must not have been written.
      expect(await Bun.file(artifact).exists()).toBe(false)
    } finally {
      holder?.kill()
      await holder?.exited
      closeStoreConnections()
    }
  }, 30000)

  test("non-BUSY store failure keeps the existing JSONL fallback", async () => {
    await using tmp = await tmpdir()
    const dbPath = getDatabasePath(tmp.path)
    const artifact = path.join(tmp.path, ".chimera", "chimera", "tool-provenance.jsonl")
    await Bun.write(dbPath, "this is not a sqlite database")
    closeStoreConnections()

    try {
      await appendProvenanceRecord(tmp.path, artifact, record(tmp.path, "event:store-non-busy-fallback"))

      // A non-BUSY open/read failure must not be retried into a different
      // outcome: the record falls back to the legacy JSONL artifact.
      expect(await Bun.file(artifact).exists()).toBe(true)
      const records = await readProvenanceRecords(tmp.path, artifact)
      expect(records.map((item) => item.id)).toContain("event:store-non-busy-fallback")
    } finally {
      closeStoreConnections()
    }
  })
})