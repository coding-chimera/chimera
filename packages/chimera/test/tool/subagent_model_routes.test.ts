import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SubagentModelCatalog } from "../../src/agent/subagent-model-catalog"
import {
  DESCRIPTION,
  Parameters,
  SubagentModelRoutesTool,
  queryRoutes,
} from "../../src/tool/subagent_model_routes"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

const OPENAI = ProviderID.make("openai")
const AZURE = ProviderID.make("azure")
const IDENTITY = "gpt-5.2"

function model(id: string, extra: Partial<Provider.Model> = {}) {
  return ProviderTest.model({ id: ModelID.make(id), ...extra })
}

function openaiInfo(variants: Record<string, Record<string, unknown>> = {}) {
  return ProviderTest.info({
    id: OPENAI,
    models: { [IDENTITY]: model(IDENTITY, { variants }) },
  })
}

function azureInfo() {
  return ProviderTest.info({ id: AZURE, models: { [IDENTITY]: model(IDENTITY) } })
}

function twoProviderSnapshot(permission?: Permission.Ruleset) {
  const openai = openaiInfo({ ultra: {} })
  const azure = azureInfo()
  const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai, azure } })
  return permission ? SubagentModelCatalog.visible(snap, permission) : snap
}

function denyAzure(): Permission.Ruleset {
  return [{ permission: "task_model", pattern: "azure/*", action: "deny" }]
}

describe("subagent_model_routes formatter", () => {
  test("exact identity lists identity and each concrete provider/model with flags", () => {
    const result = queryRoutes(twoProviderSnapshot(), { modelIdentity: IDENTITY })
    expect(result.output).toContain(`identity: ${IDENTITY}`)
    expect(result.output).toContain(
      "- openai/gpt-5.2 (provider: openai, variants: ultra, source: config, preferred: false, dormant: false, suppressed: false)",
    )
    expect(result.output).toContain(
      "- azure/gpt-5.2 (provider: azure, variants: none, source: config, preferred: false, dormant: false, suppressed: false)",
    )
    expect(result.metadata.routes).toEqual([
      {
        providerID: "azure",
        model: "azure/gpt-5.2",
        variants: [],
        source: "config",
        preferred: false,
        dormant: false,
        suppressed: false,
      },
      {
        providerID: "openai",
        model: "openai/gpt-5.2",
        variants: ["ultra"],
        source: "config",
        preferred: false,
        dormant: false,
        suppressed: false,
      },
    ])
    expect(result.metadata.suggestions).toEqual([])
    expect(Object.keys(result.metadata).sort()).toEqual(["modelIdentity", "routes", "suggestions"])
  })

  test("provider narrowing keeps only that provider's routes", () => {
    const result = queryRoutes(twoProviderSnapshot(), { modelIdentity: IDENTITY, provider: "openai" })
    expect(result.output).toContain("openai/gpt-5.2")
    expect(result.output).not.toContain("azure/gpt-5.2")
    expect(result.metadata.routes).toHaveLength(1)
    expect(result.metadata.routes[0]?.providerID).toBe("openai")
  })

  test("missing identity reports no visible route with up to 3 suggestions", () => {
    const result = queryRoutes(twoProviderSnapshot(), { modelIdentity: "gpt-5" })
    expect(result.output).toContain(`No visible current route for model identity "gpt-5"`)
    expect(result.output).toContain("Current identity suggestions (up to 3)")
    expect(result.output).toContain(IDENTITY)
    expect(result.metadata.routes).toEqual([])
    expect(result.metadata.suggestions.length).toBeGreaterThan(0)
    expect(result.metadata.suggestions.length).toBeLessThanOrEqual(3)
  })

  test("missing identity with no match has no suggestions", () => {
    const result = queryRoutes(twoProviderSnapshot(), { modelIdentity: "does-not-exist" })
    expect(result.output).toContain("No visible current route for model identity")
    expect(result.output).toContain("No current identity suggestions.")
    expect(result.metadata.suggestions).toEqual([])
  })

  test("permission deny hides denied routes before query", () => {
    const visibleSnap = twoProviderSnapshot(denyAzure())
    const result = queryRoutes(visibleSnap, { modelIdentity: IDENTITY })
    expect(result.output).not.toContain("azure/")
    expect(result.metadata.routes).toHaveLength(1)
    expect(result.metadata.routes[0]?.providerID).toBe("openai")
  })

  test("output and metadata contain no provider internals or secret sentinels", () => {
    const secretModel = ProviderTest.model({
      id: ModelID.make(IDENTITY),
      api: { id: IDENTITY, url: "https://secret-endpoint.example", npm: "@ai-sdk/openai" },
      options: { custom: "sk-model-opt" },
      headers: { authorization: "Bearer sk-hdr-secret", "x-api-key": "sk-model-hdr" },
      variants: { ultra: { reasoningEffort: "max", token: "sk-variant-secret" } },
    })
    const openai = ProviderTest.info({
      id: OPENAI,
      key: "sk-provider-secret",
      env: ["OPENAI_API_KEY=sk-env-secret"],
      options: { apiKey: "sk-opt-secret", baseURL: "https://base.secret.example" },
      models: { [IDENTITY]: secretModel },
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    const result = queryRoutes(snap, { modelIdentity: IDENTITY })
    const json = JSON.stringify(result)
    for (const secret of [
      "sk-provider-secret",
      "sk-env-secret",
      "sk-opt-secret",
      "sk-hdr-secret",
      "sk-model-opt",
      "sk-model-hdr",
      "sk-variant-secret",
      "secret-endpoint.example",
      "base.secret.example",
      "@ai-sdk/openai",
      "Bearer",
    ]) {
      expect(json).not.toContain(secret)
    }
  })
})

describe("subagent_model_routes description and schema", () => {
  test("description is high-salience read-only, current-runtime, and question guidance", () => {
    expect(DESCRIPTION).toContain("read-only")
    expect(DESCRIPTION).toContain("current runtime")
    expect(DESCRIPTION).toContain("question")
    expect(DESCRIPTION).toContain("clarification")
    expect(DESCRIPTION).toContain("Never invent")
    expect(DESCRIPTION).not.toMatch(/\bgpt-\d/)
    expect(DESCRIPTION).not.toMatch(/\b(openai|anthropic|azure|kimi|deepseek)\b/i)
  })

  test("parameters schema is exactly model_identity plus optional provider with descriptions", () => {
    expect(Object.keys(Parameters.fields).sort()).toEqual(["model_identity", "provider"])
    const ast = JSON.stringify(Parameters.ast)
    expect(ast).toContain("Model identity to inspect current visible concrete routes for.")
    expect(ast).toContain("Optional provider ID to narrow the route listing to one provider.")
  })
})

function fakeAgent(permission: Permission.Ruleset) {
  return Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      get: (agent) => Effect.succeed({ name: agent, mode: "primary", options: {}, permission }),
      list: () => Effect.succeed([]),
      defaultAgent: () => Effect.succeed("build"),
      generate: () => Effect.die(new Error("not implemented")),
    }),
  )
}

function fakeSession(permission: Permission.Ruleset) {
  const info = {
    id: SessionID.make("ses_test"),
    directory: "/tmp",
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
      updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.succeed(msg),
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

function toolLayer(agentPermission: Permission.Ruleset = [], sessionPermission: Permission.Ruleset = []) {
  const openai = openaiInfo({ ultra: {} })
  const azure = azureInfo()
  const providerLayer = ProviderTest.fake({
    info: openai,
    list: () => Effect.succeed({ [OPENAI]: openai, [AZURE]: azure }),
  }).layer
  const routingLayer = Layer.succeed(
    ConfigSubagentRouting.Service,
    ConfigSubagentRouting.Service.of({
      get: () => Effect.succeed(ConfigSubagentRouting.empty()),
      prefer: () => Effect.die(new Error("unexpected preference mutation")),
      suppress: () => Effect.die(new Error("unexpected suppression mutation")),
      recordDelegation: () => Effect.die(new Error("unexpected activity mutation")),
    }),
  )
  return Layer.mergeAll(
    providerLayer,
    routingLayer,
    TestConfig.layer(),
    fakeAgent(agentPermission),
    fakeSession(sessionPermission),
    Truncate.defaultLayer,
  )
}

const it = testEffect(toolLayer())
const denyIt = testEffect(toolLayer([], denyAzure()))

function toolCtx(asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>) {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make(""),
    callID: "call_1",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
      Effect.sync(() => {
        asks.push(req)
      }),
  } satisfies Tool.Context
}

describe("subagent_model_routes tool execute", () => {
  it.live("lists visible routes for the requested identity without asking", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelRoutesTool
      const def = yield* Tool.init(info)
      const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const result = yield* def.execute({ model_identity: IDENTITY }, toolCtx(asks))
      expect(asks).toEqual([])
      expect(result.title).toContain(IDENTITY)
      expect(result.output).toContain("- openai/gpt-5.2")
      expect(result.output).toContain("- azure/gpt-5.2")
      expect(result.metadata.modelIdentity).toBe(IDENTITY)
      expect(result.metadata.routes).toHaveLength(2)
    }),
  )

  it.live("provider narrowing applies through the tool", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelRoutesTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ model_identity: IDENTITY, provider: "openai" }, toolCtx([]))
      expect(result.output).not.toContain("azure/")
      expect(result.metadata.routes).toHaveLength(1)
    }),
  )

  it.live("missing identity returns bounded suggestions", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelRoutesTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ model_identity: "gpt-5" }, toolCtx([]))
      expect(result.output).toContain("No visible current route for model identity")
      expect(result.metadata.suggestions.length).toBeLessThanOrEqual(3)
      expect(result.metadata.suggestions.length).toBeGreaterThan(0)
    }),
  )

  denyIt.live("effective ruleset from session permission hides denied routes", () =>
    Effect.gen(function* () {
      const info = yield* SubagentModelRoutesTool
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ model_identity: IDENTITY }, toolCtx([]))
      expect(result.output).not.toContain("azure/")
      expect(result.metadata.routes).toHaveLength(1)
      expect(result.metadata.routes[0]?.providerID).toBe("openai")
    }),
  )
})
