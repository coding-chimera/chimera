// Deterministic recorder for the four WP-02 classes: prompt segments, tool
// calls/results, sqlite state, and SSE frames.
//
// One arm owns one directory and one sqlite database file. Absolute arm paths
// are never written into the transcript; DB events record only the table
// projection, so the two arms remain byte-identical.

import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import {
  CONTRACT_REV,
  TRANSCRIPT_FORMAT,
  TRANSCRIPT_VERSION,
  encodeTranscript,
  isRecord,
  parseTranscript,
  sha256,
  utf8ByteLength,
  type DbRow,
  type Transcript,
  type TranscriptEventInput,
  type TranscriptHeader,
} from "./format"
import type { Scenario } from "./scenario"

export type ArmResult = {
  scenario: string
  arm: string
  dir: string
  dbPath: string
  text: string
  transcript: Transcript
  eventCount: number
}

const TABLE_IDENTIFIER = /^[a-z][a-z0-9_]*$/

function assertTableName(table: string): void {
  if (!TABLE_IDENTIFIER.test(table)) throw new Error(`unsafe synthetic table name: ${table}`)
}

function normalizeRow(value: unknown): DbRow {
  if (!isRecord(value)) throw new Error("sqlite row is not an object")
  const id = typeof value.id === "bigint" ? Number(value.id) : value.id
  const amount = typeof value.amount === "bigint" ? Number(value.amount) : value.amount
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("sqlite row id is not an integer")
  if (typeof value.label !== "string") throw new Error("sqlite row label is not a string")
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) throw new Error("sqlite row amount is not an integer")
  return { id, label: value.label, amount }
}


export async function recordScenario(scenario: Scenario, armDir: string): Promise<ArmResult> {
  assertTableName(scenario.db.table)
  await fs.rm(armDir, { recursive: true, force: true })
  await fs.mkdir(armDir, { recursive: true })

  const dbPath = path.join(armDir, "state.db")
  const db = new Database(dbPath)
  const events: TranscriptEventInput[] = []

  try {
    scenario.prompt.forEach((segment, index) => {
      events.push({
        kind: "prompt.segment",
        segment_index: index,
        key: segment.key,
        content: segment.content,
        sha256: sha256(segment.content),
      })
    })

    for (const tool of scenario.tools) {
      events.push({
        kind: "tool.call",
        call_id: tool.call_id,
        tool: tool.tool,
        input: tool.input,
      })
      events.push({
        kind: "tool.result",
        call_id: tool.call_id,
        status: tool.status,
        output: tool.output,
      })
    }

    db.run(
      `CREATE TABLE ${scenario.db.table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount INTEGER NOT NULL)`,
    )
    const insert = db.query(`INSERT INTO ${scenario.db.table} (id, label, amount) VALUES (?, ?, ?)`)
    for (const row of scenario.db.rows) {
      const changes = insert.run(row.id, row.label, row.amount).changes
      if (changes !== 1) throw new Error(`sqlite insert for id ${row.id} changed ${changes} rows`)
      events.push({
        kind: "db.write",
        table: scenario.db.table,
        op: "insert",
        row,
      })
    }

    const query = `SELECT id, label, amount FROM ${scenario.db.table} ORDER BY id`
    const readRows = (db.query(query).all() as unknown[]).map(normalizeRow)
    events.push({
      kind: "db.read",
      table: scenario.db.table,
      query,
      rows: readRows,
    })
    events.push({
      kind: "db.snapshot",
      table: scenario.db.table,
      rows: readRows,
    })

    const streamSequences = new Map<string, number>()
    for (const frame of scenario.sse) {
      const eventSeq = (streamSequences.get(frame.stream_id) ?? 0) + 1
      streamSequences.set(frame.stream_id, eventSeq)
      events.push({
        kind: "sse.event",
        stream_id: frame.stream_id,
        event_seq: eventSeq,
        event: frame.event,
        data: frame.data,
      })
    }

    const joined = scenario.prompt.map((segment) => segment.content).join("\n\n")
    events.push({
      kind: "prompt.join",
      segment_count: scenario.prompt.length,
      digest: sha256(joined),
      byte_length: utf8ByteLength(joined),
    })
  } finally {
    db.close()
  }

  const header: TranscriptHeader = {
    record: "header",
    format: TRANSCRIPT_FORMAT,
    version: TRANSCRIPT_VERSION,
    contract_rev: CONTRACT_REV,
    scenario: scenario.id,
    layer: scenario.layer,
    description: scenario.description,
  }
  const text = encodeTranscript(header, events)
  const transcript = parseTranscript(text)

  return {
    scenario: scenario.id,
    arm: path.basename(armDir),
    dir: armDir,
    dbPath,
    text,
    transcript,
    eventCount: transcript.events.length,
  }
}
