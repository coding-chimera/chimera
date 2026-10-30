// WP-03 comparator: baseline artifact vs candidate artifact.
//
// The comparator is intentionally semantic, not a byte diff. Byte equality is
// WP-02's determinism layer; this layer must classify *why* a run diverged so a
// fault matrix can assert one stable code per class.
//
// Check order is part of the contract:
//   1. envelope terminal state  -> interruption / timeout / cancel
//   2. transcript integrity     -> FAULT_INTEGRITY
//   2b. transcript cancel mark  -> FAULT_CANCEL when later events follow
//   3. header parity
//   4. golden event alignment   -> loss / duplicate / reorder
//   5. write-vs-snapshot        -> partial write
//   6. WP-02 causality          -> FAULT_CAUSALITY
//   7. replay-state parity      -> FAULT_REPLAY
//
// Reordering the first five checks would let one fault class mask another
// (for example a lost write also breaks replay), so the order is asserted by
// the meta-test through exact expected codes.

import {
  canonicalJson,
  parseTranscript,
  stripSeq,
  TranscriptFormatError,
  type DbRow,
  type Transcript,
  type TranscriptEvent,
  type TranscriptEventInput,
} from "../transcript/format"
import { checkCausality, OracleCheckError, verifyReplay, type ReplayState } from "../transcript/verify"
import {
  FAULT_CODES,
  type CompareCheck,
  type ComparePass,
  type RunArtifact,
} from "./types"

export class CompareRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`)
    this.name = "CompareRejection"
  }
}

function parseCandidate(artifact: RunArtifact): Transcript {
  try {
    return parseTranscript(artifact.transcript)
  } catch (error) {
    if (error instanceof TranscriptFormatError) {
      throw new CompareRejection(FAULT_CODES.integrity, "candidate transcript is malformed", {
        cause_code: error.code,
      })
    }
    throw error
  }
}

function parseBaseline(artifact: RunArtifact): Transcript {
  try {
    return parseTranscript(artifact.transcript)
  } catch (error) {
    if (error instanceof TranscriptFormatError) {
      throw new CompareRejection("COMPARE_BASELINE_INVALID", "baseline transcript is malformed", {
        cause_code: error.code,
      })
    }
    throw error
  }
}

function checkEnvelope(baseline: RunArtifact, candidate: RunArtifact): void {
  if (baseline.envelope.status !== "complete") {
    throw new CompareRejection("COMPARE_BASELINE_NOT_COMPLETE", "baseline envelope must be complete", {
      baseline_status: baseline.envelope.status,
    })
  }
  if (candidate.envelope.scenario !== baseline.envelope.scenario) {
    throw new CompareRejection("COMPARE_SCENARIO_MISMATCH", "candidate scenario differs from baseline", {
      expected: baseline.envelope.scenario,
      actual: candidate.envelope.scenario,
    })
  }
  switch (candidate.envelope.status) {
    case "complete":
      return
    case "interrupted":
      throw new CompareRejection(FAULT_CODES.interruption, "candidate run ended with an interruption")
    case "timed_out":
      throw new CompareRejection(FAULT_CODES.timeout, "candidate run exceeded its deadline")
    case "cancelled":
      throw new CompareRejection(FAULT_CODES.cancel, "candidate run was cancelled")
    default:
      throw new CompareRejection("COMPARE_ENVELOPE_INVALID", "candidate envelope status is not recognized", {
        status: candidate.envelope.status,
      })
  }
}

const CANCEL_STREAM_ID = "control"
const CANCEL_EVENT_NAME = "cancel"

// A synthetic cancellation marker is recorded as a control SSE frame. If the
// transcript keeps emitting events after that marker, cancellation did not stop
// execution; classify it from the transcript itself so the fault stays visible
// even when the envelope is missing or still reports complete.
function checkTranscriptCancel(transcript: Transcript): void {
  const index = transcript.events.findIndex(
    (event) =>
      event.kind === "sse.event" && event.stream_id === CANCEL_STREAM_ID && event.event === CANCEL_EVENT_NAME,
  )
  if (index < 0) return
  const eventsAfter = transcript.events.length - index - 1
  if (eventsAfter === 0) return
  throw new CompareRejection(FAULT_CODES.cancel, "candidate transcript records a cancel marker followed by later events", {
    cancel_seq: transcript.events[index]!.seq,
    events_after_cancel: eventsAfter,
  })
}

const HEADER_FIELDS = ["format", "version", "contract_rev", "scenario", "layer"] as const

function checkHeader(baseline: Transcript, candidate: Transcript): void {
  for (const field of HEADER_FIELDS) {
    if (baseline.header[field] === candidate.header[field]) continue
    throw new CompareRejection("COMPARE_HEADER_MISMATCH", `header.${field} differs from baseline`, {
      field,
      expected: baseline.header[field],
      actual: candidate.header[field],
    })
  }
}

function eventIdentity(event: TranscriptEventInput): string {
  switch (event.kind) {
    case "prompt.segment":
      return `prompt.segment:${event.segment_index}`
    case "prompt.join":
      return "prompt.join"
    case "tool.call":
      return `tool.call:${event.call_id}`
    case "tool.result":
      return `tool.result:${event.call_id}`
    case "db.write":
      return `db.write:${event.table}:${event.row.id}`
    case "db.read":
      return `db.read:${event.table}:${event.query}`
    case "db.snapshot":
      return `db.snapshot:${event.table}`
    case "sse.event":
      return `sse.event:${event.stream_id}:${event.event_seq}`
  }
}

function identityCounts(events: TranscriptEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) {
    const identity = eventIdentity(stripSeq(event))
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}

function checkAlignment(baseline: Transcript, candidate: Transcript): void {
  const expected = baseline.events.map((event) => eventIdentity(stripSeq(event)))
  const actual = candidate.events.map((event) => eventIdentity(stripSeq(event)))
  const expectedCounts = identityCounts(baseline.events)
  const actualCounts = identityCounts(candidate.events)

  for (const [identity, actualCount] of actualCounts) {
    const expectedCount = expectedCounts.get(identity) ?? 0
    if (actualCount <= expectedCount) continue
    throw new CompareRejection(FAULT_CODES.duplicate, `candidate repeats event identity ${identity}`, {
      identity,
      expected_count: expectedCount,
      actual_count: actualCount,
    })
  }

  for (const [identity, expectedCount] of expectedCounts) {
    const actualCount = actualCounts.get(identity) ?? 0
    if (actualCount >= expectedCount) continue
    throw new CompareRejection(FAULT_CODES.loss, `candidate lost event identity ${identity}`, {
      identity,
      expected_count: expectedCount,
      actual_count: actualCount,
    })
  }

  const length = Math.max(expected.length, actual.length)
  for (let index = 0; index < length; index++) {
    if (expected[index] === actual[index]) continue
    throw new CompareRejection(FAULT_CODES.reorder, `candidate event order differs at index ${index}`, {
      index,
      expected: expected[index] ?? null,
      actual: actual[index] ?? null,
    })
  }
}

function sortRows(rows: Map<number, DbRow>): DbRow[] {
  return [...rows.values()].sort((left, right) => left.id - right.id)
}

function checkPartialWrites(transcript: Transcript): void {
  const writes = new Map<string, Map<number, DbRow>>()
  const snapshots = new Map<string, DbRow[]>()
  for (const event of transcript.events) {
    if (event.kind === "db.write") {
      const rows = writes.get(event.table) ?? new Map<number, DbRow>()
      rows.set(event.row.id, event.row)
      writes.set(event.table, rows)
      continue
    }
    if (event.kind === "db.snapshot") snapshots.set(event.table, event.rows)
  }
  for (const [table, snapshot] of snapshots) {
    const replayed = sortRows(writes.get(table) ?? new Map<number, DbRow>())
    if (canonicalJson(replayed) === canonicalJson(snapshot)) continue
    throw new CompareRejection(FAULT_CODES.partial_write, `db.snapshot for ${table} does not match recorded writes`, {
      table,
      written_rows: replayed.length,
      snapshot_rows: snapshot.length,
    })
  }
}

function checkCausalityOrReject(transcript: Transcript, baseline: boolean): void {
  try {
    checkCausality(transcript)
  } catch (error) {
    if (!(error instanceof OracleCheckError)) throw error
    const code = baseline ? "COMPARE_BASELINE_INVALID" : FAULT_CODES.causality
    throw new CompareRejection(code, `${baseline ? "baseline" : "candidate"} causality failed: ${error.message}`, {
      cause_code: error.code,
    })
  }
}

function replayState(transcript: Transcript, baseline: boolean): ReplayState {
  try {
    return verifyReplay(transcript)
  } catch (error) {
    if (!(error instanceof OracleCheckError)) throw error
    const code = baseline ? "COMPARE_BASELINE_INVALID" : FAULT_CODES.replay
    throw new CompareRejection(code, `${baseline ? "baseline" : "candidate"} replay failed: ${error.message}`, {
      cause_code: error.code,
    })
  }
}

export function compareArtifact(baseline: RunArtifact, candidate: RunArtifact): ComparePass {
  checkEnvelope(baseline, candidate)

  const candidateTranscript = parseCandidate(candidate)
  if (candidate.envelope.scenario !== candidateTranscript.header.scenario) {
    throw new CompareRejection("COMPARE_SCENARIO_MISMATCH", "candidate envelope and header scenarios differ", {
      envelope: candidate.envelope.scenario,
      header: candidateTranscript.header.scenario,
    })
  }

  checkTranscriptCancel(candidateTranscript)

  const baselineTranscript = parseBaseline(baseline)
  checkHeader(baselineTranscript, candidateTranscript)
  checkAlignment(baselineTranscript, candidateTranscript)
  checkPartialWrites(candidateTranscript)
  checkCausalityOrReject(baselineTranscript, true)
  checkCausalityOrReject(candidateTranscript, false)

  const baselineState = replayState(baselineTranscript, true)
  const candidateState = replayState(candidateTranscript, false)
  if (canonicalJson(candidateState) !== canonicalJson(baselineState)) {
    throw new CompareRejection(FAULT_CODES.replay, "replayed candidate state differs from baseline")
  }

  return {
    status: "pass",
    checks: [
      { id: "envelope", status: "pass", code: "PASS" },
      { id: "integrity", status: "pass", code: "PASS" },
      { id: "header", status: "pass", code: "PASS" },
      { id: "alignment", status: "pass", code: "PASS" },
      { id: "partial-write", status: "pass", code: "PASS" },
      { id: "causality", status: "pass", code: "PASS" },
      { id: "replay", status: "pass", code: "PASS" },
    ],
  }
}