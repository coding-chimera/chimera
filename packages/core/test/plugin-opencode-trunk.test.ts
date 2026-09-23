import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginHostSeam } from "@opencode-ai/core/plugin/host-seam"
import { OpencodePlugin } from "@opencode-ai/core/plugin/provider/opencode"
import { Policy } from "@opencode-ai/core/policy"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// OpencodePlugin (L5.4b) over the seam host, on an isolated per-run db file
// (temp dir + dedicated chimera-v2 test filename; never the production fork
// chimera.db). Ported from upstream core test/plugin/provider-opencode.test.ts,
// rebased from PluginHost.make + PluginV2 onto PluginHostSeam.make: the fork has
// not vendored the upstream plugin registry tree (L6-scale). Brand discipline
// per decision #7: the opencode integration ID, "opencode-cli" client ID,
// opencode.ai console default server, and method labels must stay upstream
// values — assertions below pin them.
const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())
const file = path.join(tmp.path, "chimera-v2-trunk-plugin-opencode.db")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Catalog.node,
      Policy.node,
      Integration.node,
      Credential.node,
      EventV2.node,
      LayerNodePlatform.httpClient,
    ]),
    [
      [Database.node, Database.layerFromPath(file)],
      [Location.node, locationLayer],
    ],
  ),
)

const addPlugin = Effect.fn(function* (http?: HttpClient.HttpClient) {
  const host = yield* PluginHostSeam.make()
  const events = yield* EventV2.Service
  const integration = yield* Integration.Service
  const client = yield* HttpClient.HttpClient
  yield* OpencodePlugin.effect(host).pipe(
    Effect.provideService(EventV2.Service, events),
    Effect.provideService(Integration.Service, integration),
    Effect.provideService(HttpClient.HttpClient, http ?? client),
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function eventually<A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, remaining = 1000): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const cost = (input: number, output = 0) => [{ input, output, cache: { read: 0, write: 0 } }]

describe("OpencodePlugin trunk (seam host)", () => {
  it.effect("registers account and service account methods with upstream brand values", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integration = yield* Integration.Service
      const info = yield* integration.get(Integration.ID.make("opencode"))
      expect(info?.name).toBe("OpenCode")
      expect(info?.methods).toEqual([
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "OpenCode Console account",
        },
        { type: "key", label: "API key (service account)" },
      ])
    }),
  )

  it.effect("resolves origin-rooted device verification URLs against the opencode.ai console", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              device_code: "device",
              user_code: "user",
              verification_uri_complete: "/console/device?user_code=user&client_id=opencode-cli",
              expires_in: 60,
              interval: 60,
            }),
          ),
        ),
      )
      yield* addPlugin(http)
      const integration = yield* Integration.Service
      const attempt = yield* integration.connection.oauth({
        integrationID: Integration.ID.make("opencode"),
        methodID: Integration.MethodID.make("device"),
        inputs: {},
      })
      expect(attempt.url).toBe("https://opencode.ai/console/device?user_code=user&client_id=opencode-cli")
    }),
  )

  it.effect("rejects malformed device verification URLs", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              device_code: "device",
              user_code: "user",
              verification_uri_complete: "http://[::1",
              expires_in: 60,
              interval: 60,
            }),
          ),
        ),
      )
      yield* addPlugin(http)
      const integration = yield* Integration.Service
      const error = yield* integration.connection
        .oauth({
          integrationID: Integration.ID.make("opencode"),
          methodID: Integration.MethodID.make("device"),
          inputs: {},
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Integration.AuthorizationError)
      expect(String(error.cause)).toContain("Invalid device verification URL")
    }),
  )

  // Gating cases run before the live-server case on purpose: the whole file
  // shares one temp chimera-v2 db, and the live case persists an opencode
  // credential that would make `connected` true here (hasKey short-circuit).
  it.effect("uses a public key and disables paid models without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.opencode),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
            api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
            cost: cost(1),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.opencode)).request.body.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("paid"))).enabled).toBe(false)
      }),
    ),
  )

  it.effect("keeps free models without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.opencode),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("free")),
            api: { id: ModelV2.ID.make("free"), type: "aisdk", package: "test-provider" },
            cost: cost(0),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.opencode)).request.body.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("free"))).enabled).toBe(true)
      }),
    ),
  )

  it.live("loads providers and models from the connected OpenCode server", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const authorization: Array<string | null> = []
        const gate = Promise.withResolvers<void>()
        return {
          authorization,
          release: gate.resolve,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              await gate.promise
              authorization.push(request.headers.get("authorization"))
              const origin = new URL(request.url).origin
              return Response.json({
                config: {
                  enterprise: { url: origin },
                  provider: {
                    remote: {
                      name: "Remote",
                      npm: "@ai-sdk/openai-compatible",
                      api: `${origin}/v1`,
                      env: ["REMOTE_API_KEY"],
                      options: {
                        apiKey: "{env:REMOTE_API_KEY}",
                        headers: { "x-org-id": "org" },
                        custom: "value",
                      },
                      models: {
                        model: {
                          name: "Remote Model",
                          family: "remote",
                          release_date: "2026-01-02",
                          tool_call: true,
                          modalities: { input: ["text", "image"], output: ["text"] },
                          options: { apiKey: "model-secret", temperature: 0.5 },
                          variants: { high: { apiKey: "variant-secret", temperature: 0.2 } },
                          cost: { input: 1, output: 2, cache_read: 0.1 },
                          limit: { context: 1000, output: 100 },
                        },
                        disabled: { name: "Disabled", status: "deprecated" },
                      },
                    },
                  },
                },
              })
            },
          }),
        }
      }),
      ({ authorization, release, server }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          yield* catalog.transform((draft) => {
            draft.provider.update(ProviderV2.ID.make("remote"), () => {})
            draft.model.update(ProviderV2.ID.make("remote"), ModelV2.ID.make("stale"), () => {})
          })
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin },
            }),
          })

          yield* addPlugin()
          expect(authorization).toEqual([])
          release()

          const provider = required(
            yield* eventually(
              catalog.provider.get(ProviderV2.ID.make("remote")),
              (item) => item?.integrationID === Integration.ID.make("opencode"),
            ),
          )
          expect(provider).toMatchObject({
            name: "Remote",
            integrationID: "opencode",
            api: {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `${server.url.origin}/v1`,
            },
          })
          expect(provider.request).toEqual({ headers: { "x-org-id": "org" }, body: { custom: "value" } })
          expect(yield* (yield* Integration.Service).get(Integration.ID.make("remote"))).toBeUndefined()

          const model = required(yield* catalog.model.get(ProviderV2.ID.make("remote"), ModelV2.ID.make("model")))
          expect(model).toMatchObject({
            name: "Remote Model",
            family: "remote",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
            limit: { context: 1000, output: 100 },
          })
          expect(model.request.body).toEqual({ custom: "value", temperature: 0.5 })
          expect(model.variants).toEqual([
            {
              id: ModelV2.VariantID.make("high"),
              headers: {},
              body: { temperature: 0.2 },
            },
          ])
          expect(
            required(yield* catalog.model.get(ProviderV2.ID.make("remote"), ModelV2.ID.make("disabled"))).enabled,
          ).toBe(false)
          expect(yield* catalog.model.get(ProviderV2.ID.make("remote"), ModelV2.ID.make("stale"))).toBeDefined()
          expect(authorization).toContain("Bearer secret")
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )
})
