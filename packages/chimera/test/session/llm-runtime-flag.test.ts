import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Stream } from "effect"
import { makeRuntime } from "../../src/effect/run-service"
import { LLM } from "../../src/session/llm"
import { WithInstance } from "../../src/project/with-instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

// L4.4 native llm runtime pilot (experimental.llm_runtime) seam coverage.
// Both flag states run the identical deepseek fixture against one local SSE
// server; transport attribution uses includeUsage:false — only the llm route
// runtime always sends stream_options.include_usage, the AI SDK
// openai-compatible path omits it when the option is off. F4 interaction
// surface (plan risk #3): the background-subagent injected continuation shape
// (parentSessionID + subagent-style caller) goes through the same seam and is
// asserted on the native transport; remote compaction never reaches this seam
// (it runs on ResponsesTransport and requires the responses wire, which the
// deepseek chat-wire pilot is gated off from in NativeLLMGating).

type CapturedRequest = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ response: Response; resolve: (value: CapturedRequest) => void }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(response: Response) {
  const pending = deferred<CapturedRequest>()
  state.queue.push({ response, resolve: pending.resolve })
  return pending.promise
}

function usageChunks(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-flag",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-flag",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ data: [] })
      const next = state.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>)
      next.resolve({ url, headers: req.headers, body })
      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

const llm = makeRuntime(LLM.Service, LLM.defaultLayer)

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

async function runDeepseekTurn(input: { flag: boolean; parentSessionID?: string }) {
  const server = state.server
  if (!server) throw new Error("Server not initialized")
  const request = waitRequest(
    new Response(usageChunks("Hello"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  )

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "chimera.json"),
        JSON.stringify({
          $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
          enabled_providers: ["deepseek"],
          provider: {
            deepseek: {
              options: {
                apiKey: "test-key",
                baseURL: `${server.url.origin}/v1`,
                // Transport discriminator: the AI SDK path omits stream_options
                // with includeUsage:false; the llm route always sends it.
                includeUsage: false,
              },
            },
          },
          experimental: { llm_runtime: input.flag },
        }),
      )
    },
  })

  return await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await getModel(ProviderID.make("deepseek"), ModelID.make("deepseek-chat"))
      const sessionID = SessionID.make("session-llm-runtime-flag")
      const agent = {
        name: "general",
        mode: "subagent",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      } satisfies Agent.Info
      const user = {
        id: MessageID.make("user-llm-runtime-flag"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: ProviderID.make("deepseek"), modelID: model.id },
      } satisfies MessageV2.User

      const events = await llm.runPromise((svc) =>
        svc
          .stream({
            user,
            sessionID,
            ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
            model,
            agent,
            system: ["runtime-system"],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })
          .pipe(Stream.runCollect),
      )
      return { model, captured: await request, events: Array.from(events) }
    },
  })
}

function text(events: ReadonlyArray<{ type: string }>) {
  return events
    .filter((event): event is { type: "text-delta"; text: string } => event.type === "text-delta")
    .map((event) => event.text)
    .join("")
}

function finishStep(events: ReadonlyArray<{ type: string }>) {
  const match = events.find((event): event is { type: "finish-step"; usage: never; finishReason: never } => event.type === "finish-step")
  if (!match) throw new Error("missing finish-step event")
  return match as { type: "finish-step"; usage: Parameters<typeof Session.getUsage>[0]["usage"]; finishReason: unknown; providerMetadata?: never }
}

describe("experimental.llm_runtime seam (deepseek pilot)", () => {
  test("flag off keeps the AI SDK transport and its wire shape", async () => {
    const { events, captured } = await runDeepseekTurn({ flag: false })
    expect(captured.url.pathname).toBe("/v1/chat/completions")
    expect(captured.body.stream_options).toBeUndefined()
    expect(text(events)).toBe("Hello")
    expect(finishStep(events).usage.inputTokens).toBe(10)
  })

  test("flag on switches the transport to the llm route runtime", async () => {
    const { events, captured } = await runDeepseekTurn({ flag: true })
    expect(captured.url.pathname).toBe("/v1/chat/completions")
    // Native transport marker: the llm openai-chat route always requests usage.
    expect(captured.body.stream_options).toEqual({ include_usage: true })
    expect(captured.body.model).toBe("deepseek-chat")
    expect(captured.headers.get("authorization")).toBe("Bearer test-key")
    // Brand discipline: identity headers keep their opencode values on the
    // native transport (decision #7, 2026-09-22).
    expect(captured.headers.get("user-agent")).toMatch(/^opencode\//)
    expect(captured.headers.get("x-session-affinity")).toBe("session-llm-runtime-flag")
    expect(text(events)).toBe("Hello")
  })

  test("cost and usage accounting reconcile across both transports", async () => {
    const off = await runDeepseekTurn({ flag: false })
    const on = await runDeepseekTurn({ flag: true })
    const offStep = finishStep(off.events)
    const onStep = finishStep(on.events)
    expect(onStep.usage).toEqual(offStep.usage)
    const offUsage = Session.getUsage({ model: off.model, usage: offStep.usage })
    const onUsage = Session.getUsage({ model: on.model, usage: onStep.usage })
    expect(onUsage.tokens).toEqual(offUsage.tokens)
    expect(onUsage.cost).toEqual(offUsage.cost)
    expect(onUsage.tokens).toMatchObject({ input: 8, output: 4, reasoning: 1, total: 15 })
    expect(onUsage.tokens.cache).toMatchObject({ read: 2 })
  })

  test("background subagent continuation shape rides the same gated seam", async () => {
    const { events, captured } = await runDeepseekTurn({ flag: true, parentSessionID: "session-parent" })
    expect(captured.body.stream_options).toEqual({ include_usage: true })
    expect(captured.headers.get("x-parent-session-id")).toBe("session-parent")
    expect(text(events)).toBe("Hello")
    expect(finishStep(events).usage.inputTokens).toBe(10)
  })
})
