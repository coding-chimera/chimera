// Synthetic fixtures for WP-02.
//
// These are mock-level inputs: no real session, provider, backend URL, or user
// data is involved. Every id, timestamp-free ordering, and payload is fixed so
// that the recorder is the only variable between the two arms.

import type { Scenario } from "../scenario"

const DETERMINISTIC_ROWS = [
  { id: 1, label: "alpha", amount: 10 },
  { id: 2, label: "beta", amount: 20 },
  { id: 3, label: "gamma", amount: 30 },
]

const CAUSAL_ROWS = [
  { id: 1, label: "one", amount: 100 },
  { id: 2, label: "two", amount: 200 },
  { id: 3, label: "three", amount: 300 },
]

export const SCENARIOS: Scenario[] = [
  {
    id: "deterministic-four-classes",
    layer: "determinism",
    description: "Synthetic prompt segments, one tool call/result, three sqlite rows, and one SSE stream.",
    golden: "determinism.jsonl",
    prompt: [
      { key: "core/default", content: "Synthetic base instruction for the transcript harness." },
      { key: "core/workflow", content: "Use synthetic tool calls and deterministic outputs." },
      { key: "model/synthetic", content: "Model overlay: reply with fixed tokens only." },
    ],
    tools: [
      {
        call_id: "call-0001",
        tool: "synthetic_echo",
        input: { text: "ping" },
        status: "ok",
        output: { text: "pong", bytes: 4 },
      },
    ],
    db: { table: "transcript_items", rows: DETERMINISTIC_ROWS },
    sse: [
      { stream_id: "synthetic-stream", event: "message.start", data: { index: 0 } },
      { stream_id: "synthetic-stream", event: "message.delta", data: { delta: "hel" } },
      { stream_id: "synthetic-stream", event: "message.delta", data: { delta: "lo" } },
      { stream_id: "synthetic-stream", event: "message.done", data: { index: 0 } },
    ],
  },
  {
    id: "causal-order-four-classes",
    layer: "causality",
    description:
      "Synthetic prompt segments, two tool calls/results, three sqlite rows, and two interleaved SSE streams.",
    golden: "causality.jsonl",
    prompt: [
      { key: "core/default", content: "Causal-order fixture: all events carry a stable sequence." },
      { key: "core/workflow", content: "A tool result must follow the tool call that produced it." },
      { key: "overlay/synthetic", content: "SSE frames are monotonic per stream." },
    ],
    tools: [
      {
        call_id: "call-0001",
        tool: "synthetic_read",
        input: { path: "synthetic://workspace/notes.txt" },
        status: "ok",
        output: { bytes: 42, summary: "synthetic file body" },
      },
      {
        call_id: "call-0002",
        tool: "synthetic_fail",
        input: { reason: "fixture" },
        status: "error",
        output: { error: "synthetic failure" },
      },
    ],
    db: { table: "transcript_items", rows: CAUSAL_ROWS },
    sse: [
      { stream_id: "synthetic-stream-a", event: "message.start", data: { index: 0 } },
      { stream_id: "synthetic-stream-b", event: "message.start", data: { index: 1 } },
      { stream_id: "synthetic-stream-a", event: "message.delta", data: { delta: "a1" } },
      { stream_id: "synthetic-stream-b", event: "message.delta", data: { delta: "b1" } },
      { stream_id: "synthetic-stream-a", event: "message.done", data: { index: 0 } },
    ],
  },
]

export function scenarioByID(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id)
}