import type {
JSONValue,
LanguageModelV3CallOptions,
LanguageModelV3Message,
LanguageModelV3StreamPart,
LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
SharedV3Warning,
} from "@ai-sdk/provider"
import { APICallError } from "@ai-sdk/provider"
import {
LLM,
LLMError,
LLMEvent,
  ToolOutput,
  ToolResultPart,
Usage,
type ContentPart,
type FinishReason,
type Model,
type ProviderOptions,
type ToolContent,
} from "@coding-chimera/llm"

// L4.4 native llm runtime pilot: two-way conversion between the AI SDK v3
// language-model contract (what streamText speaks) and the canonical
// @coding-chimera/llm request/event model (what the route runtime speaks).
// The adapter lives at the LanguageModelV3 seam so streamText keeps owning
// tool execution, multi-step loops, retry, repair, and usage aggregation —
// only the HTTP transport and provider-stream parsing switch to the llm
// package. Downstream consumers (session processor, cost/usage accounting)
// see identical AI SDK stream part shapes on both flag paths.

export type ConvertConfig = {
  /** providerID key the fork's ProviderTransform.providerOptions writes call-level options under. */
  readonly providerOptionsKey: string
  /**
   * Interleaved reasoning wire field (e.g. "reasoning_content"). When set,
   * ProviderTransform.message strips assistant reasoning parts and parks the
   * joined text under providerOptions.openaiCompatible[field]; the downconvert
   * reconstructs llm ReasoningParts so the openai-chat protocol re-emits the
   * field natively.
   */
  readonly interleavedField?: string | undefined
}

const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

// The llm ProviderMetadata contract (Record<string, Record<string, unknown>>)
// is a structural superset of the AI SDK metadata bag; values originate from
// decoded provider JSON so the narrowing cast is sound at runtime.
function sdkMetadata(value: Record<string, Record<string, unknown>> | undefined): SharedV3ProviderMetadata | undefined {
  return value as SharedV3ProviderMetadata | undefined
}

function convertToolResultOutput(output: LanguageModelV3ToolResultOutput): {
  result: unknown
  resultType?: "text" | "json" | "error" | "content"
} {
  switch (output.type) {
    case "text":
      return { result: output.value, resultType: "text" }
    case "json":
      return { result: output.value }
    case "error-text":
    case "error-json":
      return { result: output.value, resultType: "error" }
    case "execution-denied":
      return { result: output.reason ?? "Tool execution denied.", resultType: "error" }
    case "content":
      return {
        result: output.value.map((item): ToolContent => {
          if (item.type === "text") return { type: "text", text: item.text }
          if (item.type === "file-data")
            return {
              type: "file",
              uri: `data:${item.mediaType};base64,${item.data}`,
              mime: item.mediaType,
              name: item.filename,
            }
          if (item.type === "file-url") return { type: "file", uri: item.url, mime: "text/uri-list" }
          // file-id and other provider-specific variants carry no client-side
          // payload; degrade to a text reference instead of failing the call.
          return { type: "text", text: JSON.stringify(item) }
        }),
        resultType: "content",
      }
  }
}

function convertFileData(data: Uint8Array | string | URL): string | Uint8Array {
  if (data instanceof URL) return data.toString()
  return data
}

function convertAssistantMessage(
  message: LanguageModelV3Message & { role: "assistant" },
  config: ConvertConfig,
): ContentPart[] {
  const parts = message.content.flatMap((part): ContentPart[] => {
    switch (part.type) {
      case "text":
        return [{ type: "text", text: part.text }]
      case "reasoning":
        return [{ type: "reasoning", text: part.text }]
      case "file":
        return [{ type: "media", mediaType: part.mediaType, data: convertFileData(part.data), filename: part.filename }]
      case "tool-call":
        return [
          {
            type: "tool-call",
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
            providerExecuted: part.providerExecuted,
          },
        ]
      case "tool-result":
        return [
          ToolResultPart.make({
            id: part.toolCallId,
            name: part.toolName,
            ...convertToolResultOutput(part.output),
            providerExecuted: true,
          }),
        ]
      default:
        return []
    }
  })
  // Interleaved reasoning: ProviderTransform.message moved assistant reasoning
  // text into message-level providerOptions before the prompt reached this
  // adapter. Rebuild a ReasoningPart so the llm protocol sends it back on the
  // wire exactly like the AI SDK openai-compatible path does.
  if (!config.interleavedField) return parts
  const parked = message.providerOptions?.openaiCompatible?.[config.interleavedField]
  if (typeof parked !== "string" || parked.length === 0) return parts
  if (parts.some((part) => part.type === "reasoning")) return parts
  return [{ type: "reasoning", text: parked }, ...parts]
}

function convertMessage(
  message: LanguageModelV3Message,
  config: ConvertConfig,
): LLM.MessageInput | undefined {
  switch (message.role) {
    case "system":
      return undefined
    case "user":
      return {
        role: "user",
        content: message.content.flatMap((part): ContentPart[] => {
          if (part.type === "text") return [{ type: "text", text: part.text }]
          if (part.type === "file")
            return [
              { type: "media", mediaType: part.mediaType, data: convertFileData(part.data), filename: part.filename },
            ]
          return []
        }),
      }
    case "assistant":
      return { role: "assistant", content: convertAssistantMessage(message, config) }
    case "tool":
      return {
        role: "tool",
        content: message.content.flatMap((part): ContentPart[] => {
          if (part.type !== "tool-result") return []
          return [
            ToolResultPart.make({
              id: part.toolCallId,
              name: part.toolName,
              ...convertToolResultOutput(part.output),
            }),
          ]
        }),
      }
  }
}

function convertProviderOptions(
  options: LanguageModelV3CallOptions,
  config: ConvertConfig,
): ProviderOptions | undefined {
  const bag = options.providerOptions?.[config.providerOptionsKey] ?? options.providerOptions?.openaiCompatible
  if (!bag || typeof bag !== "object") return undefined
  const record = bag as Record<string, unknown>
  const effort = record.reasoningEffort
  const openai: Record<string, unknown> = {}
  if (typeof effort === "string" && OPENAI_REASONING_EFFORTS.has(effort)) openai.reasoningEffort = effort
  if (record.reasoningSummary === "auto") openai.reasoningSummary = "auto"
  if (Object.keys(openai).length === 0) return undefined
  return { openai }
}

export type Lowering = {
  readonly request: LLM.RequestInput
  readonly warnings: SharedV3Warning[]
}

/**
 * Lower AI SDK v3 call options into the canonical llm request input. Unknown
 * or unsupported surfaces (provider-hosted tools, approval parts) degrade to
 * warnings so the pilot never silently drops an intended tool.
 */
export function lower(options: LanguageModelV3CallOptions, model: Model, config: ConvertConfig): Lowering {
  const warnings: SharedV3Warning[] = []
  const system = options.prompt
    .filter((message): message is LanguageModelV3Message & { role: "system" } => message.role === "system")
    .map((message) => ({ type: "text" as const, text: message.content }))
  const messages = options.prompt
    .map((message) => convertMessage(message, config))
    .filter((message): message is LLM.MessageInput => message !== undefined)
  const tools = (options.tools ?? []).flatMap((entry) => {
    if (entry.type !== "function") {
      warnings.push({ type: "unsupported", feature: `provider tool ${entry.id}` })
      return []
    }
    return [
      {
        name: entry.name,
        description: entry.description ?? "",
        inputSchema: entry.inputSchema as Record<string, unknown>,
      },
    ]
  })
  const toolChoice =
    options.toolChoice === undefined
      ? undefined
      : options.toolChoice.type === "tool"
        ? { type: "tool" as const, name: options.toolChoice.toolName }
        : { type: options.toolChoice.type }
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    warnings,
    request: {
      model,
      system: system.length > 0 ? system : undefined,
      messages,
      tools,
      toolChoice,
      generation: {
        maxTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        frequencyPenalty: options.frequencyPenalty,
        presencePenalty: options.presencePenalty,
        seed: options.seed,
        stop: options.stopSequences,
      },
      providerOptions: convertProviderOptions(options, config),
      http: Object.keys(headers).length > 0 ? { headers } : undefined,
      responseFormat:
        options.responseFormat?.type === "json"
          ? { type: "json", schema: (options.responseFormat.schema ?? {}) as Record<string, unknown> }
          : undefined,
    },
  }
}

export function finishReason(reason: FinishReason): {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"
  raw: string | undefined
} {
  if (reason === "stop") return { unified: "stop", raw: reason }
  if (reason === "length") return { unified: "length", raw: reason }
  if (reason === "tool-calls") return { unified: "tool-calls", raw: reason }
  if (reason === "content-filter") return { unified: "content-filter", raw: reason }
  if (reason === "error") return { unified: "error", raw: reason }
  return { unified: "other", raw: reason }
}

/**
 * Map the llm Usage contract onto the AI SDK model-level usage shape. Field
 * semantics deliberately mirror the vendored openai-compatible chat model
 * (inclusive totals, cached/reasoning subsets, raw provider payload) so
 * Session.getUsage computes identical cost and token breakdowns on both
 * flag paths.
 */
export function usage(value: Usage | undefined): LanguageModelV3Usage {
  const cacheRead = value?.cacheReadInputTokens
  const noCache =
    value?.nonCachedInputTokens ??
    (value?.inputTokens !== undefined && cacheRead !== undefined ? value.inputTokens - cacheRead : undefined)
  return {
    inputTokens: {
      total: value?.inputTokens,
      noCache,
      cacheRead,
      cacheWrite: value?.cacheWriteInputTokens,
    },
    outputTokens: {
      total: value?.outputTokens,
      text: value?.outputTokens === undefined ? undefined : value.visibleOutputTokens,
      reasoning: value?.reasoningTokens,
    },
    raw: sdkMetadata(value?.providerMetadata)?.openai,
  }
}

function toolResultPart(event: LLMEvent & { type: "tool-result" }): LanguageModelV3StreamPart[] {
  const output = event.output ?? ToolOutput.fromResultValue(event.result) ?? { structured: undefined, content: [] }
  const result = ToolOutput.toResultValue(output)
  const base = {
    type: "tool-result" as const,
    toolCallId: String(event.id),
    toolName: event.name,
    providerExecuted: event.providerExecuted,
    providerMetadata: sdkMetadata(event.providerMetadata),
  }
  if (result.type === "content")
    return [{ ...base, result: result.value.map((item) => ({ ...item })) }]
  return [{ ...base, result: (result.value ?? {}) as NonNullable<JSONValue>, isError: result.type === "error" }]
}

/**
 * Raise one canonical llm event into zero or more AI SDK v3 model-level
 * stream parts. `step-start`/`finish` carry no model-level counterpart
 * (streamText synthesizes start/finish-step around the single provider turn);
 * `step-finish` is the authoritative finish part.
 */
export function raise(event: LLMEvent): LanguageModelV3StreamPart[] {
  switch (event.type) {
    case "step-start":
      return []
    case "text-start":
      return [{ type: "text-start", id: String(event.id), providerMetadata: sdkMetadata(event.providerMetadata) }]
    case "text-delta":
      return [
        {
          type: "text-delta",
          id: String(event.id),
          delta: event.text,
          providerMetadata: sdkMetadata(event.providerMetadata),
        },
      ]
    case "text-end":
      return [{ type: "text-end", id: String(event.id), providerMetadata: sdkMetadata(event.providerMetadata) }]
    case "reasoning-start":
      return [{ type: "reasoning-start", id: String(event.id), providerMetadata: sdkMetadata(event.providerMetadata) }]
    case "reasoning-delta":
      return [
        {
          type: "reasoning-delta",
          id: String(event.id),
          delta: event.text,
          providerMetadata: sdkMetadata(event.providerMetadata),
        },
      ]
    case "reasoning-end":
      return [{ type: "reasoning-end", id: String(event.id), providerMetadata: sdkMetadata(event.providerMetadata) }]
    case "tool-input-start":
      return [
        {
          type: "tool-input-start",
          id: String(event.id),
          toolName: event.name,
          providerMetadata: sdkMetadata(event.providerMetadata),
        },
      ]
    case "tool-input-delta":
      return [{ type: "tool-input-delta", id: String(event.id), delta: event.text }]
    case "tool-input-end":
      return [{ type: "tool-input-end", id: String(event.id), providerMetadata: sdkMetadata(event.providerMetadata) }]
    case "tool-call":
      return [
        {
          type: "tool-call",
          toolCallId: String(event.id),
          toolName: event.name,
          input: typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {}),
          providerExecuted: event.providerExecuted,
          providerMetadata: sdkMetadata(event.providerMetadata),
        },
      ]
    case "tool-result":
      return toolResultPart(event)
    case "tool-error":
      return [{ type: "error", error: new Error(event.message) }]
    case "step-finish":
      return [
        {
          type: "finish",
          finishReason: finishReason(event.reason),
          usage: usage(event.usage),
          providerMetadata: sdkMetadata(event.providerMetadata),
        },
      ]
    case "finish":
      return []
    case "provider-error":
      return [
        { type: "error", error: new Error(event.message) },
        {
          type: "finish",
          finishReason: finishReason("error"),
          usage: usage(undefined),
          providerMetadata: sdkMetadata(event.providerMetadata),
        },
      ]
  }
}

/**
 * Convert a typed LLMError into an APICallError so the fork's existing error
 * pipeline (MessageV2.fromError -> ProviderError.parseAPICallError ->
 * SessionRetry) treats native-runtime failures exactly like AI SDK transport
 * failures, including retry-after header handling.
 */
export function toApiCallError(error: LLMError): APICallError {
const http = "http" in error.reason ? error.reason.http : undefined
return new APICallError({
    message: error.message,
    url: http?.request?.url ?? "",
    requestBodyValues: {},
statusCode: http?.response?.status,
    responseHeaders: http?.response?.headers as Record<string, string> | undefined,
responseBody: http?.body,
cause: error,
isRetryable: error.retryable || undefined,
})
}

export * as NativeLLMConvert from "./convert"
