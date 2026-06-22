import type { JSONSchema7 } from "@ai-sdk/provider"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { type ModelMessage, type Tool } from "ai"
import z from "zod"
import { type Auth } from "@/auth"
import { codexAuthHeaders, codexEndpointUrl } from "@/plugin/codex"
import type { Provider } from "@/provider/provider"
import type { Event as LLMEvent } from "./llm"

type CodexOAuthAuth = Extract<Auth.Info, { type: "oauth" }>

type ResponsesInputItem =
  | { role: "system" | "developer"; content: string }
  | { role: "user"; content: Array<Record<string, unknown>> }
  | { role: "assistant"; content: Array<Record<string, unknown>>; id?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id: string; encrypted_content?: string | null; summary: Array<{ type: "summary_text"; text: string }> }

type ResponseUsage = {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number | null } | null
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number | null } | null
  total_tokens?: number
}

type ResponseItem = {
  id?: string
  type?: string
  role?: string
  content?: unknown
  name?: string
  call_id?: string
  arguments?: string
  encrypted_content?: string | null
  summary?: Array<{ text?: string }>
}

type StreamState = {
  responseId: string | null
  currentTextId: string | null
  currentReasoningOutputIndex: number | null
  hasFunctionCall: boolean
  usage: ResponseUsage | undefined
  serviceTier: string | undefined
  toolCalls: Record<number, { id: string; name: string; arguments: string } | undefined>
  reasoning: Record<number, { id: string; encryptedContent?: string | null; summaryIndexes: number[] } | undefined>
}

export type CodexResponsesInput = {
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  toolChoice?: "auto" | "required" | "none"
  params: {
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    options: Record<string, unknown>
  }
  headers: Record<string, string | undefined>
  auth: CodexOAuthAuth
  setAuth?: (auth: CodexOAuthAuth) => Promise<void>
  endpoint?: string
  abort: AbortSignal
}

export function buildRequestBody(input: CodexResponsesInput) {
  const reasoning = buildReasoning(input)
  const include = buildInclude(input.params.options, reasoning !== undefined)
  return stripUndefined({
    model: input.model.api.id,
    instructions: input.system.join("\n"),
    input: toResponsesInput(input.messages),
    tools: toResponsesTools(input.tools),
    tool_choice: input.toolChoice ?? "auto",
    parallel_tool_calls: false,
    reasoning,
    include,
    prompt_cache_key: stringOption(input.params.options.promptCacheKey) ?? input.sessionID,
    text: buildText(input.params.options),
    store: false,
    stream: true,
    temperature: input.params.temperature,
    top_p: input.params.topP,
    max_output_tokens: input.params.maxOutputTokens,
  })
}

export async function* stream(input: CodexResponsesInput): AsyncIterable<LLMEvent> {
  const body = buildRequestBody(input)
  yield event({ type: "start" })
  yield event({ type: "start-step", request: { body } })
  const auth = await codexAuthHeaders({ auth: input.auth, setAuth: input.setAuth })
  const headers = new Headers(auth.headers)
  headers.set("Content-Type", "application/json")
  headers.set("User-Agent", input.headers["User-Agent"] ?? `opencode/${InstallationVersion}`)
  for (const [key, value] of Object.entries(input.headers)) {
    if (value !== undefined) headers.set(key, value)
  }
  const response = await fetch(codexEndpointUrl("responses", input.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: input.abort,
  })
  if (!response.ok) {
    yield event({ type: "error", error: new Error(await response.text().catch(() => response.statusText)) })
    return
  }
  if (!response.body) {
    yield event({ type: "error", error: new Error("Codex Responses stream missing response body") })
    return
  }

  const state: StreamState = {
    responseId: null,
    currentTextId: null,
    currentReasoningOutputIndex: null,
    hasFunctionCall: false,
    usage: undefined,
    serviceTier: undefined,
    toolCalls: {},
    reasoning: {},
  }
  for await (const value of parseSSE(response.body)) {
    for (const output of await handleChunk(value, input, state)) {
      yield output
    }
  }
  if (state.currentTextId) {
    yield event({ type: "text-end", id: state.currentTextId })
  }
  for (const part of Object.values(state.reasoning)) {
    if (!part) continue
    for (const summaryIndex of part.summaryIndexes) {
      yield event({
        type: "reasoning-end",
        id: `${part.id}:${summaryIndex}`,
        providerMetadata: { openai: { itemId: part.id, reasoningEncryptedContent: part.encryptedContent ?? null } },
      })
    }
  }
  const providerMetadata = {
    openai: stripUndefined({
      responseId: state.responseId,
      serviceTier: state.serviceTier,
    }),
  }
  const usage = toLanguageModelUsage(state.usage)
  const finishReason = state.hasFunctionCall ? "tool-calls" : "stop"
  yield event({ type: "finish-step", finishReason, usage, providerMetadata })
  yield event({ type: "finish", finishReason, usage, providerMetadata })
}

async function handleChunk(value: Record<string, unknown>, input: CodexResponsesInput, state: StreamState) {
  const outputs: LLMEvent[] = []
  const type = stringOption(value.type)
  if (type === "response.created") {
    const response = recordOption(value.response)
    state.responseId = stringOption(response?.id) ?? state.responseId
    state.serviceTier = stringOption(response?.service_tier) ?? state.serviceTier
    return outputs
  }
  if (type === "response.output_item.added") {
    const item = recordOption(value.item) as ResponseItem | undefined
    const outputIndex = numberOption(value.output_index) ?? 0
    if (item?.type === "message") {
      state.currentTextId = item.id ?? `message-${outputIndex}`
      outputs.push(
        event({
          type: "text-start",
          id: state.currentTextId,
          providerMetadata: { openai: { itemId: state.currentTextId } },
        }),
      )
      return outputs
    }
    if (item?.type === "reasoning") {
      const id = item.id ?? `reasoning-${outputIndex}`
      state.reasoning[outputIndex] = { id, encryptedContent: item.encrypted_content, summaryIndexes: [0] }
      state.currentReasoningOutputIndex = outputIndex
      outputs.push(
        event({
          type: "reasoning-start",
          id: `${id}:0`,
          providerMetadata: { openai: { itemId: id, reasoningEncryptedContent: item.encrypted_content ?? null } },
        }),
      )
      return outputs
    }
    if (item?.type === "function_call") {
      const callId = item.call_id ?? item.id ?? `call-${outputIndex}`
      const toolName = item.name ?? ""
      state.toolCalls[outputIndex] = { id: callId, name: toolName, arguments: item.arguments ?? "" }
      outputs.push(event({ type: "tool-input-start", id: callId, toolName }))
    }
    return outputs
  }
  if (type === "response.output_text.delta") {
    const itemId = stringOption(value.item_id) ?? "message-0"
    if (!state.currentTextId) {
      state.currentTextId = itemId
      outputs.push(
        event({ type: "text-start", id: itemId, providerMetadata: { openai: { itemId } } }),
      )
    }
    outputs.push(event({ type: "text-delta", id: state.currentTextId, text: stringOption(value.delta) ?? "" }))
    return outputs
  }
  if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
    const outputIndex = numberOption(value.output_index) ?? 0
    const match = state.toolCalls[outputIndex] ?? toolCallById(state, stringOption(value.item_id), stringOption(value.call_id))
    if (match) {
      const delta = stringOption(value.delta) ?? ""
      match.arguments += delta
      outputs.push(event({ type: "tool-input-delta", id: match.id, delta }))
    }
    return outputs
  }
  if (type === "response.reasoning_summary_part.added") {
    const summaryIndex = numberOption(value.summary_index) ?? 0
    const part = state.currentReasoningOutputIndex === null ? undefined : state.reasoning[state.currentReasoningOutputIndex]
    if (part && !part.summaryIndexes.includes(summaryIndex)) {
      part.summaryIndexes.push(summaryIndex)
      outputs.push(
        event({
          type: "reasoning-start",
          id: `${part.id}:${summaryIndex}`,
          providerMetadata: { openai: { itemId: part.id, reasoningEncryptedContent: part.encryptedContent ?? null } },
        }),
      )
    }
    return outputs
  }
  if (type === "response.reasoning_summary_text.delta") {
    const part = state.currentReasoningOutputIndex === null ? undefined : state.reasoning[state.currentReasoningOutputIndex]
    if (part) {
      outputs.push(
        event({
          type: "reasoning-delta",
          id: `${part.id}:${numberOption(value.summary_index) ?? 0}`,
          text: stringOption(value.delta) ?? "",
          providerMetadata: { openai: { itemId: part.id } },
        }),
      )
    }
    return outputs
  }
  if (type === "response.output_item.done") {
    const item = recordOption(value.item) as ResponseItem | undefined
    const outputIndex = numberOption(value.output_index) ?? 0
    if (item?.type === "message" && state.currentTextId) {
      outputs.push(event({ type: "text-end", id: state.currentTextId }))
      state.currentTextId = null
      return outputs
    }
    if (item?.type === "reasoning") {
      const part = state.reasoning[outputIndex]
      if (part) {
        for (const summaryIndex of part.summaryIndexes) {
          outputs.push(
            event({
              type: "reasoning-end",
              id: `${part.id}:${summaryIndex}`,
              providerMetadata: { openai: { itemId: part.id, reasoningEncryptedContent: item.encrypted_content ?? null } },
            }),
          )
        }
        delete state.reasoning[outputIndex]
        if (state.currentReasoningOutputIndex === outputIndex) state.currentReasoningOutputIndex = null
      }
      return outputs
    }
    if (item?.type === "function_call") {
      const match = state.toolCalls[outputIndex]
      const toolCallId = item.call_id ?? match?.id ?? item.id ?? `call-${outputIndex}`
      const toolName = item.name ?? match?.name ?? ""
      const rawInput = item.arguments ?? match?.arguments ?? ""
      const parsedInput = parseToolInput(rawInput)
      state.hasFunctionCall = true
      delete state.toolCalls[outputIndex]
      outputs.push(event({ type: "tool-input-end", id: toolCallId }))
      outputs.push(
        event({
          type: "tool-call",
          toolCallId,
          toolName,
          input: parsedInput,
          providerMetadata: { openai: { itemId: item.id } },
        }),
      )
      const result = await executeTool(input, toolName, parsedInput, toolCallId)
      outputs.push(result)
    }
    return outputs
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const response = recordOption(value.response)
    state.responseId = stringOption(response?.id) ?? state.responseId
    state.usage = recordOption(response?.usage) as ResponseUsage | undefined
    state.serviceTier = stringOption(response?.service_tier) ?? state.serviceTier
    return outputs
  }
  if (type === "response.failed" || type === "error") {
    const response = recordOption(value.response)
    outputs.push(event({ type: "error", error: new Error(stringOption(value.message) ?? stringOption(recordOption(response?.error)?.message) ?? "Codex Responses stream failed") }))
  }
  return outputs
}

async function executeTool(input: CodexResponsesInput, toolName: string, args: unknown, toolCallId: string) {
  const tool = input.tools[toolName]
  if (!tool?.execute) {
    return event({ type: "tool-error", toolCallId, toolName, error: new Error(`Unknown tool: ${toolName}`) })
  }
  try {
    return event({
      type: "tool-result",
      toolCallId,
      toolName,
      output: await tool.execute(args, { toolCallId, messages: input.messages, abortSignal: input.abort }),
    })
  } catch (error) {
    return event({ type: "tool-error", toolCallId, toolName, error })
  }
}

async function* parseSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let index = buffer.search(/\r?\n\r?\n/)
      while (index >= 0) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(buffer.match(/\r?\n\r?\n/)?.index === index && buffer[index] === "\r" ? index + 4 : index + 2)
        const parsed = parseSSEBlock(raw)
        if (parsed) yield parsed
        index = buffer.search(/\r?\n\r?\n/)
      }
    }
    buffer += decoder.decode()
    const parsed = parseSSEBlock(buffer)
    if (parsed) yield parsed
  } finally {
    reader.releaseLock()
  }
}

function parseSSEBlock(raw: string) {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return undefined
  return JSON.parse(data) as Record<string, unknown>
}

function buildReasoning(input: CodexResponsesInput) {
  if (!input.model.capabilities.reasoning) return undefined
  return stripUndefined({
    effort: stringOption(input.params.options.reasoningEffort) ?? "medium",
    summary: stringOption(input.params.options.reasoningSummary) ?? "auto",
  })
}

function buildInclude(options: Record<string, unknown>, hasReasoning: boolean) {
  const include = Array.isArray(options.include) ? options.include.filter((item): item is string => typeof item === "string") : []
  if (hasReasoning && !include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content")
  return include
}

function buildText(options: Record<string, unknown>) {
  return stripUndefined({
    format: { type: "text" },
    verbosity: stringOption(options.textVerbosity) ?? "low",
  })
}

function toResponsesTools(tools: Record<string, Tool>) {
  return Object.entries(tools).map(([name, item]) =>
    stripUndefined({
      type: "function",
      name,
      description: stringOption((item as { description?: unknown }).description),
      parameters: toolSchema(item),
      strict: false,
    }),
  )
}

function toolSchema(tool: Tool): JSONSchema7 {
  const schema = (tool as { inputSchema?: unknown }).inputSchema
  if (isRecord(schema) && "jsonSchema" in schema) return schema.jsonSchema as JSONSchema7
  if (schema) {
    try {
      return z.toJSONSchema(schema as z.ZodTypeAny, { io: "input" }) as JSONSchema7
    } catch {}
  }
  return { type: "object", properties: {}, additionalProperties: false }
}

function toResponsesInput(messages: ModelMessage[]): ResponsesInputItem[] {
  return messages.flatMap((message) => messageToResponsesItems(message))
}

function messageToResponsesItems(message: ModelMessage): ResponsesInputItem[] {
  if (message.role === "system") return [{ role: "system", content: contentText(message.content) }]
  if (message.role === "user") return userItems(message.content)
  if (message.role === "assistant") return assistantItems(message)
  if (message.role === "tool") return toolResultItems(message.content)
  return []
}

function assistantItems(message: Extract<ModelMessage, { role: "assistant" }>): ResponsesInputItem[] {
  const content = (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]) as Array<Record<string, unknown>>
  const text: Array<Record<string, unknown>> = content.flatMap((part) => (part.type === "text" ? [{ type: "output_text", text: String(part.text ?? "") }] : []))
  return [
    ...(text.length > 0 ? [{ role: "assistant" as const, content: text }] : []),
    ...content.flatMap((part): ResponsesInputItem[] => {
      if (!isRecord(part) || part.type !== "tool-call") return []
      return [
        {
          type: "function_call",
          call_id: String(part.toolCallId ?? ""),
          name: String(part.toolName ?? ""),
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        },
      ]
    }),
  ]
}

function toolResultItems(content: unknown): ResponsesInputItem[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part): ResponsesInputItem[] => {
    if (!isRecord(part) || part.type !== "tool-result") return []
    return [
      {
        type: "function_call_output",
        call_id: String(part.toolCallId ?? ""),
        output: toolOutputText(part.output ?? part.result),
      },
    ]
  })
}

function userItems(content: unknown): ResponsesInputItem[] {
  return [{ role: "user", content: userContentParts(content) }]
}

function userContentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "input_text", text: content }]
  if (!Array.isArray(content)) return [{ type: "input_text", text: String(content ?? "") }]
  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (!isRecord(part)) return []
    if (part.type === "text") return [{ type: "input_text", text: String(part.text ?? "") }]
    if (part.type === "file" && typeof part.data === "string" && String(part.mediaType ?? "").startsWith("image/")) {
      return [{ type: "input_image", image_url: part.data }]
    }
    if (part.type === "file" && typeof part.data === "string") {
      return [{ type: "input_file", filename: String(part.filename ?? "file"), file_data: part.data }]
    }
    return []
  })
}
function contentText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  return content.flatMap((part) => (isRecord(part) && part.type === "text" ? [String(part.text ?? "")] : [])).join("\n")
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output
  if (isRecord(output) && typeof output.output === "string") return output.output
  return JSON.stringify(output ?? "")
}

function parseToolInput(input: string) {
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}

function toolCallById(state: StreamState, itemId?: string, callId?: string) {
  return Object.values(state.toolCalls).find((item) => item && (item.id === callId || item.id === itemId))
}

function toLanguageModelUsage(usage: ResponseUsage | undefined) {
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens ?? ((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) || undefined),
    inputTokenDetails: {
      cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? undefined,
    },
    outputTokenDetails: {
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? undefined,
    },
    raw: usage,
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function recordOption(value: unknown) {
  return isRecord(value) ? value : undefined
}

function stringOption(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberOption(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function event(value: unknown) {
  return value as LLMEvent
}

export * as CodexResponses from "./codex-responses"
