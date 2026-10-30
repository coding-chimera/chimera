// WP-09 negative fixtures: every mutation must be rejected with a stable code.
//
// Semantic cases re-encode a valid trace after changing event order/content;
// integrity cases keep the raw JSONL bytes (or deliberately preserve a stale
// footer) so the format layer is exercised instead of the semantic verifier.

import { sha256 } from "../../transcript/format"
import {
  canonicalTraceJson,
  encodeHookTrace,
  type HookTrace,
  type TraceEvent,
  type TraceEventInput,
} from "../trajectory"

export type NegativeCase = {
  id: string
  layer: "semantic" | "integrity"
  expected_code: string
  description: string
  apply: (trace: HookTrace) => string
}

function blockRange(events: TraceEventInput[], hook: string, scope: string, plugin: string): [number, number] {
  const start = events.findIndex(
    (event) => event.kind === "hook.start" && event.hook === hook && event.scope === scope && event.plugin_id === plugin,
  )
  if (start === -1) throw new Error(`negative fixture: no block ${hook}/${scope}/${plugin}`)
  let end = start
  while (end + 1 < events.length) {
    const next = events[end + 1]!
    if (next.kind === "hook.end" && next.hook === hook && next.scope === scope && next.plugin_id === plugin) {
      end += 1
      break
    }
    if (next.kind === "hook.mutate" || next.kind === "sdk.call" || next.kind === "hook.start") {
      end += 1
      continue
    }
    break
  }
  return [start, end]
}

function withoutBlock(events: TraceEventInput[], range: [number, number]): TraceEventInput[] {
  return [...events.slice(0, range[0]), ...events.slice(range[1] + 1)]
}

function swapBlocks(
  events: TraceEventInput[],
  first: [number, number],
  second: [number, number],
): TraceEventInput[] {
  if (first[0] > second[0]) throw new Error("negative fixture: swap order must be left-to-right")
  return [
    ...events.slice(0, first[0]),
    ...events.slice(second[0], second[1] + 1),
    ...events.slice(first[1] + 1, second[0]),
    ...events.slice(first[0], first[1] + 1),
    ...events.slice(second[1] + 1),
  ]
}

function encodeWithExplicitSeq(header: HookTrace["header"], events: TraceEvent[]): string {
  const lines = [canonicalTraceJson(header), ...events.map((event) => canonicalTraceJson(event))]
  const body = lines.join("\n") + "\n"
  const footer = { record: "footer" as const, event_count: events.length, body_sha256: sha256(body) }
  return body + canonicalTraceJson(footer) + "\n"
}

function semantic(trace: HookTrace, mutate: (events: TraceEventInput[]) => TraceEventInput[]): string {
  return encodeHookTrace(trace.header, mutate(trace.events.map((event) => {
    const { seq: _seq, ...rest } = event
    return rest as TraceEventInput
  })))
}

export const NEGATIVE_CASES: NegativeCase[] = [
  {
    id: "order-swap-chat-params",
    layer: "semantic",
    expected_code: "HOOK_ORDER_MISMATCH",
    description: "swap demo.alpha and demo.beta blocks in chat.params",
    apply: (trace) =>
      semantic(trace, (events) =>
        swapBlocks(
          events,
          blockRange(events, "chat.params", "params:op-llm", "demo.alpha"),
          blockRange(events, "chat.params", "params:op-llm", "demo.beta"),
        ),
      ),
  },
  {
    id: "missing-tool-after-beta",
    layer: "semantic",
    expected_code: "HOOK_MISSING",
    description: "drop demo.beta from tool.execute.after for call-1",
    apply: (trace) =>
      semantic(trace, (events) => withoutBlock(events, blockRange(events, "tool.execute.after", "after:call-1", "demo.beta"))),
  },
  {
    id: "duplicate-tool-before-alpha",
    layer: "semantic",
    expected_code: "HOOK_DUPLICATE",
    description: "duplicate demo.alpha's tool.execute.before block for call-1",
    apply: (trace) =>
      semantic(trace, (events) => {
        const range = blockRange(events, "tool.execute.before", "before:call-1", "demo.alpha")
        const block = events.slice(range[0], range[1] + 1)
        return [...events.slice(0, range[1] + 1), ...block, ...events.slice(range[1] + 1)]
      }),
  },
  {
    id: "tamper-before-args",
    layer: "semantic",
    expected_code: "HOOK_MUTATION_CHAIN",
    description: "change demo.beta's recorded before-value so it no longer matches the shared args object",
    apply: (trace) =>
      semantic(trace, (events) =>
        events.map((event) =>
          event.kind === "hook.mutate" &&
          event.hook === "tool.execute.before" &&
          event.scope === "before:call-1" &&
          event.plugin_id === "demo.beta"
            ? { ...event, before: "synthetic://wrong.txt" }
            : event,
        ),
      ),
  },
  {
    id: "phase-after-before-before",
    layer: "semantic",
    expected_code: "HOOK_PHASE_ORDER",
    description: "move demo.alpha's tool.execute.after block before its tool.execute.before block",
    apply: (trace) =>
      semantic(trace, (events) => {
        const before = blockRange(events, "tool.execute.before", "before:call-1", "demo.alpha")
        const after = blockRange(events, "tool.execute.after", "after:call-1", "demo.alpha")
        const afterBlock = events.slice(after[0], after[1] + 1)
        const rest = withoutBlock(events, after)
        const target = blockRange(rest, "tool.execute.before", "before:call-1", "demo.alpha")
        return [...rest.slice(0, target[0]), ...afterBlock, ...rest.slice(target[0])]
      }),
  },
  {
    id: "cancel-emits-after",
    layer: "semantic",
    expected_code: "HOOK_AFTER_ON_CANCELLED_CALL",
    description: "emit tool.execute.after for a call whose operation was cancelled",
    apply: (trace) =>
      semantic(trace, (events) => {
        const end = events.findIndex((event) => event.kind === "operation.end" && event.op_id === "op-tool-2")
        if (end === -1) throw new Error("negative fixture: op-tool-2 end is missing")
        const after: TraceEventInput[] = [
          {
            kind: "hook.start",
            hook: "tool.execute.after",
            hook_class: "tool-execute-after",
            scope: "after:call-2",
            plugin_id: "demo.alpha",
            input: { tool: "bash", session_id: "ses_synthetic", call_id: "call-2", args: { command: "synthetic-command --dry-run" } },
            output: { title: "bash", output: "synthetic", metadata: {} },
          },
          {
            kind: "hook.end",
            hook: "tool.execute.after",
            scope: "after:call-2",
            plugin_id: "demo.alpha",
            status: "ok",
            error_code: null,
          },
        ]
        return [...events.slice(0, end), ...after, ...events.slice(end)]
      }),
  },
  {
    id: "integrity-stale-footer",
    layer: "integrity",
    expected_code: "TRACE_BODY_DIGEST",
    description: "drop one event line but keep the old footer",
    apply: (trace) => {
      const lines = trace.text.slice(0, -1).split("\n")
      lines.splice(2, 1)
      return lines.join("\n") + "\n"
    },
  },
  {
    id: "integrity-seq-order",
    layer: "integrity",
    expected_code: "TRACE_SEQ_ORDER",
    description: "renumber one event so physical order and seq disagree, then recompute the footer",
    apply: (trace) => {
      const events = trace.events.map((event) => ({ ...event }))
      const target = events[10]
      if (!target) throw new Error("negative fixture: trace is too short")
      target.seq = 0
      return encodeWithExplicitSeq(trace.header, events)
    },
  },
]

export function applyNegativeCase(trace: HookTrace, negative: NegativeCase): string {
  return negative.apply(trace)
}