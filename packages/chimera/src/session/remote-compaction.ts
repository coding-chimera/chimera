import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { makeRuntime } from "@/effect/run-service"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "os"
import { Context, Effect, Layer, Schema } from "effect"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { codexAuthHeaders, codexEndpointUrl } from "@/plugin/codex"
import {
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

function responsesInput(messages: MessageV2.WithParts[]): ResponsesInputItem[] {
  return messages.flatMap((msg) => {
    if (msg.info.role === "user") {
      const remote = msg.parts.flatMap((part) => (part.type === "compaction" && part.remote ? part.remote.output : []))
      if (remote.length) return remote
      return messageText(
        msg.parts.flatMap((part) => {
          if (part.type === "text" && !part.ignored) return [part.text]
          if (part.type === "file") return [`[Attached ${part.mime}: ${part.filename ?? "file"}]`]
          if (part.type === "subtask") return [`Subtask ${part.agent}: ${part.description}\n${part.prompt}`]
          if (part.type === "compaction") return ["What did we do so far?"]
          return []
        }),
        "user",
      )
    }
    return messageText(
      msg.parts.flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type === "reasoning" && part.text.trim()) return [part.text]
        if (part.type === "tool" && part.state.status === "completed") return [`Tool ${part.tool} result:\n${part.state.output}`]
        if (part.type === "tool" && part.state.status === "error") return [`Tool ${part.tool} error:\n${part.state.error}`]
        return []
      }),
      "assistant",
    )
  })
}

export const layer: Layer.Layer<Service, never, Auth.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service

    const canCompact = Effect.fn("RemoteCompaction.canCompact")(function* (input: { model: Provider.Model }) {
      if ((yield* config.get()).compaction?.remote === "off") return false
      if (input.model.providerID !== "openai") return false
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
        catch: (cause) => new RemoteCompactionError({ message: cause instanceof Error ? cause.message : String(cause) }),
      })).headers
      headers.set("Content-Type", "application/json")
      headers.set("originator", "opencode")
      headers.set("User-Agent", `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`)
      headers.set("session_id", input.sessionID)
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(codexEndpointUrl("responses/compact"), {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: input.model.api.id,
              input: responsesInput(input.messages),
              instructions: input.instructions,
              tools: [],
              parallel_tool_calls: false,
              prompt_cache_key: input.sessionID,
              text: { format: { type: "text" } },
            }),
          }),
        catch: (cause) => new RemoteCompactionError({ message: cause instanceof Error ? cause.message : String(cause) }),
      })
      if (!response.ok) {
        return yield* new RemoteCompactionError({
          message: `remote compaction failed: ${response.status}`,
          status: response.status,
        })
      }
      const json = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new RemoteCompactionError({ message: cause instanceof Error ? cause.message : String(cause) }),
      })
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

export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer), Layer.provide(Config.defaultLayer))

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
