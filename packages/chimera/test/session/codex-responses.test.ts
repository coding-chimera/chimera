import { describe, expect, test } from "bun:test"
import { tool, type ModelMessage } from "ai"
import z from "zod"
import { CodexResponses, type CodexResponsesInput } from "../../src/session/codex-responses"

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
      options: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
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

})
