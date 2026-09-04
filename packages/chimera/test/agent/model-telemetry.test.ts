import { describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import { and, eq } from "drizzle-orm"
import { Schema } from "effect"
import {
  ModelTelemetryDelegationTable,
  ModelTelemetryEventTable,
  ModelTelemetryOracleLinkTable,
  ModelTelemetrySessionBindingTable,
} from "../../src/agent/model-telemetry.sql"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { Database } from "@/storage/db"
import * as Telemetry from "../../src/agent/model-telemetry"

const { Event, ModelTelemetry } = Telemetry

type TelemetryEvent = Schema.Schema.Type<typeof Event>

function project() {
  const id = ProjectID.make(`telemetry-test-${randomUUID()}`)
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id, worktree: `/${id}`, sandboxes: [], time_created: now, time_updated: now })
      .run(),
  )
  return id
}

function event(input: {
  projectID: ProjectID
  eventID?: string
  eventType?: TelemetryEvent["eventType"]
  createdAt?: number
  overrides?: Record<string, unknown>
}): TelemetryEvent {
  return {
    schemaVersion: 1,
    eventID: input.eventID ?? `event-${randomUUID()}`,
    eventType: input.eventType ?? "delegation.finished",
    projectID: input.projectID,
    episodeID: `episode-${randomUUID()}`,
    decisionID: `decision-${randomUUID()}`,
    delegationID: `delegation-${randomUUID()}`,
    workload: "builder",
    action: {
      route: "openai/gpt-5.6-luna",
      identity: "gpt-5.6-luna",
      variant: "max",
      selectionSource: "scheduler",
    },
    policy: {
      version: "p2-test",
      selectionMode: "scheduler",
      chosenPropensity: 1,
      candidateCount: 1,
    },
    execution: {
      status: "completed",
      durationMs: 10,
    },
    usage: {
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        status: "known",
        usd: 0,
        source: "subscription",
      },
    },
    createdAt: input.createdAt ?? Date.now(),
    ...input.overrides,
  } as TelemetryEvent
}

function usageFor(cost: Telemetry.Cost): Telemetry.Usage {
  return {
    input: 1,
    output: 1,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
  }
}

function append(input: Telemetry.AppendInput | TelemetryEvent) {
  if ("event" in input) return ModelTelemetry.append(input)
  return ModelTelemetry.append(input)
}

function read(projectID: ProjectID, limit?: number) {
  return ModelTelemetry.read({ projectID, limit })
}

function thrown(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("expected operation to throw")
}

function expectValidationError(run: () => unknown, reason: Telemetry.TelemetryValidationError["reason"]) {
  const error = thrown(run)
  expect(error).toBeInstanceOf(Telemetry.TelemetryValidationError)
  expect((error as Telemetry.TelemetryValidationError).reason).toBe(reason)
  return error as Telemetry.TelemetryValidationError
}

function expectFanoutError(run: () => unknown, reason: "self-link" | "missing-parent") {
  const error = thrown(run)
  expect(error).toBeInstanceOf(Telemetry.TelemetryFanoutLinkError)
  expect((error as Telemetry.TelemetryFanoutLinkError).reason).toBe(reason)
  return error as Telemetry.TelemetryFanoutLinkError
}

function expectStorageError(run: () => unknown) {
  const error = thrown(run)
  expect(error).toBeInstanceOf(Telemetry.TelemetryStorageError)
  return error as Telemetry.TelemetryStorageError
}

describe("ModelTelemetry", () => {
  test("strictly rejects excess event fields and append envelope mismatches", () => {
    const projectID = project()
    const otherProjectID = project()
    const input = event({
      projectID,
      overrides: {
        prompt: "do not store this",
        output: "do not store this either",
        path: "/private/source",
        metadata: { arbitrary: "data" },
      },
    })

    expect(() => Schema.decodeUnknownSync(Event)(input, { onExcessProperty: "error" })).toThrow()
    expectValidationError(() => append(input), "invalid-event")

    const valid = event({ projectID, eventID: "envelope-event" })
    expectValidationError(
      () => append({ projectID, event: valid, traceID: "unexpected" } as unknown as Telemetry.AppendInput),
      "invalid-event",
    )
    expectValidationError(() => append({ projectID: otherProjectID, event: valid }), "invalid-project-id")
  })

  test("queues append asynchronously without blocking the caller", async () => {
    const projectID = project()
    const input = event({ projectID, eventID: "async-append" })

    const pending = ModelTelemetry.appendBestEffort(input)
    expect(read(projectID, 10)).toEqual([])

    const result = await pending
    expect(result).toBeUndefined()
    expect(read(projectID, 10).map((item) => item.eventID)).toEqual([input.eventID])
  })

  test("snapshots bounded telemetry at best-effort admission", async () => {
    const projectID = project()
    const input = { ...event({ projectID, eventID: "admission-snapshot" }) }
    const pending = ModelTelemetry.appendBestEffort(input)
    input.workload = "reviewer"
    await pending
    await ModelTelemetry.drainBestEffort()

    expect(read(projectID, 10).find((item) => item.eventID === input.eventID)?.workload).toBe("builder")
  })

  test("swallows invalid best-effort appends without persisting them", async () => {
    const projectID = project()
    const input = event({
      projectID,
      eventID: "invalid-best-effort",
      overrides: { prompt: "do not store this" },
    })

    const result = await ModelTelemetry.appendBestEffort(input)
    expect(result).toBeUndefined()
    expect(read(projectID, 10)).toEqual([])
  })

  test("rejects oversized, cyclic, and accessor-bearing telemetry before cloning or decoding", async () => {
    const projectID = project()
    const accessor = event({ projectID, eventID: "accessor-admission" })
    let accessorReads = 0
    Object.defineProperty(accessor, "prompt", {
      enumerable: true,
      get() {
        accessorReads++
        throw new Error("unexpected accessor read")
      },
    })
    const candidates = Array.from({ length: 257 }, () => ({}))
    let candidateReads = 0
    Object.defineProperty(candidates, "256", {
      configurable: true,
      enumerable: true,
      get() {
        candidateReads++
        throw new Error("unexpected candidate read")
      },
    })
    const oversizedCandidates = event({
      projectID,
      eventID: "oversized-candidates-admission",
      overrides: {
        policy: {
          version: "p2-test",
          selectionMode: "scheduler",
          candidateCount: candidates.length,
          candidates,
        },
      },
    })
    const oversizedPayload = event({
      projectID,
      eventID: "oversized-payload-admission",
      overrides: { prompt: "x".repeat(16_385) },
    })
    const oversizedObject = Object.assign(
      event({ projectID, eventID: "oversized-object-admission" }),
      Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`extra-${index}`, index])),
    )
    const cyclic = event({ projectID, eventID: "cyclic-admission" })
    Object.defineProperty(cyclic, "loop", { enumerable: true, value: cyclic })

    expectValidationError(() => append(accessor), "invalid-event")
    expectValidationError(() => append(oversizedCandidates), "invalid-event")
    expectValidationError(() => append(oversizedObject), "invalid-event")
    await Promise.all([
      ModelTelemetry.appendBestEffort(accessor),
      ModelTelemetry.appendBestEffort(oversizedCandidates),
      ModelTelemetry.appendBestEffort(oversizedObject),
      ModelTelemetry.appendBestEffort(oversizedPayload),
      ModelTelemetry.appendBestEffort(cyclic),
    ])
    await ModelTelemetry.drainBestEffort()

    expect(accessorReads).toBe(0)
    expect(candidateReads).toBe(0)
    expect(read(projectID, 10)).toEqual([])
  })

  test("omits symbol-keyed fields from best-effort telemetry snapshots", async () => {
    const projectID = project()
    const input = event({ projectID, eventID: "symbol-snapshot" })
    let symbolReads = 0
    Object.defineProperty(input, Symbol("not-telemetry"), {
      enumerable: true,
      get() {
        symbolReads++
        throw new Error("unexpected symbol read")
      },
    })

    await ModelTelemetry.appendBestEffort(input)
    await ModelTelemetry.drainBestEffort()

    const persisted = read(projectID, 10).find((item) => item.eventID === input.eventID)
    expect(symbolReads).toBe(0)
    expect(persisted?.eventID).toBe(input.eventID)
    expect(Object.getOwnPropertySymbols(persisted ?? {})).toEqual([])
  })

  test("preserves decision-before-child linkage for queued appends", async () => {
    const projectID = project()
    const decision = event({
      projectID,
      eventID: "queued-decision",
      eventType: "decision.recorded",
      overrides: { decisionID: "queued-decision-id" },
    })
    const child = event({
      projectID,
      eventID: "queued-child",
      eventType: "delegation.started",
      overrides: {
        decisionID: decision.decisionID,
        fanout: {
          fanoutID: decision.eventID,
          itemIndex: 0,
          size: 1,
          concurrency: 1,
          templateKind: "task",
        },
      },
    })

    await Promise.all([ModelTelemetry.appendBestEffort(decision), ModelTelemetry.appendBestEffort(child)])
    const stored = new Map(read(projectID, 10).map((item) => [item.eventID, item]))

    expect(stored.get(decision.eventID)?.eventType).toBe("decision.recorded")
    expect(stored.get(child.eventID)?.eventType).toBe("delegation.started")
    expect(stored.get(child.eventID)?.fanout).toEqual({
      fanoutID: decision.eventID,
      itemIndex: 0,
      size: 1,
      concurrency: 1,
      templateKind: "task",
    })
  })

  test("returns inserted and duplicate outcomes, then rejects an idempotency conflict with a typed error", () => {
    const projectID = project()
    const original = event({ projectID, eventID: "idempotent-event" })

    expect(append(original)).toMatchObject({ status: "inserted", eventID: original.eventID })
    expect(append(original)).toMatchObject({ status: "duplicate", eventID: original.eventID, tombstoned: false })

    const conflicting = event({
      projectID,
      eventID: original.eventID,
      overrides: { workload: "reviewer" },
    })
    const error = thrown(() => append(conflicting))
    expect(error).toBeInstanceOf(Telemetry.TelemetryIdempotencyConflictError)
    expect((error as Telemetry.TelemetryIdempotencyConflictError).tombstoned).toBe(false)
  })

  test("records concrete routes and controlled policy candidates", () => {
    const projectID = project()
    const selectedAction = {
      route: "openai/gpt-5.6-luna",
      identity: "gpt-5.6-luna",
      variant: "max",
      selectionSource: "scheduler",
    } as const
    const policy = {
      version: "policy-v1",
      selectionMode: "scheduler",
      decisionSeed: "seed-1",
      chosenPropensity: 0.75,
      candidateCount: 3,
      candidates: [
        { action: selectedAction, propensity: 0.75, eligible: true },
        {
          action: {
            route: "openai/gpt-5.6-sol",
            identity: "gpt-5.6-sol",
            variant: "high",
            selectionSource: "exploration",
          },
          propensity: 0.2,
          eligible: false,
          filterReason: "cost",
        },
        {
          action: {
            route: "anthropic/claude-sonnet-4",
            identity: "claude-sonnet-4",
            selectionSource: "scheduler",
          },
          propensity: 0.05,
          eligible: false,
          filterReason: "quota",
        },
      ],
    } as const
    const input = event({
      projectID,
      eventID: "controlled-selection",
      overrides: { action: selectedAction, policy },
    })

    expect(append(input)).toMatchObject({ status: "inserted" })
    const stored = read(projectID, 10).find((item) => item.eventID === input.eventID)
    expect(stored?.action).toEqual(selectedAction)
    expect(stored?.policy).toEqual(policy)

    const invalidCount = event({
      projectID,
      eventID: "invalid-policy-count",
      overrides: { policy: { ...policy, candidateCount: 2 } },
    })
    expectValidationError(() => append(invalidCount), "invalid-event")

    const invalidEligibility = event({
      projectID,
      eventID: "invalid-policy-eligibility",
      overrides: {
        policy: {
          ...policy,
          candidateCount: 1,
          candidates: [{ action: selectedAction, propensity: 1, eligible: true, filterReason: "policy" }],
        },
      },
    })
    expectValidationError(() => append(invalidEligibility), "invalid-event")
  })

  test("uses canonical fanout metadata and enforces exact decision linkage", () => {
    const projectID = project()
    const parent = event({
      projectID,
      eventID: "fanout-decision",
      eventType: "decision.recorded",
      overrides: {
        decisionID: "fanout-decision-id",
        fanout: {
          fanoutID: "fanout-parent",
          size: 2,
          concurrency: 1,
          templateKind: "parallel",
        },
      },
    })
    append(parent)

    const child = event({
      projectID,
      eventID: "fanout-child",
      eventType: "delegation.started",
      overrides: {
        decisionID: parent.decisionID,
        fanout: {
          fanoutID: "fanout-parent",
          itemIndex: 0,
          size: 2,
          concurrency: 1,
          templateKind: "parallel",
        },
      },
    })
    expect(append(child)).toMatchObject({ status: "inserted" })
    expect(read(projectID, 10).find((item) => item.eventID === child.eventID)?.fanout).toEqual({
      fanoutID: "fanout-parent",
      itemIndex: 0,
      size: 2,
      concurrency: 1,
      templateKind: "parallel",
    })

    const selfLinked = event({
      projectID,
      eventID: "fanout-self",
      eventType: "delegation.started",
      overrides: {
        fanout: {
          fanoutID: "fanout-self",
          itemIndex: 0,
          size: 1,
          concurrency: 1,
          templateKind: "task",
        },
      },
    })
    expectFanoutError(() => append(selfLinked), "self-link")

    const missingParent = event({
      projectID,
      eventID: "fanout-missing-parent",
      eventType: "delegation.started",
      overrides: {
        decisionID: "missing-decision",
        fanout: {
          fanoutID: "missing-parent",
          itemIndex: 0,
          size: 1,
          concurrency: 1,
          templateKind: "parallel",
        },
      },
    })
    expectFanoutError(() => append(missingParent), "missing-parent")

    const mismatchedDecision = event({
      projectID,
      eventID: "fanout-mismatched-decision",
      eventType: "delegation.started",
      overrides: {
        decisionID: "other-decision",
        fanout: {
          fanoutID: "fanout-parent",
          itemIndex: 0,
          size: 2,
          concurrency: 1,
          templateKind: "parallel",
        },
      },
    })
    expectFanoutError(() => append(mismatchedDecision), "missing-parent")

    const invalidIndex = event({
      projectID,
      eventID: "fanout-invalid-index",
      eventType: "delegation.started",
      overrides: {
        decisionID: parent.decisionID,
        fanout: {
          fanoutID: "fanout-parent",
          itemIndex: 2,
          size: 2,
          concurrency: 1,
          templateKind: "parallel",
        },
      },
    })
    expectValidationError(() => append(invalidIndex), "invalid-event")
  })

  test("distinguishes known subscription zero cost from unknown metered and usage costs", () => {
    const projectID = project()
    const subscriptionZero = event({
      projectID,
      eventID: "subscription-zero",
      createdAt: 10,
      overrides: { usage: usageFor({ status: "known", usd: 0, source: "subscription" }) },
    })
    const meteredUnknown = event({
      projectID,
      eventID: "metered-unknown",
      eventType: "decision.recorded",
      createdAt: 11,
      overrides: {
        usage: usageFor({ status: "unknown", source: "metered", reason: "metered-zero-price" }),
      },
    })
    const usageUnknown = event({
      projectID,
      eventID: "usage-unknown",
      eventType: "decision.recorded",
      createdAt: 12,
      overrides: {
        usage: usageFor({ status: "unknown", source: "usage", reason: "usage-pending" }),
      },
    })

    append(subscriptionZero)
    append(meteredUnknown)
    append(usageUnknown)

    const stored = new Map(read(projectID, 10).map((item) => [item.eventID, item]))
    expect(stored.get(subscriptionZero.eventID)?.usage?.cost).toEqual({ status: "known", usd: 0, source: "subscription" })
    expect(stored.get(meteredUnknown.eventID)?.usage?.cost).toEqual({
      status: "unknown",
      source: "metered",
      reason: "metered-zero-price",
    })
    expect(stored.get(usageUnknown.eventID)?.usage?.cost).toEqual({
      status: "unknown",
      source: "usage",
      reason: "usage-pending",
    })

    const legacy = event({
      projectID,
      eventID: "legacy-cost-alias",
      overrides: {
        usage: {
          input: 1,
          output: 1,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0,
        },
      },
    })
    expectValidationError(() => append(legacy), "invalid-cost")

    const invalidProviderZero = event({
      projectID,
      eventID: "provider-zero-cost",
      overrides: {
        usage: usageFor({ status: "known", usd: 0, source: "provider-pricing" }),
      },
    })
    expectValidationError(() => append(invalidProviderZero), "invalid-cost")
  })

  test("isolates projects and returns deterministic bounded reads", () => {
    const projectA = project()
    const projectB = project()
    const base = 2_000_000

    append(event({ projectID: projectA, eventID: "a-old", createdAt: base + 1 }))
    append(event({ projectID: projectA, eventID: "a-middle", createdAt: base + 2 }))
    append(event({ projectID: projectA, eventID: "a-new", createdAt: base + 3 }))
    append(event({ projectID: projectB, eventID: "b-only", createdAt: base + 4 }))

    expect(read(projectA, 2).map((item) => item.eventID)).toEqual(["a-new", "a-middle"])
    expect(read(projectA, 100).map((item) => item.eventID)).toEqual(["a-new", "a-middle", "a-old"])
    expect(read(projectB).map((item) => item.eventID)).toEqual(["b-only"])
  })

  test("compacts only finalized events and prunes retained tombstones", () => {
    const projectID = project()
    const now = 3_000_000
    const started = event({ projectID, eventID: "started-event", eventType: "delegation.started", createdAt: now - 300 })
    const finished = event({ projectID, eventID: "finished-event", eventType: "delegation.finished", createdAt: now - 200 })
    const failed = event({ projectID, eventID: "failed-event", eventType: "delegation.failed", createdAt: now - 100 })

    append(started)
    append(finished)
    append(failed)

    expect(ModelTelemetry.compact({ projectID, before: now, now })).toEqual({
      deleted: 2,
      tombstoned: 2,
      prunedTombstones: 0,
    })
    expect(read(projectID, 10).map((item) => item.eventID)).toEqual([started.eventID])
    expect(append(finished)).toMatchObject({ status: "duplicate", tombstoned: true })
    expect(append(failed)).toMatchObject({ status: "duplicate", tombstoned: true })

    expect(
      ModelTelemetry.compact({
        projectID,
        before: now + 100,
        tombstoneBefore: now + 1,
        now: now + 10,
      }),
    ).toMatchObject({ deleted: 0, tombstoned: 0, prunedTombstones: 2 })
    expect(append(finished)).toMatchObject({ status: "inserted" })
    expect(append(failed)).toMatchObject({ status: "inserted" })
  })

  test("skips corrupted rows while continuing a bounded read", () => {
    const projectID = project()
    const base = 4_000_000

    append(event({ projectID, eventID: "corrupt-new", createdAt: base + 4 }))
    append(event({ projectID, eventID: "valid-new", createdAt: base + 3 }))
    append(event({ projectID, eventID: "valid-middle", createdAt: base + 2 }))
    append(event({ projectID, eventID: "valid-old", createdAt: base + 1 }))

    Database.use((db) =>
      db
        .update(ModelTelemetryEventTable)
        .set({ content_checksum: "0".repeat(64) })
        .where(and(eq(ModelTelemetryEventTable.project_id, projectID), eq(ModelTelemetryEventTable.event_id, "corrupt-new")))
        .run(),
    )

    expect(read(projectID, 2).map((item) => item.eventID)).toEqual(["valid-new", "valid-middle"])
    expect(read(projectID, 100).map((item) => item.eventID)).toEqual(["valid-new", "valid-middle", "valid-old"])
  })

  test("wraps a real foreign-key storage failure in a typed error", () => {
    const missingProjectID = ProjectID.make(`telemetry-missing-${randomUUID()}`)
    const error = expectStorageError(() => append(event({ projectID: missingProjectID, eventID: "missing-project" })))
    expect(error.operation).toBe("append")
  })
  test("normalizes shadow helper inputs into privacy-bounded schema-valid events", async () => {
    const projectID = project()
    const rawRoute = "invalid route / private-token"
    const rawIdentity = "identity with private token"
    const rawVariant = "variant with whitespace"
    const rawWorkload = "workload with whitespace"
    const action = ModelTelemetry.actionForRoute({
      route: rawRoute,
      identity: rawIdentity,
      variant: rawVariant,
      selectionSource: "invalid",
      resolutionSource: "invalid",
    } as unknown as Telemetry.ActionInput)
    const decision = ModelTelemetry.createShadowDecision({
      projectID,
      workload: rawWorkload,
      action,
      candidates: [
        {
          action: {
            route: rawRoute,
            identity: rawIdentity,
            variant: rawVariant,
            selectionSource: "invalid",
          },
          propensity: Number.POSITIVE_INFINITY,
          eligible: false,
          filterReason: "invalid",
        },
      ],
      fanout: {
        fanoutID: "fanout with whitespace",
        size: Number.POSITIVE_INFINITY,
        concurrency: 0,
        templateKind: "invalid",
      },
    } as unknown as Telemetry.ShadowDecisionInput)

    await ModelTelemetry.recordShadowDecision(decision)
    await ModelTelemetry.drainBestEffort()
    const stored = read(projectID, 10).find((item) => item.eventID === decision.eventID)
    expect(stored?.action).toMatchObject({
      route: expect.stringMatching(/^shadow\/[a-f0-9]{32}$/),
      identity: expect.stringMatching(/^identity-[a-f0-9]{32}$/),
      variant: expect.stringMatching(/^variant-[a-f0-9]{32}$/),
      selectionSource: "explicit",
    })
    expect(stored?.workload).toMatch(/^workload-[a-f0-9]{32}$/)
    expect(stored?.fanout).toMatchObject({
      fanoutID: expect.stringMatching(/^fanout-[a-f0-9]{32}$/),
      size: 1,
      concurrency: 1,
      templateKind: "delegation",
    })
    expect(stored?.policy).toMatchObject({
      candidateCount: 1,
      candidates: [
        {
          propensity: 0,
          eligible: false,
          filterReason: "policy",
        },
      ],
    })
    const serialized = JSON.stringify(stored)
    for (const value of [rawRoute, rawIdentity, rawVariant, rawWorkload]) {
      expect(serialized).not.toContain(value)
    }
  })

  test("caps best-effort queue admission without blocking valid retained events", async () => {
    const projectID = project()
    await ModelTelemetry.drainBestEffort()
    const pending = Array.from({ length: Telemetry.BEST_EFFORT_QUEUE_LIMIT + 4 }, (_, index) =>
      ModelTelemetry.appendBestEffort(event({ projectID, eventID: `queue-cap-${index}` })),
    )
    await Promise.all(pending)
    await ModelTelemetry.drainBestEffort()
    expect(read(projectID, 1_000)).toHaveLength(Telemetry.BEST_EFFORT_QUEUE_LIMIT)
  })

  test("retains an unlinked fanout lifecycle when its shared decision cannot be appended", async () => {
    const projectID = project()
    const fanout = {
      fanoutID: ModelTelemetry.createFanoutID(),
      size: 1,
      concurrency: 1,
      templateKind: "swarm" as const,
    }
    const decision = ModelTelemetry.createShadowDecision({
      projectID,
      workload: "builder",
      action: ModelTelemetry.actionForRoute({
        route: "openai/gpt-5.6-luna",
        identity: "gpt-5.6-luna",
        selectionSource: "scheduler",
      }),
      fanout,
    })
    append(
      event({
        projectID,
        eventID: decision.eventID,
        eventType: "decision.recorded",
        overrides: { decisionID: "conflicting-decision" },
      }),
    )
    const delegation = ModelTelemetry.createShadowDelegation(decision, {
      fanout: { ...fanout, itemIndex: 0 },
    })

    await Promise.all([
      ModelTelemetry.recordShadowDecision(decision),
      ModelTelemetry.recordShadowLifecycle(delegation, "delegation.started"),
    ])
    await ModelTelemetry.drainBestEffort()
    const stored = read(projectID, 10).find((item) => item.eventID === `${delegation.delegationID}:delegation.started`)
    expect(stored).toMatchObject({
      decisionID: decision.decisionID,
      delegationID: delegation.delegationID,
      eventType: "delegation.started",
    })
    expect(stored?.fanout).toBeUndefined()
  })

  function shadowFixture(projectID: ProjectID, episodeID?: string) {
    const decision = ModelTelemetry.createShadowDecision({
      projectID,
      workload: "builder",
      episodeID,
      action: ModelTelemetry.actionForRoute({
        route: "openai/gpt-5.6-luna",
        identity: "gpt-5.6-luna",
        selectionSource: "scheduler",
      }),
    })
    return ModelTelemetry.createShadowDelegation(decision, { parentDelegationID: "parent-delegation" })
  }

  function session(projectID: ProjectID) {
    const id = SessionID.make(`ses_${randomUUID()}`)
    const now = Date.now()
    Database.use((db) =>
      db.insert(SessionTable).values({
        id,
        project_id: projectID,
        slug: id,
        directory: `/${id}`,
        title: "telemetry test",
        version: "1",
        time_created: now,
        time_updated: now,
      }).run(),
    )
    return id
  }

  test("durably binds new and resumed attempts with immutable terminal state", async () => {
    const projectID = project()
    const sessionID = session(projectID)
    const first = ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    const resumed = ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID, "different-episode"), sessionID })
    expect(first.attemptIndex).toBe(0)
    expect(resumed.attemptIndex).toBe(1)
    expect(resumed.episodeID).toBe(first.episodeID)
    expect(ModelTelemetry.getShadowSessionLineage({ projectID, sessionID })).toEqual({
      episodeID: first.episodeID,
      parentDelegationID: resumed.delegationID,
    })

    await ModelTelemetry.recordShadowLifecycle(first, "delegation.finished", { status: "completed" })
    await ModelTelemetry.drainBestEffort()
    await expect(Promise.resolve(ModelTelemetry.recordShadowLifecycle(first, "delegation.finished"))).resolves.toBeUndefined()
    await expect(Promise.resolve(ModelTelemetry.recordShadowLifecycle(first, "delegation.failed"))).resolves.toBeUndefined()
    await ModelTelemetry.drainBestEffort()
    const rows = Database.use((db) => db.select().from(ModelTelemetryDelegationTable).where(eq(ModelTelemetryDelegationTable.project_id, projectID)).all())
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.delegation_id === first.delegationID)?.terminal_event_type).toBe("delegation.finished")
  })

  test("links an oracle only for exact unambiguous attribution and stores no payload", async () => {
    const projectID = project()
    const sessionID = session(projectID)
    const delegation = ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    await ModelTelemetry.recordShadowOracle({
      projectID,
      sessionID,
      oracleID: "oracle-late",
      verificationKind: "test",
      status: "pass",
      trusted: true,
      occurredAt: 123,
    })
    await ModelTelemetry.drainBestEffort()
    await ModelTelemetry.recordShadowOracle({
      projectID,
      sessionID,
      oracleID: "oracle-late",
      verificationKind: "test",
      status: "pass",
      trusted: true,
      occurredAt: 456,
    })
    await ModelTelemetry.drainBestEffort()
    const links = Database.use((db) => db.select().from(ModelTelemetryOracleLinkTable).where(eq(ModelTelemetryOracleLinkTable.project_id, projectID)).all())
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ oracle_key: expect.stringMatching(/^oracle-[a-f0-9]{64}$/), delegation_id: delegation.delegationID, attempt_index: 0 })
    expect(JSON.stringify(links[0])).not.toContain("oracle-late")
    expect(JSON.stringify(links[0])).not.toContain("payload")
    const events = read(projectID, 20).filter((item) => item.eventType === "verification.recorded")
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({ verification: { kind: "test", status: "pass", linked: true } }))
    expect(JSON.stringify(events[0])).not.toContain("oracle-late")
  })

  test("does not link an unbound oracle", async () => {
    const projectID = project()
    const sessionID = session(projectID)
    await ModelTelemetry.recordShadowOracle({
      projectID,
      sessionID,
      oracleID: "oracle-unbound",
      verificationKind: "lsp",
      status: "unknown",
      trusted: false,
    })
    await ModelTelemetry.drainBestEffort()
    expect(Database.use((db) => db.select().from(ModelTelemetryOracleLinkTable).where(eq(ModelTelemetryOracleLinkTable.project_id, projectID)).all())).toEqual([])
    expect(Database.use((db) => db.select().from(ModelTelemetrySessionBindingTable).where(eq(ModelTelemetrySessionBindingTable.project_id, projectID)).all())).toEqual([])
    expect(delegationFixtureMarker(projectID)).toBe(projectID)
  })

  function lifecycleFor(delegation: Telemetry.ShadowDelegation, eventType: TelemetryEvent["eventType"], extra?: Record<string, unknown>): TelemetryEvent {
    return event({
      projectID: delegation.projectID,
      eventType,
      overrides: {
        eventID: `${delegation.delegationID}:${eventType}`,
        episodeID: delegation.episodeID,
        decisionID: delegation.decisionID,
        delegationID: delegation.delegationID,
        ...(delegation.parentDelegationID ? { parentDelegationID: delegation.parentDelegationID } : {}),
        ...(delegation.attemptIndex === undefined ? {} : { attemptIndex: delegation.attemptIndex }),
        workload: delegation.workload,
        action: delegation.action,
        ...(delegation.fanout ? { fanout: delegation.fanout } : {}),
        ...extra,
      },
    })
  }

  test("preserves shared fan-out metadata on bound delegation lifecycle", async () => {
    const projectID = project()
    const sessionID = session(projectID)
    const fanout = { fanoutID: ModelTelemetry.createFanoutID(), size: 2, concurrency: 1, templateKind: "swarm" as const }
    const decision = ModelTelemetry.createShadowDecision({
      projectID,
      workload: "builder",
      action: ModelTelemetry.actionForRoute({ route: "openai/gpt-5.6-luna", identity: "gpt-5.6-luna", selectionSource: "scheduler" }),
      fanout,
    })
    await ModelTelemetry.recordShadowDecision(decision)
    const bound = ModelTelemetry.bindShadowDelegation({
      delegation: ModelTelemetry.createShadowDelegation(decision, { fanout: { ...fanout, itemIndex: 0 } }),
      sessionID,
    })
    await ModelTelemetry.recordShadowLifecycle(bound, "delegation.started")
    await ModelTelemetry.drainBestEffort()
    const stored = read(projectID, 20).find((item) => item.eventID === `${bound.delegationID}:delegation.started`)
    expect(stored?.decisionID).toBe(decision.decisionID)
    expect(stored?.fanout).toMatchObject({ fanoutID: fanout.fanoutID, itemIndex: 0, size: 2 })
  })

  test("enforces strict immutable terminal identity", () => {
    const projectID = project()
    const sessionID = session(projectID)
    const delegation = ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    const finished = lifecycleFor(delegation, "delegation.finished")
    expect(append(finished)).toMatchObject({ status: "inserted" })
    expect(append(finished)).toMatchObject({ status: "duplicate", tombstoned: false })
    const conflicting = lifecycleFor(delegation, "delegation.finished", { eventID: `${delegation.delegationID}:delegation.finished:other` })
    expect(thrown(() => append(conflicting))).toBeInstanceOf(Telemetry.TelemetryTerminalConflictError)
    expect(thrown(() => append(lifecycleFor(delegation, "delegation.failed")))).toBeInstanceOf(Telemetry.TelemetryTerminalConflictError)
    expect(thrown(() => append(lifecycleFor(delegation, "delegation.started")))).toBeInstanceOf(Telemetry.TelemetryTerminalConflictError)
  })

  test("rejects lifecycle events whose immutable identity drifts from the ledger", () => {
    const projectID = project()
    const sessionID = session(projectID)
    const delegation = ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    expectValidationError(() => append({ ...lifecycleFor(delegation, "delegation.started"), workload: "reviewer" }), "invalid-event")
  })

  test("derives stable project-scoped opaque oracle keys and fails closed across projects", async () => {
    const projectID = project()
    const otherProjectID = project()
    const sessionID = session(projectID)
    ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    await ModelTelemetry.recordShadowOracle({ projectID, sessionID, oracleID: "oracle-key-test", verificationKind: "test", status: "pass", trusted: true })
    await ModelTelemetry.drainBestEffort()
    const links = Database.use((db) => db.select().from(ModelTelemetryOracleLinkTable).where(eq(ModelTelemetryOracleLinkTable.project_id, projectID)).all())
    expect(links).toHaveLength(1)
    expect(links[0]!.oracle_key).toMatch(/^oracle-[a-f0-9]{64}$/)
    expect(JSON.stringify(links[0])).not.toContain("oracle-key-test")
    await ModelTelemetry.recordShadowOracle({ projectID: otherProjectID, sessionID, oracleID: "oracle-key-test", verificationKind: "test", status: "pass", trusted: true })
    await ModelTelemetry.drainBestEffort()
    expect(Database.use((db) => db.select().from(ModelTelemetryOracleLinkTable).where(eq(ModelTelemetryOracleLinkTable.project_id, otherProjectID)).all())).toEqual([])
  })

  test("does not link an oracle when the session has multiple delegations", async () => {
    const projectID = project()
    const sessionID = session(projectID)
    ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    await ModelTelemetry.recordShadowOracle({ projectID, sessionID, oracleID: "oracle-ambiguous", verificationKind: "test", status: "pass", trusted: true })
    await ModelTelemetry.drainBestEffort()
    expect(Database.use((db) => db.select().from(ModelTelemetryOracleLinkTable).where(eq(ModelTelemetryOracleLinkTable.project_id, projectID)).all())).toEqual([])
  })

  test("preserves execution ttftMs through schema decode and append/read round-trip", async () => {
    const projectID = project()
    const input = event({
      projectID,
      eventID: `ttft-${randomUUID()}`,
      overrides: {
        execution: { status: "completed", durationMs: 5_000, ttftMs: 1_240 },
      },
    })
    const decoded = Schema.decodeUnknownSync(Event)(input, { onExcessProperty: "error" })
    expect(decoded.execution?.ttftMs).toBe(1_240)

    await append(input)
    const persisted = read(projectID, 10).find((item) => item.eventID === input.eventID)
    expect(persisted?.execution).toMatchObject({ status: "completed", durationMs: 5_000, ttftMs: 1_240 })
  })

  test("rejects negative or non-finite execution ttftMs on append", () => {
    const projectID = project()
    expectValidationError(
      () => append(event({ projectID, overrides: { execution: { status: "completed", durationMs: 10, ttftMs: -1 } } })),
      "invalid-event",
    )
    expectValidationError(
      () => append(event({ projectID, overrides: { execution: { status: "completed", durationMs: 10, ttftMs: 1 / 0 } } })),
      "invalid-event",
    )
  })

  test("round-trips usage through shadow lifecycle recording", async () => {
    const projectID = project()
    const sessionID = session(projectID)
    const delegation = ModelTelemetry.bindShadowDelegation({ delegation: shadowFixture(projectID), sessionID })
    const usage: Telemetry.Usage = { input: 123, output: 45, reasoning: 6, cacheRead: 7, cacheWrite: 8 }
    await ModelTelemetry.recordShadowLifecycle(
      delegation,
      "delegation.finished",
      { status: "completed", durationMs: 100, ttftMs: 30 },
      usage,
    )
    await ModelTelemetry.drainBestEffort()
    const stored = read(projectID, 10).find((item) => item.eventID === `${delegation.delegationID}:delegation.finished`)
    expect(stored?.execution).toMatchObject({ status: "completed", durationMs: 100, ttftMs: 30 })
    expect(stored?.usage).toEqual(usage)
  })

  function delegationFixtureMarker(projectID: ProjectID) {
    return projectID
  }
})
