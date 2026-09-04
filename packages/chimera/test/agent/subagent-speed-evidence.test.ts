import { describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { Database } from "@/storage/db"
import * as Telemetry from "../../src/agent/model-telemetry"
import * as SpeedEvidence from "../../src/agent/subagent-speed-evidence"

function project() {
  const id = ProjectID.make(`speed-test-${randomUUID()}`)
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id, worktree: `/${id}`, sandboxes: [], time_created: now, time_updated: now })
      .run(),
  )
  return id
}

function sample(overrides: Partial<SpeedEvidence.SpeedEventSample>): SpeedEvidence.SpeedEventSample {
  return {
    model: "openai/gpt-5.6-luna",
    durationMs: 4_000,
    input: 1_000,
    output: 200,
    reasoning: 50,
    ...overrides,
  }
}

describe("tpsToNorm", () => {
  test("anchors at the bounds", () => {
    expect(SpeedEvidence.tpsToNorm(10)).toBe(0)
    expect(SpeedEvidence.tpsToNorm(150)).toBe(1)
    expect(SpeedEvidence.tpsToNorm(0)).toBe(0)
    expect(SpeedEvidence.tpsToNorm(-5)).toBe(0)
    expect(SpeedEvidence.tpsToNorm(500)).toBe(1)
  })

  test("maps the log-space midpoint to ~0.5", () => {
    expect(SpeedEvidence.tpsToNorm(38.7)).toBeCloseTo(0.5, 1)
  })
})

describe("blendedSpeedNorm", () => {
  test("falls back to the static heuristic without evidence or samples", () => {
    expect(SpeedEvidence.blendedSpeedNorm(undefined, 0.6)).toEqual({ norm: 0.6, source: "heuristic" })
    expect(SpeedEvidence.blendedSpeedNorm({ samples: 0, trustworthy: true, decodeTokPerSec: {} }, 0.6)).toEqual({
      norm: 0.6,
      source: "heuristic",
    })
  })

  test("keeps untrustworthy evidence on the static heuristic", () => {
    const evidence: SpeedEvidence.RouteSpeedEvidence = {
      samples: 8,
      trustworthy: false,
      decodeTokPerSec: { low: 100 },
      decodeSamples: { low: 8 },
    }
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6)).toEqual({ norm: 0.6, source: "heuristic" })
  })

  test("uses measured speed once evidence passes the prior-sample threshold", () => {
    const evidence: SpeedEvidence.RouteSpeedEvidence = {
      samples: 5,
      trustworthy: true,
      decodeTokPerSec: { low: 38.7 },
      decodeSamples: { low: 5 },
    }
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6)).toEqual({
      norm: SpeedEvidence.tpsToNorm(38.7),
      source: "local",
    })
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6, "low").norm).toBe(SpeedEvidence.tpsToNorm(38.7))
  })

  test("blends the static prior with measured speed before the threshold", () => {
    const evidence: SpeedEvidence.RouteSpeedEvidence = {
      samples: 2,
      trustworthy: true,
      decodeTokPerSec: { high: 150 },
      decodeSamples: { high: 2 },
    }
    const expected = (2 * SpeedEvidence.tpsToNorm(150) + (5 - 2) * 0.6) / 5
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6)).toEqual({ norm: expected, source: "blended" })
  })

  test("prefers the requested tier and falls back to the pooled mean", () => {
    const evidence: SpeedEvidence.RouteSpeedEvidence = {
      samples: 5,
      trustworthy: true,
      decodeTokPerSec: { low: 20, high: 100 },
      decodeSamples: { low: 1, high: 4 },
    }
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6, "low")).toEqual({
      norm: SpeedEvidence.tpsToNorm(20),
      source: "local",
    })
    // pooled = (20 * 1 + 100 * 4) / 5 = 84
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6).norm).toBe(SpeedEvidence.tpsToNorm(84))
  })

  test("falls back to the static heuristic when no decode is measured", () => {
    const evidence: SpeedEvidence.RouteSpeedEvidence = {
      samples: 6,
      trustworthy: true,
      decodeTokPerSec: {},
    }
    expect(SpeedEvidence.blendedSpeedNorm(evidence, 0.6)).toEqual({ norm: 0.6, source: "heuristic" })
  })
})

describe("aggregateSpeedEvents", () => {
  test("buckets decode rates per tier and ema in arrival order", () => {
    const low = SpeedEvidence.aggregateSpeedEvents([
      sample({ model: "test-relay/model-a", tier: "low", durationMs: 1_000, ttftMs: 0, output: 30, reasoning: 0 }),
      sample({ model: "test-relay/model-a", tier: "low", durationMs: 1_000, ttftMs: 0, output: 90, reasoning: 0 }),
      sample({ model: "test-relay/model-a", tier: "medium", durationMs: 1_000, ttftMs: 0, output: 60, reasoning: 0 }),
    ])
    const evidence = low.get("test-relay/model-a")
    expect(evidence).toBeDefined()
    expect(evidence!.samples).toBe(3)
    // low: 30 + (90 - 30) / 3 = 50
    expect(evidence!.decodeTokPerSec["low"]).toBeCloseTo(50, 6)
    expect(evidence!.decodeTokPerSec["medium"]).toBe(60)
    expect(evidence!.decodeSamples).toMatchObject({ low: 2, medium: 1 })

    const reversed = SpeedEvidence.aggregateSpeedEvents([
      sample({ model: "test-relay/model-a", tier: "low", durationMs: 1_000, ttftMs: 0, output: 90, reasoning: 0 }),
      sample({ model: "test-relay/model-a", tier: "low", durationMs: 1_000, ttftMs: 0, output: 30, reasoning: 0 }),
    ])
    // reversed order: 90 + (30 - 90) / 3 = 70
    expect(reversed.get("test-relay/model-a")!.decodeTokPerSec["low"]).toBeCloseTo(70, 6)
  })

  test("reasons through unknown tiers and marks evidence trustworthy on reasoning tokens", () => {
    const evidence = SpeedEvidence.aggregateSpeedEvents([
      sample({ model: "x/y", tier: "max", durationMs: 2_000, ttftMs: 0, output: 100, reasoning: 20 }),
    ]).get("x/y")
    expect(evidence!.trustworthy).toBe(true)
    expect(evidence!.decodeTokPerSec["max"]).toBeCloseTo(60, 6)

    const untrusted = SpeedEvidence.aggregateSpeedEvents([
      sample({ model: "x/y", durationMs: 2_000, ttftMs: 0, output: 100, reasoning: 0 }),
    ]).get("x/y")
    expect(untrusted!.trustworthy).toBe(false)
    expect(untrusted!.decodeTokPerSec["unknown"]).toBeCloseTo(50, 6)
  })

  test("skips non-positive decode windows while still counting the sample", () => {
    const evidence = SpeedEvidence.aggregateSpeedEvents([
      sample({ model: "x/y", durationMs: 100, ttftMs: 100, output: 50, reasoning: 0 }),
      sample({ model: "x/y", durationMs: 100, ttftMs: 200, output: 50, reasoning: 0 }),
      sample({ model: "x/y", durationMs: 500, output: 50, reasoning: 0 }),
    ]).get("x/y")
    expect(evidence!.samples).toBe(3)
    expect(evidence!.decodeTokPerSec).toEqual({ unknown: 100 })
  })

  test("records prefill and ttft only when ttftMs is positive", () => {
    const evidence = SpeedEvidence.aggregateSpeedEvents([
      sample({ model: "x/y", durationMs: 4_000, ttftMs: 2_000, input: 1_000, output: 200, reasoning: 50 }),
      sample({ model: "x/y", durationMs: 4_000, output: 200, reasoning: 50 }),
    ]).get("x/y")
    // prefill = 1000 / (2000 / 1000) = 500; ttft ema keeps the single sample
    expect(evidence!.prefillTokPerSec).toBe(500)
    expect(evidence!.ttftMs).toBe(2_000)
    // sample1 window = 2000 -> 125 tps; sample2 window = 4000 -> 62.5 tps; ema = 125 - 20.8333
    expect(evidence!.decodeTokPerSec["unknown"]).toBeCloseTo(104.1667, 4)
  })
})
describe("speedEvidenceFromEvents", () => {
  test("accepts a finished event with execution and usage and produces a decode sample", () => {
    const action = Telemetry.actionForRoute({
      route: "openai/gpt-5.6-luna",
      identity: "gpt-5.6-luna",
      variant: "max",
      selectionSource: "scheduler",
    })
    const event: Telemetry.Event = {
      schemaVersion: 1,
      eventID: `speed-evidence-${randomUUID()}`,
      eventType: "delegation.finished",
      episodeID: `episode-${randomUUID()}`,
      decisionID: `decision-${randomUUID()}`,
      delegationID: `delegation-${randomUUID()}`,
      workload: "builder",
      action,
      execution: { status: "completed", durationMs: 4_000, ttftMs: 1_000 },
      usage: { input: 500, output: 300, reasoning: 25, cacheRead: 0, cacheWrite: 0 },
      createdAt: Date.now(),
    }
    const evidence = SpeedEvidence.speedEvidenceFromEvents([event])
    const route = evidence.get("openai/gpt-5.6-luna")
    expect(route).toBeDefined()
    expect(route!.samples).toBe(1)
    expect(route!.trustworthy).toBe(true)
    expect(route!.ttftMs).toBe(1_000)
    expect(route!.prefillTokPerSec).toBe(500)
    // decode = (300 + 25) * 1000 / (4000 - 1000) = 108.33
    expect(route!.decodeTokPerSec["max"]).toBeCloseTo(325 / 3, 6)
  })

  test("drops events that carry execution but no usage", () => {
    const action = Telemetry.actionForRoute({
      route: "openai/gpt-5.6-luna",
      identity: "gpt-5.6-luna",
      selectionSource: "scheduler",
    })
    const event: Telemetry.Event = {
      schemaVersion: 1,
      eventID: `speed-evidence-${randomUUID()}`,
      eventType: "delegation.finished",
      episodeID: `episode-${randomUUID()}`,
      decisionID: `decision-${randomUUID()}`,
      delegationID: `delegation-${randomUUID()}`,
      workload: "builder",
      action,
      execution: { status: "completed", durationMs: 4_000 },
      createdAt: Date.now(),
    }
    expect(SpeedEvidence.speedEvidenceFromEvents([event]).size).toBe(0)
  })
})

describe("recentSpeedEvidence", () => {
  test("pulls recent terminal events from the telemetry store and aggregates them", async () => {
    const projectID = project()
    const action = Telemetry.actionForRoute({
      route: "openai/gpt-5.6-luna",
      identity: "gpt-5.6-luna",
      variant: "max",
      selectionSource: "scheduler",
    })
    const event: Telemetry.Event = {
      schemaVersion: 1,
      eventID: `speed-evidence-${randomUUID()}`,
      eventType: "delegation.finished",
      projectID,
      episodeID: `episode-${randomUUID()}`,
      decisionID: `decision-${randomUUID()}`,
      delegationID: `delegation-${randomUUID()}`,
      workload: "builder",
      action,
      execution: { status: "completed", durationMs: 4_000, ttftMs: 1_000 },
      usage: { input: 500, output: 300, reasoning: 25, cacheRead: 0, cacheWrite: 0 },
      createdAt: Date.now(),
    }
    Telemetry.append(event)

    const evidence = await Effect.runPromise(SpeedEvidence.recentSpeedEvidence({ projectID, limit: 10 }))
    const route = evidence.get("openai/gpt-5.6-luna")
    expect(route).toBeDefined()
    expect(route!.samples).toBe(1)
    expect(route!.trustworthy).toBe(true)
    expect(route!.ttftMs).toBe(1_000)
    expect(route!.prefillTokPerSec).toBe(500)
    // decode = (300 + 25) * 1000 / (4000 - 1000) = 108.33
    expect(route!.decodeTokPerSec["max"]).toBeCloseTo(325 / 3, 6)
  })

  test("ignores lifecycle events without execution details", async () => {
    const projectID = project()
    const action = Telemetry.actionForRoute({
      route: "openai/gpt-5.6-luna",
      identity: "gpt-5.6-luna",
      selectionSource: "scheduler",
    })
    const event: Telemetry.Event = {
      schemaVersion: 1,
      eventID: `speed-evidence-${randomUUID()}`,
      eventType: "delegation.finished",
      projectID,
      episodeID: `episode-${randomUUID()}`,
      decisionID: `decision-${randomUUID()}`,
      delegationID: `delegation-${randomUUID()}`,
      workload: "builder",
      action,
      createdAt: Date.now(),
    }
    Telemetry.append(event)

    const evidence = await Effect.runPromise(SpeedEvidence.recentSpeedEvidence({ projectID, limit: 10 }))
    expect(evidence.size).toBe(0)
  })
})
