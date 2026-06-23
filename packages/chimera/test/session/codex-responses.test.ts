import { describe, expect, test } from "bun:test"
import { tool, type ModelMessage } from "ai"
import { openai } from "@ai-sdk/openai"
import z from "zod"
import { CodexResponses, type CodexResponsesInput, type RequestBody, type ResponsesInputItem } from "../../src/session/codex-responses"
import { encodeRemoteCompactionInput } from "../../src/session/remote-compaction-codec"

function model() {
  return {
    id: "gpt-5.5",
    name: "GPT 5.5",
    providerID: "openai",
    api: { id: "gpt-5.5", npm: "@ai-sdk/openai", url: "" },
    status: "active",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    options: {},
    headers: {},
    family: "gpt-5",
    release_date: "2026-01-01",
    variants: {},
  } as CodexResponsesInput["model"]
}

function baseInput(input: Partial<CodexResponsesInput> = {}): CodexResponsesInput {
  return {
    sessionID: "session-codex-direct",
    model: model(),
    system: ["You are concise."],
    messages: [{ role: "user", content: "Hello" }],
    tools: {},
    params: {
      temperature: 0.2,
      topP: 0.8,
      topK: undefined,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"], codexResponsesTransport: "http" },
    },
    headers: {},
    auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000, accountId: "acc-123" },
    abort: new AbortController().signal,
    ...input,
  }
}

function responseStream(chunks: unknown[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\ndata: [DONE]\n\n"))
      controller.close()
    },
  })
}

async function collect(input: CodexResponsesInput) {
  const events: any[] = []
  for await (const event of CodexResponses.stream(input)) events.push(event)
  return events
}

function installFakeWebSocket(responses: unknown[][], options: { failOpen?: boolean } = {}) {
  const original = globalThis.WebSocket
  const sockets: Array<{ url: string; init?: { headers?: Record<string, string> }; sent: string[] }> = []
  class FakeWebSocket extends EventTarget {
    readyState = 0
    url: string
    init?: { headers?: Record<string, string> }
    sent: string[] = []

    constructor(url: string, init?: { headers?: Record<string, string> }) {
      super()
      this.url = url
      this.init = init
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        if (options.failOpen) {
          this.readyState = 3
          this.dispatchEvent(new Event("error"))
          return
        }
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
      })
    }

    send(data: string) {
      this.sent.push(data)
      const chunks = responses.shift() ?? []
      queueMicrotask(() => {
        for (const chunk of chunks) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(chunk) }))
        }
      })
    }

    close() {
      this.readyState = 3
      this.dispatchEvent(new Event("close"))
    }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  return {
    sockets,
    restore() {
      globalThis.WebSocket = original
    },
  }
}

function inputWithOptions(input: Partial<CodexResponsesInput>, options: Record<string, unknown>) {
  const base = baseInput(input)
  return {
    ...base,
    params: {
      ...base.params,
      options: { ...base.params.options, ...options },
    },
  }
}

describe("session.codex-responses", () => {
  test("builds Codex Responses request body", () => {
    const body = CodexResponses.buildRequestBody(
      baseInput({
        tools: {
          lookup: tool({
            description: "Lookup data",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ output: "ok" }),
          }),
        },
      }),
    ) as any

    expect(body.model).toBe("gpt-5.5")
    expect(body.instructions).toBe("You are concise.")
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hello" }] }])
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.prompt_cache_key).toBe("session-codex-direct")
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tools[0].type).toBe("function")
    expect(body.tools[0].name).toBe("lookup")
  })

  test("converts hosted web search tool into Responses request body", () => {
    const body = CodexResponses.buildRequestBody(
      baseInput({
        tools: {
          web_search: openai.tools.webSearch({ externalWebAccess: true, searchContextSize: "medium" }),
        },
      }),
    ) as any

    expect(body.tools).toContainEqual({
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
    })
    expect(body.include).toContain("web_search_call.action.sources")
  })

  test("streams text events from Codex SSE", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer access")
        expect(request.headers.get("ChatGPT-Account-ID")).toBe("acc-123")
        expect((await request.json() as any).stream).toBe(true)
        return new Response(
          responseStream([
            { type: "response.created", response: { id: "resp-1", created_at: 1, model: "gpt-5.5" } },
            { type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message" } },
            { type: "response.output_text.delta", item_id: "msg-1", delta: "Hello" },
            { type: "response.output_item.done", output_index: 0, item: { id: "msg-1", type: "message" } },
            {
              type: "response.completed",
              response: {
                id: "resp-1",
                usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 1 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 5 },
                service_tier: "default",
              },
            },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })

    const events = await collect(baseInput({ endpoint: `${server.url.origin}/backend-api/codex/responses` }))

    expect(events.map((event) => event.type)).toEqual(["start", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"])
    expect(events.find((event) => event.type === "text-delta")?.text).toBe("Hello")
    expect(events.find((event) => event.type === "finish-step")?.finishReason).toBe("stop")
    expect(events.find((event) => event.type === "finish-step")?.usage.inputTokenDetails.cacheReadTokens).toBe(1)
  })

  test("surfaces nested Responses error messages", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(
          responseStream([
            {
              type: "error",
              error: {
                message: "Invalid 'input[9].id': 'ws_123'. Expected an ID that begins with 'fc'.",
              },
            },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })

    const events = await collect(baseInput({ endpoint: `${server.url.origin}/backend-api/codex/responses` }))

    expect(events.find((event) => event.type === "error")?.error.message).toBe("Invalid 'input[9].id': 'ws_123'. Expected an ID that begins with 'fc'.")
  })


  test("streams text events from Codex WebSocket", async () => {
    const fake = installFakeWebSocket([
      [
        { type: "response.created", response: { id: "resp-ws-1", created_at: 1, model: "gpt-5.5" } },
        { type: "response.output_item.added", output_index: 0, item: { id: "msg-ws-1", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg-ws-1", delta: "Hello over ws" },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg-ws-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello over ws" }] } },
        { type: "response.completed", response: { id: "resp-ws-1", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
      ],
    ])
    try {
      const events = await collect(
        inputWithOptions(
          { sessionID: "session-ws-text", endpoint: "http://codex.test/backend-api/codex/responses" },
          { codexResponsesTransport: "websocket", codexResponsesPrewarm: false },
        ),
      )
      const request = JSON.parse(fake.sockets[0].sent[0])

      expect(fake.sockets[0].url).toBe("ws://codex.test/backend-api/codex/responses")
      expect(fake.sockets[0].init?.headers?.authorization).toBe("Bearer access")
      expect(request.type).toBe("response.create")
      expect(request.stream).toBe(true)
      expect(events.map((event) => event.type)).toEqual(["start", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"])
      expect(events.find((event) => event.type === "text-delta")?.text).toBe("Hello over ws")
      expect(events.find((event) => event.type === "finish-step")?.providerMetadata.openai.responseId).toBe("resp-ws-1")
    } finally {
      fake.restore()
    }
  })

  test("classifies WebSocket incremental reuse diagnostics", () => {
    const first = CodexResponses.buildRequestBody(baseInput({ messages: [{ role: "user", content: "First" }] }))
    const assistant: ResponsesInputItem = { role: "assistant", content: [{ type: "output_text", text: "Answer" }] }
    const second = CodexResponses.buildRequestBody(
      baseInput({
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: [{ type: "text", text: "Answer", providerOptions: { openai: { itemId: "msg-diag-1" } } }] },
          { role: "user", content: "Second" },
        ] as ModelMessage[],
      }),
    )
    const diagnostics = CodexResponses.diagnoseWebSocketIncrementalRequest(
      { lastRequest: first, lastResponse: { responseId: "resp-diag-1", itemsAdded: [assistant] } },
      second,
    )

    expect(diagnostics).toEqual({
      status: "reused",
      previousResponseId: "resp-diag-1",
      baselineInputCount: 2,
      currentInputCount: 3,
      deltaInputCount: 1,
      responseItemsAddedCount: 1,
    })
  })

  test("classifies WebSocket incremental request non-input changes", () => {
    const first = CodexResponses.buildRequestBody(baseInput({ messages: [{ role: "user", content: "First" }] }))
    const changedTools = CodexResponses.buildRequestBody(
      baseInput({
        messages: [{ role: "user", content: "First" }],
        tools: { lookup: tool({ inputSchema: z.object({ query: z.string() }) }) },
      }),
    )
    const changedTemperature = { ...first, temperature: 0.3 } satisfies RequestBody

    expect(
      CodexResponses.diagnoseWebSocketIncrementalRequest(
        { lastRequest: first, lastResponse: { responseId: "resp-diag-tools", itemsAdded: [] } },
        changedTools,
      ),
    ).toMatchObject({ status: "miss", reason: "tools_changed", changedNonInputKeys: ["tools"] })
    expect(
      CodexResponses.diagnoseWebSocketIncrementalRequest(
        { lastRequest: first, lastResponse: { responseId: "resp-diag-request", itemsAdded: [] } },
        changedTemperature,
      ),
    ).toMatchObject({ status: "miss", reason: "request_without_input_mismatch", changedNonInputKeys: ["temperature"] })
  })

  test("classifies WebSocket incremental input prefix changes", () => {
    const runtimeBefore = CodexResponses.buildRequestBody(
      baseInput({
        messages: [
          { role: "user", content: "<system-reminder>\n<runtime-context>\n## Current Work Brief\nBefore\n</runtime-context>\n</system-reminder>" },
          { role: "user", content: "First" },
        ],
      }),
    )
    const runtimeAfter = CodexResponses.buildRequestBody(
      baseInput({
        messages: [
          { role: "user", content: "<system-reminder>\n<runtime-context>\n## Current Work Brief\nAfter\n</runtime-context>\n</system-reminder>" },
          { role: "user", content: "First" },
        ],
      }),
    )
    const ordinaryAfter = CodexResponses.buildRequestBody(baseInput({ messages: [{ role: "user", content: "Changed" }] }))

    expect(
      CodexResponses.diagnoseWebSocketIncrementalRequest(
        { lastRequest: runtimeBefore, lastResponse: { responseId: "resp-diag-runtime", itemsAdded: [] } },
        runtimeAfter,
      ),
    ).toMatchObject({ status: "miss", reason: "runtime_context_changed", firstMismatchIndex: 0 })
    expect(
      CodexResponses.diagnoseWebSocketIncrementalRequest(
        { lastRequest: CodexResponses.buildRequestBody(baseInput({ messages: [{ role: "user", content: "Original" }] })), lastResponse: { responseId: "resp-diag-prefix", itemsAdded: [] } },
        ordinaryAfter,
      ),
    ).toMatchObject({ status: "miss", reason: "input_prefix_mismatch", firstMismatchIndex: 0 })
  })

  test("uses previous_response_id for WebSocket input deltas", async () => {
    const fake = installFakeWebSocket([
      [
        { type: "response.output_item.added", output_index: 0, item: { id: "msg-delta-1", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg-delta-1", delta: "First" },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg-delta-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "First" }] } },
        { type: "response.completed", response: { id: "resp-delta-1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
      [
        { type: "response.completed", response: { id: "resp-delta-2", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
    ])
    try {
      await collect(
        inputWithOptions(
          { sessionID: "session-ws-delta", endpoint: "http://codex.test/backend-api/codex/responses", messages: [{ role: "user", content: "Hello" }] },
          { codexResponsesTransport: "websocket", codexResponsesPrewarm: false },
        ),
      )
      await collect(
        inputWithOptions(
          {
            sessionID: "session-ws-delta",
            endpoint: "http://codex.test/backend-api/codex/responses",
            messages: [
              { role: "user", content: "Hello" },
              { role: "assistant", content: [{ type: "text", text: "First", providerOptions: { openai: { itemId: "msg-delta-1" } } }] },
              { role: "user", content: "Second" },
            ] as ModelMessage[],
          },
          { codexResponsesTransport: "websocket", codexResponsesPrewarm: false },
        ),
      )
      const second = JSON.parse(fake.sockets[0].sent[1])

      expect(second.previous_response_id).toBe("resp-delta-1")
      expect(second.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Second" }] }])
    } finally {
      fake.restore()
    }
  })

  test("omits provider-executed hosted web search from WebSocket input deltas", async () => {
    const fake = installFakeWebSocket([
      [
        { type: "response.output_item.added", output_index: 0, item: { id: "ws_0ca0", type: "web_search_call", status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item: { id: "ws_0ca0", type: "web_search_call", status: "completed", action: { type: "search", query: "weather" } } },
        { type: "response.completed", response: { id: "resp-search-delta-1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
      [
        { type: "response.completed", response: { id: "resp-search-delta-2", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
    ])
    try {
      await collect(
        inputWithOptions(
          { sessionID: "session-ws-search-delta", endpoint: "http://codex.test/backend-api/codex/responses", messages: [{ role: "user", content: "Search" }] },
          { codexResponsesTransport: "websocket", codexResponsesPrewarm: false },
        ),
      )
      await collect(
        inputWithOptions(
          {
            sessionID: "session-ws-search-delta",
            endpoint: "http://codex.test/backend-api/codex/responses",
            messages: [
              { role: "user", content: "Search" },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "ws_0ca0",
                    toolName: "web_search",
                    input: { action: { type: "search", query: "weather" } },
                    providerExecuted: true,
                    providerOptions: { openai: { itemId: "ws_0ca0" } },
                  },
                ],
              },
              { role: "user", content: "Next" },
            ] as ModelMessage[],
          },
          { codexResponsesTransport: "websocket", codexResponsesPrewarm: false },
        ),
      )
      const second = JSON.parse(fake.sockets[0].sent[1])

      expect(second.previous_response_id).toBe("resp-search-delta-1")
      expect(second.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Next" }] }])
      expect(JSON.stringify(second)).not.toContain("ws_0ca0")
    } finally {
      fake.restore()
    }
  })

  test("prewarms WebSocket requests with generate false", async () => {
    const fake = installFakeWebSocket([
      [{ type: "response.completed", response: { id: "resp-warm", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }],
      [{ type: "response.completed", response: { id: "resp-real", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ])
    try {
      await collect(inputWithOptions({ sessionID: "session-ws-prewarm", endpoint: "http://codex.test/backend-api/codex/responses" }, { codexResponsesTransport: "websocket" }))
      const warmup = JSON.parse(fake.sockets[0].sent[0])
      const real = JSON.parse(fake.sockets[0].sent[1])

      expect(warmup.generate).toBe(false)
      expect(warmup.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hello" }] }])
      expect(real.previous_response_id).toBe("resp-warm")
      expect(real.input).toEqual([])
    } finally {
      fake.restore()
    }
  })

  test("falls back to HTTP SSE when WebSocket cannot open", async () => {
    const fake = installFakeWebSocket([], { failOpen: true })
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("POST")
        return new Response(
          responseStream([
            { type: "response.output_item.added", output_index: 0, item: { id: "msg-fallback", type: "message" } },
            { type: "response.output_text.delta", item_id: "msg-fallback", delta: "HTTP fallback" },
            { type: "response.output_item.done", output_index: 0, item: { id: "msg-fallback", type: "message" } },
            { type: "response.completed", response: { id: "resp-fallback", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    try {
      const events = await collect(
        inputWithOptions(
          { sessionID: "session-ws-fallback", endpoint: `${server.url.origin}/backend-api/codex/responses` },
          { codexResponsesTransport: "websocket" },
        ),
      )

      expect(fake.sockets).toHaveLength(1)
      expect(events.find((event) => event.type === "text-delta")?.text).toBe("HTTP fallback")
      expect(events.find((event) => event.type === "finish-step")?.providerMetadata.openai.responseId).toBe("resp-fallback")
    } finally {
      fake.restore()
    }
  })

  test("persists x-codex-turn-state across HTTP same-turn followups and clears after final response", async () => {
    const seenTurnStates: Array<string | null> = []
    const responses = [
      {
        headers: { "x-codex-turn-state": "ts-http-1" },
        events: [
          { type: "response.output_item.added", output_index: 0, item: { id: "fc-http", type: "function_call", call_id: "call-http", name: "lookup" } },
          { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"query\":\"one\"}" },
          { type: "response.output_item.done", output_index: 0, item: { id: "fc-http", type: "function_call", call_id: "call-http", name: "lookup", arguments: "{\"query\":\"one\"}" } },
          { type: "response.completed", response: { id: "resp-http-turn-1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ],
      },
      {
        headers: {},
        events: [
          { type: "response.output_item.added", output_index: 0, item: { id: "msg-http-turn", type: "message" } },
          { type: "response.output_text.delta", item_id: "msg-http-turn", delta: "Done" },
          { type: "response.output_item.done", output_index: 0, item: { id: "msg-http-turn", type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
          { type: "response.completed", response: { id: "resp-http-turn-2", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ],
      },
      {
        headers: {},
        events: [{ type: "response.completed", response: { id: "resp-http-turn-3", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
      },
    ]
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        seenTurnStates.push(request.headers.get("x-codex-turn-state"))
        const next = responses.shift()
        if (!next) return new Response("unexpected request", { status: 500 })
        return new Response(responseStream(next.events), { headers: new Headers([["Content-Type", "text/event-stream"], ...Object.entries(next.headers)]) })
      },
    })
    const endpoint = `${server.url.origin}/backend-api/codex/responses`
    const tools = {
      lookup: tool({
        description: "Lookup data",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ output: "ok" }),
      }),
    }
    await collect(baseInput({ sessionID: "session-http-turn-state", endpoint, tools }))
    await collect(
      baseInput({
        sessionID: "session-http-turn-state",
        endpoint,
        messages: [
          { role: "user", content: "Use lookup" },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-http", toolName: "lookup", input: { query: "one" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "call-http", toolName: "lookup", output: "ok" }] },
        ] as ModelMessage[],
      }),
    )
    await collect(baseInput({ sessionID: "session-http-turn-state", endpoint, messages: [{ role: "user", content: "New turn" }] }))

    expect(seenTurnStates).toEqual([null, "ts-http-1", null])
  })

  test("sends x-codex-turn-state in WebSocket client metadata only for same-turn followups", async () => {
    const fake = installFakeWebSocket([
      [
        { type: "response.metadata", headers: { "x-codex-turn-state": "ts-ws-1" } },
        { type: "response.output_item.added", output_index: 0, item: { id: "fc-ws-turn", type: "function_call", call_id: "call-ws-turn", name: "lookup" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"query\":\"one\"}" },
        { type: "response.output_item.done", output_index: 0, item: { id: "fc-ws-turn", type: "function_call", call_id: "call-ws-turn", name: "lookup", arguments: "{\"query\":\"one\"}" } },
        { type: "response.completed", response: { id: "resp-ws-turn-1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
      [
        { type: "response.output_item.added", output_index: 0, item: { id: "msg-ws-turn", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg-ws-turn", delta: "Done" },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg-ws-turn", type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
        { type: "response.completed", response: { id: "resp-ws-turn-2", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
      [{ type: "response.completed", response: { id: "resp-ws-turn-3", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ])
    const endpoint = "http://codex.test/backend-api/codex/responses"
    const tools = {
      lookup: tool({
        description: "Lookup data",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ output: "ok" }),
      }),
    }
    try {
      await collect(inputWithOptions({ sessionID: "session-ws-turn-state", endpoint, tools }, { codexResponsesTransport: "websocket", codexResponsesPrewarm: false }))
      await collect(
        inputWithOptions(
          {
            sessionID: "session-ws-turn-state",
            endpoint,
            messages: [
              { role: "user", content: "Use lookup" },
              { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-ws-turn", toolName: "lookup", input: { query: "one" } }] },
              { role: "tool", content: [{ type: "tool-result", toolCallId: "call-ws-turn", toolName: "lookup", output: "ok" }] },
            ] as ModelMessage[],
          },
          { codexResponsesTransport: "websocket", codexResponsesPrewarm: false },
        ),
      )
      await collect(inputWithOptions({ sessionID: "session-ws-turn-state", endpoint, messages: [{ role: "user", content: "New turn" }] }, { codexResponsesTransport: "websocket", codexResponsesPrewarm: false }))
      const requests = fake.sockets[0].sent.map((item) => JSON.parse(item))

      expect(requests[0].client_metadata?.["x-codex-turn-state"]).toBeUndefined()
      expect(requests[1].client_metadata?.["x-codex-turn-state"]).toBe("ts-ws-1")
      expect(requests[2].client_metadata?.["x-codex-turn-state"]).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  test("executes function calls and emits tool results", async () => {
    let seenInput: unknown
    using server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(
          responseStream([
            { type: "response.output_item.added", output_index: 0, item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "lookup" } },
            { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"query\":\"weather\"}" },
            { type: "response.output_item.done", output_index: 0, item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "lookup" } },
            { type: "response.completed", response: { id: "resp-tools", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })

    const events = await collect(
      baseInput({
        endpoint: `${server.url.origin}/backend-api/codex/responses`,
        tools: {
          lookup: tool({
            description: "Lookup data",
            inputSchema: z.object({ query: z.string() }),
            execute: async (input) => {
              seenInput = input
              return { output: `found ${(input as { query: string }).query}` }
            },
          }),
        },
      }),
    )

    expect(seenInput).toEqual({ query: "weather" })
    expect(events.find((event) => event.type === "tool-call")?.input).toEqual({ query: "weather" })
    expect(events.find((event) => event.type === "tool-result")?.output).toEqual({ output: "found weather" })
    expect(events.find((event) => event.type === "finish-step")?.finishReason).toBe("tool-calls")
  })

  test("maps hosted web search calls as provider-executed tool events", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(
          responseStream([
            { type: "response.output_item.added", output_index: 0, item: { id: "ws-1", type: "web_search_call", status: "in_progress" } },
            { type: "response.output_item.done", output_index: 0, item: { id: "ws-1", type: "web_search_call", status: "completed", action: { type: "search", query: "weather" } } },
            { type: "response.completed", response: { id: "resp-search", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })

    const events = await collect(baseInput({ endpoint: `${server.url.origin}/backend-api/codex/responses` }))

    expect(events.map((event) => event.type)).toEqual(["start", "start-step", "tool-input-start", "tool-input-end", "tool-call", "tool-result", "finish-step", "finish"])
    expect(events.find((event) => event.type === "tool-input-start")?.providerExecuted).toBe(true)
    expect(events.find((event) => event.type === "tool-call")?.providerExecuted).toBe(true)
    expect(events.find((event) => event.type === "tool-call")?.input).toEqual({ action: { type: "search", query: "weather" } })
    expect(events.find((event) => event.type === "tool-result")?.output).toEqual({ status: "completed", action: { type: "search", query: "weather" } })
    expect(events.find((event) => event.type === "finish-step")?.finishReason).toBe("stop")
  })

  test("converts function call replay into Responses input", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { query: "weather" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: "sunny" }] },
    ] as ModelMessage[]
    const body = CodexResponses.buildRequestBody(baseInput({ messages })) as any

    expect(body.input).toEqual([
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"query\":\"weather\"}" },
      { type: "function_call_output", call_id: "call-1", output: "sunny" },
    ])
  })

  test("omits provider-executed hosted web search replay from Responses input", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Search" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "ws_0ca0b06cf5be6676016a3a5323185881998d9c0b9aefb9d96f",
            toolName: "web_search",
            input: { action: { type: "search", query: "weather" } },
            providerExecuted: true,
            providerOptions: { openai: { itemId: "ws_0ca0b06cf5be6676016a3a5323185881998d9c0b9aefb9d96f" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "ws_0ca0b06cf5be6676016a3a5323185881998d9c0b9aefb9d96f",
            toolName: "web_search",
            output: { status: "completed", action: { type: "search", query: "weather" } },
          },
        ],
      },
      { role: "user", content: "Next" },
    ] as ModelMessage[]
    const body = CodexResponses.buildRequestBody(baseInput({ messages })) as any

    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Search" }] },
      { role: "user", content: [{ type: "input_text", text: "Next" }] },
    ])
    expect(JSON.stringify(body.input)).not.toContain("ws_0ca0b06cf5be6676016a3a5323185881998d9c0b9aefb9d96f")
  })

  test("converts stored assistant replay without item ids", () => {
    const body = CodexResponses.buildRequestBody(
      baseInput({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "thinking",
                providerOptions: { openai: { itemId: "rs-1", reasoningEncryptedContent: "encrypted-reasoning" } },
              },
              { type: "text", text: "Answer", providerOptions: { openai: { itemId: "msg-1" } } },
              {
                type: "tool-call",
                toolCallId: "call-function-1",
                toolName: "lookup",
                input: { query: "weather" },
                providerOptions: { openai: { itemId: "fc-1" } },
              },
            ],
          },
        ] as ModelMessage[],
      }),
    ) as any

    expect(body.input).toEqual([
      {
        type: "reasoning",
        encrypted_content: "encrypted-reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
      },
      { role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
      { type: "function_call", call_id: "call-function-1", name: "lookup", arguments: JSON.stringify({ query: "weather" }) },
    ])
    expect(JSON.stringify(body.input)).not.toContain('"id"')
    expect(JSON.stringify(body.input)).not.toContain("rs-1")
    expect(JSON.stringify(body.input)).not.toContain("msg-1")
    expect(JSON.stringify(body.input)).not.toContain("fc-1")
  })

  test("converts user image and PDF files into Responses input", () => {
    const body = CodexResponses.buildRequestBody(
      baseInput({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "See attachments" },
              { type: "file", mediaType: "image/png", data: "aW1n", filename: "img.png" },
              { type: "file", mediaType: "application/pdf", data: "cGRm", filename: "doc.pdf" },
              { type: "file", mediaType: "text/csv", data: "YSxi", filename: "data.csv" },
            ],
          },
        ] as ModelMessage[],
      }),
    ) as any

    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "See attachments" },
          { type: "input_image", image_url: "data:image/png;base64,aW1n" },
          { type: "input_file", filename: "doc.pdf", file_data: "data:application/pdf;base64,cGRm" },
          { type: "input_text", text: "[Attached text/csv: data.csv]" },
        ],
      },
    ])
  })
  test("converts encoded remote compaction replay into raw Responses input", () => {
    const encoded = encodeRemoteCompactionInput([
      { type: "compaction", encrypted_content: "encrypted-context" },
      { type: "compaction_summary", encrypted_content: "encrypted-summary" },
    ])
    const body = CodexResponses.buildRequestBody(
      baseInput({
        messages: [
          { role: "user", content: [{ type: "text", text: "Before compaction" }, { type: "text", text: encoded }, { type: "text", text: "After compaction" }] },
        ] as ModelMessage[],
      }),
    ) as any

    expect(JSON.stringify(body.input)).not.toContain("__chimera_remote_compaction")
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Before compaction" }] },
      { type: "compaction", encrypted_content: "encrypted-context" },
      { type: "compaction_summary", encrypted_content: "encrypted-summary" },
      { role: "user", content: [{ type: "input_text", text: "After compaction" }] },
    ])
  })
})
