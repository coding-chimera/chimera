import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { makeRuntime } from "@/effect/run-service"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
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
  type RemoteCompactionMetadata,
  type RemoteCompactionOutputItem,
} from "./remote-compaction-codec"

type ResponsesMessageItem = {
  type: "message"
  role: "user" | "assistant"
  content: { type: "input_text" | "output_text"; text: string }[]
}

type ResponsesInputItem = RemoteCompactionOutputItem | ResponsesMessageItem

const TOOL_OUTPUT_MAX_CHARS = 2_000

export class RemoteCompactionError extends Schema.TaggedErrorClass<RemoteCompactionError>()(
  "RemoteCompactionError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
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

export function failureMetadata(input: { modelID: string; error: RemoteCompactionError }) {
  return {
    providerID: "openai" as const,
    endpoint: "codex" as const,
    implementation: "responses_compact" as const,
    modelID: input.modelID,
    message: input.error.message,
    ...(input.error.status === undefined ? {} : { status: input.error.status }),
    time: Date.now(),
  }
}

export const layerWithEndpoint = (endpoint = codexEndpointUrl("responses/compact")): Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | HttpClient.HttpClient
> => Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient

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
      if (!(yield* canCompact(input))) return yield* new RemoteCompactionError({ message: "remote compaction unavailable" })
      const stored = yield* auth.get("openai").pipe(Effect.orElseSucceed(() => undefined))
      if (!stored || stored.type !== "oauth") return yield* new RemoteCompactionError({ message: "openai oauth missing" })
      const headers = (yield* Effect.tryPromise({
        try: () =>
          codexAuthHeaders({
            auth: stored,
            setAuth: (next) => Effect.runPromise(auth.set("openai", next)),
          }),
        catch: (cause) => new RemoteCompactionError({ message: errorMessage(cause) }),
      })).headers
      headers.set("Content-Type", "application/json")
      headers.set("originator", "opencode")
      headers.set("User-Agent", `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`)
      headers.set("session_id", input.sessionID)
      const requestInput = yield* responsesInput(input.messages, input.model)
      const response = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeaders(Object.fromEntries(headers.entries())),
        HttpClientRequest.bodyJson({
          model: input.model.api.id,
          input: requestInput,
          instructions: input.instructions,
          tools: [],
          parallel_tool_calls: false,
          prompt_cache_key: input.sessionID,
          text: { format: { type: "text" } },
        }),
        Effect.flatMap((request) => http.execute(request)),
        Effect.mapError((cause) => new RemoteCompactionError({ message: errorMessage(cause) })),
      )
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
        return yield* new RemoteCompactionError({
          message: [`remote compaction failed: ${response.status}`, body.trim().slice(0, 500)].filter(Boolean).join(" "),
          status: response.status,
        })
      }
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => new RemoteCompactionError({ message: errorMessage(cause) })),
      )
      const output = isRecord(json) ? decodeRemoteCompactionOutput(json.output) : undefined
      if (!output || output.length !== 1) {
        return yield* new RemoteCompactionError({ message: "remote compaction response missing compaction output" })
      }
      return {
        providerID: "openai" as const,
        endpoint: "codex" as const,
        implementation: "responses_compact" as const,
        modelID: input.model.id,
        output,
      }
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
