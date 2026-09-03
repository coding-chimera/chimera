import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { CAPABILITY_PRIOR_VERSION } from "../../src/agent/subagent-capability-prior"
import type { ModelPricing } from "../../src/agent/subagent-model-pricing"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { ConfigSubagentRouting } from "../../src/config/subagent-routing"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { ProjectID } from "../../src/project/schema"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  DESCRIPTION,
  Parameters,
  SubagentModelScheduleTool,
} from "../../src/tool/subagent_model_schedule"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("subscription")
const modelID = ModelID.make("gpt-5.6-sol")
const model = ProviderTest.model({
  providerID,
  id: modelID,
  variants: { low: {}, medium: {}, max: {} },
})
const provider = ProviderTest.info({ id: providerID, models: { [modelID]: model } }, model)

function fakeAgent(permission: Permission.Ruleset = []) {
  return Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      get: (name) => Effect.succeed({ name, mode: "primary", options: {}, permission }),
      list: () => Effect.succeed([]),
      defaultAgent: () => Effect.succeed("build"),
      generate: () => Effect.die(new Error("not implemented")),
    }),
  )
}

function fakeSession(permission: Permission.Ruleset = []) {
  const info = {
    id: SessionID.make("ses_schedule"),
    directory: "/tmp",
    projectID: ProjectID.global,
    permission,
  } as unknown as Session.Info
  return Layer.succeed(
    Session.Service,
    Session.Service.of({
      list: () => Effect.succeed([]),
      create: () => Effect.die(new Error("unused")),
      fork: () => Effect.die(new Error("unused")),
      touch: () => Effect.void,
      get: () => Effect.succeed(info),
      setTitle: () => Effect.void,
      setArchived: () => Effect.void,
      setPermission: () => Effect.void,
      updatePermissionSlots: () => Effect.void,
      setRevert: () => Effect.void,
      clearRevert: () => Effect.void,
      recordUsage: () => Effect.void,
      setSummary: () => Effect.void,
      diff: () => Effect.succeed([]),
      messages: () => Effect.succeed([]),
      children: () => Effect.succeed([]),
      remove: () => Effect.void,
      updateMessage: <T extends MessageV2.Info>(message: T) => Effect.succeed(message),
      removeMessage: () => Effect.die(new Error("unused")),
      removePart: () => Effect.die(new Error("unused")),
      getPart: () => Effect.succeed(undefined),
      updatePart: <T extends MessageV2.Part>(part: T) => Effect.succeed(part),
      updatePartDelta: () => Effect.void,
      findMessage: () => Effect.succeed(Option.none()),
      remoteCompactionLock: () => Effect.succeed(undefined),
    }),
  )
}

const routingLayer = Layer.succeed(
  ConfigSubagentRouting.Service,
  ConfigSubagentRouting.Service.of({
    get: () => Effect.succeed(ConfigSubagentRouting.empty()),
    prefer: () => Effect.die(new Error("unexpected preference mutation")),
    suppress: () => Effect.die(new Error("unexpected suppression mutation")),
    recordDelegation: () => Effect.die(new Error("unexpected activity mutation")),
  }),
)

function authLayer(type: "oauth" | "api" = "oauth") {
  return Layer.mock(Auth.Service)({
    get: () => Effect.succeed(undefined),
    all: () =>
      Effect.succeed({
        [providerID]:
          type === "oauth"
            ? {
                type: "oauth" as const,
                refresh: "refresh",
                access: "access",
                expires: Date.now() + 60_000,
              }
            : { type: "api" as const, key: "test-key" },
      }),
    set: () => Effect.void,
    remove: () => Effect.void,
  })
}

function toolLayer(input?: {
  schedulingEnabled?: boolean
  permission?: Permission.Ruleset
  authType?: "oauth" | "api"
  cost?: ModelPricing
  billing?: "free"
}) {
  const currentModel = ProviderTest.model({ ...model, cost: input?.cost ?? model.cost })
  return Layer.mergeAll(
    ProviderTest.fake({
      model: currentModel,
      info: ProviderTest.info({ id: providerID, models: { [modelID]: currentModel } }, currentModel),
    }).layer,
    TestConfig.layer({
      get: () =>
        Effect.succeed({
          delegation: {
            scheduling: {
              enabled: input?.schedulingEnabled,
              archetypes: {
                triage: {
                  description: "Fast custom triage.",
                  minQuality: 0.4,
                  effortCap: "low",
                  weights: { quality: 0.2, speed: 0.6, cost: 0.2 },
                },
              },
              overrides: input?.billing
                ? { [`${providerID}/${modelID}`]: { billing: input.billing } }
                : undefined,
            },
          },
        }),
    }),
    routingLayer,
    authLayer(input?.authType),
    fakeAgent(input?.permission),
    fakeSession(),
    Truncate.defaultLayer,
  )
}

const it = testEffect(toolLayer())
const deniedIt = testEffect(
  toolLayer({ permission: [{ permission: "task_model", pattern: "subscription/*", action: "deny" }] }),
)
const disabledIt = testEffect(toolLayer({ schedulingEnabled: false }))
const positiveMeteredIt = testEffect(
  toolLayer({
    authType: "api",
    cost: { input: 1, output: 2, cache: { read: 0.5, write: 1 } },
  }),
)
const unknownMeteredIt = testEffect(toolLayer({ authType: "api" }))
const freeIt = testEffect(toolLayer({ authType: "api", billing: "free" }))

function context(asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>) {
  return {
    sessionID: SessionID.make("ses_schedule"),
    messageID: MessageID.make("msg_schedule"),
    callID: "call_schedule",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
      Effect.sync(() => {
        asks.push(request)
      }),
  } satisfies Tool.Context
}

describe("subagent_model_schedule description and schema", () => {
  test("describes a read-only current recommendation surface", () => {
    expect(DESCRIPTION).toContain("read-only")
    expect(DESCRIPTION).toContain("live permission-filtered provider catalog")
    expect(DESCRIPTION).toContain("DeepSWE")
    expect(DESCRIPTION).toContain("does not create child sessions")
  })

  test("keeps the schema limited to workload and result limit", () => {
    expect(Object.keys(Parameters.fields).sort()).toEqual(["limit", "workload"])
  })
})

describe("subagent_model_schedule tool", () => {
  it.live("returns all current workloads without requesting authorization", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const result = yield* def.execute({}, context(asks))
      const output = JSON.parse(result.output)

      expect(asks).toEqual([])
      expect(result.title).toBe("subagent_model_schedule")
      expect(output.priorVersion).toBe(CAPABILITY_PRIOR_VERSION)
      expect(Object.keys(output.recommendations)).toEqual(["scout", "builder", "reviewer", "triage"])
      expect(output.recommendations.scout).toEqual([])
      expect(output.recommendations.builder[0]).toMatchObject({
        route: "subscription/gpt-5.6-sol",
        regime: "subscription",
        variant: "medium",
        unitCostUsd: 0,
        quota: { state: "no-data" },
      })
    }),
  )

  positiveMeteredIt.live("projects positive live Provider pricing for metered routes", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ workload: "builder" }, context([]))
      const output = JSON.parse(result.output)
      const recommendation = output.recommendations[0]

      expect(recommendation).toMatchObject({
        route: "subscription/gpt-5.6-sol",
        regime: "metered",
        unitCostSource: "provider-pricing",
      })
      expect(recommendation.quota).toBeUndefined()
      expect(recommendation.unitCostUsd).toBeCloseTo(0.132, 6)
    }),
  )

  unknownMeteredIt.live("keeps all-zero metered Provider pricing unknown", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ workload: "builder" }, context([]))
      const recommendation = JSON.parse(result.output).recommendations[0]

      expect(recommendation).toMatchObject({
        route: "subscription/gpt-5.6-sol",
        regime: "metered",
        unitCostSource: "metered",
        unitCostReason: "provider pricing has no positive price evidence",
      })
      expect(recommendation.unitCostUsd).toBeUndefined()
      expect(recommendation.rationale).toContain("cost unknown")
    }),
  )

  freeIt.live("reports explicit free billing without subscription quota semantics", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ workload: "builder" }, context([]))
      const recommendation = JSON.parse(result.output).recommendations[0]

      expect(recommendation).toMatchObject({
        route: "subscription/gpt-5.6-sol",
        regime: "free",
        unitCostUsd: 0,
        unitCostSource: "explicit-free",
      })
      expect(recommendation.quota).toBeUndefined()
    }),
  )

  it.live("narrows recommendations to one custom workload", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ workload: "triage", limit: 1 }, context([]))
      const output = JSON.parse(result.output)

      expect(result.title).toBe("subagent_model_schedule: triage")
      expect(output.workload).toBe("triage")
      expect(output.recommendations).toHaveLength(1)
      expect(output.recommendations[0]).toMatchObject({ route: "subscription/gpt-5.6-sol", variant: "low" })
    }),
  )

  deniedIt.live("filters denied task_model routes before ranking", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ workload: "builder" }, context([]))
      const output = JSON.parse(result.output)

      expect(output.recommendations).toEqual([])
      expect(result.output).not.toContain("subscription/gpt-5.6-sol")
    }),
  )

  it.live("rejects unknown workloads and invalid limits without asking", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const unknown = yield* def.execute({ workload: "unknown" }, context(asks)).pipe(Effect.exit)
      const invalidLimit = yield* def.execute({ limit: 6 }, context(asks)).pipe(Effect.exit)

      expect(asks).toEqual([])
      expect(String(unknown)).toContain("Valid workloads: scout, builder, reviewer, triage")
      expect(String(invalidLimit)).toContain("limit must be an integer between 1 and 5")
    }),
  )

  disabledIt.live("fails clearly when workload scheduling is disabled", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelScheduleTool
      const def = yield* Tool.init(info)
      const exit = yield* def.execute({}, context([])).pipe(Effect.exit)

      expect(String(exit)).toContain("Subagent workload scheduling is disabled")
    }),
  )
})
