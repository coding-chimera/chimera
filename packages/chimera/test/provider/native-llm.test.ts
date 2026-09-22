import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { APICallError } from "@ai-sdk/provider"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { LLM, type LLMClientShape } from "@coding-chimera/llm"
import { LLMClient, RequestExecutor } from "@coding-chimera/llm/route"
import { NativeLLMConvert } from "../../src/provider/sdk/native-llm/convert"
import { NativeLLMGating } from "../../src/provider/sdk/native-llm/gating"
import { NativeLLMLanguageModel } from "../../src/provider/sdk/native-llm/language-model"
import * as OpenAICompatible from "@coding-chimera/llm/providers/openai-compatible"

// Minimal stand-in for a configured llm Model value; lowering only carries it
// through to LLMRequest.model without inspecting it.
const OpenAICompatibleModelStub = OpenAICompatible.deepseek
  .configure({ apiKey: "test-key", baseURL: "https://test-deepseek.invalid" })
  .model("deepseek-chat")

// L4.4 native llm runtime pilot (experimental.llm_runtime). Unit coverage for
// the gating predicate and the DeepSeek LanguageModelV3 adapter, executed
// against a scripted effect HttpClient — no live provider calls.

type CapturedRequest = {
  url: string
  method: string
  authorization: string | undefined
  body: Record<string, unknown>
}

function sse(chunks: ReadonlyArray<unknown>) {
  return chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`).join("\n\n") + "\n\ndata: [DONE]\n\n"
}

const textChunks = [
  { choices: [{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
  { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
  {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  },
]

const toolChunks = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Tokyo"}' } }] } }] },
  {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  },
]

async function scriptedClient(
  respond: (index: number, request: HttpClientRequest.HttpClientRequest, text: string) => Response,
) {
  const captured: CapturedRequest[] = []
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const cursor = yield* Ref.make(0)
      return Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            const text = yield* Effect.promise(() => web.text())
            const index = yield* Ref.getAndUpdate(cursor, (n) => n + 1)
            captured.push({
              url: request.url,
              method: request.method,
              authorization: request.headers.authorization as string | undefined,
              body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
            })
            return HttpClientResponse.fromWeb(request, respond(index, request, text))
          }),
        ),
      )
    }),
  )
  const runtime = ManagedRuntime.make(
    LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(layer)),
  )
  const client = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* LLMClient.Service
    }),
  )
  return { client: client as LLMClientShape, captured, dispose: () => runtime.dispose() }
}

const sseResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": "text/event-stream", ...init.headers } })

function testModel(client?: LLMClientShape) {
  return NativeLLMLanguageModel.languageModel({
    providerID: "deepseek",
    wireModelID: "deepseek-chat",
    baseURL: "https://test-deepseek.invalid",
    apiKey: "test-key",
    interleavedField: "reasoning_content",
    client,
  })
}

const baseOptions: LanguageModelV3CallOptions = {
  prompt: [
    { role: "system", content: "You are terse." },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ],
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    parts.push(next.value)
  }
  return parts
}

function gatingInput(overrides: {
  llmRuntime?: boolean
  providerID?: string
  npm?: string
  modelWire?: string
  providerWire?: string
  auth?: { type: string } | undefined
}) {
  return {
    llmRuntime: overrides.llmRuntime,
    model: {
      providerID: overrides.providerID ?? "deepseek",
      api: { npm: overrides.npm ?? "@ai-sdk/openai-compatible", id: "deepseek-chat" },
      wire_api: overrides.modelWire,
    },
    provider: { wire_api: overrides.providerWire },
    auth: overrides.auth === undefined ? undefined : (overrides.auth as never),
  } as never
}

describe("native-llm gating (experimental.llm_runtime)", () => {
  test("flag off keeps every provider on the AI SDK transport", () => {
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: false }))).toBe(false)
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: undefined }))).toBe(false)
  })

  test("flag on enables the deepseek pilot with api auth", () => {
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, auth: { type: "api" } }))).toBe(true)
  })

  test("flag on tolerates a missing auth entry (key may live in provider options)", () => {
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true }))).toBe(true)
  })

  test("oauth and wellknown auth stay on the AI SDK transport", () => {
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, auth: { type: "oauth" } }))).toBe(false)
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, auth: { type: "wellknown" } }))).toBe(false)
  })

  test("non-pilot providers, non-compatible npm, and responses wire stay on the AI SDK transport", () => {
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, providerID: "openai" }))).toBe(false)
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, npm: "@ai-sdk/openai" }))).toBe(false)
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, modelWire: "responses" }))).toBe(false)
    expect(NativeLLMGating.eligible(gatingInput({ llmRuntime: true, providerWire: "responses" }))).toBe(false)
  })
})

describe("native-llm adapter doStream", () => {
  test("streams text and maps usage onto the AI SDK finish part", async () => {
    const { client, captured, dispose } = await scriptedClient(() => sseResponse(sse(textChunks)))
    try {
      const result = await testModel(client).doStream(baseOptions)
      const parts = await collect(result.stream)
      expect(parts[0]).toMatchObject({ type: "stream-start", warnings: [] })
      expect(parts.map((part) => part.type)).toContain("text-start")
      const text = parts
        .filter((part) => part.type === "text-delta")
        .map((part) => (part.type === "text-delta" ? part.delta : ""))
        .join("")
      expect(text).toBe("Hello")
      const finish = parts.find((part) => part.type === "finish")
      expect(finish).toBeDefined()
      if (finish?.type !== "finish") throw new Error("missing finish part")
      expect(finish.finishReason).toMatchObject({ unified: "stop" })
      expect(finish.usage.inputTokens).toMatchObject({ total: 10, cacheRead: 2, noCache: 8 })
      expect(finish.usage.outputTokens).toMatchObject({ total: 5, reasoning: 1, text: 4 })
      // Wire parity: the route targets /chat/completions with bearer auth and
      // requests stream usage exactly like the fork's openai-compatible path.
      expect(captured[0].url).toBe("https://test-deepseek.invalid/chat/completions")
      expect(captured[0].authorization).toBe("Bearer test-key")
      expect(captured[0].body.model).toBe("deepseek-chat")
      expect(captured[0].body.stream_options).toMatchObject({ include_usage: true })
      const messages = captured[0].body.messages as Array<{ role: string; content: unknown }>
      expect(messages[0]).toMatchObject({ role: "system", content: "You are terse." })
    } finally {
      await dispose()
    }
  })

  test("streams tool calls with stringified input", async () => {
    const { client, captured, dispose } = await scriptedClient(() => sseResponse(sse(toolChunks)))
    try {
      const result = await testModel(client).doStream({
        ...baseOptions,
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Weather for a city",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        toolChoice: { type: "auto" },
      })
      const parts = await collect(result.stream)
      expect(parts.map((part) => part.type)).toEqual([
        "stream-start",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "finish",
      ])
      const call = parts.find((part) => part.type === "tool-call")
      if (call?.type !== "tool-call") throw new Error("missing tool-call part")
      expect(call.toolCallId).toBe("call_1")
      expect(call.toolName).toBe("get_weather")
      expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" })
      const finish = parts.find((part) => part.type === "finish")
      if (finish?.type !== "finish") throw new Error("missing finish part")
      expect(finish.finishReason.unified).toBe("tool-calls")
      const tools = captured[0].body.tools as Array<{ function?: { name?: string } }>
      expect(tools[0]?.function?.name ?? (tools[0] as never as { name?: string }).name).toBe("get_weather")
    } finally {
      await dispose()
    }
  })

  test("maps HTTP failures onto APICallError with retry metadata", async () => {
    const { client, dispose } = await scriptedClient(
      () =>
        new Response(JSON.stringify({ error: { message: "Rate Limited" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
    )
    try {
      const result = await testModel(client).doStream(baseOptions)
      const reader = result.stream.getReader()
      let failure: unknown
      for (;;) {
        const next = await reader.read().then(
          (value) => value,
          (error: unknown) => ({ error }) as const,
        )
        if ("error" in next) {
          failure = next.error
          break
        }
        if (next.done) break
      }
      expect(APICallError.isInstance(failure)).toBe(true)
      if (!APICallError.isInstance(failure)) return
      expect(failure.statusCode).toBe(429)
      expect(failure.isRetryable).toBe(true)
    } finally {
      await dispose()
    }
  })

  test("aborting the call cancels the native stream", async () => {
    let cancelSeen = false
    const encoder = new TextEncoder()
    const { client, dispose } = await scriptedClient(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "hi" } }] })}\n\n`,
                ),
              )
            },
            cancel() {
              cancelSeen = true
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    )
    try {
      const abort = new AbortController()
      const result = await testModel(client).doStream({ ...baseOptions, abortSignal: abort.signal })
      const reader = result.stream.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      // Release the lock so the abort listener can cancel the stream, then
      // drain: a cancelled stream must complete instead of hanging.
      reader.releaseLock()
      abort.abort()
      const drain = result.stream.getReader()
      for (;;) {
        const next = await drain.read()
        if (next.done) break
      }
      expect(cancelSeen).toBe(true)
    } finally {
      await dispose()
    }
  })
})

describe("native-llm lowering", () => {
  test("rebuilds interleaved reasoning, tools, choices, options, and headers", () => {
    const model = OpenAICompatibleModelStub
    const lowering = NativeLLMConvert.lower(
      {
        prompt: [
          { role: "system", content: "base" },
          { role: "system", content: "delta" },
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "prev" }],
            providerOptions: { openaiCompatible: { reasoning_content: "thought" } },
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_9",
                toolName: "get_weather",
                output: { type: "text", value: "sunny" },
              },
            ],
          },
        ],
        tools: [
          { type: "function", name: "get_weather", description: "d", inputSchema: { type: "object" } },
          { type: "provider", id: "openai.web_search", name: "web_search", args: {} },
        ],
        toolChoice: { type: "tool", toolName: "get_weather" },
        temperature: 0.5,
        maxOutputTokens: 64,
        stopSequences: ["<|end|>"],
        headers: { "x-session-affinity": "test-session", "User-Agent": "opencode/test" },
        providerOptions: { deepseek: { reasoningEffort: "high", bogus: 1 } },
        responseFormat: { type: "json", schema: { type: "object" } },
      } as LanguageModelV3CallOptions,
      model,
      { providerOptionsKey: "deepseek", interleavedField: "reasoning_content" },
    )
    const request = LLM.request(lowering.request)
    expect(request.system.map((part) => part.text)).toEqual(["base", "delta"])
    const assistant = request.messages[1]
    expect(assistant.role).toBe("assistant")
    expect(assistant.content[0]).toMatchObject({ type: "reasoning", text: "thought" })
    expect(assistant.content[1]).toMatchObject({ type: "text", text: "prev" })
    const toolMessage = request.messages[2]
    expect(toolMessage.role).toBe("tool")
    expect(toolMessage.content[0]).toMatchObject({ type: "tool-result", id: "call_9", name: "get_weather" })
    expect(request.tools.map((entry) => entry.name)).toEqual(["get_weather"])
    expect(lowering.warnings).toHaveLength(1)
    expect(request.toolChoice).toMatchObject({ type: "tool", name: "get_weather" })
    expect(request.generation).toMatchObject({ temperature: 0.5, maxTokens: 64, stop: ["<|end|>"] })
    expect(request.providerOptions?.openai).toMatchObject({ reasoningEffort: "high" })
    expect(request.providerOptions?.openai).not.toHaveProperty("bogus")
    expect(request.http?.headers).toMatchObject({ "x-session-affinity": "test-session", "User-Agent": "opencode/test" })
    expect(request.responseFormat).toMatchObject({ type: "json" })
  })
})
