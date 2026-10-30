// WP-02 transcript format v1.
//
// The format is deliberately small and dependency-free so that a later Rust
// recorder can emit the same bytes without importing this implementation:
//
//   header line
//   event line * N (seq = 1..N, physical order)
//   footer line (event_count + sha256 of header+events body)
//
// Every line is canonical JSON: object keys are sorted recursively, numbers
// must be safe integers, and `undefined` is rejected. Timestamps, absolute
// paths, random ids, and wall-clock values are intentionally absent so that
// two isolated arms can produce byte-identical output.

export const TRANSCRIPT_FORMAT = "chimera.oracle.transcript" as const
export const TRANSCRIPT_VERSION = 1 as const
export const CONTRACT_REV = "cr-2026-10-30-r1" as const

export type TranscriptLayer = "determinism" | "causality"

export type DbRow = {
  id: number
  label: string
  amount: number
}

export type PromptSegmentEvent = {
  kind: "prompt.segment"
  segment_index: number
  key: string
  content: string
  sha256: string
}

export type PromptJoinEvent = {
  kind: "prompt.join"
  segment_count: number
  digest: string
  byte_length: number
}

export type ToolCallEvent = {
  kind: "tool.call"
  call_id: string
  tool: string
  input: Record<string, unknown>
}

export type ToolResultEvent = {
  kind: "tool.result"
  call_id: string
  status: "ok" | "error"
  output: Record<string, unknown>
}

export type DbWriteEvent = {
  kind: "db.write"
  table: string
  op: "insert"
  row: DbRow
}

export type DbReadEvent = {
  kind: "db.read"
  table: string
  query: string
  rows: DbRow[]
}

export type DbSnapshotEvent = {
  kind: "db.snapshot"
  table: string
  rows: DbRow[]
}

export type SseEvent = {
  kind: "sse.event"
  stream_id: string
  event_seq: number
  event: string
  data: Record<string, unknown>
}

export type TranscriptEventInput =
  | PromptSegmentEvent
  | PromptJoinEvent
  | ToolCallEvent
  | ToolResultEvent
  | DbWriteEvent
  | DbReadEvent
  | DbSnapshotEvent
  | SseEvent

// Distribute the seq field over the union so `kind` stays a discriminant.
export type WithSeq<T> = T extends unknown ? T & { seq: number } : never
export type TranscriptEvent = WithSeq<TranscriptEventInput>

export type TranscriptHeader = {
  record: "header"
  format: typeof TRANSCRIPT_FORMAT
  version: typeof TRANSCRIPT_VERSION
  contract_rev: string
  scenario: string
  layer: TranscriptLayer
  description: string
}

export type TranscriptFooter = {
  record: "footer"
  event_count: number
  body_sha256: string
}

export type Transcript = {
  header: TranscriptHeader
  events: TranscriptEvent[]
  footer: TranscriptFooter
  // The exact source bytes that produced this parsed transcript.
  text: string
}

export class TranscriptFormatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = "TranscriptFormatError"
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`canonicalJson: non-integer number ${value}`)
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const undefinedEntry = entries.find(([, item]) => item === undefined)
    if (undefinedEntry) throw new Error(`canonicalJson: undefined value at key ${JSON.stringify(undefinedEntry[0])}`)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
}

export function stripSeq(event: TranscriptEvent): TranscriptEventInput {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "seq")) as TranscriptEventInput
}

export function encodeTranscript(header: TranscriptHeader, events: TranscriptEventInput[]): string {
  const lines = [canonicalJson(header)]
  events.forEach((event, index) => {
    lines.push(canonicalJson({ ...event, seq: index + 1 }))
  })
  const body = lines.join("\n") + "\n"
  const footer: TranscriptFooter = {
    record: "footer",
    event_count: events.length,
    body_sha256: sha256(body),
  }
  return body + canonicalJson(footer) + "\n"
}

const EVENT_KINDS = new Set<string>([
  "prompt.segment",
  "prompt.join",
  "tool.call",
  "tool.result",
  "db.write",
  "db.read",
  "db.snapshot",
  "sse.event",
])

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new TranscriptFormatError("TRANSCRIPT_JSON", `line ${lineNumber} is not valid JSON`)
  }
}

function assertHeader(value: unknown): asserts value is TranscriptHeader {
  if (!isRecord(value)) throw new TranscriptFormatError("TRANSCRIPT_HEADER", "header is not an object")
  if (value.record !== "header") throw new TranscriptFormatError("TRANSCRIPT_HEADER", "first line is not a header")
  if (value.format !== TRANSCRIPT_FORMAT) {
    throw new TranscriptFormatError("TRANSCRIPT_FORMAT", `unexpected format ${String(value.format)}`)
  }
  if (value.version !== TRANSCRIPT_VERSION) {
    throw new TranscriptFormatError("TRANSCRIPT_VERSION", `unexpected version ${String(value.version)}`)
  }
  if (value.contract_rev !== CONTRACT_REV) {
    throw new TranscriptFormatError(
      "TRANSCRIPT_CONTRACT_REV",
      `expected ${CONTRACT_REV}, got ${String(value.contract_rev)}`,
    )
  }
  if (typeof value.scenario !== "string") {
    throw new TranscriptFormatError("TRANSCRIPT_HEADER", "scenario must be a string")
  }
  if (value.layer !== "determinism" && value.layer !== "causality") {
    throw new TranscriptFormatError("TRANSCRIPT_HEADER", `unexpected layer ${String(value.layer)}`)
  }
  if (typeof value.description !== "string") {
    throw new TranscriptFormatError("TRANSCRIPT_HEADER", "description must be a string")
  }
}

function assertFooter(value: unknown): asserts value is TranscriptFooter {
  if (!isRecord(value)) throw new TranscriptFormatError("TRANSCRIPT_FOOTER", "footer is not an object")
  if (value.record !== "footer") throw new TranscriptFormatError("TRANSCRIPT_FOOTER", "last line is not a footer")
  if (typeof value.event_count !== "number" || !Number.isSafeInteger(value.event_count)) {
    throw new TranscriptFormatError("TRANSCRIPT_FOOTER", "event_count must be an integer")
  }
  if (typeof value.body_sha256 !== "string") {
    throw new TranscriptFormatError("TRANSCRIPT_FOOTER", "body_sha256 must be a string")
  }
}

export function parseTranscript(text: string): Transcript {
  if (!text.endsWith("\n")) {
    throw new TranscriptFormatError("TRANSCRIPT_TRAILING_NEWLINE", "transcript must end with a newline")
  }
  const lines = text.slice(0, -1).split("\n")
  if (lines.length < 3) throw new TranscriptFormatError("TRANSCRIPT_SHAPE", "transcript needs header, event, and footer lines")
  if (lines.some((line) => line.length === 0)) {
    throw new TranscriptFormatError("TRANSCRIPT_SHAPE", "blank lines are not allowed")
  }

  const header = parseLine(lines[0]!, 1)
  assertHeader(header)

  const footer = parseLine(lines[lines.length - 1]!, lines.length)
  assertFooter(footer)

  const body = lines.slice(0, -1).join("\n") + "\n"
  if (footer.body_sha256 !== sha256(body)) {
    throw new TranscriptFormatError("TRANSCRIPT_BODY_DIGEST", "footer body_sha256 does not match header+events body")
  }

  const eventLines = lines.slice(1, -1)
  if (footer.event_count !== eventLines.length) {
    throw new TranscriptFormatError(
      "TRANSCRIPT_EVENT_COUNT",
      `footer event_count ${footer.event_count} does not match ${eventLines.length} event lines`,
    )
  }

  const events = eventLines.map((line, index) => {
    const value = parseLine(line, index + 2)
    if (!isRecord(value)) throw new TranscriptFormatError("TRANSCRIPT_EVENT", `line ${index + 2} is not an object`)
    if (typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind)) {
      throw new TranscriptFormatError("TRANSCRIPT_EVENT_KIND", `line ${index + 2} has unknown kind ${String(value.kind)}`)
    }
    if (value.seq !== index + 1) {
      throw new TranscriptFormatError(
        "TRANSCRIPT_SEQ_ORDER",
        `line ${index + 2} has seq ${String(value.seq)}, expected ${index + 1}`,
      )
    }
    return value as unknown as TranscriptEvent
  })

  return { header, events, footer, text }
}