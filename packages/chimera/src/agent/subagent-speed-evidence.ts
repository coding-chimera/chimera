import { Effect } from "effect"
import type { ProjectID } from "@/project/schema"
import * as ModelTelemetry from "./model-telemetry"

export const TPS_MIN = 10
export const TPS_MAX = 150
export const BLEND_PRIOR_SAMPLES = 5

export interface RouteSpeedEvidence {
  samples: number
  /**
   * True once any sample has reasoning tokens > 0. Open models stream their
   * thinking, so end-to-end tokens-per-second is meaningful; closed models
   * with hidden CoT stay on static heuristics regardless.
   */
  trustworthy: boolean
  /** EMA of time-to-first-token in ms. */
  ttftMs?: number
  /** EMA of prompt_tokens / (ttftMs / 1000). */
  prefillTokPerSec?: number
  /** Per-tier EMA of (output + reasoning) * 1000 / (durationMs - ttftMs). */
  decodeTokPerSec: Record<string, number>
  /** Per-tier sample counts, used for the sample-weighted pooled decode mean. */
  decodeSamples?: Record<string, number>
}

export interface SpeedEventSample {
  model: string
  tier?: string
  durationMs: number
  ttftMs?: number
  input: number
  output: number
  reasoning: number
}

const ALPHA = 1 / 3

const ema = (previous: number | undefined, value: number) =>
  previous === undefined ? value : previous + ALPHA * (value - previous)

export function tpsToNorm(tps: number): number {
  if (!Number.isFinite(tps) || tps <= TPS_MIN) return 0
  if (tps >= TPS_MAX) return 1
  return (Math.log(tps) - Math.log(TPS_MIN)) / (Math.log(TPS_MAX) - Math.log(TPS_MIN))
}

function measuredDecode(evidence: RouteSpeedEvidence, tier: string | undefined): number | undefined {
  if (tier !== undefined) {
    const perTier = evidence.decodeTokPerSec[tier]
    if (perTier !== undefined) return perTier
  }
  const entries = Object.entries(evidence.decodeTokPerSec)
  if (entries.length === 0) return undefined
  const weights = evidence.decodeSamples ?? {}
  const weighted = entries.reduce((sum, [tierKey, rate]) => sum + rate * (weights[tierKey] ?? 1), 0)
  const totalWeight = entries.reduce((sum, [tierKey]) => sum + (weights[tierKey] ?? 1), 0)
  return totalWeight === 0 ? undefined : weighted / totalWeight
}

export function blendedSpeedNorm(
  evidence: RouteSpeedEvidence | undefined,
  staticNorm: number,
  tier?: string,
): { norm: number; source: "local" | "blended" | "heuristic" } {
  if (!evidence || evidence.samples === 0 || !evidence.trustworthy) {
    return { norm: staticNorm, source: "heuristic" }
  }
  const measured = measuredDecode(evidence, tier)
  if (measured === undefined) return { norm: staticNorm, source: "heuristic" }
  if (evidence.samples >= BLEND_PRIOR_SAMPLES) {
    return { norm: tpsToNorm(measured), source: "local" }
  }
  return {
    norm:
      (evidence.samples * tpsToNorm(measured) + (BLEND_PRIOR_SAMPLES - evidence.samples) * staticNorm) /
      BLEND_PRIOR_SAMPLES,
    source: "blended",
  }
}

type RouteState = {
  samples: number
  trustworthy: boolean
  ttftMs?: number
  prefillTokPerSec?: number
  decode: Record<string, { value: number; samples: number }>
}

export function aggregateSpeedEvents(events: readonly SpeedEventSample[]): Map<string, RouteSpeedEvidence> {
  const routes = new Map<string, RouteState>()
  for (const event of events) {
    const state = routes.get(event.model) ?? { samples: 0, trustworthy: false, decode: {} }
    state.samples += 1
    routes.set(event.model, state)
    if (event.reasoning > 0) state.trustworthy = true
    if (event.ttftMs !== undefined && event.ttftMs > 0) {
      state.ttftMs = ema(state.ttftMs, event.ttftMs)
      state.prefillTokPerSec = ema(state.prefillTokPerSec, (event.input * 1000) / event.ttftMs)
    }
    const windowMs = event.durationMs - (event.ttftMs ?? 0)
    if (windowMs <= 0) continue
    const tierKey = event.tier ?? "unknown"
    const bucket = state.decode[tierKey]
    const decodeRate = ((event.output + event.reasoning) * 1000) / windowMs
    if (bucket === undefined) {
      state.decode[tierKey] = { value: decodeRate, samples: 1 }
    } else {
      bucket.value = ema(bucket.value, decodeRate)
      bucket.samples += 1
    }
  }

  const result = new Map<string, RouteSpeedEvidence>()
  for (const [model, state] of routes) {
    result.set(model, {
      samples: state.samples,
      trustworthy: state.trustworthy,
      ...(state.ttftMs === undefined ? {} : { ttftMs: state.ttftMs }),
      ...(state.prefillTokPerSec === undefined ? {} : { prefillTokPerSec: state.prefillTokPerSec }),
      decodeTokPerSec: Object.fromEntries(
        Object.entries(state.decode).map(([tierKey, bucket]) => [tierKey, bucket.value] as const),
      ),
      decodeSamples: Object.fromEntries(
        Object.entries(state.decode).map(([tierKey, bucket]) => [tierKey, bucket.samples] as const),
      ),
    })
  }
  return result
}

export function speedSampleFromEvent(event: ModelTelemetry.Event): SpeedEventSample | undefined {
  const execution = event.execution
  const usage = event.usage
  const action = event.action
  if (execution === undefined || usage === undefined || action === undefined || execution.durationMs === undefined) {
    return undefined
  }
  return {
    model: action.route,
    ...(action.variant === undefined ? {} : { tier: action.variant }),
    durationMs: execution.durationMs,
    ...(execution.ttftMs === undefined ? {} : { ttftMs: execution.ttftMs }),
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning,
  }
}

export function speedEvidenceFromEvents(events: readonly ModelTelemetry.Event[]): Map<string, RouteSpeedEvidence> {
  return aggregateSpeedEvents(
    events.flatMap((event) => {
      const sample = speedSampleFromEvent(event)
      return sample === undefined ? [] : [sample]
    }),
  )
}

const FINAL_EVENT_TYPES = ["delegation.finished", "delegation.failed", "delegation.cancelled"] as const

// Thin adapter over the synchronous telemetry store. Scheduler wiring lands later.
export const recentSpeedEvidence = Effect.fn("SubagentSpeedEvidence.recent")(function* (input: {
  projectID: ProjectID
  limit?: number
}) {
  const events = yield* Effect.sync(() =>
    ModelTelemetry.read({
      projectID: input.projectID,
      limit: input.limit ?? 50,
      eventTypes: [...FINAL_EVENT_TYPES],
    }),
  )
  return speedEvidenceFromEvents(events)
})

export * as SubagentSpeedEvidence from "./subagent-speed-evidence"
