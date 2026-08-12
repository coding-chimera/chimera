import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Installation } from "../installation"
import { Flag } from "@opencode-ai/core/flag/flag"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { CodexModel } from "./codex-model"

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

const BackendSemantics = Schema.Literals(["openai", "codex"])
const ReasoningEffort = Schema.Literals(CodexModel.REASONING_EFFORTS)
const ReasoningProtocol = Schema.Literals([
  "zhipuai_thinking",
  "dashscope_enable_thinking",
  "vllm_chat_template",
  "anthropic_thinking",
  "google_thinking_config",
])
const ReasoningOption = Schema.Struct({
  type: Schema.String,
  values: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  backend_semantics: Schema.optional(BackendSemantics),
  capability_model_id: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  reasoning_efforts: Schema.optional(Schema.Array(ReasoningEffort)),
  reasoning_protocol: Schema.optional(ReasoningProtocol),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated"])),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export function normalizeCatalog(catalog: Record<string, Provider>) {
  return Object.fromEntries(
    Object.entries(catalog).map(([providerID, provider]) => [
      providerID,
      {
        ...provider,
        models: Object.fromEntries(
          Object.entries(provider.models).map(([modelID, model]) => {
            const capabilityModelID = model.capability_model_id ?? CodexModel.capabilityModelID(model.id)
            const effortOption = model.reasoning_options?.find((option) => option.type === "effort")
            const reasoningEfforts =
              model.reasoning_efforts ??
              (effortOption ? CodexModel.normalizeReasoningEfforts(effortOption.values) : undefined)
            const npm = model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
            const backendSemantics =
              model.backend_semantics ??
              (capabilityModelID &&
              reasoningEfforts?.includes("max") &&
              ["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(npm) &&
              CodexModel.supportsCatalogSemantics(capabilityModelID)
                ? "codex"
                : undefined)
            const reasoningProtocol = inferReasoningProtocol(providerID, model, npm)
            return [
              modelID,
              {
                ...model,
                ...(backendSemantics ? { backend_semantics: backendSemantics } : {}),
                ...(capabilityModelID ? { capability_model_id: capabilityModelID } : {}),
                ...(reasoningEfforts ? { reasoning_efforts: reasoningEfforts } : {}),
                ...(reasoningProtocol ? { reasoning_protocol: reasoningProtocol } : {}),
              },
            ]
          }),
        ),
      },
    ]),
  )
}

// Infers the reasoning protocol that controls how thinking is enabled in the
// request body. Mirrors the providerID/SDK matching previously hardcoded in
// transform.ts options(), but runs at catalog normalization time so custom
// providers inherit the protocol via findKnownModelMetadata cross-provider
// model ID matching.
type ReasoningProtocol =
  | "zhipuai_thinking"
  | "dashscope_enable_thinking"
  | "vllm_chat_template"
  | "anthropic_thinking"
  | "google_thinking_config"

function inferReasoningProtocol(providerID: string, model: Model, npm: string): ReasoningProtocol | undefined {
  if (model.reasoning_protocol) return model.reasoning_protocol
  const id = model.id.toLowerCase()
  const family = model.family?.toLowerCase() ?? ""
  // zhipuai / zai / tencent GLM models use the OpenAI-compatible `thinking`
  // field with clear_thinking to enable reasoning_content output.
  if (
    (family === "glm" || id.includes("glm")) &&
    ["zhipuai", "zai", "tencent"].some((p) => providerID.includes(p)) &&
    npm === "@ai-sdk/openai-compatible"
  ) {
    return "zhipuai_thinking"
  }
  // DashScope (alibaba-cn) requires enable_thinking in the body for reasoning
  // models; kimi-k2-thinking returns reasoning_content by default and is excluded.
  if (
    providerID === "alibaba-cn" &&
    model.reasoning &&
    npm === "@ai-sdk/openai-compatible" &&
    !id.includes("kimi-k2-thinking")
  ) {
    return "dashscope_enable_thinking"
  }
  // vLLM-style chat template arg for providers that deploy GLM/Kimi via
  // baseten or the opencode hosted proxy.
  if (
    providerID === "baseten" ||
    (providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(id))
  ) {
    return "vllm_chat_template"
  }
  // Google AI SDK exposes thinkingConfig for reasoning models.
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    if (model.reasoning) return "google_thinking_config"
  }
  // Anthropic SDK with Kimi K2 models uses budget-token thinking.
  if (
    (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") &&
    (id.includes("k2p") || id.includes("kimi-k2.") || id.includes("kimi-k2p"))
  ) {
    return "anthropic_thinking"
  }
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
  readonly revision: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

const serviceLayer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | EffectFlock.Service | HttpClient.HttpClient
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    let currentRevision = 0

    const source = Flag.OPENCODE_MODELS_URL || "https://models.dev"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", Installation.USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    // Bundled at build time; absent in dev — `tryPromise` covers both.
    const loadSnapshot = Effect.tryPromise({
      // @ts-ignore — generated at build time, may not exist in dev
      try: () => import("./models-snapshot.js").then((m) => m.snapshot as Record<string, Provider> | undefined),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      yield* fs.writeWithDirs(filepath, text)
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent opencode CLIs can race on this cache file.
      const text = yield* Effect.gen(function* () {
        return yield* fetchAndWrite()
      }).pipe(flock.withLock(lockKey))
      return JSON.parse(text) as Record<string, Provider>
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(
      populate.pipe(Effect.map(normalizeCatalog)),
      Duration.infinity,
    )

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.gen(function* () {
        // Re-check under the lock: another process may have refreshed between
        // our outer check and lock acquisition.
        if (!force && (yield* fresh())) return
        yield* fetchAndWrite()
        yield* invalidate
        currentRevision += 1
      }).pipe(
        flock.withLock(lockKey),
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause })),
        Effect.ignore,
      )
    })

    const revision = Effect.fn("ModelsDev.revision")(function* () {
      return currentRevision
    })

    if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh, revision })
  }),
)

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | HttpClient.HttpClient> = serviceLayer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as ModelsDev from "./models"
