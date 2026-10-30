// Deterministic fault injection over a parsed WP-02 transcript.
//
// Every fixture is data (see faults/fixtures/*.json); this module only applies
// the declared operations and re-encodes the transcript with a fresh footer.
// Re-encoding is deliberate: loss/reorder/duplicate fixtures must reach the
// comparator instead of being rejected by the transcript integrity guard.

import {
  encodeTranscript,
  parseTranscript,
  stripSeq,
  type Transcript,
  type TranscriptEventInput,
} from "../transcript/format"
import type { RunArtifact } from "../compare/types"
import type { FaultFixture, InjectionOp } from "./matrix"

function requireEventIndex(
  events: TranscriptEventInput[],
  kind: string,
  ordinal: number,
  label: string,
): number {
  const matches: number[] = []
  events.forEach((event, index) => {
    if (event.kind === kind) matches.push(index)
  })
  const index = matches[ordinal - 1]
  if (index === undefined) {
    throw new Error(`fault injection: ${label} not found (${kind} #${ordinal}, ${matches.length} available)`)
  }
  return index
}

function applyOp(events: TranscriptEventInput[], op: InjectionOp): void {
  switch (op.op) {
    case "drop-event": {
      events.splice(requireEventIndex(events, op.kind, op.ordinal, "drop-event"), 1)
      return
    }
    case "duplicate-event": {
      const index = requireEventIndex(events, op.kind, op.ordinal, "duplicate-event")
      events.splice(index + 1, 0, { ...events[index]! })
      return
    }
    case "swap-events": {
      const left = requireEventIndex(events, op.kind, op.ordinals[0], "swap-events")
      const right = requireEventIndex(events, op.kind, op.ordinals[1], "swap-events")
      const leftEvent = events[left]!
      const rightEvent = events[right]!
      events[left] = rightEvent
      events[right] = leftEvent
      return
    }
    case "truncate-events": {
      events.splice(op.keep)
      return
    }
    case "insert-cancel-event": {
      if (op.at > events.length + 1) {
        throw new Error(`fault injection: insert-cancel-event at ${op.at} exceeds ${events.length + 1} insertion points`)
      }
      events.splice(op.at - 1, 0, {
        kind: "sse.event",
        stream_id: "control",
        event_seq: 1,
        event: "cancel",
        data: { reason: op.reason },
      })
      return
    }
    case "remove-snapshot-row": {
      const index = events.findIndex((event) => event.kind === "db.snapshot" && event.table === op.table)
      if (index < 0) throw new Error(`fault injection: db.snapshot for table ${op.table} not found`)
      const event = events[index]!
      if (event.kind !== "db.snapshot") throw new Error("fault injection: matched a non-snapshot event")
      const rows = event.rows.filter((row) => row.id !== op.id)
      if (rows.length === event.rows.length) {
        throw new Error(`fault injection: snapshot row id ${op.id} not found in ${op.table}`)
      }
      events[index] = { ...event, rows }
      return
    }
    case "set-tool-output": {
      const index = events.findIndex((event) => event.kind === "tool.result" && event.call_id === op.call_id)
      if (index < 0) throw new Error(`fault injection: tool.result ${op.call_id} not found`)
      const event = events[index]!
      if (event.kind !== "tool.result") throw new Error("fault injection: matched a non-result event")
      events[index] = { ...event, output: op.output }
      return
    }
  }
}

export function injectTranscript(transcript: Transcript, injections: InjectionOp[]): string {
  const events = transcript.events.map(stripSeq)
  for (const op of injections) applyOp(events, op)
  return encodeTranscript(transcript.header, events)
}

export function buildInjectedArtifact(fixture: FaultFixture, baseline: RunArtifact): RunArtifact {
  const transcript = parseTranscript(baseline.transcript)
  return {
    envelope: { ...baseline.envelope, status: fixture.envelope_status },
    transcript: injectTranscript(transcript, fixture.injections),
  }
}
