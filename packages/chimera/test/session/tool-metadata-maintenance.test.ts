import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { SessionToolMetadata } from "@/chimera/session-tool-metadata"
import { recordAuditRun } from "@/chimera/store"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { ToolMetadataMaintenance } from "@/session/tool-metadata-maintenance"
import { tmpdir } from "../fixture/fixture"

function openSessionStore(file: string) {
  const db = new BunDatabase(file)
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
  `)
  return db
}

async function auditMetadata(projectRoot: string, label: string) {
  const payload = {
    projectRoot,
    source: "recent_provenance",
    label,
    detail: "x".repeat(512),
  }
  const auditRunID = await recordAuditRun(projectRoot, {
    source: payload.source,
    changedFiles: [`${label}.ts`],
    snapshotRevision: `revision-${label}`,
    seedNodes: [],
    obligations: [],
    payload,
  })
  return {
    ...payload,
    auditRunID,
    ref: `audit:${auditRunID}`,
  }
}

function completedPart(metadata: Record<string, unknown>, callID: string) {
  return JSON.stringify({
    type: "tool",
    tool: "chimera_audit_recent",
    callID,
    state: {
      status: "completed",
      input: {},
      output: "audit complete",
      metadata,
      title: "Chimera audit",
      time: { start: 1, end: 2 },
    },
  })
}

function calledEvent(sessionID: string, callID: string) {
  return JSON.stringify({
    sessionID,
    callID,
    tool: "chimera_audit_recent",
    input: {},
    provider: { executed: false },
    timestamp: "2026-01-01T00:00:00.000Z",
  })
}

function successEvent(sessionID: string, callID: string, metadata: Record<string, unknown>) {
  return JSON.stringify({
    sessionID,
    callID,
    structured: metadata,
    content: [{ type: "text", text: "audit complete" }],
    provider: { executed: false },
    timestamp: "2026-01-01T00:00:01.000Z",
  })
}

function data(db: BunDatabase, table: "part" | "event", id: string) {
  return (db.query(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string }).data
}

describe("tool metadata maintenance", () => {
  test("defaults to a read-only dry-run and reports filtered Legacy and V2 success rows", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    const first = await auditMetadata(tmp.path, "first")
    const second = await auditMetadata(tmp.path, "second")
    const dbPath = path.join(tmp.path, "sessions.db")
    const db = openSessionStore(dbPath)
    try {
      const firstPart = completedPart(first, "call-first-part")
      const secondPart = completedPart(second, "call-second-part")
      const firstSuccess = successEvent("session-first", "call-first-event", first)
      const secondSuccess = successEvent("session-second", "call-second-event", second)
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-first", "session-first", firstPart)
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-second", "session-second", secondPart)
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("called-first", "session-first", 1, "session.next.tool.called", calledEvent("session-first", "call-first-event"))
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("success-first", "session-first", 2, "session.next.tool.success", firstSuccess)
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("called-second", "session-second", 1, "session.next.tool.called", calledEvent("session-second", "call-second-event"))
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("success-second", "session-second", 2, "session.next.tool.success", secondSuccess)

      const result = await ToolMetadataMaintenance.run({ dbPath, sessionID: "session-first" })

      expect(result.dryRun).toBe(true)
      expect(result.scannedParts).toBe(1)
      expect(result.scannedEvents).toBe(1)
      expect(result.candidates).toBe(2)
      expect(result.validated).toBe(2)
      expect(result.rejected).toBe(0)
      expect(result.rewrittenParts).toBe(0)
      expect(result.rewrittenEvents).toBe(0)
      expect(data(db, "part", "part-first")).toBe(firstPart)
      expect(data(db, "event", "success-first")).toBe(firstSuccess)
      expect(data(db, "part", "part-second")).toBe(secondPart)
      expect(data(db, "event", "success-second")).toBe(secondSuccess)
    } finally {
      db.close()
    }
  })

  test("applies validated Legacy and V2 envelopes only to the selected session", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    const first = await auditMetadata(tmp.path, "apply-first")
    const second = await auditMetadata(tmp.path, "apply-second")
    const dbPath = path.join(tmp.path, "sessions.db")
    const db = openSessionStore(dbPath)
    try {
      const untouchedPart = completedPart(second, "call-untouched")
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-apply", "session-apply", completedPart(first, "call-part"))
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-untouched", "session-untouched", untouchedPart)
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("called-apply", "session-apply", 1, "session.next.tool.called", calledEvent("session-apply", "call-event"))
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("success-apply", "session-apply", 2, "session.next.tool.success", successEvent("session-apply", "call-event", first))

      const result = await ToolMetadataMaintenance.run({ dbPath, apply: true, sessionID: "session-apply" })
      const part = JSON.parse(data(db, "part", "part-apply")) as { state: { metadata: unknown } }
      const event = JSON.parse(data(db, "event", "success-apply")) as { structured: unknown }
      const recoveredPart = await SessionToolMetadata.recover(part.state.metadata)
      const recoveredEvent = await SessionToolMetadata.recover(event.structured)

      expect(result.dryRun).toBe(false)
      expect(result.scannedParts).toBe(1)
      expect(result.scannedEvents).toBe(1)
      expect(result.rewrittenParts).toBe(1)
      expect(result.rewrittenEvents).toBe(1)
      expect(SessionToolMetadata.isPersisted(part.state.metadata)).toBe(true)
      expect(SessionToolMetadata.isPersisted(event.structured)).toBe(true)
      expect(recoveredPart.status).toBe("recovered")
      expect(recoveredEvent.status).toBe("recovered")
      if (recoveredPart.status === "recovered") expect(recoveredPart.metadata).toEqual(first)
      if (recoveredEvent.status === "recovered") expect(recoveredEvent.metadata).toEqual(first)
      expect(data(db, "part", "part-untouched")).toBe(untouchedPart)
    } finally {
      db.close()
    }
  })

  test("rejects malformed successes and missing called-event context before any apply rewrite", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    const metadata = await auditMetadata(tmp.path, "rejected")
    const dbPath = path.join(tmp.path, "sessions.db")
    const db = openSessionStore(dbPath)
    try {
      const originalPart = completedPart(metadata, "call-valid-part")
      const missingContext = successEvent("session-rejected", "call-missing", metadata)
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-valid", "session-rejected", originalPart)
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("success-malformed", "session-rejected", 1, "session.next.tool.success", "{")
      db.query("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run("success-missing-context", "session-rejected", 2, "session.next.tool.success", missingContext)

      const dryRun = await ToolMetadataMaintenance.run({ dbPath, sessionID: "session-rejected" })
      expect(dryRun.scannedParts).toBe(1)
      expect(dryRun.scannedEvents).toBe(2)
      expect(dryRun.validated).toBe(1)
      expect(dryRun.rejected).toBe(2)
      expect(dryRun.rejections.map((item) => item.reason)).toEqual([
        "tool success event data is malformed",
        "tool success event lacks called-event tool context",
      ])

      await expect(ToolMetadataMaintenance.run({ dbPath, apply: true, sessionID: "session-rejected" })).rejects.toThrow(
        "tool metadata maintenance rejected 2 candidates; no rows were rewritten",
      )
      expect(data(db, "part", "part-valid")).toBe(originalPart)
      expect(data(db, "event", "success-malformed")).toBe("{")
      expect(data(db, "event", "success-missing-context")).toBe(missingContext)
    } finally {
      db.close()
    }
  })

  test("rolls back the transaction when a CAS detects a concurrent row change", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    const first = await auditMetadata(tmp.path, "cas-first")
    const second = await auditMetadata(tmp.path, "cas-second")
    const dbPath = path.join(tmp.path, "sessions.db")
    const db = openSessionStore(dbPath)
    try {
      const firstPart = completedPart(first, "call-cas-first")
      const secondPart = completedPart(second, "call-cas-second")
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-cas-1", "session-cas", firstPart)
      db.query("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)").run("part-cas-2", "session-cas", secondPart)
      db.exec(`
        CREATE TRIGGER mutate_second_part_after_first_update
        AFTER UPDATE ON part
        WHEN NEW.id = 'part-cas-1'
        BEGIN
          UPDATE part SET data = '{"concurrent":true}' WHERE id = 'part-cas-2';
        END;
      `)

      await expect(ToolMetadataMaintenance.run({ dbPath, apply: true, sessionID: "session-cas" })).rejects.toThrow(
        "metadata row changed during maintenance: part:part-cas-1",
      )
      expect(data(db, "part", "part-cas-1")).toBe(firstPart)
      expect(data(db, "part", "part-cas-2")).toBe(secondPart)
    } finally {
      db.close()
    }
  })
})
