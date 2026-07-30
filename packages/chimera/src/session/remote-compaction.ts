import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { makeRuntime } from "@/effect/run-service"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import os from "os"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import z from "zod"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "./schema"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"
import type { RemoteCompactionLock } from "./session"
import { MessageV2 } from "./message-v2"
import { codexAuthHeaders, codexEndpointUrl } from "@/plugin/codex"
import type { ModelMessage } from "ai"
import {
  bindingFromTransportIdentity,
  decodeRemoteCompactionInput,
  decodeRemoteCompactionOutput,
  rewriteRemoteCompactionInput,
  sameRemoteCompactionBinding,
  type RemoteCompactionImplementation,
  type RemoteCompactionMetadata,
  type RemoteCompactionOutputItem,
  type RemoteCompactionReplayBinding,
  type RemoteCompactionUsage,
} from "./remote-compaction-codec"
import { ResponsesTransport } from "@/provider/responses-transport"
import { isModelRemoteCompactionCapable, isProviderRemoteCompactionDegraded, recordRemoteCompactionFailure, resetRemoteCompactionHealth } from "./remote-compaction-registry"

const log = Log.create({ service: "remote.compaction" })

type ResponsesMessageItem = {
  type: "message"
  role: "user" | "assistant"
  content: { type: "input_text" | "output_text"; text: string }[]
}

type ResponsesInputItem = RemoteCompactionOutputItem | ResponsesMessageItem

type ResponsesCompactionTriggerItem = {
  type: "compaction_trigger"
}

type RemoteCompactionProtocol = "auto" | "v2" | "legacy"

type SseEvent = {
  event: string | undefined
  data: unknown
}

const TOOL_OUTPUT_MAX_CHARS = 2_000
const DEFAULT_COMPACTION_TIMEOUT = "60 seconds"
const DEFAULT_COMPACTION_ATTEMPTS = 2
const LEGACY_IMPLEMENTATION = "responses_compact" as const
const V2_IMPLEMENTATION = "responses_compaction_v2" as const

type RemoteCompactionOptions = {
  timeout?: Parameters<typeof Effect.sleep>[0]
  attempts?: number
  responsesEndpoint?: string
  legacyEndpoint?: string
}

export class RemoteCompactionError extends Schema.TaggedErrorClass<RemoteCompactionError>()(
  "RemoteCompactionError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    retryable: Schema.optional(Schema.Boolean),
    attempts: Schema.optional(Schema.Number),
    implementation: Schema.optional(
      Schema.Union([Schema.Literal("responses_compact"), Schema.Literal("responses_compaction_v2")]),
    ),
  },
) {}

export const StatusQuery = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
  sessionID: Schema.optional(SessionID),
})
  .annotate({ identifier: "RemoteCompactionStatusQuery" })
  .pipe(
    withStatics(() => ({
      zod: z
        .object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          sessionID: (z.string() as unknown as z.ZodType<SessionID>).optional(),
        })
        .strict(),
    })),
  )
export type StatusQuery = Schema.Schema.Type<typeof StatusQuery>

export const PolicyPatch = Schema.StructWithRest(
  Schema.Struct({
    remote: Schema.optional(Schema.Union([Schema.Literals(["auto", "on", "off"]), Schema.Null])),
    remote_protocol: Schema.optional(Schema.Union([Schema.Literals(["auto", "v2", "legacy"]), Schema.Null])),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
  .annotate({ identifier: "RemoteCompactionPolicyPatch" })
  .pipe(
    withStatics(() => ({
      zod: z
        .object({
          remote: z.enum(["auto", "on", "off"]).nullable().optional(),
          remote_protocol: z.enum(["auto", "v2", "legacy"]).nullable().optional(),
        })
        .strict(),
    })),
  )
export type PolicyPatch = Schema.Schema.Type<typeof PolicyPatch>

export const SourceCategory = Schema.Literals(["default", "global", "project", "environment", "account", "managed"])
export type SourceCategory = Schema.Schema.Type<typeof SourceCategory>

export const ValueMetadata = Schema.Struct({
  source: SourceCategory,
  explicitAtWriteTarget: Schema.Boolean,
})
export type ValueMetadata = Schema.Schema.Type<typeof ValueMetadata>

export const WriteTargetMetadata = Schema.Struct({
  source: Schema.Literal("project"),
  format: Schema.Literals(["json", "jsonc"]),
  exists: Schema.Boolean,
})
export type WriteTargetMetadata = Schema.Schema.Type<typeof WriteTargetMetadata>

export const PolicyMetadata = Schema.Struct({
  remote: ValueMetadata,
  remote_protocol: ValueMetadata,
  writeTarget: WriteTargetMetadata,
})
export type PolicyMetadata = Schema.Schema.Type<typeof PolicyMetadata>

export const Policy = Schema.Struct({
  remote: Schema.Literals(["auto", "on", "off"]),
  remote_protocol: Schema.Literals(["auto", "v2", "legacy"]),
  metadata: PolicyMetadata,
})
  .annotate({ identifier: "RemoteCompactionPolicy" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Policy = Schema.Schema.Type<typeof Policy>

export const ResolutionReason = Schema.Literals([
  "policy_off",
  "provider_capability_missing",
  "model_disabled",
  "wire_api_not_responses",
  "credential_unavailable",
  "protocol_mismatch",
  "routing_identity_unsafe",
  "model_unsupported",
  "ready",
])
export type ResolutionReason = Schema.Schema.Type<typeof ResolutionReason>

export const ReplayReason = Schema.Literals([
  "no_lock",
  "exact_binding",
  "model_mismatch",
  "transport_unavailable",
  "wire_api_not_responses",
  "binding_mismatch",
  "credential_unavailable",
  "routing_identity_unsafe",
])
export type ReplayReason = Schema.Schema.Type<typeof ReplayReason>

export const LockResolution = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({
    status: Schema.Literals(["exact", "route_mismatch", "model_mismatch"]),
    endpoint: Schema.Literals(["openai-codex", "provider"]),
    providerID: Schema.String,
    modelID: Schema.String,
  }),
])
export type LockResolution = Schema.Schema.Type<typeof LockResolution>

export const ReplayResolution = Schema.Struct({
  mode: Schema.Literals(["none", "encoded", "full_history", "blocked"]),
  reason: ReplayReason,
})
export type ReplayResolution = Schema.Schema.Type<typeof ReplayResolution>

export type ResolveInput = {
  model: Provider.Model
  session?: { sessionID?: SessionID; lock?: RemoteCompactionLock }
}

const ReplayBinding = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  wireModelID: Schema.String,
  driver: Schema.Literal("codex-responses"),
  format: Schema.Literal("responses_compaction_v1"),
  wire_api: Schema.Literal("responses"),
  compatibility_key: Schema.String,
})

export const Resolution = Schema.Struct({
  configured: Schema.Struct({
    mode: Schema.Literals(["off", "auto", "on"]),
    protocol: Schema.Literals(["auto", "v2", "legacy"]),
    metadata: Schema.optional(PolicyMetadata),
  }),
  requested: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
  effective: Schema.Struct({ providerID: Schema.String, modelID: Schema.String, wireModelID: Schema.String }),
  mode: Schema.Literals(["remote", "local"]),
  target: Schema.Literals(["openai-codex", "provider", "local"]),
  profile: Schema.optional(Schema.Literal("codex-responses")),
  driver: Schema.optional(Schema.Literal("codex-responses")),
  credential: Schema.Literals(["oauth", "provider-bearer", "configured", "missing", "unavailable"]),
  protocols: Schema.Array(Schema.Literals(["v2", "legacy"])),
  localFallback: Schema.Literal(true),
  reason: ResolutionReason,
  binding: Schema.optional(ReplayBinding),
  lock: LockResolution,
  replay: ReplayResolution,
})
  .annotate({ identifier: "RemoteCompactionResolution" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Resolution = Schema.Schema.Type<typeof Resolution>

const EligibilityProtocols = Schema.Union([
  Schema.Tuple([Schema.Literals(["v2", "legacy"])]),
  Schema.Tuple([Schema.Literal("v2"), Schema.Literal("legacy")]),
  Schema.Tuple([Schema.Literal("legacy"), Schema.Literal("v2")]),
])

export const EligibilityPatch = Schema.StructWithRest(
  Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    enabled: Schema.Union([Schema.Boolean, Schema.Null]),
    protocols: Schema.optional(EligibilityProtocols),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
  .annotate({ identifier: "RemoteCompactionEligibilityPatch" })
  .pipe(
    withStatics(() => ({
      zod: z
        .object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          enabled: z.boolean().nullable(),
          protocols: z
            .union([
              z.tuple([z.enum(["v2", "legacy"])]),
              z.tuple([z.literal("v2"), z.literal("legacy")]),
              z.tuple([z.literal("legacy"), z.literal("v2")]),
            ])
            .optional(),
        })
        .passthrough(),
    })),
  )
export type EligibilityPatch = Schema.Schema.Type<typeof EligibilityPatch>

export const EligibilityMetadata = Schema.Struct({
  modelRemoteCompaction: ValueMetadata,
  protocols: ValueMetadata,
  writeTarget: WriteTargetMetadata,
})
export type EligibilityMetadata = Schema.Schema.Type<typeof EligibilityMetadata>

export const Eligibility = Schema.Struct({
  providerID: Schema.String,
  providerName: Schema.String,
  modelID: Schema.String,
  modelName: Schema.String,
  apiNpm: Schema.String,
  wire_api: Schema.Literals(["chat", "responses"]),
  providerCapability: Schema.Struct({
    present: Schema.Boolean,
    protocols: Schema.Array(Schema.Literals(["v2", "legacy"])),
  }),
  modelRemoteCompaction: Schema.Literals(["enabled", "disabled", "unset"]),
  configurable: Schema.Boolean,
  metadata: EligibilityMetadata,
})
  .annotate({ identifier: "RemoteCompactionEligibility" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Eligibility = Schema.Schema.Type<typeof Eligibility>

export const EligibilityList = Schema.Struct({
  items: Schema.Array(Eligibility),
})
  .annotate({ identifier: "RemoteCompactionEligibilityList" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type EligibilityList = Schema.Schema.Type<typeof EligibilityList>

export const EligibilityErrorReason = Schema.Literals([
  "unknown_provider",
  "unknown_model",
  "not_configurable",
  "unknown_field",
])
export type EligibilityErrorReason = Schema.Schema.Type<typeof EligibilityErrorReason>

const EligibilityErrorFields = {
  name: Schema.Literal("RemoteCompactionEligibilityError"),
  data: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
    reason: EligibilityErrorReason,
  }),
}

export const EligibilityErrorResponse = Schema.Struct(EligibilityErrorFields)
  .annotate({ identifier: "RemoteCompactionEligibilityError" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type EligibilityErrorResponse = Schema.Schema.Type<typeof EligibilityErrorResponse>

export class EligibilityError extends Schema.ErrorClass<EligibilityError>("RemoteCompactionEligibilityError")(
  EligibilityErrorFields,
  { httpApiStatus: 400 },
) {}

export function eligibilityError(input: { providerID: string; modelID: string; reason: EligibilityErrorReason }) {
  return { name: "RemoteCompactionEligibilityError" as const, data: input }
}

const ELIGIBLE_PROVIDER_PACKAGES = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible"])

type EligibilityContext = {
  modelRemoteCompaction: boolean | undefined
  metadata: EligibilityMetadata
}

function valueMetadata(
  resolution: Config.ValueResolution,
  input?: { source: Config.SourceCategory; explicitAtWriteTarget: boolean },
): ValueMetadata {
  return {
    source: input?.source ?? resolution.source,
    explicitAtWriteTarget: input?.explicitAtWriteTarget ?? resolution.explicitAtWriteTarget,
  }
}

export function policy(config: Config.Interface) {
  return Effect.gen(function* () {
    const [remote, protocol] = yield* Effect.all([
      config.resolve(["compaction", "remote"]),
      config.resolve(["compaction", "remote_protocol"]),
    ])
    return {
      remote: (remote.value as Policy["remote"] | undefined) ?? "auto",
      remote_protocol: (protocol.value as Policy["remote_protocol"] | undefined) ?? "auto",
      metadata: {
        remote: valueMetadata(remote),
        remote_protocol: valueMetadata(protocol),
        writeTarget: remote.writeTarget,
      },
    } satisfies Policy
  })
}

export function configured(policy: Policy) {
  return {
    mode: policy.remote,
    protocol: policy.remote_protocol,
    metadata: policy.metadata,
  } satisfies Resolution["configured"]
}

export function eligibilityContext(
  config: Config.Interface,
  input: Pick<EligibilityPatch, "providerID" | "modelID">,
) {
  return Effect.gen(function* () {
    const [model, protocols] = yield* Effect.all([
      config.resolve(["provider", input.providerID, "models", input.modelID, "remote_compaction"]),
      config.resolve(["provider", input.providerID, "remote_compaction", "protocols"]),
    ])
    return {
      modelRemoteCompaction: model.value as boolean | undefined,
      metadata: {
        modelRemoteCompaction: valueMetadata(model),
        protocols: valueMetadata(protocols),
        writeTarget: model.writeTarget,
      },
    } satisfies EligibilityContext
  })
}

function currentEligibilityContext(
  model: Provider.Model,
  modelMetadata?: Config.ValueResolution,
  protocolMetadata?: Config.ValueResolution,
): EligibilityContext {
  return {
    modelRemoteCompaction: model.remote_compaction,
    metadata: {
      modelRemoteCompaction: modelMetadata
        ? valueMetadata(modelMetadata)
        : { source: "default", explicitAtWriteTarget: false },
      protocols: protocolMetadata
        ? valueMetadata(protocolMetadata)
        : { source: "default", explicitAtWriteTarget: false },
      writeTarget: modelMetadata?.writeTarget ?? { source: "project", format: "json", exists: false },
    },
  }
}

export function eligibility(
  provider: Provider.Info,
  model: Provider.Model,
  context = currentEligibilityContext(model),
): Eligibility {
  const enabled = context.modelRemoteCompaction
  return {
    providerID: provider.id,
    providerName: provider.name,
    modelID: model.id,
    modelName: model.name,
    apiNpm: model.api.npm,
    wire_api: model.wire_api ?? provider.wire_api ?? "chat",
    providerCapability: {
      present: provider.remote_compaction !== undefined,
      protocols: [...(provider.remote_compaction?.protocols ?? [])],
    },
    modelRemoteCompaction: enabled === true ? "enabled" : enabled === false ? "disabled" : "unset",
    configurable: provider.id !== "openai" && isModelRemoteCompactionCapable(model) && provider.remote_compaction !== undefined,
    metadata: context.metadata,
  }
}

export function eligibilityList(providers: Record<string, Provider.Info>, config?: Config.Interface) {
  const items = Object.values(providers)
    .filter((provider) => provider.id !== "openai")
    .flatMap((provider) => Object.values(provider.models).map((model) => ({ provider, model })))
  const build = (contexts: EligibilityContext[]) => ({
    items: items
      .map((item, index) => eligibility(item.provider, item.model, contexts[index]))
      .sort((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`)),
  })
  if (!config) return Effect.succeed(build(items.map((item) => currentEligibilityContext(item.model))))
  return Effect.all(
    items.map((item) =>
      Effect.all([
        config.resolve(["provider", item.provider.id, "models", item.model.id, "remote_compaction"]),
        config.resolve(["provider", item.provider.id, "remote_compaction", "protocols"]),
      ]).pipe(Effect.map(([model, protocols]) => currentEligibilityContext(item.model, model, protocols))),
    ),
  ).pipe(Effect.map(build))
}

export function eligibilityConfigPatch(input: EligibilityPatch): Config.Info {
  if (input.enabled === null) return {}
  return {
    provider: {
      [input.providerID]: {
        models: {
          [input.modelID]: input.enabled
            ? { wire_api: "responses", remote_compaction: true }
            : { remote_compaction: false },
        },
      },
    },
  }
}

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Resolution>
  readonly canCompact: (input: { model: Provider.Model }) => Effect.Effect<boolean>
  readonly compact: (input: {
    sessionID: SessionID
    model: Provider.Model
    messages: MessageV2.WithParts[]
    instructions: string
  }) => Effect.Effect<RemoteCompactionMetadata, RemoteCompactionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RemoteCompaction") {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function remoteError(cause: unknown) {
  return cause instanceof RemoteCompactionError ? cause : new RemoteCompactionError({ message: errorMessage(cause) })
}

function durationLabel(duration: Parameters<typeof Effect.sleep>[0]) {
  return typeof duration === "number" || typeof duration === "string" ? String(duration) : "configured timeout"
}

export function supportsOpenAIRemoteCompactionModel(model: Provider.Model) {
  return isModelRemoteCompactionCapable(model)
}

function truncate(text: string) {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[Tool output truncated for remote compaction]`
}

function roleForResponses(role: unknown): "user" | "assistant" {
  return role === "assistant" || role === "tool" ? "assistant" : "user"
}

function messageText(parts: string[], role: "user" | "assistant"): ResponsesInputItem[] {
  if (!parts.length) return []
  return [
    {
      type: "message",
      role,
      content: parts.map((text) => ({ type: role === "assistant" ? "output_text" : "input_text", text })),
    },
  ]
}

function textFromRecord(value: Record<string, unknown>) {
  if (typeof value.text === "string") return value.text
  if (typeof value.errorText === "string") return value.errorText
  if (typeof value.value === "string") return value.value
  if (typeof value.output === "string") return value.output
  return undefined
}

function inputFromText(text: string, role: "user" | "assistant") {
  return decodeRemoteCompactionInput(text) ?? messageText([text], role)
}

function inputFromContent(content: unknown, role: "user" | "assistant"): ResponsesInputItem[] {
  if (typeof content === "string") return inputFromText(content, role)
  if (!Array.isArray(content)) return []
  const items = content.flatMap((part): ResponsesInputItem[] => {
    if (!isRecord(part)) return []
    const text = textFromRecord(part)
    if (text) return inputFromText(text, role)
    if (part.type === "file" || part.type === "image" || part.type === "media") {
      return messageText([`[Attached ${String(part.mediaType ?? part.mime ?? "file")}: ${String(part.filename ?? "file")}]`], role)
    }
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      const output = typeof part.output === "string" ? truncate(part.output) : JSON.stringify(part.output ?? part.errorText ?? "")
      return messageText([`Tool ${part.type.slice(5)} result:\n${output}`], "assistant")
    }
    return []
  })
  const remote = items.flatMap((item) => (item.type === "compaction" || item.type === "compaction_summary" ? [item] : []))
  if (remote.length) return remote
  return messageText(
    items.flatMap((item) => (item.type === "message" ? item.content.map((part) => part.text) : [])),
    role,
  )
}

const responsesInput = Effect.fn("RemoteCompaction.responsesInput")(function* (
  messages: MessageV2.WithParts[],
  model: Provider.Model,
) {
  const modelMessages = yield* MessageV2.toModelMessagesEffect(messages, model, {
    stripMedia: true,
    toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
    remoteCompaction: "encoded",
  })
  return modelMessages.flatMap((message: ModelMessage): ResponsesInputItem[] => {
    if (!isRecord(message)) return []
    return inputFromContent(message.content, roleForResponses(message.role))
  })
})

function responsesEndpointFrom(endpoint: string) {
  const trimmed = endpoint.replace(/\/+$/, "")
  if (trimmed.endsWith("/compact")) return trimmed.slice(0, -"/compact".length)
  return endpoint
}

function legacyEndpointFrom(endpoint: string) {
  const trimmed = endpoint.replace(/\/+$/, "")
  if (trimmed.endsWith("/compact")) return endpoint
  return codexEndpointUrl("responses/compact", endpoint)
}

function protocolsFor(protocol: RemoteCompactionProtocol) {
  if (protocol === "legacy") return [LEGACY_IMPLEMENTATION]
  if (protocol === "v2") return [V2_IMPLEMENTATION]
  return [V2_IMPLEMENTATION, LEGACY_IMPLEMENTATION]
}

function withImplementation(error: RemoteCompactionError, implementation: RemoteCompactionImplementation) {
  return new RemoteCompactionError({
    message: error.message,
    status: error.status,
    retryable: error.retryable,
    attempts: error.attempts,
    implementation,
  })
}

function sseEvents(body: string): Array<SseEvent | RemoteCompactionError> {
  return body
    .split(/\r?\n\r?\n/)
    .map((block): SseEvent | RemoteCompactionError | undefined => {
      const lines = block.split(/\r?\n/)
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n")
      if (!data || data === "[DONE]") return undefined
      try {
        const parsed = JSON.parse(data)
        const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim()
        return { event: isRecord(parsed) && typeof parsed.type === "string" ? parsed.type : event, data: parsed }
      } catch {
        return new RemoteCompactionError({
          message: "remote compaction v2 stream contained invalid JSON",
          implementation: V2_IMPLEMENTATION,
        })
      }
    })
    .filter((event): event is SseEvent | RemoteCompactionError => event !== undefined)
}

function outputItemFromEvent(data: unknown) {
  if (!isRecord(data)) return undefined
  if (isRecord(data.item)) return data.item
  return data
}

function usageFromCompleted(data: unknown): RemoteCompactionUsage | undefined {
  if (!isRecord(data) || !isRecord(data.usage)) return undefined
  const usage = Object.fromEntries(
    Object.entries(data.usage).filter((entry): entry is [string, number] => {
      const value = entry[1]
      return typeof value === "number" && Number.isFinite(value) && value >= 0
    }),
  )
  return Object.keys(usage).length ? usage : undefined
}

function remoteHttpErrorMessage(status: number, body: string) {
  const base =
    status === 401 || status === 403
      ? `remote compaction failed: ${status} Codex remote compaction authorization or entitlement failed; verify the selected ChatGPT account has Codex access and re-authenticate if needed.`
      : `remote compaction failed: ${status}`
  return [base, body.trim().slice(0, 500)].filter(Boolean).join(" ")
}

function parseV2CompactionStream(body: string) {
  const events = sseEvents(body)
  const invalid = events.find((event) => event instanceof RemoteCompactionError)
  if (invalid instanceof RemoteCompactionError) return invalid
  const parsedEvents = events.filter(
    (event): event is { event: string | undefined; data: unknown } => !(event instanceof RemoteCompactionError),
  )
  if (!parsedEvents.some((event) => event.event === "response.completed")) {
    return new RemoteCompactionError({
      message: "remote compaction v2 schema drift: stream closed before response.completed",
      retryable: true,
      implementation: V2_IMPLEMENTATION,
    })
  }
  const completed = parsedEvents.find((event) => event.event === "response.completed")
  const outputItems = parsedEvents
    .filter((event) => event.event === "response.output_item.done")
    .map((event) => outputItemFromEvent(event.data))
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "compaction")
  if (outputItems.some((item) => typeof item.encrypted_content !== "string")) {
    return new RemoteCompactionError({
      message: "remote compaction v2 schema drift: compaction output missing encrypted_content",
      implementation: V2_IMPLEMENTATION,
    })
  }
  const output = outputItems.map(
    (item): RemoteCompactionOutputItem => ({ type: "compaction", encrypted_content: item.encrypted_content as string }),
  )
  if (output.length !== 1) {
    return new RemoteCompactionError({
      message: `remote compaction v2 schema drift: expected exactly one compaction output item, got ${output.length}`,
      implementation: V2_IMPLEMENTATION,
    })
  }
  return { output, usage: usageFromCompleted(completed?.data) }
}

export function failureMetadata(input: { model: Provider.Model; error: RemoteCompactionError }) {
  const common = {
    implementation: input.error.implementation ?? LEGACY_IMPLEMENTATION,
    modelID: input.model.id,
    message: input.error.message,
    ...(input.error.status === undefined ? {} : { status: input.error.status }),
    ...(input.error.attempts === undefined ? {} : { attempts: input.error.attempts }),
    ...(input.error.retryable === undefined ? {} : { retryable: input.error.retryable }),
    time: Date.now(),
  }
  if (input.model.providerID === "openai")
    return { providerID: "openai" as const, endpoint: "codex" as const, ...common }
  return {
    providerID: input.model.providerID,
    endpoint: "provider" as const,
    wireModelID: input.model.api.id,
    ...common,
  }
}

export const layerWithEndpoint = (endpoint = codexEndpointUrl("responses/compact"), options: RemoteCompactionOptions = {}): Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | HttpClient.HttpClient
> => Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const timeout = options.timeout ?? DEFAULT_COMPACTION_TIMEOUT
    const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_COMPACTION_ATTEMPTS))
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const responsesEndpoint = options.responsesEndpoint ?? responsesEndpointFrom(endpoint)
    const legacyEndpoint = options.legacyEndpoint ?? legacyEndpointFrom(endpoint)

    const resolve = Effect.fn("RemoteCompaction.resolve")(function* (input: ResolveInput) {
      const selectedPolicy = yield* policy(config)
      const configured = {
        mode: selectedPolicy.remote,
        protocol: selectedPolicy.remote_protocol,
        metadata: selectedPolicy.metadata,
      } satisfies Resolution["configured"]
      const common = {
        configured,
        requested: { providerID: input.model.providerID, modelID: input.model.id },
        effective: {
          providerID: input.model.providerID,
          modelID: input.model.id,
          wireModelID: input.model.api.id,
        },
        localFallback: true as const,
      }
      type ProductionResolution = Omit<Resolution, "lock" | "replay">
      const resolved = (value: Resolution) => value
      const local = (
        reason: ResolutionReason,
        credential: Resolution["credential"] = "unavailable",
      ): ProductionResolution => ({
        ...common,
        mode: "local",
        target: "local",
        credential,
        protocols: [],
        reason,
      })
      // Smart degradation: skip remote for degraded non-OAuth providers
      const isOAuth = (yield* auth.get(input.model.providerID).pipe(Effect.orElseSucceed(() => undefined)))?.type === "oauth"
      if (!isOAuth && isProviderRemoteCompactionDegraded(input.model.providerID)) {
        return resolved({
          ...common,
          mode: "local",
          target: "local",
          credential: "unavailable",
          protocols: [],
          reason: "routing_identity_unsafe",
          lock: { status: "none" },
          replay: { mode: "none", reason: "no_lock" },
        })
      }
      const stored = yield* auth.get(input.model.providerID).pipe(Effect.orElseSucceed(() => undefined))
      const info = provider
        ? yield* provider.getProvider(input.model.providerID).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const needsProviderTransport =
        !!provider &&
        (!!info?.remote_compaction ||
          (input.session?.lock?.endpoint === "provider" &&
            input.session.lock.providerID === input.model.providerID &&
            input.session.lock.modelID === input.model.id))
      const transport = needsProviderTransport
        ? yield* provider
            .getResponsesTransport(input.model.providerID, input.model.id)
            .pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const currentBinding = transport ? bindingFromTransportIdentity(transport.identity) : undefined
      const production: ProductionResolution = yield* Effect.gen(function* () {
        if (configured.mode === "off") return local("policy_off")
        if (stored?.type === "oauth") {
          if (input.model.remote_compaction === false) return local("model_disabled")
          if (!supportsOpenAIRemoteCompactionModel(input.model)) return local("model_unsupported")
          if (stored?.type !== "oauth") return local("credential_unavailable", "missing")
          return {
            ...common,
            mode: "remote" as const,
            target: "openai-codex" as const,
            driver: "codex-responses" as const,
            credential: "oauth" as const,
            protocols: protocolsFor(configured.protocol).map((item) =>
              item === V2_IMPLEMENTATION ? "v2" as const : "legacy" as const,
            ),
            reason: "ready" as const,
          }
        }
        if (!provider || !info?.remote_compaction) return local("provider_capability_missing")
        if (!isModelRemoteCompactionCapable(input.model)) return local("model_unsupported")
        if (input.model.remote_compaction !== true) return local("model_disabled")
        if (input.model.wire_api !== "responses") return local("wire_api_not_responses")
        if (!transport?.identity.ready) return local("credential_unavailable", "missing")
        if (!transport.identity.replay.eligible) return local("routing_identity_unsafe", transport.identity.auth)
        const requested = configured.protocol === "auto" ? info.remote_compaction.protocols : [configured.protocol]
        const protocols = requested.filter((item) => info.remote_compaction!.protocols.includes(item))
        if (!protocols.length) return local("protocol_mismatch", transport.identity.auth)
        return {
          ...common,
          mode: "remote" as const,
          target: "provider" as const,
          profile: "codex-responses" as const,
          driver: "codex-responses" as const,
          credential: transport.identity.auth,
          protocols,
          reason: "ready" as const,
          binding: currentBinding,
        }
      })
      const installed = input.session?.lock
      if (!installed)
        return resolved({
          ...production,
          lock: { status: "none" },
          replay: { mode: "none", reason: "no_lock" },
        })
      const identity = {
        endpoint: installed.endpoint === "codex" ? "openai-codex" as const : "provider" as const,
        providerID: installed.providerID,
        modelID: installed.modelID,
      }
      if (installed.providerID !== input.model.providerID || installed.modelID !== input.model.id)
        return resolved({
          ...production,
          lock: { status: "model_mismatch", ...identity },
          replay: { mode: "blocked", reason: "model_mismatch" },
        })
      if (installed.endpoint === "codex")
        return resolved({
          ...production,
          lock: { status: "exact", ...identity },
          replay:
            stored?.type === "oauth"
              ? { mode: "encoded", reason: "exact_binding" }
              : { mode: "full_history", reason: "credential_unavailable" },
        })
      if (input.model.wire_api !== "responses")
        return resolved({
          ...production,
          lock: { status: "exact", ...identity },
          replay: { mode: "full_history", reason: "wire_api_not_responses" },
        })
      const installedBinding: RemoteCompactionReplayBinding = {
        providerID: installed.providerID,
        modelID: installed.modelID,
        wireModelID: installed.wireModelID,
        driver: installed.driver,
        format: installed.format,
        wire_api: installed.wireAPI,
        compatibility_key: installed.compatibilityKey,
      }
      if (!currentBinding || !sameRemoteCompactionBinding(installedBinding, currentBinding))
        return resolved({
          ...production,
          lock: { status: "route_mismatch", ...identity },
          replay: {
            mode: "full_history",
            reason: currentBinding ? "binding_mismatch" : "transport_unavailable",
          },
        })
      return resolved({
        ...production,
        lock: { status: "exact", ...identity },
        replay: transport?.identity.ready
          ? transport.identity.replay.eligible
            ? { mode: "encoded", reason: "exact_binding" }
            : { mode: "full_history", reason: "routing_identity_unsafe" }
          : { mode: "full_history", reason: "credential_unavailable" },
      })
    })

    const canCompact = Effect.fn("RemoteCompaction.canCompact")(function* (input: { model: Provider.Model }) {
      return (yield* resolve(input)).mode === "remote"
    })

    const compact = Effect.fn("RemoteCompaction.compact")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      messages: MessageV2.WithParts[]
      instructions: string
    }) {
      const storedCredential = yield* auth.get(input.model.providerID).pipe(Effect.orElseSucceed(() => undefined))
      const isOAuthCredential = storedCredential?.type === "oauth"
      return yield* compactInternal(input).pipe(
        Effect.tap(() => Effect.sync(() => resetRemoteCompactionHealth(input.model.providerID))),
        Effect.tapError(() => Effect.sync(() => recordRemoteCompactionFailure(input.model.providerID, isOAuthCredential))),
      )
    })

    const compactInternal = Effect.fn("RemoteCompaction.compactInternal")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      messages: MessageV2.WithParts[]
      instructions: string
    }) {
      const resolution = yield* resolve(input)
      const firstImplementation =
        resolution.protocols[0] === "legacy" ? LEGACY_IMPLEMENTATION : V2_IMPLEMENTATION
      if (resolution.mode !== "remote") {
        return yield* new RemoteCompactionError({
          message: `remote compaction unavailable: ${resolution.reason}`,
          implementation: firstImplementation,
        })
      }
      if (resolution.target === "provider") {
        if (!provider)
          return yield* new RemoteCompactionError({
            message: `provider ${input.model.providerID} remote compaction transport is unavailable`,
            implementation: firstImplementation,
          })
        const transport = yield* provider.getResponsesTransport(input.model.providerID, input.model.id).pipe(
          Effect.mapError(
            () =>
              new RemoteCompactionError({
                message: `provider ${input.model.providerID} remote compaction transport is unavailable`,
                implementation: firstImplementation,
              }),
          ),
        )
        const requestInput = yield* responsesInput(input.messages, input.model)
        const binding = bindingFromTransportIdentity(transport.identity)
        const body = {
          model: transport.identity.wireModelID,
          input: requestInput,
          instructions: input.instructions,
          tools: [],
          parallel_tool_calls: false,
          prompt_cache_key: input.sessionID,
          store: false,
        }
        const runProtocol = (protocol: "v2" | "legacy") => {
          const implementation = protocol === "v2" ? V2_IMPLEMENTATION : LEGACY_IMPLEMENTATION
          const target = protocol === "v2" ? "responses" as const : "responses/compact" as const
          const payload =
            protocol === "v2"
              ? {
                  ...body,
                  input: [...requestInput, { type: "compaction_trigger" } satisfies ResponsesCompactionTriggerItem],
                  stream: true,
                }
              : body
          const rewritten = rewriteRemoteCompactionInput(JSON.stringify(payload), binding)
          const execute: (attempt: number) => Effect.Effect<RemoteCompactionMetadata, RemoteCompactionError> = (attempt) =>
            Effect.tryPromise({
              try: () =>
                transport.execute(target, {
                  body: rewritten,
                  feature: protocol === "v2" ? "remote-compaction-v2" : undefined,
                  timeout: Duration.toMillis(Duration.fromInputUnsafe(timeout)),
                }),
              catch: (cause) =>
                new RemoteCompactionError({
                  message: `provider ${input.model.providerID} ${protocol} remote compaction transport failed`,
                  retryable:
                    cause instanceof ResponsesTransport.Error &&
                    (cause.kind === "timeout" || cause.kind === "network"),
                  implementation,
                }),
            }).pipe(
              Effect.flatMap((response) => {
                if (response.status < 200 || response.status >= 300)
                  return Effect.fail(
                    new RemoteCompactionError({
                      message: `provider ${input.model.providerID} ${protocol} remote compaction failed with HTTP ${response.status}`,
                      status: response.status,
                      retryable: response.status === 429 || response.status >= 500,
                      implementation,
                    }),
                  )
                const parsed =
                  protocol === "v2"
                    ? parseV2CompactionStream(response.body)
                    : (() => {
                        try {
                          const json = JSON.parse(response.body)
                          const output = isRecord(json) ? decodeRemoteCompactionOutput(json.output) : undefined
                          return output?.length === 1
                            ? { output, usage: undefined }
                            : new RemoteCompactionError({
                                message: `provider ${input.model.providerID} legacy remote compaction response was invalid`,
                                implementation,
                              })
                        } catch {
                          return new RemoteCompactionError({
                            message: `provider ${input.model.providerID} legacy remote compaction response was invalid`,
                            implementation,
                          })
                        }
                      })()
                if (parsed instanceof RemoteCompactionError) return Effect.fail(parsed)
                return Effect.succeed({
                  providerID: input.model.providerID,
                  endpoint: "provider" as const,
                  driver: "codex-responses" as const,
                  profile: "codex-responses" as const,
                  implementation,
                  modelID: input.model.id,
                  wireModelID: transport.identity.wireModelID,
                  replay: {
                    format: "responses_compaction_v1" as const,
                    wire_api: "responses" as const,
                    compatibility_key: transport.identity.compatibilityKey,
                  },
                  output: parsed.output,
                  ...(parsed.usage ? { usage: parsed.usage } : {}),
                })
              }),
              Effect.catch((error) =>
                error.retryable && attempt < attempts
                  ? execute(attempt + 1)
                  : Effect.fail(
                      attempt > 1
                        ? new RemoteCompactionError({ ...error, attempts: attempt, implementation })
                        : error,
                    ),
              ),
            )
          return execute(1)
        }
        const runOrdered = (index: number): Effect.Effect<RemoteCompactionMetadata, RemoteCompactionError> => {
          const protocol = resolution.protocols[index]
          if (!protocol)
            return Effect.fail(
              new RemoteCompactionError({
                message: `provider ${input.model.providerID} remote compaction has no authorized protocol`,
              }),
            )
          return runProtocol(protocol).pipe(
            Effect.catch((error) =>
              resolution.protocols[index + 1] ? runOrdered(index + 1) : Effect.fail(error),
            ),
          )
        }
        return yield* runOrdered(0)
      }
      const stored = yield* auth.get("openai").pipe(Effect.orElseSucceed(() => undefined))
      if (!stored || stored.type !== "oauth") {
        return yield* new RemoteCompactionError({ message: "openai oauth missing", implementation: firstImplementation })
      }
      const headers = (yield* Effect.tryPromise({
        try: () =>
          codexAuthHeaders({
            auth: stored,
            setAuth: (next) => Effect.runPromise(auth.set("openai", next)),
          }),
        catch: (cause) => new RemoteCompactionError({ message: errorMessage(cause), implementation: firstImplementation }),
      })).headers
      headers.set("Content-Type", "application/json")
      headers.set("originator", "opencode")
      headers.set("User-Agent", `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`)
      headers.set("session_id", input.sessionID)
      const requestInput = yield* responsesInput(input.messages, input.model)
      const body = {
        model: input.model.api.id,
        input: requestInput,
        instructions: input.instructions,
        tools: [],
        parallel_tool_calls: false,
        prompt_cache_key: input.sessionID,
        text: { format: { type: "text" } },
      }
      const execute = (
        requestEndpoint: string,
        requestBody: Record<string, unknown>,
        implementation: RemoteCompactionImplementation,
        attempt: number,
      ) =>
        Effect.gen(function* () {
          log.info("remote compaction request", { attempt, attempts, implementation, timeout: durationLabel(timeout) })
          const response = yield* HttpClientRequest.post(requestEndpoint).pipe(
            HttpClientRequest.setHeaders(Object.fromEntries(headers.entries())),
            HttpClientRequest.bodyJson(requestBody),
            Effect.flatMap((request) => http.execute(request)),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  new RemoteCompactionError({
                    message: `remote compaction timed out after ${durationLabel(timeout)}`,
                    retryable: true,
                    implementation,
                  }),
                ),
            }),
            Effect.mapError((cause) => withImplementation(remoteError(cause), implementation)),
          )
          if (response.status < 200 || response.status >= 300) {
            const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
            return yield* new RemoteCompactionError({
              message: remoteHttpErrorMessage(response.status, body),
              status: response.status,
              retryable: response.status === 429 || response.status >= 500,
              implementation,
            })
          }
          return response
        })
      const compactLegacy = (attempt: number) =>
        Effect.gen(function* () {
          const response = yield* execute(legacyEndpoint, body, LEGACY_IMPLEMENTATION, attempt)
          const json = yield* response.json.pipe(
            Effect.mapError((cause) => new RemoteCompactionError({ message: errorMessage(cause), implementation: LEGACY_IMPLEMENTATION })),
          )
          const output = isRecord(json) ? decodeRemoteCompactionOutput(json.output) : undefined
          if (!output || output.length !== 1) {
            return yield* new RemoteCompactionError({
              message: "remote compaction response missing compaction output",
              implementation: LEGACY_IMPLEMENTATION,
            })
          }
          return {
            providerID: "openai" as const,
            endpoint: "codex" as const,
            implementation: LEGACY_IMPLEMENTATION,
            modelID: input.model.id,
            output,
          }
        })
      const compactV2 = (attempt: number) =>
        Effect.gen(function* () {
          const response = yield* execute(
            responsesEndpoint,
            {
              ...body,
              input: [...requestInput, { type: "compaction_trigger" } satisfies ResponsesCompactionTriggerItem],
              store: false,
              stream: true,
            },
            V2_IMPLEMENTATION,
            attempt,
          )
          const parsed = parseV2CompactionStream(yield* response.text.pipe(Effect.catch(() => Effect.succeed(""))))
          if (parsed instanceof RemoteCompactionError) return yield* parsed
          return {
            providerID: "openai" as const,
            endpoint: "codex" as const,
            implementation: V2_IMPLEMENTATION,
            modelID: input.model.id,
            output: parsed.output,
            ...(parsed.usage ? { usage: parsed.usage } : {}),
          }
        })
      const attemptProtocol = (
        implementation: RemoteCompactionImplementation,
        request: (attempt: number) => Effect.Effect<RemoteCompactionMetadata, RemoteCompactionError>,
      ) => {
        const attemptCompact: (attempt: number) => Effect.Effect<RemoteCompactionMetadata, RemoteCompactionError> = (attempt) =>
          Effect.gen(function* () {
            const result = yield* request(attempt).pipe(
              Effect.map((metadata) => ({ ok: true as const, metadata })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
            )
            if (result.ok) {
              log.info("remote compaction succeeded", { attempt, attempts, implementation })
              return result.metadata
            }
            if (result.error.retryable && attempt < attempts) {
              log.warn("remote compaction retrying", {
                attempt,
                attempts,
                implementation,
                error: result.error.message,
                status: result.error.status,
              })
              return yield* attemptCompact(attempt + 1)
            }
            if (attempt > 1) {
              return yield* new RemoteCompactionError({
                message: `remote compaction failed after ${attempt} attempts: ${result.error.message}`,
                status: result.error.status,
                retryable: result.error.retryable,
                attempts: attempt,
                implementation,
              })
            }
            return yield* Effect.fail(withImplementation(result.error, implementation))
          })
        return attemptCompact(1)
      }
      const runProtocol = (implementation: RemoteCompactionImplementation) =>
        implementation === V2_IMPLEMENTATION
          ? attemptProtocol(implementation, compactV2)
          : attemptProtocol(implementation, compactLegacy)
      const ordered = resolution.protocols.map((item) =>
        item === "v2" ? V2_IMPLEMENTATION : LEGACY_IMPLEMENTATION,
      )
      const first = ordered[0] ?? V2_IMPLEMENTATION
      const result = yield* runProtocol(first).pipe(
        Effect.map((metadata) => ({ ok: true as const, metadata })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )
      if (result.ok) return result.metadata
      const next = ordered[1]
      if (!next) return yield* Effect.fail(result.error)
      log.warn("remote compaction protocol fallback", {
        from: first,
        to: next,
        error: result.error.message,
        status: result.error.status,
      })
      return yield* runProtocol(next)
    })

    return Service.of({ resolve, canCompact, compact })
  }),
)

export const layer = layerWithEndpoint()

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Provider.defaultLayer),
)

export const disabledLayer = Layer.succeed(
  Service,
  Service.of({
    resolve: ({ model, session }) => {
      const lock = session?.lock
      const mismatch = !!lock && (lock.providerID !== model.providerID || lock.modelID !== model.id)
      return Effect.succeed({
        configured: {
          mode: "off",
          protocol: "auto",
          metadata: {
            remote: { source: "default", explicitAtWriteTarget: false },
            remote_protocol: { source: "default", explicitAtWriteTarget: false },
            writeTarget: { source: "project", format: "json", exists: false },
          },
        },
        requested: { providerID: model.providerID, modelID: model.id },
        effective: { providerID: model.providerID, modelID: model.id, wireModelID: model.api.id },
        mode: "local",
        target: "local",
        credential: "unavailable",
        protocols: [],
        localFallback: true,
        reason: "policy_off",
        lock: !lock
          ? { status: "none" }
          : {
              status: mismatch ? "model_mismatch" : lock.endpoint === "codex" ? "exact" : "route_mismatch",
              endpoint: lock.endpoint === "codex" ? "openai-codex" : "provider",
              providerID: lock.providerID,
              modelID: lock.modelID,
            },
        replay: !lock
          ? { mode: "none", reason: "no_lock" }
          : mismatch
            ? { mode: "blocked", reason: "model_mismatch" }
            : { mode: "full_history", reason: "transport_unavailable" },
      } satisfies Resolution)
    },
    canCompact: () => Effect.succeed(false),
    compact: () => Effect.fail(new RemoteCompactionError({ message: "remote compaction disabled" })),
  }),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function resolve(input: ResolveInput) {
  return runPromise((svc) => svc.resolve(input))
}

export async function canCompact(input: { model: Provider.Model }) {
  return runPromise((svc) => svc.canCompact(input))
}

export * as RemoteCompaction from "./remote-compaction"
