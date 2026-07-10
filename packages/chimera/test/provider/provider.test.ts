import { test, expect } from "bun:test"
import { mkdir, unlink } from "fs/promises"
import path from "path"

import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Plugin } from "../../src/plugin/index"
import { ModelsDev } from "@/provider/models"
import { snapshot } from "../../src/provider/models-snapshot.js"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "@/util/filesystem"
import { Env } from "../../src/env"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { makeRuntime } from "../../src/effect/run-service"

const env = makeRuntime(Env.Service, Env.defaultLayer)
const set = (k: string, v: string) => env.runSync((svc) => svc.set(k, v))

async function run<A, E>(fn: (provider: Provider.Interface) => Effect.Effect<A, E, never>) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* fn(provider)
    }),
  )
}

async function list() {
  return run((provider) => provider.list())
}

async function getProvider(providerID: ProviderID) {
  return run((provider) => provider.getProvider(providerID))
}

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return run((provider) => provider.getModel(providerID, modelID))
}

async function getLanguage(model: Provider.Model) {
  return run((provider) => provider.getLanguage(model))
}

async function closest(providerID: ProviderID, query: string[]) {
  return run((provider) => provider.closest(providerID, query))
}

async function getSmallModel(providerID: ProviderID) {
  return run((provider) => provider.getSmallModel(providerID))
}

async function defaultModel() {
  return run((provider) => provider.defaultModel())
}

async function markPluginDependenciesReady(dir: string) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  await Bun.write(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "0.0.0" } } } }),
  )
}

function paid(providers: Awaited<ReturnType<typeof list>>) {
  const item = providers[ProviderID.make("opencode")]
  expect(item).toBeDefined()
  return Object.values(item.models).filter((model) => model.cost.input > 0).length
}

test("provider loaded from env variable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // Provider should retain its connection source even if custom loaders
      // merge additional options.
      expect(providers[ProviderID.anthropic].source).toBe("env")
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
    },
  })
})

test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          disabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeUndefined()
    },
  })
})

test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          enabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              blacklist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).not.toContain("claude-sonnet-4-20250514")
    },
  })
})

test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "my-alias": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.anthropic].models["my-alias"]).toBeDefined()
      expect(providers[ProviderID.anthropic].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-provider")]).toBeDefined()
      expect(providers[ProviderID.make("custom-provider")].name).toBe("Custom Provider")
      expect(providers[ProviderID.make("custom-provider")].models["custom-model"]).toBeDefined()
    },
  })
})

test("custom OpenAI-compatible provider reuses known model metadata", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "openai/gpt-5.4-pro": {},
              },
              options: {
                baseURL: "https://api.custom.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("custom-openai")].models["openai/gpt-5.4-pro"]
      expect(model.name).toBe("GPT-5.4 Pro")
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBe(1_050_000)
      expect(model.limit.output).toBe(128_000)
      expect(model.cost.input).toBeGreaterThan(0)
    },
  })
})

test("backend semantics resolves model over provider and preserves explicit variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-codex": {
              name: "Custom Codex Proxy",
              npm: "@ai-sdk/openai-compatible",
              backend_semantics: "codex",
              env: [],
              models: {
                "gpt-5.6-sol": {
                  variants: {
                    max: { disabled: true },
                    ultra: { reasoningEffort: "ultra", custom: true },
                  },
                },
                "gpt-5.6-luna": {
                  backend_semantics: "openai",
                  limit: {
                    context: 1_050_000,
                    input: 922_000,
                    output: 128_000,
                  },
                },
                "gpt-5.5": {
                  limit: {
                    context: 144_000,
                    input: 128_000,
                    output: 16_000,
                  },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://api.custom.test/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const provider = providers[ProviderID.make("custom-codex")]
      const sol = provider.models["gpt-5.6-sol"]
      const luna = provider.models["gpt-5.6-luna"]
      const explicit = provider.models["gpt-5.5"]
      expect(provider.backend_semantics).toBe("codex")
      expect(sol.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(sol.backend_semantics).toBe("codex")
      expect(sol.limit).toEqual({ context: 500_000, input: 372_000, output: 128_000 })
      expect(sol.variants?.max).toBeUndefined()
      expect(sol.variants?.ultra).toEqual({ reasoningEffort: "ultra", custom: true })
      expect(sol.variants?.ultra.reasoningSummary).toBeUndefined()
      expect(sol.variants?.ultra.include).toBeUndefined()
      expect(luna.backend_semantics).toBe("openai")
      expect(luna.limit).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
      expect(luna.variants?.max).toBeUndefined()
      expect(explicit.backend_semantics).toBe("codex")
      expect(explicit.limit).toEqual({ context: 144_000, input: 128_000, output: 16_000 })
    },
  })
})

test("custom Responses provider selects the Responses SDK and preserves Codex variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-responses": {
              name: "Custom Responses",
              wire_api: "responses",
              backend_semantics: "codex",
              env: [],
              models: {
                "gpt-5.6-sol": {
                  reasoning: true,
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://api.custom.test/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = (await list())[ProviderID.make("custom-responses")]
      const model = provider.models["gpt-5.6-sol"]
      expect(provider.wire_api).toBe("responses")
      expect(model.api.npm).toBe("@ai-sdk/openai")
      expect(model.variants?.max).toEqual({ reasoningEffort: "max" })
      expect((await getLanguage(model)).provider).toBe("custom-responses.responses")
    },
  })
})

test("custom Responses provider does not fall back to a Chat-only SDK", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "chat-only-responses": {
              name: "Chat-only Responses",
              npm: "@ai-sdk/openai-compatible",
              wire_api: "responses",
              env: [],
              models: {
                model: {},
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://api.custom.test/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = (await list())[ProviderID.make("chat-only-responses")].models.model
      await expect(getLanguage(model)).rejects.toThrow("does not expose a responses model")
    },
  })
})

test("custom Responses provider discovers models with the Responses SDK", async () => {
  const calls: { path: string; auth: string | null }[] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      calls.push({ path: url.pathname, auth: request.headers.get("authorization") })
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-5.6-sol" }] })
      return new Response("not found", { status: 404 })
    },
  })
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-responses-discovery": {
              name: "Custom Responses Discovery",
              wire_api: "responses",
              backend_semantics: "codex",
              env: [],
              options: {
                apiKey: "test-key",
                baseURL: server.url.origin,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = (await list())[ProviderID.make("custom-responses-discovery")]
      const model = provider.models["gpt-5.6-sol"]
      expect(provider.options.baseURL).toBe(`${server.url.origin}/v1`)
      expect(model.api.npm).toBe("@ai-sdk/openai")
      expect(model.variants?.max).toEqual({ reasoningEffort: "max" })
      expect((await getLanguage(model)).provider).toBe("custom-responses-discovery.responses")
    },
  })
  expect(calls).toEqual([
    { path: "/models", auth: "Bearer test-key" },
    { path: "/v1/models", auth: "Bearer test-key" },
  ])
})


test("custom OpenAI-compatible provider discovers models when omitted from config", async () => {
  const calls: { path: string; auth: string | null }[] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      calls.push({ path: url.pathname, auth: request.headers.get("authorization") })
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-5.5" }, { id: "bge-m3" }] })
      return new Response("not found", { status: 404 })
    },
  })
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: {
                apiKey: "test-key",
                baseURL: server.url.origin,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const provider = providers[ProviderID.make("custom-openai")]
      expect(provider).toBeDefined()
      expect(provider.options.baseURL).toBe(`${server.url.origin}/v1`)
      expect(provider.models["gpt-5.5"]).toBeDefined()
      expect(provider.models["gpt-5.5"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(provider.models["bge-m3"]).toBeDefined()
    },
  })
  expect(calls).toEqual([
    { path: "/models", auth: "Bearer test-key" },
    { path: "/v1/models", auth: "Bearer test-key" },
  ])
})
test("Tencent TokenHub discovery filters non-coding models", async () => {
  const calls: { path: string; auth: string | null }[] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      calls.push({ path: url.pathname, auth: request.headers.get("authorization") })
      if (url.pathname === "/v1/models")
        return Response.json({
          data: [
            { id: "glm-5" },
            { id: "kimi-k2.5" },
            { id: "hunyuan-mt-7b" },
            { id: "bge-m3" },
            { id: "text-embedding-v3" },
            { id: "flux.1" },
            { id: "reranker-v2" },
          ],
        })
      return new Response("not found", { status: 404 })
    },
  })
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "tencent-tokenhub": {
              name: "Tencent TokenHub",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: {
                apiKey: "test-key",
                baseURL: server.url.origin,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const provider = providers[ProviderID.make("tencent-tokenhub")]
      expect(provider).toBeDefined()
      expect(provider.options.baseURL).toBe(`${server.url.origin}/v1`)
      expect(Object.keys(provider.models).sort()).toEqual(["glm-5", "kimi-k2.5"])
    },
  })
  expect(calls).toEqual([
    { path: "/models", auth: "Bearer test-key" },
    { path: "/v1/models", auth: "Bearer test-key" },
  ])
})

test("known model metadata lookup normalizes provider-prefixed GPT-5.5 ids", () => {
  const provider = Provider.fromModelsDevProvider({
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5",
        family: "gpt",
        release_date: "2026-06-01",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 5,
          output: 30,
          cache_read: 0.5,
          context_over_200k: {
            input: 10,
            output: 45,
            cache_read: 1,
          },
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
      },
    },
  } as unknown as ModelsDev.Provider)

  const model = Provider.findKnownModelMetadata({ openai: provider }, "openai/gpt-5.5")
  expect(model?.name).toBe("GPT-5.5")
  expect(model?.family).toBe("gpt")
  expect(model?.limit.context).toBe(1_050_000)
  expect(model?.cost.experimentalOver200K).toEqual({
    input: 10,
    output: 45,
    cache: {
      read: 1,
      write: 0,
    },
  })
})

test("known model metadata lookup resolves GPT-5.6 snapshot metadata", () => {
  const openai = (snapshot as Record<string, ModelsDev.Provider>).openai
  const model = Provider.findKnownModelMetadata(
    { openai: Provider.fromModelsDevProvider(openai) },
    "openai/gpt-5.6-sol",
  )
  expect(model?.api.id).toBe("gpt-5.6-sol")
  expect(model?.limit.context).toBe(1_050_000)
  expect(model?.limit.input).toBe(922_000)
  expect(model?.limit.output).toBe(128_000)
})

test("known model metadata lookup normalizes DeepSeek V4 max aliases", () => {
  const provider = Provider.fromModelsDevProvider({
    id: "deepseek",
    name: "DeepSeek",
    env: [],
    api: "https://api.deepseek.com/v1",
    models: {
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        family: "deepseek-thinking",
        release_date: "2026-04-24",
        reasoning: true,
        temperature: true,
        tool_call: true,
        modalities: {
          input: ["text"],
          output: ["text"],
        },
        limit: {
          context: 1_000_000,
          output: 384_000,
        },
        cost: {
          input: 1.74,
          output: 3.84,
        },
      },
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        family: "deepseek-flash",
        release_date: "2026-04-24",
        reasoning: true,
        temperature: true,
        tool_call: true,
        modalities: {
          input: ["text"],
          output: ["text"],
        },
        limit: {
          context: 1_000_000,
          output: 384_000,
        },
        cost: {
          input: 0.14,
          output: 0.28,
        },
      },
    },
  } as unknown as ModelsDev.Provider)

  const proMax = Provider.findKnownModelMetadata({ deepseek: provider }, "deepseek-v4-pro-max")
  const flashMax = Provider.findKnownModelMetadata({ deepseek: provider }, "deepseek/deepseek-v4-flash-max")

  expect(proMax?.name).toBe("DeepSeek V4 Pro")
  expect(proMax?.capabilities.reasoning).toBe(true)
  expect(proMax?.variants).toBeDefined()
  expect(proMax?.variants?.max).toEqual({ reasoningEffort: "max" })
  expect(flashMax?.name).toBe("DeepSeek V4 Flash")
  expect(flashMax?.capabilities.reasoning).toBe(true)
  expect(flashMax?.variants).toBeDefined()
  expect(flashMax?.variants?.max).toEqual({ reasoningEffort: "max" })
})

test("known model metadata lookup normalizes Claude Opus wrapper aliases", () => {
  const provider = Provider.fromModelsDevProvider({
    id: "anthropic",
    name: "Anthropic",
    env: [],
    api: "https://api.anthropic.com/v1",
    models: {
      "claude-opus-4-7": {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        family: "claude-opus",
        release_date: "2026-05-01",
        reasoning: true,
        temperature: true,
        tool_call: true,
        modalities: {
          input: ["text"],
          output: ["text"],
        },
        limit: {
          context: 200_000,
          output: 32_000,
        },
        cost: {
          input: 15,
          output: 75,
        },
      },
    },
  } as unknown as ModelsDev.Provider)

  const wrapper = Provider.findKnownModelMetadata({ anthropic: provider }, "evomap-claude-opus-4-7")
  const routed = Provider.findKnownModelMetadata({ anthropic: provider }, "Claude-Opus-4-7/Antigravity")

  expect(wrapper?.name).toBe("Claude Opus 4.7")
  expect(wrapper?.capabilities.reasoning).toBe(true)
  expect(wrapper?.variants?.max).toEqual({ reasoningEffort: "max" })
  expect(routed?.name).toBe("Claude Opus 4.7")
  expect(routed?.variants?.max).toEqual({ reasoningEffort: "max" })
})

test("config provider model cost parses over-200k pricing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "custom-model": {
                  cost: {
                    input: 1,
                    output: 2,
                    cache_read: 0.5,
                    context_over_200k: {
                      input: 3,
                      output: 4,
                      cache_read: 1.5,
                    },
                  },
                },
              },
              options: {
                baseURL: "https://api.custom.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("custom-openai")].models["custom-model"]
      expect(model.cost).toEqual({
        input: 1,
        output: 2,
        cache: {
          read: 0.5,
          write: 0,
        },
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: {
            read: 1.5,
            write: 0,
          },
        },
      })
    },
  })
})

test("custom DeepSeek openai-compatible model defaults interleaved reasoning field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              models: {
                "deepseek-r1": {
                  name: "DeepSeek R1",
                },
                "deepseek-details": {
                  name: "DeepSeek Details",
                  interleaved: { field: "reasoning_details" },
                },
                "custom-model": {
                  name: "Custom Model",
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
            "custom-anthropic-provider": {
              name: "Custom Anthropic Provider",
              npm: "@ai-sdk/anthropic",
              api: "https://api.custom.com/v1",
              models: {
                "deepseek-r1": {
                  name: "DeepSeek R1",
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const provider = providers[ProviderID.make("custom-provider")]
      expect(provider.models["deepseek-r1"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(provider.models["deepseek-details"].capabilities.interleaved).toEqual({ field: "reasoning_details" })
      expect(provider.models["custom-model"].capabilities.interleaved).toBe(false)
      expect(
        providers[ProviderID.make("custom-anthropic-provider")].models["deepseek-r1"].capabilities.interleaved,
      ).toBe(false)
    },
  })
})

test("env variable takes precedence, config merges options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              options: {
                timeout: 60000,
                chunkTimeout: 15000,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "env-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // Config options should be merged
      expect(providers[ProviderID.anthropic].options.timeout).toBe(60000)
      expect(providers[ProviderID.anthropic].options.chunkTimeout).toBe(15000)
    },
  })
})

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      expect(model).toBeDefined()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.id)).toBe("claude-sonnet-4-20250514")
      const language = await getLanguage(model)
      expect(language).toBeDefined()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      expect(getModel(ProviderID.anthropic, ModelID.make("nonexistent-model"))).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(getModel(ProviderID.make("nonexistent-provider"), ModelID.make("some-model"))).rejects.toThrow()
    },
  })
})

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await defaultModel()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-openai")]).toBeDefined()
      expect(providers[ProviderID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})

test("model cost defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "test-provider": {
              name: "Test Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.cost.input).toBe(0)
      expect(model.cost.output).toBe(0)
      expect(model.cost.cache.read).toBe(0)
      expect(model.cost.cache.write).toBe(0)
    },
  })
})

test("model options are merged from existing model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeUndefined()
    },
  })
})

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const result = await closest(ProviderID.anthropic, ["sonnet-4"])
      expect(result).toBeDefined()
      expect(String(result?.providerID)).toBe("anthropic")
      expect(String(result?.modelID)).toContain("sonnet-4")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await closest(ProviderID.make("nonexistent"), ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "my-sonnet": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic].models["my-sonnet"]).toBeDefined()

      const model = await getModel(ProviderID.anthropic, ModelID.make("my-sonnet"))
      expect(model).toBeDefined()
      expect(String(model.id)).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers[ProviderID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model inherits properties from existing database model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.name).toBe("Custom Name for Sonnet")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBeGreaterThan(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array allows no providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          enabled_providers: [],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(Object.keys(providers).length).toBe(0)
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
              blacklist: ["claude-opus-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models).not.toContain("claude-opus-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})

test("model with custom cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                  cost: {
                    input: 5,
                    output: 15,
                    cache_read: 2.5,
                    cache_write: 7.5,
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.cost.input).toBe(5)
      expect(model.cost.output).toBe(15)
      expect(model.cost.cache.read).toBe(2.5)
      expect(model.cost.cache.write).toBe(7.5)
    },
  })
})

test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          small_model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(String(model?.providerID)).toBe("anthropic")
      expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              options: { timeout: 30000 },
            },
            openai: {
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-anthropic-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeDefined()
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.openai].options.timeout).toBe(60000)
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("local-llm")]).toBeDefined()
      expect(providers[ProviderID.make("local-llm")].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers[ProviderID.make("local-llm")].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

// Edge cases for model configuration

test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                sonnet: {
                  id: "claude-sonnet-4-20250514",
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("provider with multiple env var options only includes apiKey when single env", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "multi-env": {
              name: "Multi Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("MULTI_ENV_KEY_1", "test-key")
      const providers = await list()
      expect(providers[ProviderID.make("multi-env")]).toBeDefined()
      // When multiple env options exist, key should NOT be auto-set
      expect(providers[ProviderID.make("multi-env")].key).toBeUndefined()
    },
  })
})

test("provider with single env var includes apiKey automatically", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("SINGLE_ENV_KEY", "my-api-key")
      const providers = await list()
      expect(providers[ProviderID.make("single-env")]).toBeDefined()
      // Single env option should auto-set key
      expect(providers[ProviderID.make("single-env")].key).toBe("my-api-key")
    },
  })
})

test("model cost overrides existing cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  cost: {
                    input: 999,
                    output: 888,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.cost.input).toBe(999)
      expect(model.cost.output).toBe(888)
    },
  })
})

test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("brand-new-provider")]).toBeDefined()
      expect(providers[ProviderID.make("brand-new-provider")].name).toBe("Brand New")
      const model = providers[ProviderID.make("brand-new-provider")].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-anthropic")
      set("OPENAI_API_KEY", "test-openai")
      set("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
      const providers = await list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers[ProviderID.openai]).toBeUndefined()
      // google: not in enabled = NOT allowed (even though not disabled)
      expect(providers[ProviderID.google]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("no-tools")].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("default-tools")].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("headers-provider")].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("custom provider userAgent is applied to model headers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "ua-provider": {
              name: "UA Provider",
              npm: "@ai-sdk/openai-compatible",
              userAgent: "custom-client/1.0",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("ua-provider")].models["model"]
      expect(model.headers["User-Agent"]).toBe("custom-client/1.0")
    },
  })
})

test("custom provider userAgent does not override explicit model User-Agent header", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "ua-override-provider": {
              name: "UA Override Provider",
              npm: "@ai-sdk/openai-compatible",
              userAgent: "provider-client/1.0",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "User-Agent": "model-client/1.0",
                    "X-Custom-Header": "custom-value",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("ua-override-provider")].models["model"]
      expect(model.headers).toEqual({
        "User-Agent": "model-client/1.0",
        "X-Custom-Header": "custom-value",
      })
    },
  })
})

test("built-in provider userAgent config is not applied to model headers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              userAgent: "ignored-client/1.0",
              options: {
                apiKey: "config-api-key",
              },
              models: {
                "ua-alias": {
                  id: "claude-sonnet-4-20250514",
                  name: "UA Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.anthropic].models["ua-alias"].headers["User-Agent"]).toBeUndefined()
    },
  })
})

test("provider env fallback - second env var used if first missing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "fallback-env": {
              name: "Fallback Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["PRIMARY_KEY", "FALLBACK_KEY"],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { baseURL: "https://api.example.com" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      // Only set fallback, not primary
      set("FALLBACK_KEY", "fallback-api-key")
      const providers = await list()
      // Provider should load because fallback env var is set
      expect(providers[ProviderID.make("fallback-env")]).toBeDefined()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model1 = await getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      const model2 = await getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("my-custom-id")].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      try {
        await getModel(ProviderID.anthropic, ModelID.make("claude-sonet-4")) // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      try {
        await getModel(ProviderID.make("antropic"), ModelID.make("claude-sonnet-4")) // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await getProvider(ProviderID.make("nonexistent"))
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const provider = await getProvider(ProviderID.anthropic)
      expect(provider).toBeDefined()
      expect(String(provider?.id)).toBe("anthropic")
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const result = await closest(ProviderID.anthropic, ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      // First term won't match, second will
      const result = await closest(ProviderID.anthropic, ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("no-limit")].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      // Custom options should be merged
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.anthropic].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("custom model inherits npm package from models.dev provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENAI_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.openai].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits api.url from models.dev provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENROUTER_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.openrouter]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers[ProviderID.openrouter].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers[ProviderID.openrouter].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("mode cost preserves over-200k pricing from base model", () => {
  const provider = {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        release_date: "2026-03-05",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
              },
              provider: {
                body: {
                  service_tier: "priority",
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4-fast"]
  expect(model.cost.input).toEqual(5)
  expect(model.cost.output).toEqual(30)
  expect(model.cost.cache.read).toEqual(0.5)
  expect(model.cost.cache.write).toEqual(0)
  expect(model.options["serviceTier"]).toEqual("priority")
  expect(model.cost.experimentalOver200K).toEqual({
    input: 5,
    output: 22.5,
    cache: {
      read: 0.5,
      write: 0,
    },
  })
})

test("models.dev normalization fills required response fields", () => {
  const provider = {
    id: "gateway",
    name: "Gateway",
    env: [],
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        cost: {
          input: 2.5,
          output: 15,
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4"]
  expect(model.api.url).toBe("")
  expect(model.capabilities.temperature).toBe(false)
  expect(model.capabilities.reasoning).toBe(false)
  expect(model.capabilities.attachment).toBe(false)
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.release_date).toBe("")
})

test("models.dev normalization exposes Kimi For Coding as a stable model id", () => {
  const provider = {
    id: "kimi-for-coding",
    name: "Kimi K2.6",
    env: ["KIMI_API_KEY"],
    npm: "@ai-sdk/anthropic",
    api: "https://api.kimi.com/coding/v1",
    models: {
      k2p6: {
        id: "k2p6",
        name: "Kimi K2.6",
        family: "kimi-thinking",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        release_date: "2026-04",
        modalities: {
          input: ["text", "image", "video"],
          output: ["text"],
        },
        limit: {
          context: 262_144,
          output: 32_768,
        },
        cost: {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const models = Provider.fromModelsDevProvider(provider).models
  const stable = models["kimi-for-coding"]
  const legacy = models["k2p6"]

  expect(legacy).toBeDefined()
  expect(stable).toBeDefined()
  expect(stable.id).toBe(ModelID.make("kimi-for-coding"))
  expect(stable.name).toBe("kimi-for-coding（Kimi-K2.7）")
  expect(stable.api.id).toBe("kimi-for-coding")
  expect(stable.api.url).toBe("https://api.kimi.com/coding/v1")
  expect(stable.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(stable.capabilities.temperature).toBe(false)
  expect(stable.capabilities.reasoning).toBe(true)
  expect(stable.capabilities.toolcall).toBe(true)
  expect(stable.capabilities.interleaved).toEqual({ field: "reasoning_content" })
  expect(stable.limit.context).toBe(262_144)
  expect(stable.limit.output).toBe(32_768)
  expect(legacy.id).toBe(ModelID.make("k2p6"))
  expect(legacy.name).toBe("kimi-for-coding（Kimi-K2.7）")
  expect(legacy.api.id).toBe("kimi-for-coding")
  expect(legacy.status).toBe("deprecated")
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      // Claude sonnet 4 has reasoning capability
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // max variant should still exist
      expect(model.variants!["max"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                    max: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated thinking config and the custom option
      expect(model.variants!["high"].thinking).toBeDefined()
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for database models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            openai: {
              models: {
                "gpt-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENAI_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.openai].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("custom-reasoning")].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})

test("Google Vertex: retains baseURL for custom proxy", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "vertex-proxy": {
              name: "Vertex Proxy",
              npm: "@ai-sdk/google-vertex",
              api: "https://my-proxy.com/v1",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"], // Mock env var requirement
              models: {
                "gemini-pro": {
                  name: "Gemini Pro",
                  tool_call: true,
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
                baseURL: "https://my-proxy.com/v1", // Should be retained
              },
            },
          },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
      const providers = await list()
      expect(providers[ProviderID.make("vertex-proxy")]).toBeDefined()
      expect(providers[ProviderID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
    },
  })
})

test("Google Vertex: supports OpenAI compatible models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "vertex-openai": {
              name: "Vertex OpenAI",
              npm: "@ai-sdk/google-vertex",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  provider: {
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://api.openai.com/v1",
                  },
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
              },
            },
          },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
      const providers = await list()
      const model = providers[ProviderID.make("vertex-openai")].models["gpt-4"]

      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    },
  })
})

test("cloudflare-ai-gateway loads with env variables", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      set("CLOUDFLARE_API_TOKEN", "test-token")
      const providers = await list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
    },
  })
})

test("cloudflare-ai-gateway forwards config metadata options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            "cloudflare-ai-gateway": {
              options: {
                metadata: { invoked_by: "test", project: "opencode" },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      set("CLOUDFLARE_API_TOKEN", "test-token")
      const providers = await list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")].options.metadata).toEqual({
        invoked_by: "test",
        project: "opencode",
      })
    },
  })
})

test("plugin config providers persist after instance dispose", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const configDir = path.join(dir, ".chimera")
      const root = path.join(configDir, "plugin")
      await mkdir(root, { recursive: true })
      await markPluginDependenciesReady(configDir)
      await markPluginDependenciesReady(Global.Path.config)
      await Bun.write(
        path.join(root, "demo-provider.ts"),
        [
          "export default {",
          '  id: "demo.plugin-provider",',
          "  server: async () => ({",
          "    async config(cfg) {",
          "      cfg.provider ??= {}",
          "      cfg.provider.demo = {",
          '        name: "Demo Provider",',
          '        npm: "@ai-sdk/openai-compatible",',
          '        api: "https://example.com/v1",',
          "        models: {",
          "          chat: {",
          '            name: "Demo Chat",',
          "            tool_call: true,",
          "            limit: { context: 128000, output: 4096 },",
          "          },",
          "        },",
          "      }",
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  const first = await WithInstance.provide({
    directory: tmp.path,
    fn: async () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const provider = yield* Provider.Service
          yield* plugin.init()
          return yield* provider.list()
        }),
      ),
  })
  expect(first[ProviderID.make("demo")]).toBeDefined()
  expect(first[ProviderID.make("demo")].models[ModelID.make("chat")]).toBeDefined()

  await disposeAllInstances()

  const second = await WithInstance.provide({
    directory: tmp.path,
    fn: async () => list(),
  })
  expect(second[ProviderID.make("demo")]).toBeDefined()
  expect(second[ProviderID.make("demo")].models[ModelID.make("chat")]).toBeDefined()
})

test("plugin config enabled and disabled providers are honored", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const root = path.join(dir, ".chimera", "plugin")
      await mkdir(root, { recursive: true })
      await Bun.write(
        path.join(root, "provider-filter.ts"),
        [
          "export default {",
          '  id: "demo.provider-filter",',
          "  server: async () => ({",
          "    async config(cfg) {",
          '      cfg.enabled_providers = ["anthropic", "openai"]',
          '      cfg.disabled_providers = ["openai"]',
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-anthropic-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("opencode loader keeps paid models when config apiKey is present", async () => {
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })

  const none = await WithInstance.provide({
    directory: base.path,
    fn: async () => paid(await list()),
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          provider: {
            opencode: {
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })

  const keyedCount = await WithInstance.provide({
    directory: keyed.path,
    fn: async () => paid(await list()),
  })

  expect(none).toBe(0)
  expect(keyedCount).toBeGreaterThan(0)
})

test("opencode loader keeps paid models when auth exists", async () => {
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })

  const none = await WithInstance.provide({
    directory: base.path,
    fn: async () => paid(await list()),
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
        }),
      )
    },
  })

  const authPath = path.join(Global.Path.data, "auth.json")
  let prev: string | undefined

  try {
    prev = await Filesystem.readText(authPath)
  } catch {}

  try {
    await Filesystem.write(
      authPath,
      JSON.stringify({
        opencode: {
          type: "api",
          key: "test-key",
        },
      }),
    )

    const keyedCount = await WithInstance.provide({
      directory: keyed.path,
      fn: async () => paid(await list()),
    })

    expect(none).toBe(0)
    expect(keyedCount).toBeGreaterThan(0)
  } finally {
    if (prev !== undefined) {
      await Filesystem.write(authPath, prev)
    }
    if (prev === undefined) {
      try {
        await unlink(authPath)
      } catch {}
    }
  }
})
