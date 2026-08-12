import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { WithInstance } from "../../src/project/with-instance"
import { tmpdir } from "../fixture/fixture"
import { attach } from "../../src/effect/run-service"

// These tests drive the on-disk models.dev cache through a mock HttpClient and a
// runtime-local ModelsDev instance, so they must not leak the pinned
// OPENCODE_MODELS_PATH fixture or touch the process-global app runtime.
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH

const cacheFile = path.join(Global.Path.cache, "models.json")

const catalogA: Record<string, ModelsDev.Provider> = {
  phase5cat: {
    id: "phase5cat",
    name: "Phase5 Catalog",
    env: ["PHASE5CAT_API_KEY"],
    models: {
      "cat-a": {
        id: "cat-a",
        name: "Catalog A Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const catalogB: Record<string, ModelsDev.Provider> = {
  phase5cat: {
    id: "phase5cat",
    name: "Phase5 Catalog",
    env: ["PHASE5CAT_API_KEY"],
    models: {
      "cat-b": {
        id: "cat-b",
        name: "Catalog B Model",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

let served: Record<string, ModelsDev.Provider> = catalogA
const mockClient = HttpClient.make((request) =>
  Effect.gen(function* () {
    if (request.url.includes("/api.json")) {
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(served), { status: 200 }))
    }
    return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }))
  }),
)

const modelsLayer = ModelsDev.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, mockClient)),
  Layer.provide(AppFileSystem.defaultLayer),
)
const otherDeps = Layer.mergeAll(
  AppFileSystem.defaultLayer,
  Env.defaultLayer,
  Config.defaultLayer,
  Auth.defaultLayer,
  Plugin.defaultLayer,
  Npm.defaultLayer,
)
const both = Provider.baseLayer.pipe(
  Layer.provide(otherDeps),
  Layer.provide(modelsLayer),
  Layer.provideMerge(modelsLayer),
)
const rt = ManagedRuntime.make(both)

beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
  process.env.PHASE5CAT_API_KEY = "phase5-test-key"
})

afterAll(async () => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  delete process.env.PHASE5CAT_API_KEY
  await rm(cacheFile, { force: true })
  await rt.dispose()
})

test("warmed Provider candidates rebuild after a ModelsDev catalog refresh", async () => {
  const providerID = ProviderID.make("phase5cat")
  await using tmp = await tmpdir()
  await mkdir(Global.Path.cache, { recursive: true })
  await writeFile(cacheFile, JSON.stringify(catalogA))

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const warmed = await rt.runPromise(
        attach(
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            return yield* provider.list()
          }),
        ),
      )
      expect(Object.keys(warmed[providerID].models)).toEqual(["cat-a"])

      served = catalogB
      const refreshCheck = await rt.runPromise(
        attach(
          Effect.gen(function* () {
            const modelsDev = yield* ModelsDev.Service
            yield* modelsDev.refresh(true)
            return { revision: yield* modelsDev.revision(), catalog: yield* modelsDev.get() }
          }),
        ),
      )
      expect(refreshCheck.revision).toBeGreaterThan(0)
      expect(Object.keys(refreshCheck.catalog.phase5cat.models)).toEqual(["cat-b"])

      const refreshed = await rt.runPromise(
        attach(
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            return yield* Effect.all(
              [provider.list(), provider.getProvider(providerID), provider.getModel(providerID, ModelID.make("cat-b"))],
              { concurrency: "unbounded" },
            )
          }),
        ),
      )
      const [providers, info, model] = refreshed
      expect(Object.keys(providers[providerID].models)).toEqual(["cat-b"])
      expect(providers[providerID]).toBe(info)
      expect(info.models["cat-b"]).toBe(model)
      expect(providers[providerID].models["cat-a"]).toBeUndefined()
    },
  })
})
