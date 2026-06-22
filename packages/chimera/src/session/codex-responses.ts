import type { JSONSchema7 } from "@ai-sdk/provider"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { type ModelMessage, type Tool } from "ai"
import z from "zod"
import { type Auth } from "@/auth"
import { codexAuthHeaders, codexEndpointUrl } from "@/plugin/codex"
import type { Provider } from "@/provider/provider"
import type { Event as LLMEvent } from "./llm"
import { decodeRemoteCompactionInput, type RemoteCompactionOutputItem } from "./remote-compaction-codec"

type CodexOAuthAuth = Extract<Auth.Info, { type: "oauth" }>

type ResponsesInputItem =
  | RemoteCompactionOutputItem
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
  status?: string
  action?: unknown
}

type RequestBody = ReturnType<typeof buildRequestBody>

type WebSocketSessionState = {
  socket?: WebSocket
  lastRequest?: RequestBody
  lastResponse?: { responseId: string; itemsAdded: ResponsesInputItem[] }
  fallbackHttp?: boolean
  prewarmed?: boolean
  turnState?: string
}

type StreamState = {
  responseId: string | null
  currentTextId: string | null
  currentReasoningOutputIndex: number | null
  hasFunctionCall: boolean
  completed: boolean
  usage: ResponseUsage | undefined
  serviceTier: string | undefined
  itemsAdded: ResponsesInputItem[]
  turnState: string | undefined
  toolCalls: Record<number, { id: string; name: string; arguments: string } | undefined>
  reasoning: Record<number, { id: string; encryptedContent?: string | null; summaryIndexes: number[] } | undefined>
}

const webSocketSessions = new Map<string, WebSocketSessionState>()
const WEBSOCKET_CONNECT_TIMEOUT_MS = 3_000
const TURN_STATE_HEADER = "x-codex-turn-state"

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
  const hasWebSearch = hasHostedWebSearchTool(input.tools)
  const include = buildInclude(input.params.options, reasoning !== undefined, hasWebSearch)
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
  const headers = await buildHeaders(input)
  const session = webSocketSession(input)
  if (useWebSocket(input, session)) {
    let emitted = false
    try {
      await prewarmWebSocket(input, body, headers, session)
      for await (const output of streamWebSocket(input, body, headers, session)) {
        emitted = true
        yield output
      }
      return
    } catch (error) {
      resetWebSocketSession(session)
      session.fallbackHttp = true
      if (emitted) {
        yield event({ type: "error", error })
        return
      }
    }
  }
  for await (const output of streamHttp(input, body, headers, session)) {
    yield output
  }
}

async function buildHeaders(input: CodexResponsesInput) {
  const auth = await codexAuthHeaders({ auth: input.auth, setAuth: input.setAuth })
  const headers = new Headers(auth.headers)
  headers.set("Content-Type", "application/json")
  headers.set("User-Agent", input.headers["User-Agent"] ?? `opencode/${InstallationVersion}`)
  for (const [key, value] of Object.entries(input.headers)) {
    if (value !== undefined) headers.set(key, value)
  }
  return headers
}

async function* streamHttp(input: CodexResponsesInput, body: RequestBody, headers: Headers, session: WebSocketSessionState) {
  const response = await fetch(codexEndpointUrl("responses", input.endpoint), {
    method: "POST",
    headers: headersWithTurnState(headers, session),
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
  const state = createStreamState(session)
  captureTurnState(state, response.headers.get(TURN_STATE_HEADER) ?? undefined)
  for await (const value of parseSSE(response.body)) {
    for (const output of await handleChunk(value, input, state)) {
      yield output
    }
  }
  updateSessionTurnState(session, state)
  for (const output of finishEvents(state)) {
    yield output
  }
}

async function prewarmWebSocket(input: CodexResponsesInput, body: RequestBody, headers: Headers, session: WebSocketSessionState) {
  if (session.lastRequest || session.prewarmed) return
  if (input.params.options.codexResponsesPrewarm === false) return
  for await (const _ of streamWebSocket(input, body, headers, session, true)) {}
  session.prewarmed = true
}

async function* streamWebSocket(input: CodexResponsesInput, body: RequestBody, headers: Headers, session: WebSocketSessionState, warmup = false) {
  const state = createStreamState(session)
  for await (const value of sendWebSocketRequest(input, headers, buildWebSocketRequest(session, body, warmup), session)) {
    for (const output of await handleChunk(value, input, state)) {
      if (!warmup) yield output
    }
  }
  if (state.completed && state.responseId) {
    session.lastRequest = body
    session.lastResponse = { responseId: state.responseId, itemsAdded: state.itemsAdded }
  }
  updateSessionTurnState(session, state)
  if (warmup) return
  for (const output of finishEvents(state)) {
    yield output
  }
}

function createStreamState(session?: WebSocketSessionState): StreamState {
  return {
    responseId: null,
    currentTextId: null,
    currentReasoningOutputIndex: null,
    hasFunctionCall: false,
    completed: false,
    usage: undefined,
    serviceTier: undefined,
    itemsAdded: [],
    turnState: session?.turnState,
    toolCalls: {},
    reasoning: {},
  }
}

function finishEvents(state: StreamState) {
  const outputs: LLMEvent[] = []
  if (state.currentTextId) {
    outputs.push(event({ type: "text-end", id: state.currentTextId }))
  }
  for (const part of Object.values(state.reasoning)) {
    if (!part) continue
    for (const summaryIndex of part.summaryIndexes) {
      outputs.push(
        event({
          type: "reasoning-end",
          id: `${part.id}:${summaryIndex}`,
          providerMetadata: { openai: { itemId: part.id, reasoningEncryptedContent: part.encryptedContent ?? null } },
        }),
      )
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
  outputs.push(event({ type: "finish-step", finishReason, usage, providerMetadata }))
  outputs.push(event({ type: "finish", finishReason, usage, providerMetadata }))
  return outputs
}

function webSocketSession(input: CodexResponsesInput) {
  const key = `${codexEndpointUrl("responses", input.endpoint)}:${input.auth.accountId ?? ""}:${input.sessionID}`
  const existing = webSocketSessions.get(key)
  if (existing) return existing
  const session: WebSocketSessionState = {}
  webSocketSessions.set(key, session)
  return session
}

function useWebSocket(input: CodexResponsesInput, session: WebSocketSessionState) {
  const transport = stringOption(input.params.options.codexResponsesTransport)
  if (session.fallbackHttp) return false
  if (transport === "http") return false
  if (input.params.options.codexResponsesWebSocket === false) return false
  return typeof globalThis.WebSocket === "function"
}

function resetWebSocketSession(session: WebSocketSessionState) {
  if (session.socket && session.socket.readyState < 2) session.socket.close()
  session.socket = undefined
  session.lastRequest = undefined
  session.lastResponse = undefined
  session.prewarmed = false
}

function buildWebSocketRequest(session: WebSocketSessionState, body: RequestBody, warmup: boolean) {
  const delta = warmup ? undefined : incrementalRequest(session, body)
  return stripUndefined({
    type: "response.create",
    ...body,
    client_metadata: turnStateClientMetadata(session),
    previous_response_id: delta?.previousResponseId,
    input: delta?.input ?? body.input,
    generate: warmup ? false : undefined,
  })
}

function incrementalRequest(session: WebSocketSessionState, body: RequestBody) {
  if (!session.lastRequest || !session.lastResponse?.responseId) return undefined
  if (!deepEqual(requestWithoutInput(session.lastRequest), requestWithoutInput(body))) return undefined
  const baseline = [...session.lastRequest.input, ...session.lastResponse.itemsAdded]
  if (!startsWithItems(body.input, baseline)) return undefined
  return { previousResponseId: session.lastResponse.responseId, input: body.input.slice(baseline.length) }
}

function requestWithoutInput(body: RequestBody) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "input"))
}

function startsWithItems(input: ResponsesInputItem[], baseline: ResponsesInputItem[]) {
  if (baseline.length > input.length) return false
  return deepEqual(input.slice(0, baseline.length), baseline)
}

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function headersWithTurnState(headers: Headers, session: WebSocketSessionState) {
  const next = new Headers(headers)
  if (session.turnState) next.set(TURN_STATE_HEADER, session.turnState)
  return next
}

function turnStateClientMetadata(session: WebSocketSessionState) {
  return session.turnState ? { [TURN_STATE_HEADER]: session.turnState } : undefined
}

function captureTurnState(state: StreamState, value: unknown) {
  if (state.turnState || value === undefined || value === null) return
  const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined
  if (text) state.turnState = text
}

function updateSessionTurnState(session: WebSocketSessionState, state: StreamState) {
  if (!state.completed) return
  if (state.hasFunctionCall && state.turnState) {
    session.turnState = state.turnState
    return
  }
  if (!state.hasFunctionCall) session.turnState = undefined
}

function recordHeaderValue(headers: Record<string, unknown> | undefined, name: string) {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}
async function* sendWebSocketRequest(input: CodexResponsesInput, headers: Headers, request: Record<string, unknown>, session: WebSocketSessionState) {
  const socket = await openWebSocket(input, headers, session)
  const queue: Record<string, unknown>[] = []
  let resume: (() => void) | undefined
  let done = false
  let failure: unknown
  const wake = () => {
    resume?.()
    resume = undefined
  }
  const onMessage = (message: MessageEvent) => {
    try {
      const parsed = JSON.parse(webSocketDataText(message.data)) as Record<string, unknown>
      queue.push(parsed)
      done = done || isTerminalChunk(parsed)
      wake()
    } catch (error) {
      failure = error
      done = true
      wake()
    }
  }
  const onError = (value: Event) => {
    failure = new Error(stringOption(recordOption(value)?.message) ?? "Codex Responses WebSocket failed")
    done = true
    wake()
  }
  const onClose = () => {
    if (!done) failure = new Error("Codex Responses WebSocket closed before a terminal event")
    done = true
    wake()
  }
  const onAbort = () => {
    failure = input.abort.reason instanceof Error ? input.abort.reason : new Error("Codex Responses WebSocket aborted")
    done = true
    socket.close()
    wake()
  }
  socket.addEventListener("message", onMessage)
  socket.addEventListener("error", onError)
  socket.addEventListener("close", onClose)
  input.abort.addEventListener("abort", onAbort, { once: true })
  try {
    socket.send(JSON.stringify(request))
    while (true) {
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (done) break
      await new Promise<void>((resolve) => (resume = resolve))
    }
    if (failure) throw failure
  } finally {
    socket.removeEventListener("message", onMessage)
    socket.removeEventListener("error", onError)
    socket.removeEventListener("close", onClose)
    input.abort.removeEventListener("abort", onAbort)
  }
}

async function openWebSocket(input: CodexResponsesInput, headers: Headers, session: WebSocketSessionState) {
  if (session.socket?.readyState === 1) return session.socket
  if (session.socket) resetWebSocketSession(session)
  const socket = newWebSocket(webSocketEndpointUrl(input), headers)
  await waitWebSocketOpen(input, socket)
  session.socket = socket
  socket.addEventListener("close", () => {
    if (session.socket === socket) session.socket = undefined
  })
  return socket
}

function newWebSocket(url: string, headers: Headers) {
  const WebSocketClient = globalThis.WebSocket as unknown as new (url: string, init?: { headers: Record<string, string> }) => WebSocket
  return new WebSocketClient(url, { headers: headerRecord(headers) })
}

async function waitWebSocketOpen(input: CodexResponsesInput, socket: WebSocket) {
  if (socket.readyState === 1) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      socket.close()
      reject(new Error("Codex Responses WebSocket connection timed out"))
    }, numberOption(input.params.options.codexResponsesWebSocketConnectTimeoutMs) ?? WEBSOCKET_CONNECT_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      input.abort.removeEventListener("abort", onAbort)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error("Codex Responses WebSocket failed to open"))
    }
    const onAbort = () => {
      cleanup()
      socket.close()
      reject(input.abort.reason instanceof Error ? input.abort.reason : new Error("Codex Responses WebSocket aborted"))
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    input.abort.addEventListener("abort", onAbort, { once: true })
  })
}

function webSocketEndpointUrl(input: CodexResponsesInput) {
  const url = new URL(codexEndpointUrl("responses", input.endpoint))
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol === "http:") url.protocol = "ws:"
  return url.toString()
}

function headerRecord(headers: Headers) {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

function webSocketDataText(data: unknown) {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  return textValue(data)
}

function isTerminalChunk(value: Record<string, unknown>) {
  const type = stringOption(value.type)
  return type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error"
}

async function handleChunk(value: Record<string, unknown>, input: CodexResponsesInput, state: StreamState) {
  const outputs: LLMEvent[] = []
  const type = stringOption(value.type)
  if (type === "response.metadata") {
    captureTurnState(state, recordHeaderValue(recordOption(value.headers), TURN_STATE_HEADER))
    return outputs
  }
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
    if (item?.type === "web_search_call") {
      const id = item.id ?? `web-search-${outputIndex}`
      outputs.push(event({ type: "tool-input-start", id, toolName: "web_search", providerExecuted: true }))
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
    const replay = item ? responseItemToInputItem(item) : undefined
    if (replay) state.itemsAdded.push(replay)
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
    if (item?.type === "web_search_call") {
      const toolCallId = item.id ?? `web-search-${outputIndex}`
      outputs.push(event({ type: "tool-input-end", id: toolCallId }))
      outputs.push(
        event({
          type: "tool-call",
          toolCallId,
          toolName: "web_search",
          input: webSearchInput(item),
          providerExecuted: true,
          providerMetadata: { openai: stripUndefined({ itemId: item.id }) },
        }),
      )
      outputs.push(
        event({
          type: "tool-result",
          toolCallId,
          toolName: "web_search",
          output: webSearchOutput(item),
          providerExecuted: true,
        }),
      )
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
    state.completed = type === "response.completed"
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

function buildInclude(options: Record<string, unknown>, hasReasoning: boolean, hasWebSearch: boolean) {
  const include = Array.isArray(options.include) ? options.include.filter((item): item is string => typeof item === "string") : []
  if (hasReasoning && !include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content")
  if (hasWebSearch && !include.includes("web_search_call.action.sources")) include.push("web_search_call.action.sources")
  return include
}

function buildText(options: Record<string, unknown>) {
  return stripUndefined({
    format: { type: "text" },
    verbosity: stringOption(options.textVerbosity) ?? "low",
  })
}

function toResponsesTools(tools: Record<string, Tool>) {
  return Object.entries(tools).map(([name, item]) => {
    const hosted = hostedWebSearchTool(item)
    if (hosted) return hosted
    return stripUndefined({
      type: "function",
      name,
      description: stringOption((item as { description?: unknown }).description),
      parameters: toolSchema(item),
      strict: false,
    })
  })
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

function hostedWebSearchTool(tool: Tool) {
  const provider = tool as { type?: unknown; id?: unknown; args?: unknown }
  if (provider.type !== "provider") return undefined
  if (provider.id !== "openai.web_search" && provider.id !== "openai.web_search_preview") return undefined
  const args = recordOption(provider.args)
  const filters = recordOption(args?.filters)
  const allowedDomains = Array.isArray(filters?.allowedDomains) ? filters.allowedDomains.filter((item): item is string => typeof item === "string") : undefined
  return stripUndefined({
    type: provider.id === "openai.web_search_preview" ? "web_search_preview" : "web_search",
    external_web_access: provider.id === "openai.web_search" && typeof args?.externalWebAccess === "boolean" ? args.externalWebAccess : undefined,
    filters: allowedDomains?.length ? { allowed_domains: allowedDomains } : undefined,
    search_context_size: searchContextSize(args?.searchContextSize),
    user_location: recordOption(args?.userLocation),
  })
}

function hasHostedWebSearchTool(tools: Record<string, Tool>) {
  return Object.values(tools).some((tool) => hostedWebSearchTool(tool) !== undefined)
}

function searchContextSize(value: unknown) {
  return value === "low" || value === "medium" || value === "high" ? value : undefined
}

function webSearchInput(item: ResponseItem) {
  return stripUndefined({ action: item.action })
}

function webSearchOutput(item: ResponseItem) {
  return stripUndefined({ status: item.status, action: item.action })
}

function responseItemToInputItem(item: ResponseItem): ResponsesInputItem | undefined {
  if (item.type === "message" && item.role === "assistant") {
    return stripUndefined({
      role: "assistant" as const,
      content: Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [],
      id: item.id,
    })
  }
  if (item.type === "function_call") {
    return stripUndefined({
      type: "function_call" as const,
      call_id: item.call_id ?? item.id ?? "",
      name: item.name ?? "",
      arguments: item.arguments ?? "",
      id: item.id,
    })
  }
  if (item.type === "reasoning" && item.id) {
    return {
      type: "reasoning",
      id: item.id,
      encrypted_content: item.encrypted_content ?? null,
      summary: Array.isArray(item.summary) ? item.summary.flatMap((part) => (part.text ? [{ type: "summary_text" as const, text: part.text }] : [])) : [],
    }
  }
  return undefined
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
  return content.flatMap((part): ResponsesInputItem[] => {
    if (!isRecord(part)) return []
    const openai = openaiProviderOptions(part)
    if (part.type === "text") {
      return [
        stripUndefined({
          role: "assistant" as const,
          content: [{ type: "output_text", text: textValue(part.text) }],
          id: stringOption(openai?.itemId),
        }),
      ]
    }
    if (part.type === "reasoning") {
      const id = stringOption(openai?.itemId)
      if (!id) return []
      return [
        {
          type: "reasoning",
          id,
          encrypted_content: stringOption(openai?.reasoningEncryptedContent) ?? null,
          summary: textValue(part.text) ? [{ type: "summary_text", text: textValue(part.text) }] : [],
        },
      ]
    }
    if (part.type !== "tool-call") return []
    return [
      stripUndefined({
        type: "function_call" as const,
        call_id: textValue(part.toolCallId),
        name: textValue(part.toolName),
        arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        id: stringOption(openai?.itemId),
      }),
    ]
  })
}

function toolResultItems(content: unknown): ResponsesInputItem[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part): ResponsesInputItem[] => {
    if (!isRecord(part) || part.type !== "tool-result") return []
    return [
      {
        type: "function_call_output",
        call_id: textValue(part.toolCallId),
        output: toolOutputText(part.output ?? part.result),
      },
    ]
  })
}

function userItems(content: unknown): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  const pending: Array<Record<string, unknown>> = []
  const flush = () => {
    if (!pending.length) return
    items.push({ role: "user", content: [...pending] })
    pending.length = 0
  }
  for (const part of userContentParts(content)) {
    const remote = typeof part.text === "string" ? decodeRemoteCompactionInput(part.text) : undefined
    if (remote) {
      flush()
      items.push(...remote)
      continue
    }
    pending.push(part)
  }
  flush()
  return items
}

function userContentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "input_text", text: content }]
  if (!Array.isArray(content)) return [{ type: "input_text", text: textValue(content) }]
  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (!isRecord(part)) return []
    if (part.type === "text") return [{ type: "input_text", text: textValue(part.text) }]
    if (part.type !== "file") return []
    const mediaType = textValue(part.mediaType || part.mime)
    const data = filePartData(part)
    if (mediaType.startsWith("image/") && data) {
      return [{ type: "input_image", image_url: mediaData(data, mediaType === "image/*" ? "image/jpeg" : mediaType) }]
    }
    if (mediaType === "application/pdf" && data) {
      const url = urlString(data)
      if (url) return [{ type: "input_file", file_url: url }]
      return [{ type: "input_file", filename: textValue(part.filename) || "file.pdf", file_data: mediaData(data, mediaType) }]
    }
    return [{ type: "input_text", text: `[Attached ${mediaType || "file"}: ${textValue(part.filename) || "file"}]` }]
  })
}

function filePartData(part: Record<string, unknown>) {
  return part.data ?? part.url
}

function mediaData(data: unknown, mediaType: string) {
  const url = urlString(data)
  if (url) return url
  const base64 = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString("base64") : data instanceof Uint8Array ? Buffer.from(data).toString("base64") : textValue(data)
  if (base64.startsWith("data:")) return base64
  return `data:${mediaType};base64,${base64}`
}

function urlString(value: unknown) {
  if (value instanceof URL) return value.toString()
  if (typeof value !== "string") return undefined
  return /^(data:|https?:|file:)/.test(value) ? value : undefined
}

function openaiProviderOptions(part: Record<string, unknown>) {
  return recordOption(recordOption(part.providerOptions)?.openai) ?? recordOption(recordOption(part.providerMetadata)?.openai)
}

function textValue(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (value == null) return ""
  return JSON.stringify(value) ?? ""
}

function contentText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return textValue(content)
  return content.flatMap((part) => (isRecord(part) && part.type === "text" ? [textValue(part.text)] : [])).join("\n")
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
