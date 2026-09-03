import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { ProjectID } from "@/project/schema"
import { ModelIdentity } from "../../src/provider/model-identity"
import { SubagentModelCatalog } from "../../src/agent/subagent-model-catalog"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

function capabilities(overrides: Partial<Provider.Model["capabilities"]> = {}) {
  return {
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    interleaved: false,
    ...overrides,
  } satisfies Provider.Model["capabilities"]
}

function model(override: Partial<Provider.Model> = {}) {
  return ProviderTest.model(override)
}

function provider(id: ProviderID, models: Record<string, Provider.Model>) {
  return ProviderTest.info({ id, models })
}

describe("capability filtering", () => {
  test("only models with input.text, output.text, and toolcall become routes", () => {
    const openai = provider(ProviderID.openai, {
      full: model({ id: ModelID.make("full"), name: "Full" }),
      "no-toolcall": model({
        id: ModelID.make("no-toolcall"),
        capabilities: capabilities({ toolcall: false }),
      }),
      "no-input-text": model({
        id: ModelID.make("no-input-text"),
        capabilities: capabilities({ input: { text: false, image: false, audio: false, video: false, pdf: false } }),
      }),
      "no-output-text": model({
        id: ModelID.make("no-output-text"),
        capabilities: capabilities({ output: { text: false, image: false, audio: false, video: false, pdf: false } }),
      }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    expect(snap.routes.map((route) => route.modelID)).toEqual(["full"])
  })
})

describe("sensitive-field exclusion", () => {
  test("projection drops key, env, options, headers, api url/npm, cost, limit, and variant payloads", () => {
    const secretModel = model({
      id: ModelID.make("gpt-5.2"),
      api: { id: "gpt-5.2", url: "https://secret-endpoint.example", npm: "@ai-sdk/openai" },
      options: { custom: "sk-model-opt" },
      headers: { authorization: "Bearer sk-hdr-secret", "x-api-key": "sk-model-hdr" },
      variants: { ultra: { reasoningEffort: "max", token: "sk-variant-secret" } },
      cost: { input: 5, output: 15, cache: { read: 1, write: 2 } },
      limit: { context: 200_000, output: 10_000 },
    })
    const openai = ProviderTest.info({
      id: ProviderID.openai,
      key: "sk-provider-secret",
      env: ["OPENAI_API_KEY=sk-env-secret"],
      options: { apiKey: "sk-opt-secret", baseURL: "https://base.secret.example" },
      models: { [secretModel.id]: secretModel },
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    expect(snap.routes).toEqual([
      {
        identity: "gpt-5.2",
        identityConfidence: "api-exact",
        providerID: "openai",
        modelID: "gpt-5.2",
        model: "openai/gpt-5.2",
        name: "Test Model",
        variants: ["ultra"],
        source: "config",
        dormant: false,
        preferred: false,
        suppressed: false,
      },
    ])
    const json = JSON.stringify(snap)
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
    ]) {
      expect(json).not.toContain(secret)
    }
  })
})

describe("explicit config identity", () => {
  test("capability_model_id from config groups routes with explicit confidence", () => {
    const openai = provider(ProviderID.openai, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
    const azure = provider(ProviderID.azure, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: { openai, azure },
      configuredProviders: {
        openai: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
        azure: { models: { "gpt-5.2": { capability_model_id: " GPT-5.6 " } } },
      },
    })
    expect(snap.routes.map((route) => route.identity)).toEqual(["gpt-5.6", "gpt-5.6"])
    expect(snap.routes.every((route) => route.identityConfidence === "explicit")).toBe(true)
    expect(snap.identities).toEqual([
      { identity: "gpt-5.6", identityConfidence: "explicit", routeCount: 2, providerIDs: ["azure", "openai"], variants: [] },
    ])
  })
})

describe("api-exact identity", () => {
  test("equal normalized api.id groups routes across providers with api-exact confidence", () => {
    const openai = provider(ProviderID.openai, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
    const azure = provider(ProviderID.azure, {
      "gpt-5.2": model({
        id: ModelID.make("gpt-5.2"),
        api: { id: "GPT-5.2", url: "https://example.com", npm: "@ai-sdk/openai" },
      }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai, azure } })
    expect(snap.routes.map((route) => route.identity)).toEqual(["gpt-5.2", "gpt-5.2"])
    expect(snap.routes.every((route) => route.identityConfidence === "api-exact")).toBe(true)
    expect(snap.identities).toEqual([
      { identity: "gpt-5.2", identityConfidence: "api-exact", routeCount: 2, providerIDs: ["azure", "openai"], variants: [] },
    ])
  })

  test("runtime-derived capability_model_id is not treated as explicit provenance", () => {
    const openai = provider(ProviderID.openai, {
      "gpt-5.2": model({
        id: ModelID.make("gpt-5.2"),
        capability_model_id: "gpt-5.6-derived",
      }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    expect(snap.routes[0].identity).toBe("gpt-5.2")
    expect(snap.routes[0].identityConfidence).toBe("api-exact")
    expect(snap.routes[0].identity).not.toBe("gpt-5.6-derived")
  })
})
describe("size class resolution", () => {
  test("resolves size class from identity and honors config override", () => {
    const openai = provider(ProviderID.openai, {
      "qwen-max": model({ id: ModelID.make("qwen-max"), api: { id: "qwen3.8-max", url: "https://example.com", npm: "@ai-sdk/openai" } }),
      "ds-pro": model({ id: ModelID.make("ds-pro"), api: { id: "deepseek-v4-pro", url: "https://example.com", npm: "@ai-sdk/openai" } }),
      haiku: model({ id: ModelID.make("haiku"), api: { id: "claude-haiku", url: "https://example.com", npm: "@ai-sdk/openai" } }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: { openai },
      configuredProviders: { openai: { models: { "qwen-max": { size_class: "S" } } } },
    })
    const byID = Object.fromEntries(snap.routes.map((route) => [route.modelID, route.sizeClass]))
    // config override wins over the XL class inferred from qwen3.8-max
    expect(byID["qwen-max"]).toBe("S")
    expect(byID["ds-pro"]).toBe("L")
    expect(byID["haiku"]).toBe("S")
  })

  test("leaves size class undefined for unknown identities without config", () => {
    const openai = provider(ProviderID.openai, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    expect(snap.routes[0].sizeClass).toBeUndefined()
  })

  test("matches size class by dash prefix for dated deployments", () => {
    const openai = provider(ProviderID.openai, {
      "flash-0731": model({
        id: ModelID.make("flash-0731"),
        api: { id: "deepseek-v4-flash-0731", url: "https://example.com", npm: "@ai-sdk/openai" },
      }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    expect(snap.routes[0].sizeClass).toBe("L")
  })
})

describe("stable sorting and variant names", () => {
  test("routes sort deterministically by identity and variants expose only sorted names", () => {
    const azure = provider(ProviderID.azure, {
      "gpt-5.2": model({
        id: ModelID.make("gpt-5.2"),
        api: { id: "alpha-model", url: "https://example.com", npm: "@ai-sdk/openai" },
      }),
    })
    const openai = provider(ProviderID.openai, {
      "gpt-5.2": model({
        id: ModelID.make("gpt-5.2"),
        api: { id: "beta-model", url: "https://example.com", npm: "@ai-sdk/openai" },
        variants: { ultra: { reasoningEffort: "max" }, max: { reasoningEffort: "high" } },
      }),
    })
    const input = { providers: { azure, openai } }
    const first = SubagentModelCatalog.buildSnapshot(input)
    const second = SubagentModelCatalog.buildSnapshot(input)
    expect(second).toEqual(first)
    expect(first.routes.map((route) => route.model)).toEqual(["azure/gpt-5.2", "openai/gpt-5.2"])
    expect(first.routes[0].variants).toEqual([])
    expect(first.routes[1].variants).toEqual(["max", "ultra"])
  })
})

describe("source immutability", () => {
  test("mutating source or returned snapshots does not leak into later builds", () => {
    const base = model({ id: ModelID.make("gpt-5.2") })
    const openai = provider(ProviderID.openai, { "gpt-5.2": base })
    const input = { providers: { openai } }
    const first = SubagentModelCatalog.buildSnapshot(input)
    const second = SubagentModelCatalog.buildSnapshot(input)
    expect(second).toEqual(first)
    openai.key = "sk-leaked"
    openai.options = { apiKey: "sk-leaked-opt" }
    base.options = { secret: "sk-leaked-model" }
    base.headers = { authorization: "Bearer sk-leaked-hdr" }
    first.routes[0].name = "hacked"
    first.routes[0].variants.push("zzz")
    const third = SubagentModelCatalog.buildSnapshot(input)
    expect(third).toEqual(second)
    expect(third.routes[0].name).toBe("Test Model")
    expect(third.routes[0].variants).toEqual([])
    expect(JSON.stringify(third)).not.toContain("sk-leaked")
  })
})

describe("snapshot() reads live services", () => {
  let listCalls = 0
  let configCalls = 0
  const base = model({ id: ModelID.make("gpt-5.2") })
  const providers: Record<string, Provider.Info> = {
    openai: provider(ProviderID.openai, { "gpt-5.2": base }),
  }
  const providerLayer = ProviderTest.fake({
    list: Effect.fn("CountingProvider.list")(() => {
      listCalls += 1
      return Effect.succeed(providers)
    }),
  }).layer
  const configLayer = TestConfig.layer({
    get: () => {
      configCalls += 1
      return Effect.succeed(Config.Info.zod.parse({}))
    },
  })
  const it = testEffect(Layer.mergeAll(providerLayer, configLayer))

  it.effect("reads fresh Provider list and Config on every snapshot() call", () =>
    Effect.gen(function* () {
      const first = yield* SubagentModelCatalog.snapshot()
      expect(first.routes).toHaveLength(1)
      providers.azure = provider(ProviderID.azure, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
      const second = yield* SubagentModelCatalog.snapshot()
      expect(second.routes).toHaveLength(2)
      expect(listCalls).toBe(2)
      expect(configCalls).toBe(2)
      expect(second).not.toEqual(first)
    }),
  )
})

describe("routes exact query", () => {
  test("returns only routes of the identity group, narrowed by provider", () => {
    const openai = provider(ProviderID.openai, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
    const azure = provider(ProviderID.azure, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) })
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: { openai, azure },
      configuredProviders: {
        openai: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
        azure: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
      },
    })
    const identity = ModelIdentity.group([
      { providerID: "openai", modelID: "gpt-5.2", explicitCapabilityModelID: "gpt-5.6" },
      { providerID: "azure", modelID: "gpt-5.2", explicitCapabilityModelID: "gpt-5.6" },
    ])[0]!.identity
    expect(identity).toBe("gpt-5.6")
    const matched = SubagentModelCatalog.routes(snap, { modelIdentity: identity })
    expect(matched.map((route) => route.model)).toEqual(["azure/gpt-5.2", "openai/gpt-5.2"])
    expect(
      SubagentModelCatalog.routes(snap, { modelIdentity: identity, provider: "azure" }).map((route) => route.model),
    ).toEqual(["azure/gpt-5.2"])
    expect(SubagentModelCatalog.routes(snap, { modelIdentity: identity, provider: "unknown" })).toEqual([])
    expect(
      SubagentModelCatalog.routes(snap, { modelIdentity: "no-such-identity" }),
    ).toEqual([])
  })
})

describe("suggest", () => {
  test("bounded, stable fuzzy suggestions over model keys and names", () => {
    const openai = provider(ProviderID.openai, {
      "gpt-5.2": model({ id: ModelID.make("gpt-5.2"), name: "GPT-5.2" }),
      "gpt-4o": model({ id: ModelID.make("gpt-4o"), name: "GPT-4o" }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({ providers: { openai } })
    const first = SubagentModelCatalog.suggest(snap, "gpt-5.2")
    expect(first.length).toBeGreaterThanOrEqual(1)
    expect(first.length).toBeLessThanOrEqual(3)
    expect(first.some((identity) => identity.identity === "gpt-5.2")).toBe(true)
    expect(SubagentModelCatalog.suggest(snap, "gpt-5.2")).toEqual(first)
    expect(SubagentModelCatalog.suggest(snap, "gpt-5.2", 1)).toHaveLength(1)
    expect(SubagentModelCatalog.suggest(snap, "does-not-exist")).toEqual([])
  })
})

describe("permission visibility", () => {
  test("deny hides concrete routes while ask and allow remain visible", () => {
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: {
        openai: provider(ProviderID.openai, { alpha: model({ id: ModelID.make("alpha") }) }),
        azure: provider(ProviderID.azure, { alpha: model({ id: ModelID.make("alpha") }) }),
        relay: provider(ProviderID.make("relay"), { alpha: model({ id: ModelID.make("alpha") }) }),
      },
    })
    const ruleset: Permission.Ruleset = [
      { permission: "task_model", pattern: "openai/*", action: "allow" },
      { permission: "task_model", pattern: "azure/*", action: "ask" },
      { permission: "task_model", pattern: "relay/*", action: "deny" },
    ]
    const visible = SubagentModelCatalog.visible(snap, ruleset)
    expect(visible.routes.map((route) => route.model)).toEqual(["azure/alpha", "openai/alpha"])
    expect(visible.identities).toEqual([
      { identity: "alpha", identityConfidence: "api-exact", routeCount: 2, providerIDs: ["azure", "openai"], variants: [] },
    ])
  })

  test("visible returns a defensive route and variant projection", () => {
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: {
        openai: provider(ProviderID.openai, {
          alpha: model({ id: ModelID.make("alpha"), variants: { ultra: { reasoningEffort: "max" } } }),
        }),
      },
    })
    const visible = SubagentModelCatalog.visible(snap, [])
    visible.routes[0]!.name = "mutated"
    visible.routes[0]!.variants.push("mutated")
    expect(snap.routes[0]!.name).toBe("Test Model")
    expect(snap.routes[0]!.variants).toEqual(["ultra"])
  })
})

describe("compact disclosure", () => {
  const snap = SubagentModelCatalog.buildSnapshot({
    providers: {
      openai: provider(
        ProviderID.openai,
        Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => {
            const id = `identity-${index.toString().padStart(2, "0")}-with-a-long-stable-selector`
            return [id, model({ id: ModelID.make(id) })]
          }),
        ),
      ),
    },
  })

  test("is deterministic and complete when it fits the default budget", () => {
    const first = SubagentModelCatalog.disclosure(snap)
    expect(first).toBe(SubagentModelCatalog.disclosure(snap))
    expect(first?.length).toBeLessThanOrEqual(SubagentModelCatalog.DISCLOSURE_MAX_CHARS)
    expect(first).toContain("## Available Subagent Model Identities")
    expect(first).toContain("Use `subagent_model_routes`")
  })

  test("reports a stable omitted count without slicing a selector", () => {
    const first = SubagentModelCatalog.disclosure(snap, 360)
    const second = SubagentModelCatalog.disclosure(snap, 360)
    expect(first).toBe(second)
    expect(first?.length).toBeLessThanOrEqual(360)
    const omitted = Number(first?.match(/- (\d+) identities omitted/)?.[1])
    const shown = first?.split("\n").filter((line) => line.startsWith("- \"identity-")).length ?? 0
    expect(shown).toBeGreaterThan(0)
    expect(shown + omitted).toBe(snap.identities.length)
    for (const line of first?.split("\n").filter((item) => item.startsWith("- \"identity-")) ?? []) {
      expect(line).toMatch(/: 1 route$/)
    }
  })

  test("shows the sorted variant union per identity", () => {
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: {
        openai: provider(ProviderID.openai, {
          alpha: model({ id: ModelID.make("alpha"), variants: { ultra: { reasoningEffort: "max" }, high: {} } }),
        }),
        azure: provider(ProviderID.azure, {
          alpha: model({
            id: ModelID.make("alpha"),
            api: { id: "alpha", url: "https://example.com", npm: "@ai-sdk/openai" },
            variants: { max: {} },
          }),
        }),
      },
    })
    expect(SubagentModelCatalog.disclosure(snap)).toContain(`- "alpha": 2 routes; variants: high, max, ultra`)
  })

  test("returns no partial disclosure when even the fixed guidance cannot fit", () => {
    expect(SubagentModelCatalog.disclosure(snap, 80)).toBeUndefined()
    expect(SubagentModelCatalog.disclosure({ routes: [], identities: [] })).toBeUndefined()
  })
})

describe("resolveRoute", () => {
  test("resolves a unique current route and provider narrowing", async () => {
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: {
        openai: provider(ProviderID.openai, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) }),
        azure: provider(ProviderID.azure, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) }),
      },
      configuredProviders: {
        openai: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
        azure: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
      },
    })
    const route = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(snap, { modelIdentity: " GPT-5.6 ", provider: "azure" }),
    )
    expect(route.model).toBe("azure/gpt-5.2")
    expect(route.variants).toEqual([])
  })

  test("returns exact current options for multi-provider ambiguity", async () => {
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: {
        openai: provider(ProviderID.openai, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) }),
        azure: provider(ProviderID.azure, { "gpt-5.2": model({ id: ModelID.make("gpt-5.2") }) }),
      },
      configuredProviders: {
        openai: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
        azure: { models: { "gpt-5.2": { capability_model_id: "gpt-5.6" } } },
      },
    })
    const error = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(snap, { modelIdentity: "gpt-5.6" }).pipe(Effect.flip),
    )
    expect(error._tag).toBe("SubagentModelRouteAmbiguousError")
    if (error._tag !== "SubagentModelRouteAmbiguousError") throw error
    expect(error.reason).toBe("multiple-providers")
    expect(error.routes).toEqual([
      { providerID: "azure", model: "azure/gpt-5.2", variants: [] },
      { providerID: "openai", model: "openai/gpt-5.2", variants: [] },
    ])
  })

  test("keeps multiple deployments on one provider ambiguous", async () => {
    const openai = provider(ProviderID.openai, {
      first: model({ id: ModelID.make("first") }),
      second: model({ id: ModelID.make("second"), variants: { max: {} } }),
    })
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: { openai },
      configuredProviders: {
        openai: {
          models: {
            first: { capability_model_id: "shared" },
            second: { capability_model_id: "shared" },
          },
        },
      },
    })
    const error = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(snap, { modelIdentity: "shared", provider: "openai" }).pipe(Effect.flip),
    )
    expect(error._tag).toBe("SubagentModelRouteAmbiguousError")
    if (error._tag !== "SubagentModelRouteAmbiguousError") throw error
    expect(error.reason).toBe("multiple-deployments")
    expect(error.routes).toEqual([
      { providerID: "openai", model: "openai/first", variants: [] },
      { providerID: "openai", model: "openai/second", variants: ["max"] },
    ])
  })

  test("returns bounded live suggestions when no route matches", async () => {
    const snap = SubagentModelCatalog.buildSnapshot({
      providers: {
        openai: provider(ProviderID.openai, {
          "gpt-5.6": model({ id: ModelID.make("gpt-5.6") }),
          "gpt-5.5": model({ id: ModelID.make("gpt-5.5") }),
          "gpt-5.4": model({ id: ModelID.make("gpt-5.4") }),
          "gpt-5.3": model({ id: ModelID.make("gpt-5.3") }),
        }),
      },
    })
    const error = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(snap, { modelIdentity: "gpt-5" }).pipe(Effect.flip),
    )
    expect(error._tag).toBe("SubagentModelRouteNotFoundError")
    if (error._tag !== "SubagentModelRouteNotFoundError") throw error
    expect(error.suggestions).toHaveLength(3)
    expect(error.suggestions.every((identity) => snap.identities.some((item) => item.identity === identity))).toBe(true)
    const second = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(snap, { modelIdentity: "gpt-5" }).pipe(Effect.flip),
    )
    if (second._tag !== "SubagentModelRouteNotFoundError") throw second
    expect(second.suggestions).toEqual(error.suggestions)
  })
})

const preferenceProjectID = ProjectID.make("phase-4-catalog-project")
const preferenceIdentity = "shared-routing-identity"

function preferenceEntry(
  weight: number,
  revision: number,
  activity = 0,
  suppressedRevision?: number,
 ): ConfigSubagentRouting.Entry {
  return {
    preference: { weight, activity, revision },
    ...(suppressedRevision === undefined ? {} : { suppressedRevision }),
  }
}

function suppressionEntry(revision: number): ConfigSubagentRouting.Entry {
  return { suppressedRevision: revision }
}

function preferenceState(input: {
  globalProviders?: Record<string, ConfigSubagentRouting.Entry>
  globalRoutes?: Record<string, ConfigSubagentRouting.Entry>
  projectProviders?: Record<string, ConfigSubagentRouting.Entry>
  projectRoutes?: Record<string, ConfigSubagentRouting.Entry>
  globalActivity?: number
  projectActivity?: number
} = {}): ConfigSubagentRouting.State {
  return {
    version: 1,
    revision: 1_000,
    activity: {
      global: input.globalActivity ?? 0,
      projects: { [preferenceProjectID]: input.projectActivity ?? 0 },
    },
    global: {
      providers: input.globalProviders ?? {},
      routes: { [preferenceIdentity]: input.globalRoutes ?? {} },
    },
    projects: {
      [preferenceProjectID]: {
        providers: input.projectProviders ?? {},
        routes: { [preferenceIdentity]: input.projectRoutes ?? {} },
      },
    },
  }
}

function preferenceSnapshot() {
  const relay = ProviderID.make("relay")
  return SubagentModelCatalog.buildSnapshot({
    providers: {
      openai: provider(ProviderID.openai, { deployment: model({ id: ModelID.make("deployment") }) }),
      azure: provider(ProviderID.azure, { deployment: model({ id: ModelID.make("deployment") }) }),
      relay: provider(relay, { deployment: model({ id: ModelID.make("deployment") }) }),
    },
    configuredProviders: {
      openai: { models: { deployment: { capability_model_id: preferenceIdentity } } },
      azure: { models: { deployment: { capability_model_id: preferenceIdentity } } },
      relay: { models: { deployment: { capability_model_id: preferenceIdentity } } },
    },
  })
}

function routeState(
  tier: "global-provider" | "project-provider" | "global-route" | "project-route",
  entry: ConfigSubagentRouting.Entry,
 ) {
  if (tier === "global-provider") return preferenceState({ globalProviders: { openai: entry } })
  if (tier === "project-provider") return preferenceState({ projectProviders: { openai: entry } })
  if (tier === "global-route") return preferenceState({ globalRoutes: { "openai/deployment": entry } })
  return preferenceState({ projectRoutes: { "openai/deployment": entry } })
}

describe("Phase 4 preference precedence", () => {
  test("orders project route above global route above project provider above global provider", () => {
    const snap = preferenceSnapshot()
    const states = [
      {
        state: preferenceState({ globalProviders: { openai: preferenceEntry(8, 900) } }),
        expected: "openai/deployment",
      },
      {
        state: preferenceState({
          globalProviders: { openai: preferenceEntry(8, 900) },
          projectProviders: { azure: preferenceEntry(1, 10) },
        }),
        expected: "azure/deployment",
      },
      {
        state: preferenceState({
          globalProviders: { openai: preferenceEntry(8, 900) },
          projectProviders: { azure: preferenceEntry(8, 800) },
          globalRoutes: { "relay/deployment": preferenceEntry(1, 5) },
        }),
        expected: "relay/deployment",
      },
      {
        state: preferenceState({
          globalProviders: { openai: preferenceEntry(8, 900) },
          projectProviders: { azure: preferenceEntry(8, 800) },
          globalRoutes: { "relay/deployment": preferenceEntry(8, 700) },
          projectRoutes: { "openai/deployment": preferenceEntry(1, 1) },
        }),
        expected: "openai/deployment",
      },
    ]

    for (const item of states) {
      const applied = SubagentModelCatalog.applyPreferences(snap, item.state, preferenceProjectID)
      expect(applied.routes.filter((route) => route.preferred).map((route) => route.model)).toEqual([item.expected])
    }
  })

  test("uses tier precedence for suppression and restoration regardless of lower-tier revision", () => {
    const snap = preferenceSnapshot()
    const tiers = ["global-provider", "project-provider", "global-route", "project-route"] as const
    for (let index = 0; index < tiers.length - 1; index++) {
      const lower = routeState(tiers[index], preferenceEntry(1, 900))
      const higher = routeState(tiers[index + 1], suppressionEntry(1))
      const suppressed = SubagentModelCatalog.applyPreferences(
        snap,
        {
          ...lower,
          global: {
            providers: { ...lower.global.providers, ...higher.global.providers },
            routes: {
              [preferenceIdentity]: {
                ...lower.global.routes[preferenceIdentity],
                ...higher.global.routes[preferenceIdentity],
              },
            },
          },
          projects: {
            [preferenceProjectID]: {
              providers: {
                ...lower.projects[preferenceProjectID].providers,
                ...higher.projects[preferenceProjectID].providers,
              },
              routes: {
                [preferenceIdentity]: {
                  ...lower.projects[preferenceProjectID].routes[preferenceIdentity],
                  ...higher.projects[preferenceProjectID].routes[preferenceIdentity],
                },
              },
            },
          },
        },
        preferenceProjectID,
      )
      expect(suppressed.routes.find((route) => route.model === "openai/deployment")?.suppressed).toBe(true)

      const lowerSuppression = routeState(tiers[index], suppressionEntry(900))
      const higherRestore = routeState(tiers[index + 1], preferenceEntry(1, 1))
      const restored = SubagentModelCatalog.applyPreferences(
        snap,
        {
          ...lowerSuppression,
          global: {
            providers: { ...lowerSuppression.global.providers, ...higherRestore.global.providers },
            routes: {
              [preferenceIdentity]: {
                ...lowerSuppression.global.routes[preferenceIdentity],
                ...higherRestore.global.routes[preferenceIdentity],
              },
            },
          },
          projects: {
            [preferenceProjectID]: {
              providers: {
                ...lowerSuppression.projects[preferenceProjectID].providers,
                ...higherRestore.projects[preferenceProjectID].providers,
              },
              routes: {
                [preferenceIdentity]: {
                  ...lowerSuppression.projects[preferenceProjectID].routes[preferenceIdentity],
                  ...higherRestore.projects[preferenceProjectID].routes[preferenceIdentity],
                },
              },
            },
          },
        },
        preferenceProjectID,
      )
      expect(restored.routes.find((route) => route.model === "openai/deployment")?.suppressed).toBe(false)
    }
  })

  test("uses only the effective tier's latest event and suppression wins revision ties", () => {
    const snap = preferenceSnapshot()
    const tied = SubagentModelCatalog.applyPreferences(
      snap,
      preferenceState({
        globalRoutes: { "openai/deployment": preferenceEntry(8, 900) },
        projectRoutes: { "openai/deployment": preferenceEntry(1, 5, 0, 5) },
      }),
      preferenceProjectID,
    )
    const suppressed = tied.routes.find((route) => route.model === "openai/deployment")!
    expect(suppressed.suppressed).toBe(true)
    expect(SubagentModelCatalog.routes(tied, { modelIdentity: preferenceIdentity, provider: "openai" })).toEqual([])
    expect(
      SubagentModelCatalog.routes(tied, {
        modelIdentity: preferenceIdentity,
        provider: "openai",
        includeSuppressed: true,
      }).map((route) => route.model),
    ).toEqual(["openai/deployment"])

    const restored = SubagentModelCatalog.applyPreferences(
      snap,
      preferenceState({
        globalRoutes: { "openai/deployment": { suppressedRevision: 900 } },
        projectRoutes: { "openai/deployment": preferenceEntry(1, 6, 0, 5) },
      }),
      preferenceProjectID,
    )
    expect(restored.routes.find((route) => route.model === "openai/deployment")).toMatchObject({
      preferred: true,
      suppressed: false,
    })
  })

  test("marks only a dormant provider affinity and keeps unrelated routes visible", () => {
    const applied = SubagentModelCatalog.applyPreferences(
      preferenceSnapshot(),
      preferenceState({
        globalProviders: { openai: preferenceEntry(1, 1) },
        globalActivity: 96,
      }),
      preferenceProjectID,
    )
    expect(applied.routes.find((route) => route.model === "openai/deployment")?.dormant).toBe(true)
    expect(
      applied.routes.filter((route) => route.providerID !== "openai").every((route) => !route.dormant),
    ).toBe(true)
    expect(applied.identities).toEqual([
      {
        identity: preferenceIdentity,
        identityConfidence: "explicit",
        routeCount: 2,
        providerIDs: ["azure", "relay"],
        variants: [],
      },
    ])
    expect(
      SubagentModelCatalog.routes(applied, { modelIdentity: preferenceIdentity, provider: "openai" }).map(
        (route) => route.model,
      ),
    ).toEqual(["openai/deployment"])
  })
})

describe("Phase 4 preferred route resolution", () => {
  const deploymentSnapshot = SubagentModelCatalog.buildSnapshot({
    providers: {
      openai: provider(ProviderID.openai, {
        first: model({ id: ModelID.make("first") }),
        second: model({ id: ModelID.make("second") }),
      }),
    },
    configuredProviders: {
      openai: {
        models: {
          first: { capability_model_id: preferenceIdentity },
          second: { capability_model_id: preferenceIdentity },
        },
      },
    },
  })

  test("resolves the sole preferred deployment even with provider narrowing", async () => {
    const applied = SubagentModelCatalog.applyPreferences(
      deploymentSnapshot,
      preferenceState({ projectRoutes: { "openai/second": preferenceEntry(1, 1) } }),
      preferenceProjectID,
    )
    const resolved = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(applied, { modelIdentity: preferenceIdentity, provider: "openai" }),
    )
    expect(resolved.model).toBe("openai/second")
  })

  test("keeps equal provider-affinity deployments ambiguous instead of choosing by sort order", async () => {
    const applied = SubagentModelCatalog.applyPreferences(
      deploymentSnapshot,
      preferenceState({ projectProviders: { openai: preferenceEntry(1, 1) } }),
      preferenceProjectID,
    )
    expect(applied.routes.some((route) => route.preferred)).toBe(false)
    const error = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(applied, { modelIdentity: preferenceIdentity, provider: "openai" }).pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe("SubagentModelRouteAmbiguousError")
    if (error._tag !== "SubagentModelRouteAmbiguousError") throw error
    expect(error.reason).toBe("multiple-deployments")
    expect(error.routes.map((route) => route.model)).toEqual(["openai/first", "openai/second"])
  })

  test("keeps equal cross-provider preferences ambiguous", async () => {
    const applied = SubagentModelCatalog.applyPreferences(
      preferenceSnapshot(),
      preferenceState({
        projectProviders: {
          openai: preferenceEntry(1, 1),
          azure: preferenceEntry(1, 2),
        },
      }),
      preferenceProjectID,
    )
    expect(applied.routes.some((route) => route.preferred)).toBe(false)
    const error = await Effect.runPromise(
      SubagentModelCatalog.resolveRoute(applied, { modelIdentity: preferenceIdentity }).pipe(Effect.flip),
    )
    expect(error._tag).toBe("SubagentModelRouteAmbiguousError")
    if (error._tag !== "SubagentModelRouteAmbiguousError") throw error
    expect(error.reason).toBe("multiple-providers")
  })
})
