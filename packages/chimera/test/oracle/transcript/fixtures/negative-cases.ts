// Negative fixtures: each case deliberately corrupts a recorded transcript
// and names the exact verifier code that must reject it.
//
// Reorder/loss cases are re-encoded with a fresh footer so they reach the
// causality layer instead of being rejected by the format integrity check.
// The integrity case intentionally keeps the stale footer to exercise the
// format-level guard.

import { encodeTranscript, stripSeq, type Transcript, type TranscriptEventInput } from "../format"

export type NegativeLayer = "determinism" | "causality" | "integrity"

export type NegativeMutation =
  | { op: "tamper-tool-output" }
  | { op: "tamper-db-row" }
  | { op: "drop-prompt-segment"; segment_index: number }
  | { op: "drop-sse-frame"; stream_id: string; event_seq: number }
  | { op: "duplicate-sse-frame"; stream_id: string; event_seq: number }
  | { op: "move-result-before-call"; call_id: string }
  | { op: "move-db-read-before-write" }
  | { op: "swap-prompt-segments" }
  | { op: "drop-raw-line"; line_index: number }

export type NegativeCase = {
  id: string
  base: string
  layer: NegativeLayer
  description: string
  expected_code: string
  mutation: NegativeMutation
}

export const NEGATIVE_CASES: NegativeCase[] = [
  {
    id: "determinism-tampered-tool-output",
    base: "deterministic-four-classes",
    layer: "determinism",
    description: "Tool result payload is changed; byte comparison against the golden must fail.",
    expected_code: "DETERMINISM_DIFF",
    mutation: { op: "tamper-tool-output" },
  },
  {
    id: "determinism-tampered-db-row",
    base: "deterministic-four-classes",
    layer: "determinism",
    description: "SQLite write row is changed; byte comparison against the golden must fail.",
    expected_code: "DETERMINISM_DIFF",
    mutation: { op: "tamper-db-row" },
  },
  {
    id: "determinism-dropped-prompt-segment",
    base: "deterministic-four-classes",
    layer: "determinism",
    description: "One prompt segment is lost; byte comparison against the golden must fail.",
    expected_code: "DETERMINISM_DIFF",
    mutation: { op: "drop-prompt-segment", segment_index: 1 },
  },
  {
    id: "determinism-dropped-sse-frame",
    base: "deterministic-four-classes",
    layer: "determinism",
    description: "One SSE frame is lost; byte comparison against the golden must fail.",
    expected_code: "DETERMINISM_DIFF",
    mutation: { op: "drop-sse-frame", stream_id: "synthetic-stream", event_seq: 3 },
  },
  {
    id: "causality-tool-result-before-call",
    base: "causal-order-four-classes",
    layer: "causality",
    description: "Tool result is moved before its call; the causal layer must reject it.",
    expected_code: "CAUSAL_RESULT_BEFORE_CALL",
    mutation: { op: "move-result-before-call", call_id: "call-0001" },
  },
  {
    id: "causality-sse-seq-gap",
    base: "causal-order-four-classes",
    layer: "causality",
    description: "An SSE frame is lost, leaving a sequence gap; the causal layer must reject it.",
    expected_code: "CAUSAL_SSE_SEQ_GAP",
    mutation: { op: "drop-sse-frame", stream_id: "synthetic-stream-a", event_seq: 2 },
  },
  {
    id: "causality-sse-seq-duplicate",
    base: "causal-order-four-classes",
    layer: "causality",
    description: "An SSE frame is duplicated; the causal layer must reject it.",
    expected_code: "CAUSAL_SSE_SEQ_DUPLICATE",
    mutation: { op: "duplicate-sse-frame", stream_id: "synthetic-stream-a", event_seq: 2 },
  },
  {
    id: "causality-db-read-before-write",
    base: "causal-order-four-classes",
    layer: "causality",
    description: "A DB read is moved before the first write; the causal layer must reject it.",
    expected_code: "CAUSAL_DB_READ_BEFORE_WRITE",
    mutation: { op: "move-db-read-before-write" },
  },
  {
    id: "causality-prompt-segment-reorder",
    base: "causal-order-four-classes",
    layer: "causality",
    description: "Two prompt segments are swapped; the causal layer must reject the assembly order.",
    expected_code: "CAUSAL_PROMPT_SEGMENT_ORDER",
    mutation: { op: "swap-prompt-segments" },
  },
  {
    id: "integrity-stale-footer",
    base: "causal-order-four-classes",
    layer: "integrity",
    description: "A line is dropped without re-encoding; the footer digest must reject the transcript.",
    expected_code: "TRANSCRIPT_BODY_DIGEST",
    mutation: { op: "drop-raw-line", line_index: 3 },
  },
]

function requireIndex(index: number, label: string): number {
  if (index < 0) throw new Error(`negative fixture cannot find ${label}`)
  return index
}

function applyMutation(events: TranscriptEventInput[], mutation: NegativeMutation): void {
  switch (mutation.op) {
    case "tamper-tool-output": {
      const index = requireIndex(
        events.findIndex((event) => event.kind === "tool.result"),
        "tool.result",
      )
      const event = events[index]!
      if (event.kind !== "tool.result") throw new Error("negative fixture found a non-result event")
      events[index] = { ...event, output: { ...event.output, tampered: true } }
      return
    }
    case "tamper-db-row": {
      const index = requireIndex(
        events.findIndex((event) => event.kind === "db.write"),
        "db.write",
      )
      const event = events[index]!
      if (event.kind !== "db.write") throw new Error("negative fixture found a non-write event")
      events[index] = { ...event, row: { ...event.row, amount: event.row.amount + 1 } }
      return
    }
    case "drop-prompt-segment": {
      const index = requireIndex(
        events.findIndex(
          (event) => event.kind === "prompt.segment" && event.segment_index === mutation.segment_index,
        ),
        `prompt.segment ${mutation.segment_index}`,
      )
      events.splice(index, 1)
      return
    }
    case "drop-sse-frame": {
      const index = requireIndex(
        events.findIndex(
          (event) =>
            event.kind === "sse.event" &&
            event.stream_id === mutation.stream_id &&
            event.event_seq === mutation.event_seq,
        ),
        `sse.event ${mutation.stream_id}#${mutation.event_seq}`,
      )
      events.splice(index, 1)
      return
    }
    case "duplicate-sse-frame": {
      const index = requireIndex(
        events.findIndex(
          (event) =>
            event.kind === "sse.event" &&
            event.stream_id === mutation.stream_id &&
            event.event_seq === mutation.event_seq,
        ),
        `sse.event ${mutation.stream_id}#${mutation.event_seq}`,
      )
      const event = events[index]!
      if (event.kind !== "sse.event") throw new Error("negative fixture found a non-SSE event")
      events.splice(index + 1, 0, { ...event })
      return
    }
    case "move-result-before-call": {
      const callIndex = requireIndex(
        events.findIndex((event) => event.kind === "tool.call" && event.call_id === mutation.call_id),
        `tool.call ${mutation.call_id}`,
      )
      const resultIndex = requireIndex(
        events.findIndex((event) => event.kind === "tool.result" && event.call_id === mutation.call_id),
        `tool.result ${mutation.call_id}`,
      )
      const call = events[callIndex]!
      const result = events.splice(resultIndex, 1)[0]!
      const nextCallIndex = events.indexOf(call)
      events.splice(nextCallIndex, 0, result)
      return
    }
    case "move-db-read-before-write": {
      const writeIndex = requireIndex(
        events.findIndex((event) => event.kind === "db.write"),
        "db.write",
      )
      const readIndex = requireIndex(
        events.findIndex((event) => event.kind === "db.read"),
        "db.read",
      )
      const write = events[writeIndex]!
      const read = events.splice(readIndex, 1)[0]!
      const nextWriteIndex = events.indexOf(write)
      events.splice(nextWriteIndex, 0, read)
      return
    }
    case "swap-prompt-segments": {
      const indices: number[] = []
      events.forEach((event, index) => {
        if (event.kind === "prompt.segment") indices.push(index)
      })
      if (indices.length < 2) throw new Error("negative fixture needs at least two prompt segments")
      const first = indices[0]!
      const second = indices[1]!
      const left = events[first]!
      const right = events[second]!
      events[first] = right
      events[second] = left
      return
    }
    case "drop-raw-line":
      throw new Error("drop-raw-line is applied to raw text, not parsed events")
  }
}

export function applyNegativeCase(
  transcript: Transcript,
  negative: NegativeCase,
): { text: string; expectedCode: string } {
  if (negative.mutation.op === "drop-raw-line") {
    const lines = transcript.text.slice(0, -1).split("\n")
    const index = negative.mutation.line_index
    if (index < 1 || index >= lines.length - 1) {
      throw new Error(`drop-raw-line index ${index} is outside the event range`)
    }
    lines.splice(index, 1)
    return { text: lines.join("\n") + "\n", expectedCode: negative.expected_code }
  }

  const events = transcript.events.map(stripSeq)
  applyMutation(events, negative.mutation)
  return { text: encodeTranscript(transcript.header, events), expectedCode: negative.expected_code }
}