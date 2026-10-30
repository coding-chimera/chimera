// Two-layer verifier:
//
//   determinism layer: byte equality (same input -> same output)
//   causality layer:   event order (result after call, SSE monotonic, DB
//                      read after write, prompt segments in assembly order)
//
// Every failure is an OracleCheckError with a stable code so negative fixtures
// can assert the exact rejection reason instead of a generic throw.

import {
  canonicalJson,
  encodeTranscript,
  sha256,
  stripSeq,
  utf8ByteLength,
  type DbRow,
  type PromptJoinEvent,
  type Transcript,
  type TranscriptEvent,
} from "./format"

export class OracleCheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`)
    this.name = "OracleCheckError"
  }
}

export type ReplayTool = {
  call_id: string
  tool: string
  input: Record<string, unknown>
  status: "ok" | "error" | null
  output: Record<string, unknown> | null
}

export type ReplaySseStream = {
  stream_id: string
  frames: { event_seq: number; event: string; data: Record<string, unknown> }[]
}

export type ReplayState = {
  prompt: { segments: { key: string; content: string }[]; digest: string; byte_length: number }
  tools: ReplayTool[]
  db: { table: string; rows: DbRow[] }[]
  sse: ReplaySseStream[]
}

export function firstDiff(expected: string, actual: string): Record<string, unknown> {
  const expectedLines = expected.split("\n")
  const actualLines = actual.split("\n")
  const max = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < max; index++) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? null,
        actual: actualLines[index] ?? null,
      }
    }
  }
  return { line: null, expected: null, actual: null }
}

export function checkDeterminism(expected: string, actual: string, label: string): void {
  const expectedBytes = new TextEncoder().encode(expected)
  const actualBytes = new TextEncoder().encode(actual)
  const equal =
    expectedBytes.length === actualBytes.length && expectedBytes.every((byte, index) => byte === actualBytes[index])
  if (equal) return
  throw new OracleCheckError(
    "DETERMINISM_DIFF",
    `${label}: expected ${expectedBytes.length} bytes, got ${actualBytes.length}`,
    firstDiff(expected, actual),
  )
}

function checkTools(transcript: Transcript): void {
  const calls = new Map<string, Extract<TranscriptEvent, { kind: "tool.call" }>>()
  const results = new Map<string, Extract<TranscriptEvent, { kind: "tool.result" }>>()

  for (const event of transcript.events) {
    if (event.kind !== "tool.call") continue
    if (calls.has(event.call_id)) {
      throw new OracleCheckError("CAUSAL_DUPLICATE_CALL", `tool call ${event.call_id} appears more than once`)
    }
    calls.set(event.call_id, event)
  }

  for (const event of transcript.events) {
    if (event.kind !== "tool.result") continue
    const call = calls.get(event.call_id)
    if (!call) {
      throw new OracleCheckError("CAUSAL_RESULT_WITHOUT_CALL", `tool result ${event.call_id} has no preceding call`)
    }
    if (event.seq < call.seq) {
      throw new OracleCheckError(
        "CAUSAL_RESULT_BEFORE_CALL",
        `tool result ${event.call_id} (seq ${event.seq}) precedes its call (seq ${call.seq})`,
      )
    }
    if (results.has(event.call_id)) {
      throw new OracleCheckError("CAUSAL_DUPLICATE_RESULT", `tool result ${event.call_id} appears more than once`)
    }
    results.set(event.call_id, event)
  }

  for (const callID of calls.keys()) {
    if (!results.has(callID)) {
      throw new OracleCheckError("CAUSAL_CALL_WITHOUT_RESULT", `tool call ${callID} has no result`)
    }
  }
}

function checkSse(transcript: Transcript): void {
  const streams = new Map<string, { expected: number; seen: Set<number> }>()
  for (const event of transcript.events) {
    if (event.kind !== "sse.event") continue
    const state = streams.get(event.stream_id) ?? { expected: 1, seen: new Set<number>() }
    if (state.seen.has(event.event_seq)) {
      throw new OracleCheckError(
        "CAUSAL_SSE_SEQ_DUPLICATE",
        `SSE stream ${event.stream_id} repeats event_seq ${event.event_seq}`,
      )
    }
    if (event.event_seq < state.expected) {
      throw new OracleCheckError(
        "CAUSAL_SSE_SEQ_REWIND",
        `SSE stream ${event.stream_id} event_seq ${event.event_seq} rewinds below ${state.expected}`,
      )
    }
    if (event.event_seq > state.expected) {
      throw new OracleCheckError(
        "CAUSAL_SSE_SEQ_GAP",
        `SSE stream ${event.stream_id} expected event_seq ${state.expected}, got ${event.event_seq}`,
      )
    }
    state.seen.add(event.event_seq)
    state.expected++
    streams.set(event.stream_id, state)
  }
}

function checkDb(transcript: Transcript): void {
  const writes = new Map<string, number[]>()
  for (const event of transcript.events) {
    if (event.kind === "db.write") {
      const sequences = writes.get(event.table) ?? []
      sequences.push(event.seq)
      writes.set(event.table, sequences)
      continue
    }
    if (event.kind !== "db.read" && event.kind !== "db.snapshot") continue
    if (event.rows.length === 0) continue
    const sequences = writes.get(event.table) ?? []
    if (!sequences.some((seq) => seq < event.seq)) {
      const code = event.kind === "db.read" ? "CAUSAL_DB_READ_BEFORE_WRITE" : "CAUSAL_DB_SNAPSHOT_BEFORE_WRITE"
      throw new OracleCheckError(code, `${event.kind} on ${event.table} has no earlier write`)
    }
  }
}

function checkPrompt(transcript: Transcript): void {
  const segments = transcript.events.filter(
    (event): event is Extract<TranscriptEvent, { kind: "prompt.segment" }> => event.kind === "prompt.segment",
  )
  const joins = transcript.events.filter(
    (event): event is Extract<TranscriptEvent, { kind: "prompt.join" }> => event.kind === "prompt.join",
  )
  if (joins.length !== 1) {
    throw new OracleCheckError("CAUSAL_PROMPT_JOIN_COUNT", `expected exactly one prompt.join, got ${joins.length}`)
  }
  const join = joins[0]!
  const lastSegment = segments[segments.length - 1]
  if (lastSegment && join.seq < lastSegment.seq) {
    throw new OracleCheckError("CAUSAL_PROMPT_JOIN_BEFORE_SEGMENTS", "prompt.join precedes prompt segments")
  }
  segments.forEach((segment, index) => {
    if (segment.segment_index !== index) {
      throw new OracleCheckError(
        "CAUSAL_PROMPT_SEGMENT_ORDER",
        `prompt segment at physical index ${index} declares segment_index ${segment.segment_index}`,
      )
    }
  })
  if (join.segment_count !== segments.length) {
    throw new OracleCheckError(
      "CAUSAL_PROMPT_SEGMENT_COUNT",
      `prompt.join declares ${join.segment_count} segments, found ${segments.length}`,
    )
  }
}

export function checkCausality(transcript: Transcript): void {
  checkTools(transcript)
  checkSse(transcript)
  checkDb(transcript)
  checkPrompt(transcript)
}

function sortRows(rows: Map<number, DbRow>): DbRow[] {
  return [...rows.values()].sort((left, right) => left.id - right.id)
}

export function replay(transcript: Transcript): ReplayState {
  const promptSegments: { key: string; content: string }[] = []
  const tools = new Map<string, ReplayTool>()
  const tables = new Map<string, Map<number, DbRow>>()
  const streams = new Map<string, ReplaySseStream>()
  let join: PromptJoinEvent | undefined

  for (const event of transcript.events) {
    switch (event.kind) {
      case "prompt.segment":
        if (sha256(event.content) !== event.sha256) {
          throw new OracleCheckError(
            "REPLAY_PROMPT_SEGMENT_DIGEST",
            `prompt segment ${event.segment_index} content does not match its sha256`,
          )
        }
        promptSegments[event.segment_index] = { key: event.key, content: event.content }
        break
      case "prompt.join":
        join = event
        break
      case "tool.call":
        tools.set(event.call_id, {
          call_id: event.call_id,
          tool: event.tool,
          input: event.input,
          status: null,
          output: null,
        })
        break
      case "tool.result": {
        const tool = tools.get(event.call_id)
        if (!tool) {
          throw new OracleCheckError("REPLAY_RESULT_WITHOUT_CALL", `tool result ${event.call_id} has no call`)
        }
        tool.status = event.status
        tool.output = event.output
        break
      }
      case "db.write": {
        const rows = tables.get(event.table) ?? new Map<number, DbRow>()
        rows.set(event.row.id, event.row)
        tables.set(event.table, rows)
        break
      }
      case "db.read": {
        const rows = tables.get(event.table) ?? new Map<number, DbRow>()
        if (canonicalJson(sortRows(rows)) !== canonicalJson(event.rows)) {
          throw new OracleCheckError("REPLAY_DB_READ_MISMATCH", `db.read for ${event.table} does not match replayed writes`)
        }
        break
      }
      case "db.snapshot": {
        const rows = tables.get(event.table) ?? new Map<number, DbRow>()
        const replayed = sortRows(rows)
        if (canonicalJson(replayed) !== canonicalJson(event.rows)) {
          throw new OracleCheckError(
            "REPLAY_DB_SNAPSHOT_MISMATCH",
            `db.snapshot for ${event.table} does not match replayed writes`,
          )
        }
        break
      }
      case "sse.event": {
        const stream = streams.get(event.stream_id) ?? { stream_id: event.stream_id, frames: [] }
        stream.frames.push({ event_seq: event.event_seq, event: event.event, data: event.data })
        streams.set(event.stream_id, stream)
        break
      }
    }
  }

  const joined = promptSegments.map((segment) => segment.content).join("\n\n")
  const digest = sha256(joined)
  const byteLength = utf8ByteLength(joined)
  if (!join) {
    throw new OracleCheckError("REPLAY_PROMPT_JOIN_MISSING", "transcript has no prompt.join event")
  }
  if (join.digest !== digest || join.byte_length !== byteLength) {
    throw new OracleCheckError(
      "REPLAY_PROMPT_MISMATCH",
      `prompt.join digest/byte_length does not match replayed segments`,
      { expected_digest: digest, recorded_digest: join.digest, expected_bytes: byteLength, recorded_bytes: join.byte_length },
    )
  }

  return {
    prompt: { segments: promptSegments, digest, byte_length: byteLength },
    tools: [...tools.values()],
    db: [...tables.entries()].map(([table, rows]) => ({
      table,
      rows: sortRows(rows),
    })),
    sse: [...streams.values()],
  }
}

export function verifyReplay(transcript: Transcript): ReplayState {
  const state = replay(transcript)
  const reencoded = encodeTranscript(transcript.header, transcript.events.map(stripSeq))
  if (reencoded !== transcript.text) {
    throw new OracleCheckError("REPLAY_ENCODING_UNSTABLE", "parse -> encode does not reproduce the source bytes")
  }
  return state
}

export function verifyTranscript(transcript: Transcript): ReplayState {
  checkCausality(transcript)
  return verifyReplay(transcript)
}
