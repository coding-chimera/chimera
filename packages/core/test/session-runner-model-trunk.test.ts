import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Exit, Layer, Option, Scope } from "effect"
import { Headers } from "effect/unstable/http"
import { type AuthInput, type AuthShape } from "@coding-chimera/llm/route"
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
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Session runner model trunk (L5.4a) over an isolated per-run db file (temp dir
// + dedicated chimera-v2 test filename; never the production fork chimera.db).
// Exercises the State.create-driven provider -> integration resolution
// roundtrip (4898263dec mapping) against the L5.2 credential/integration trunk
// and the L5.1 Location seam (bound by a test layer; no project/git closure).
const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())
const file = path.join(tmp.path, "chimera-v2-trunk-session-runner-model.db")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionRunnerModel.node,
      Catalog.node,
      Policy.node,
      Integration.node,
      Credential.node,
      EventV2.node,
    ]),
    [
      [Database.node, Database.layerFromPath(file)],
      [Location.node, locationLayer],
    ],
  ),
)

const catalogModel = () =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: {
      id: ModelV2.ID.make("api-test-model"),
      type: "aisdk",
      package: "@ai-sdk/openai",
      url: "https://openai.example/v1",
    },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    request: { headers: { "x-test": "header" }, body: { apiKey: "secret", custom_extension: { enabled: true } } },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

// The credential auth path renders into request headers at apply time; the
// fromCredential Auth only reads `headers` from its input, so a headers-only
// AuthInput is enough to observe the rendered authorization header.
const authorization = (auth: AuthShape) =>
  auth
    .apply({ headers: Headers.empty } as unknown as AuthInput)
    .pipe(Effect.map((headers) => Option.getOrUndefined(Headers.get("authorization")(headers))))

describe("Session runner model trunk", () => {
  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(catalogModel())

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, output: 20 },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
      // The request-body apiKey never leaks into the provider JSON body; it
      // becomes bearer auth instead.
      expect(JSON.stringify(resolved.route.defaults.http?.body)).not.toContain("secret")
      expect(yield* authorization(resolved.route.auth)).toBe("Bearer secret")
    }),
  )

  it.effect("resolves the session model through the catalog and the mapped integration credential", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const runner = yield* SessionRunnerModel.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const providerID = ProviderV2.ID.make("test-provider")
      const modelID = ModelV2.ID.make("test-model")
      const integrationID = Integration.ID.make("test-provider")

      yield* catalog
        .transform((editor) => {
          editor.provider.update(providerID, (provider) => {
            provider.name = "Test provider"
            provider.api = { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }
          })
          editor.model.update(providerID, modelID, (model) => {
            model.name = "Test model"
            model.api = { id: ModelV2.ID.make("api-test-model"), type: "aisdk", package: "@ai-sdk/openai" }
            model.capabilities = { tools: false, input: ["text"], output: ["text"] }
            model.limit = { context: 100, output: 20 }
          })
        })
        .pipe(Scope.provide(scope))

      // Provider without integrationID maps to Integration.ID.make(provider.id)
      // (4898263dec); registering a key connection for it makes the provider
      // available and feeds the credential into the resolved route auth.
      yield* integrations
        .transform((editor) => {
          editor.update(integrationID, (integration) => (integration.name = "Test provider"))
          editor.method.update({ integrationID, method: { type: "key", label: "API key" } })
        })
        .pipe(Scope.provide(scope))
      yield* integrations.connection.key({ integrationID, key: "integration-secret", label: "Work" })

      const session: SessionSchema.Info = {
        id: SessionSchema.ID.create(),
        projectID: ProjectID.global,
        model: { providerID, id: modelID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        title: "test",
        location: { directory: AbsolutePath.make(tmp.path) },
      }

      const resolved = yield* runner.resolve(session)
      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
      })
      expect(yield* authorization(resolved.route.auth)).toBe("Bearer integration-secret")

      yield* Scope.close(scope, Exit.void)
    }),
  )
})
