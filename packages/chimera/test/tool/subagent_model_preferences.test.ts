import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Result, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { ProjectID } from "@/project/schema"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import {
  DESCRIPTION as PREFER_DESCRIPTION,
  Parameters as PreferParameters,
  SubagentModelPreferTool,
} from "@/tool/subagent_model_prefer"
import {
  DESCRIPTION as SUPPRESS_DESCRIPTION,
  Parameters as SuppressParameters,
  SubagentModelSuppressTool,
} from "@/tool/subagent_model_suppress"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const PROVIDER = ProviderID.make("relay")
const MODEL_ID = ModelID.make("deployment")
const IDENTITY = "identity-a"
const MODEL = `${PROVIDER}/${MODEL_ID}`
const PROJECT = ProjectID.make("phase-4-preference-project")
const SESSION = SessionID.make("ses_preference_root")
const CHILD = SessionID.make("ses_preference_parent")

const liveModel = ProviderTest.model({
  id: MODEL_ID,
  providerID: PROVIDER,
  api: { id: ModelID.make(IDENTITY), url: "https://secret-route.example", npm: "secret-provider-package" },
  headers: { authorization: "Bearer secret-model-header" },
  options: { apiKey: "secret-model-option" },
})

const liveProvider = ProviderTest.info(
  {
    id: PROVIDER,
    key: "secret-provider-key",
    env: ["SECRET_PROVIDER_ENV"],
    options: { apiKey: "secret-provider-option", baseURL: "https://secret-provider.example" },
    models: { [MODEL_ID]: liveModel },
  },
  liveModel,
)

const valid = {
  scope: "project" as const,
  target: "route" as const,
  provider: String(PROVIDER),
  model_identity: IDENTITY,
  model: MODEL,
}

type MutationCall = {
  mutation: "prefer" | "suppress"
  scope: ConfigSubagentRouting.Scope
  target: ConfigSubagentRouting.Target
}

type Ask = Omit<Permission.Request, "id" | "sessionID" | "tool">

function suppressedState(): ConfigSubagentRouting.State {
  const state = ConfigSubagentRouting.empty()
  return {
    ...state,
    revision: 1,
    global: {
      ...state.global,
      routes: { [IDENTITY]: { [MODEL]: { suppressedRevision: 1 } } },
    },
  }
}

function harness(
  options: {
    agentMode?: Agent.Info["mode"]
    parentID?: SessionID
    projectID?: ProjectID
    sessionPermission?: Permission.Ruleset
    state?: ConfigSubagentRouting.State
  } = {},
) {
  const events: string[] = []
  const asks: Ask[] = []
  const mutations: MutationCall[] = []
  const calls = { providerList: 0 }
  const state = options.state ?? ConfigSubagentRouting.empty()
  const agent: Agent.Info = {
    name: "build",
    mode: options.agentMode ?? "primary",
    options: {},
    permission: [],
  }
  const sessionInfo = {
    id: SESSION,
    projectID: options.projectID ?? PROJECT,
    directory: "/tmp",
    parentID: options.parentID,
    permission: options.sessionPermission,
  } as unknown as Session.Info
  const routing = Layer.succeed(
    ConfigSubagentRouting.Service,
    ConfigSubagentRouting.Service.of({
      get: () => Effect.succeed(state),
      prefer: (input) =>
        Effect.sync(() => {
          events.push("mutation:prefer")
          mutations.push({ mutation: "prefer", ...input })
          return state
        }),
      suppress: (input) =>
        Effect.sync(() => {
          events.push("mutation:suppress")
          mutations.push({ mutation: "suppress", ...input })
          return state
        }),
      recordDelegation: () => Effect.die(new Error("unexpected delegation activity")),
    }),
  )
  const provider = ProviderTest.fake({
    info: liveProvider,
    list: () =>
      Effect.sync(() => {
        calls.providerList += 1
        return { [PROVIDER]: liveProvider }
      }),
  }).layer
  const agents = Layer.mock(Agent.Service)({
    get: () => Effect.succeed(agent),
  })
  const sessions = Layer.mock(Session.Service)({
    get: () => Effect.succeed(sessionInfo),
  })

  return {
    events,
    asks,
    mutations,
    calls,
    layer: Layer.mergeAll(provider, routing, agents, sessions, TestConfig.layer(), Truncate.defaultLayer),
    context(deny?: string): Tool.Context {
      return {
        sessionID: SESSION,
        messageID: MessageID.make("msg_preference"),
        callID: "call_preference",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (request) =>
          Effect.gen(function* () {
            events.push(`ask:${request.permission}`)
            asks.push(request)
            if (request.permission === deny) return yield* Effect.die(new Error(`${deny} denied`))
          }),
      }
    },
  }
}

function errorText(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
}

const routeHarness = harness()
const routeIt = testEffect(routeHarness.layer)
const providerHarness = harness()
const providerIt = testEffect(providerHarness.layer)
const dedicatedDenyHarness = harness()
const dedicatedDenyIt = testEffect(dedicatedDenyHarness.layer)
const modelDenyHarness = harness()
const modelDenyIt = testEffect(modelDenyHarness.layer)
const validationHarness = harness()
const validationIt = testEffect(validationHarness.layer)
const hiddenHarness = harness({
  sessionPermission: [{ permission: "task_model", pattern: `${PROVIDER}/*`, action: "deny" }],
})
const hiddenIt = testEffect(hiddenHarness.layer)
const suppressedHarness = harness({ state: suppressedState() })
const suppressedIt = testEffect(suppressedHarness.layer)
const childHarness = harness({ parentID: CHILD })
const childIt = testEffect(childHarness.layer)
const subagentHarness = harness({ agentMode: "subagent" })
const subagentIt = testEffect(subagentHarness.layer)
const globalProjectHarness = harness({ projectID: ProjectID.global })
const globalProjectIt = testEffect(globalProjectHarness.layer)

function reset(input: ReturnType<typeof harness>) {
  input.events.length = 0
  input.asks.length = 0
  input.mutations.length = 0
  input.calls.providerList = 0
}

describe("subagent model preference schemas and descriptions", () => {
  test("both tools expose the same concise required schema", () => {
    expect(PreferParameters).toBe(SuppressParameters)
    expect(Object.keys(PreferParameters.fields).sort()).toEqual([
      "model",
      "model_identity",
      "provider",
      "scope",
      "target",
    ])
    expect(Schema.decodeUnknownSync(PreferParameters)(valid)).toEqual(valid)
    for (const field of Object.keys(valid)) {
      const input = { ...valid }
      delete input[field as keyof typeof input]
      expect(Result.isFailure(Schema.decodeUnknownResult(PreferParameters)(input))).toBe(true)
    }
    expect(Result.isFailure(Schema.decodeUnknownResult(PreferParameters)({ ...valid, scope: "session" }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(PreferParameters)({ ...valid, target: "identity" }))).toBe(true)
  })

  test("descriptions require explicit future preference or hide instructions", () => {
    expect(PREFER_DESCRIPTION).toContain("ONLY")
    expect(PREFER_DESCRIPTION).toContain("explicitly")
    expect(PREFER_DESCRIPTION).toContain("restoring")
    expect(PREFER_DESCRIPTION).toContain("Ordinary task success")
    expect(PREFER_DESCRIPTION).toContain("task_model allow/reject/once/always")
    expect(SUPPRESS_DESCRIPTION).toContain("ONLY")
    expect(SUPPRESS_DESCRIPTION).toContain("future")
    expect(SUPPRESS_DESCRIPTION).toContain("one task_model rejection")
    expect(SUPPRESS_DESCRIPTION).toContain("subagent_model_prefer")
    for (const description of [PREFER_DESCRIPTION, SUPPRESS_DESCRIPTION]) {
      expect(description).toContain("root-session-only")
      expect(description).toContain("current visible live Provider catalog")
      expect(description).toContain("never")
      expect(description).not.toMatch(/\b(openai|anthropic|azure|deepseek|kimi)\b/i)
    }
  })
})

describe("subagent model preference mutations", () => {
  routeIt.live("validates, asks in order, and prefers one project route", () =>
    Effect.gen(function* () {
      reset(routeHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute(valid, routeHarness.context())
      expect(routeHarness.calls.providerList).toBe(1)

      expect(routeHarness.events).toEqual([
        "ask:subagent_model_prefer",
        "ask:task_model",
        "mutation:prefer",
      ])
      expect(routeHarness.asks[0]).toMatchObject({
        permission: "subagent_model_prefer",
        patterns: [`project:route:${MODEL}`],
      })
      expect(routeHarness.asks[1]).toEqual({
        permission: "task_model",
        patterns: [MODEL],
        always: [MODEL],
        metadata: { model: MODEL },
      })
      expect(routeHarness.mutations).toEqual([
        {
          mutation: "prefer",
          scope: { type: "project", projectID: PROJECT },
          target: { type: "route", identity: IDENTITY, providerID: PROVIDER, model: MODEL },
        },
      ])
      expect(result.output).toContain(`route ${MODEL}`)
      expect(JSON.stringify({ result, asks: routeHarness.asks, mutations: routeHarness.mutations })).not.toMatch(
        /secret-provider-key|secret-provider-option|secret-model-header|secret-model-option|secret-route\.example/,
      )
    }),
  )

  providerIt.live("suppresses one provider globally after both authorizations", () =>
    Effect.gen(function* () {
      reset(providerHarness)
      const info = yield* SubagentModelSuppressTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute(
        { ...valid, scope: "global", target: "provider" },
        providerHarness.context(),
      )

      expect(providerHarness.events).toEqual([
        "ask:subagent_model_suppress",
        "ask:task_model",
        "mutation:suppress",
      ])
      expect(providerHarness.calls.providerList).toBe(1)
      expect(providerHarness.asks[1]).toEqual({
        permission: "task_model",
        patterns: [MODEL],
        always: [MODEL],
        metadata: { model: MODEL },
      })
      expect(providerHarness.mutations).toEqual([
        {
          mutation: "suppress",
          scope: { type: "global" },
          target: { type: "provider", providerID: PROVIDER },
        },
      ])
      expect(result.output).toContain(`provider ${PROVIDER}`)
      expect(result.output).toContain("globally")
    }),
  )

  dedicatedDenyIt.live("dedicated permission denial happens before task_model and leaves state untouched", () =>
    Effect.gen(function* () {
      reset(dedicatedDenyHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      const exit = yield* def
        .execute(valid, dedicatedDenyHarness.context("subagent_model_prefer"))
        .pipe(Effect.exit)

      expect(errorText(exit)).toContain("subagent_model_prefer denied")
      expect(dedicatedDenyHarness.events).toEqual(["ask:subagent_model_prefer"])
      expect(dedicatedDenyHarness.mutations).toEqual([])
    }),
  )

  modelDenyIt.live("task_model denial happens after dedicated permission and leaves state untouched", () =>
    Effect.gen(function* () {
      reset(modelDenyHarness)
      const info = yield* SubagentModelSuppressTool
      const def = yield* Tool.init(info)
      const exit = yield* def.execute(valid, modelDenyHarness.context("task_model")).pipe(Effect.exit)

      expect(errorText(exit)).toContain("task_model denied")
      expect(modelDenyHarness.events).toEqual(["ask:subagent_model_suppress", "ask:task_model"])
      expect(modelDenyHarness.mutations).toEqual([])
    }),
  )

  validationIt.live("rejects provider, identity, and model disagreement before asking", () =>
    Effect.gen(function* () {
      reset(validationHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      for (const params of [
        { ...valid, provider: "other" },
        { ...valid, model_identity: "other-identity" },
        { ...valid, model: "relay/other-deployment" },
      ]) {
        const exit = yield* def.execute(params, validationHarness.context()).pipe(Effect.exit)
        expect(errorText(exit)).toContain("No visible current route exactly matches")
      }
      expect(validationHarness.events).toEqual([])
      expect(validationHarness.mutations).toEqual([])
    }),
  )

  hiddenIt.live("effective session task_model deny hides the route before dedicated authorization", () =>
    Effect.gen(function* () {
      reset(hiddenHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      const exit = yield* def.execute(valid, hiddenHarness.context()).pipe(Effect.exit)

      expect(errorText(exit)).toContain("No visible current route exactly matches")
      expect(hiddenHarness.events).toEqual([])
      expect(hiddenHarness.mutations).toEqual([])
    }),
  )

  suppressedIt.live("explicit provider-narrowed prefer reaches a currently suppressed route for restoration", () =>
    Effect.gen(function* () {
      reset(suppressedHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      yield* def.execute({ ...valid, scope: "global" }, suppressedHarness.context())

      expect(suppressedHarness.events).toEqual([
        "ask:subagent_model_prefer",
        "ask:task_model",
        "mutation:prefer",
      ])
      expect(suppressedHarness.mutations[0]?.target).toEqual({
        type: "route",
        identity: IDENTITY,
        providerID: PROVIDER,
        model: MODEL,
      })
    }),
  )
})

describe("subagent model preference root-session guards", () => {
  childIt.live("rejects child sessions before asking or mutating", () =>
    Effect.gen(function* () {
      reset(childHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      const exit = yield* def.execute(valid, childHarness.context()).pipe(Effect.exit)

      expect(errorText(exit)).toContain("unavailable in child sessions")
      expect(childHarness.events).toEqual([])
      expect(childHarness.mutations).toEqual([])
      expect(childHarness.calls.providerList).toBe(0)
    }),
  )

  subagentIt.live("rejects subagent-mode agents before asking or mutating", () =>
    Effect.gen(function* () {
      reset(subagentHarness)
      const info = yield* SubagentModelSuppressTool
      const def = yield* Tool.init(info)
      const exit = yield* def.execute(valid, subagentHarness.context()).pipe(Effect.exit)

      expect(errorText(exit)).toContain("root sessions using a primary-capable agent")
      expect(subagentHarness.events).toEqual([])
      expect(subagentHarness.mutations).toEqual([])
      expect(subagentHarness.calls.providerList).toBe(0)
    }),
  )

  globalProjectIt.live("rejects global project ID masquerading as project scope", () =>
    Effect.gen(function* () {
      reset(globalProjectHarness)
      const info = yield* SubagentModelPreferTool
      const def = yield* Tool.init(info)
      const exit = yield* def.execute(valid, globalProjectHarness.context()).pipe(Effect.exit)

      expect(errorText(exit)).toContain("project scope cannot use the global project ID")
      expect(globalProjectHarness.events).toEqual([])
      expect(globalProjectHarness.mutations).toEqual([])
      expect(globalProjectHarness.calls.providerList).toBe(0)
    }),
  )
})
