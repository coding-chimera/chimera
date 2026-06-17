import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { makeRuntime } from "@/effect/run-service"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import os from "os"
import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { codexAuthHeaders, codexEndpointUrl } from "@/plugin/codex"
import type { ModelMessage } from "ai"
import {
  decodeRemoteCompactionInput,
  decodeRemoteCompactionOutput,
  type RemoteCompactionImplementation,
  type RemoteCompactionMetadata,
  type RemoteCompactionOutputItem,
  type RemoteCompactionUsage,
} from "./remote-compaction-codec"

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

export interface Interface {
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
  const id = (model.api.id ?? model.id).toLowerCase()
  return model.providerID === "openai" || /^(gpt-|o[1-9](?:-|$)|chatgpt-|codex-)/.test(id)
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

export function failureMetadata(input: { modelID: string; error: RemoteCompactionError }) {
  return {
    providerID: "openai" as const,
    endpoint: "codex" as const,
    implementation: input.error.implementation ?? LEGACY_IMPLEMENTATION,
    modelID: input.modelID,
    message: input.error.message,
    ...(input.error.status === undefined ? {} : { status: input.error.status }),
    ...(input.error.attempts === undefined ? {} : { attempts: input.error.attempts }),
    ...(input.error.retryable === undefined ? {} : { retryable: input.error.retryable }),
    time: Date.now(),
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
    const responsesEndpoint = options.responsesEndpoint ?? responsesEndpointFrom(endpoint)
    const legacyEndpoint = options.legacyEndpoint ?? legacyEndpointFrom(endpoint)

    const canCompact = Effect.fn("RemoteCompaction.canCompact")(function* (input: { model: Provider.Model }) {
      const mode = (yield* config.get()).compaction?.remote ?? "auto"
      if (mode === "off") return false
      if (mode === "auto" && input.model.providerID !== "openai") return false
      if (mode === "on" && !supportsOpenAIRemoteCompactionModel(input.model)) return false
      return (yield* auth.get("openai").pipe(Effect.orElseSucceed(() => undefined)))?.type === "oauth"
    })

    const compact = Effect.fn("RemoteCompaction.compact")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      messages: MessageV2.WithParts[]
      instructions: string
    }) {
      const cfg = yield* config.get()
      const protocol = cfg.compaction?.remote_protocol ?? "auto"
      const firstImplementation = protocolsFor(protocol)[0] ?? V2_IMPLEMENTATION
      if (!(yield* canCompact(input))) {
        return yield* new RemoteCompactionError({
          message: "remote compaction unavailable",
          implementation: firstImplementation,
        })
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
      const ordered = protocolsFor(protocol)
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

    return Service.of({ canCompact, compact })
  }),
)

export const layer = layerWithEndpoint()

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export const disabledLayer = Layer.succeed(
  Service,
  Service.of({
    canCompact: () => Effect.succeed(false),
    compact: () => Effect.fail(new RemoteCompactionError({ message: "remote compaction disabled" })),
  }),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function canCompact(input: { model: Provider.Model }) {
  return runPromise((svc) => svc.canCompact(input))
}

export * as RemoteCompaction from "./remote-compaction"
