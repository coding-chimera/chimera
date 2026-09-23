import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { Policy } from "@opencode-ai/core/policy"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Catalog trunk (L5.4a) over an isolated per-run db file (temp dir + dedicated
// chimera-v2 test filename; never the production fork chimera.db). The
// makeLocationNode graph compiles through the fork seam AppNodeBuilder with the
// L5.1 Location shim bound by a test layer: no project/git closure is pulled in.
const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())
const file = path.join(tmp.path, "chimera-v2-trunk-catalog.db")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Catalog.node, Policy.node, Integration.node, Credential.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(file)],
    [Location.node, locationLayer],
  ]),
)

describe("Catalog trunk", () => {
  it.effect("publishes an updated event after catalog changes", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const events = yield* EventV2.Service
      const updated = yield* events
        .subscribe(Catalog.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))

      expect((yield* Fiber.join(updated)).length).toBe(1)
    }),
  )

  it.effect("registers providers and models through the state editor and projects model api from the provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const providerID = ProviderV2.ID.make("test-provider")
      const modelID = ModelV2.ID.make("test-model")

      yield* catalog
        .transform((editor) => {
          editor.provider.update(providerID, (provider) => {
            provider.name = "Test provider"
            provider.api = { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }
            provider.request = { headers: { "x-provider": "header" }, body: {} }
          })
          editor.model.update(providerID, modelID, (model) => {
            model.name = "Test model"
            model.api = { id: ModelV2.ID.make("api-test-model"), type: "aisdk", package: "@ai-sdk/openai" }
            model.capabilities = { tools: false, input: ["text"], output: ["text"] }
            model.limit = { context: 100, output: 20 }
          })
        })
        .pipe(Scope.provide(scope))

      expect((yield* catalog.provider.all()).map((provider) => provider.id)).toEqual([providerID])
      const model = yield* catalog.model.get(providerID, modelID)
      // projectModel: an aisdk model api without url inherits the provider url
      // and merges provider settings/headers/body (4898263dec mapping tree).
      expect(model?.api).toEqual({
        id: ModelV2.ID.make("api-test-model"),
        type: "aisdk",
        package: "@ai-sdk/openai",
        url: "https://openai.example/v1",
        settings: {},
      })
      expect(model?.request.headers).toEqual({ "x-provider": "header" })
      expect((yield* catalog.model.all()).map((item) => item.id)).toEqual([modelID])
      expect((yield* catalog.model.default())?.id).toBe(modelID)

      yield* Scope.close(scope, Exit.void)
      expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    }),
  )

  it.effect("derives provider availability from the mapped integration", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const providerID = ProviderV2.ID.make("remote")
      const soloID = ProviderV2.ID.make("solo")
      const integrationID = Integration.ID.make("gateway")

      yield* catalog
        .transform((editor) => {
          editor.provider.update(providerID, (provider) => {
            provider.integrationID = integrationID
          })
          editor.provider.update(soloID, () => {})
        })
        .pipe(Scope.provide(scope))

      // The provider mapped to "gateway" has no integration registered yet; the
      // provider without integrationID is available through the fallback path
      // (Integration.ID.make(provider.id) miss => available).
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([soloID])

      yield* integrations
        .transform((editor) => {
          editor.update(integrationID, (integration) => (integration.name = "Gateway"))
          editor.method.update({ integrationID, method: { type: "key", label: "API key" } })
        })
        .pipe(Scope.provide(scope))
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([soloID])

      yield* integrations.connection.key({ integrationID, key: "secret", label: "Work" })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([providerID, soloID])

      yield* Scope.close(scope, Exit.void)
    }),
  )
})
