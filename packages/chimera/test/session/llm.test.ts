import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Effect, Exit, Stream } from "effect"
import z from "zod"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { makeRuntime } from "../../src/effect/run-service"
import { LLM } from "../../src/session/llm"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@/provider/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "@/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

const llm = makeRuntime(LLM.Service, LLM.defaultLayer)

async function drain(input: LLM.StreamInput) {
  return llm.runPromise((svc) => svc.stream(input).pipe(Stream.runDrain))
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return new Response("websocket upgrade not supported", { status: 426 })
      }
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json(url.pathname.includes("/v1beta/") ? { models: [] } : { data: [] })
      }
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>)
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
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

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function systemPromptFrom(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined
  const system = messages?.find((msg) => msg.role === "system")
  if (typeof system?.content !== "string") throw new Error("Missing system prompt")
  return system.content
}

function promptForRole(body: Record<string, unknown>, role: string) {
  const messages = (body.messages ?? body.input) as Array<{ role?: string; content?: unknown }> | undefined
  const content = messages?.find((message) => message.role === role)?.content
  if (content === undefined) throw new Error(`Missing ${role} prompt`)
  return typeof content === "string" ? content : (JSON.stringify(content) ?? "")
}

async function capturePromptRoutingSystem(input: { providerID: string; modelID: string; agentPrompt?: string }) {
  const server = state.server
  if (!server) throw new Error("Server not initialized")

  const fixture = await loadFixture(input.providerID, input.modelID)
  const request = waitRequest(
    "/chat/completions",
    new Response(createChatStream("Hello"), {
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
          enabled_providers: [input.providerID],
          provider: {
            [input.providerID]: {
              options: {
                apiKey: "test-key",
                baseURL: `${server.url.origin}/v1`,
              },
            },
          },
        }),
      )
    },
  })

  return await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const resolved = await getModel(ProviderID.make(input.providerID), ModelID.make(fixture.model.id))
      const sessionID = SessionID.make("session-prompt-routing")
      const agent = {
        name: "test",
        mode: "primary",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        ...(input.agentPrompt ? { prompt: input.agentPrompt } : {}),
      } satisfies Agent.Info
      const user = {
        id: MessageID.make("user-prompt-routing"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: ProviderID.make(input.providerID), modelID: resolved.id },
      } satisfies MessageV2.User

      await drain({
        user,
        sessionID,
        model: resolved,
        agent,
        system: ["runtime-system"],
        messages: [{ role: "user", content: "Hello" }],
        tools: {},
      })

      return systemPromptFrom((await request).body)
    },
  })
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test("injects DeepSeek overlay when an agent prompt replaces provider prompt", async () => {
    const system = await capturePromptRoutingSystem({
      providerID: "deepseek",
      modelID: "deepseek-chat",
      agentPrompt: "custom-agent-prompt",
    })

    expect(system).toContain("custom-agent-prompt")
    expect(system).toContain("# DeepSeek runtime overlay")
    expect(system).not.toContain("你是运行在 DeepSeek 上的 Chimera 代理")
    expect(system).toContain("runtime-system")
  })

  test("does not inject DeepSeek overlay for non-DeepSeek models with agent prompt", async () => {
    const system = await capturePromptRoutingSystem({
      providerID: "alibaba",
      modelID: "qwen-plus",
      agentPrompt: "custom-agent-prompt",
    })

    expect(system).toContain("custom-agent-prompt")
    expect(system).not.toContain("# DeepSeek runtime overlay")
    expect(system).toContain("runtime-system")
  })

  test("keeps DeepSeek provider prompt and overlay without agent prompt", async () => {
    const system = await capturePromptRoutingSystem({
      providerID: "deepseek",
      modelID: "deepseek-chat",
    })

    expect(system).toContain("You are Chimera")
    expect(system).toContain("你是运行在 DeepSeek 上的 Chimera 代理")
    expect(system).toContain("# DeepSeek runtime overlay")
    expect(system).toContain("runtime-system")
  })
  test("keeps Codex semantics on OpenAI-compatible Chat requests", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "vivgrid"
    const modelID = "gemini-3.1-pro-preview"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
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
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                backend_semantics: "codex",
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        expect(resolved.backend_semantics).toBe("codex")
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")
        expect(headers.get("User-Agent")?.startsWith(`opencode/${InstallationVersion}`)).toBe(true)
        expect(headers.get("User-Agent")).toContain("ai-sdk/provider-utils/")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(body.max_tokens).toBe(expectedMaxTokens)
        expect(body).not.toHaveProperty("max_output_tokens")
        expect(body.reasoning_effort).toBe("high")
        expect(body).not.toHaveProperty("reasoningEffort")
      },
    })
  })

  test("encodes Codex modes and Ultra effort on OpenAI-compatible Chat", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "custom-compatible-chat"
    const modelID = "gpt-5.6-sol"
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "Custom Compatible Chat",
                npm: "@ai-sdk/openai-compatible",
                wire_api: "chat",
                backend_semantics: "codex",
                env: [],
                models: { [modelID]: { reasoning: true } },
                options: {
                  apiKey: "test-compatible-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(modelID))
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const capture = async (variant: string, label: string, parentSessionID?: string) => {
          const request = waitRequest(
            "/chat/completions",
            new Response(createChatStream(label), {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          )
          const sessionID = SessionID.make(`session-compatible-${label}`)
          const user = {
            id: MessageID.make(`user-compatible-${label}`),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant },
          } satisfies MessageV2.User

          await drain({
            user,
            sessionID,
            parentSessionID,
            model: resolved,
            agent,
            system: ["runtime-system"],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })
          return (await request).body
        }

        const ultra = await capture("ultra", "ultra")
        expect(ultra.reasoning_effort).toBe("max")
        const ultraPrompt = promptForRole(ultra, "system")
        expect(ultraPrompt).toContain("Proactive multi-agent delegation is active for this root session.")
        expect(ultraPrompt).toContain("perform a delegation checkpoint")
        expect(ultraPrompt).toContain("state the concrete blocker")
        expect(ultraPrompt).toContain("Do not fan out by item count alone.")
        expect((ultra.messages as Array<{ role?: string }>).some((message) => message.role === "developer")).toBe(false)

        const max = await capture("max", "max")
        expect(max.reasoning_effort).toBe("max")
        expect(promptForRole(max, "system")).toContain("Explicit-request-only multi-agent mode is active.")

        const child = await capture("ultra", "child", SessionID.make("session-compatible-parent"))
        expect(child.reasoning_effort).toBe("max")
        expect(promptForRole(child, "system")).toContain("active for this child session")
        expect(promptForRole(child, "system")).not.toContain("active for this root session")
      },
    })
  })

  test("uses developer policy on OpenAI Chat and rejects unsupported Codex maximum efforts", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "custom-openai-chat"
    const modelID = "gpt-5.6-sol"
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("high"), {
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
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "Custom OpenAI Chat",
                npm: "@ai-sdk/openai",
                wire_api: "chat",
                backend_semantics: "codex",
                env: [],
                models: { [modelID]: { reasoning: true } },
                options: {
                  apiKey: "test-openai-chat-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(modelID))
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const highSessionID = SessionID.make("session-openai-chat-high")
        const highUser = {
          id: MessageID.make("user-openai-chat-high"),
          sessionID: highSessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user: highUser,
          sessionID: highSessionID,
          model: resolved,
          agent,
          system: ["runtime-system"],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const high = (await request).body
        expect(high.reasoning_effort).toBe("high")
        expect(promptForRole(high, "developer")).toContain("Explicit-request-only multi-agent mode is active.")
        expect((high.messages as Array<{ role?: string }>).some((message) => message.role === "system")).toBe(false)

        const ultraSessionID = SessionID.make("session-openai-chat-ultra")
        const ultraUser = {
          ...highUser,
          id: MessageID.make("user-openai-chat-ultra"),
          sessionID: ultraSessionID,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "ultra" },
        } satisfies MessageV2.User
        await expect(
          drain({
            user: ultraUser,
            sessionID: ultraSessionID,
            model: resolved,
            agent,
            system: ["runtime-system"],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          }),
        ).rejects.toThrow('does not support Codex reasoning effort "ultra". Use wire_api "responses" or @ai-sdk/openai-compatible Chat.')
      },
    })
  })

  test("service stream cancellation cancels provider response body promptly", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const ctrl = new AbortController()
        const run = llm.runPromiseExit(
          (svc) =>
            svc
              .stream({
                user,
                sessionID,
                model: resolved,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
              })
              .pipe(Stream.runDrain),
          { signal: ctrl.signal },
        )

        await pending.request
        ctrl.abort()

        await Promise.race([pending.responseCanceled, timeout(500)])
        const exit = await run
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
      },
    })
  })

  test("service stream propagates caller abort signal to provider request", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-caller-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-caller-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const ctrl = new AbortController()
        const run = llm.runPromiseExit((svc) =>
          svc
            .stream({
              user,
              sessionID,
              model: resolved,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
              abort: ctrl.signal,
            })
            .pipe(Stream.runDrain),
        )

        await pending.request
        ctrl.abort()

        await Promise.race([pending.responseCanceled, timeout(500)])
        await run
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
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
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string }; type?: string }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
        expect(tools?.some((item) => item.type === "web_search")).toBe(false)
      },
    })
  })

  test("routes OpenAI OAuth conversation streams directly to Codex Responses", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const request = waitRequest(
      "/backend-api/codex/responses",
      createEventResponse([
        { type: "response.created", response: { id: "resp-direct", created_at: Math.floor(Date.now() / 1000), model: model.id } },
        { type: "response.output_item.added", output_index: 0, item: { id: "msg-direct", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg-direct", delta: "Hello direct" },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg-direct", type: "message" } },
        { type: "response.completed", response: { id: "resp-direct", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
      ], true),
    )
    const originalAuth = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "refresh-direct",
        access: "access-direct",
        expires: Date.now() + 60_000,
        accountId: "acc-direct",
      },
    })

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "chimera.json"),
            JSON.stringify({
              $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
              enabled_providers: ["openai"],
              provider: {
                openai: {
                  name: "OpenAI",
                  env: [],
                  npm: "file:///tmp/chimera-missing-openai-provider.js",
                  api: "https://api.openai.com/v1",
                  models: {
                    [model.id]: {
                      ...model,
                      variants: { ultra: { reasoningEffort: "ultra" } },
                    },
                  },
                  options: {
                    codexApiEndpoint: `${server.url.origin}/backend-api/codex/responses`,
                  },
                },
              },
            }),
          )
        },
      })

      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
          expect(resolved.backend_semantics).toBe("codex")
          const sessionID = SessionID.make("session-test-openai-oauth-direct")
          const agent = {
            name: "test",
            mode: "primary",
            prompt: "You are a helpful assistant.",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const user = {
            id: MessageID.make("user-openai-oauth-direct"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderID.make("openai"), modelID: resolved.id, variant: "ultra" },
          } satisfies MessageV2.User

          await drain({
            user,
            sessionID,
            model: resolved,
            agent,
            system: [],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })

          const capture = await request
          const body = capture.body
          expect(capture.url.pathname.endsWith("/backend-api/codex/responses")).toBe(true)
          expect(capture.headers.get("authorization")).toBe("Bearer access-direct")
          expect(capture.headers.get("ChatGPT-Account-ID")).toBe("acc-direct")
          expect(body.model).toBe(resolved.api.id)
          const instructions = body.instructions as string
          expect(instructions).toContain("You are a helpful assistant.")
          expect(instructions).toContain("<multi_agent_mode>")
          expect(instructions).toContain("Proactive multi-agent delegation is active for this root session.")
          expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hello" }] }])
          expect(body.stream).toBe(true)
          expect(body.store).toBe(false)
          expect(body.prompt_cache_key).toBe(sessionID)
          expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("max")
          expect(body.max_output_tokens).toBeUndefined()
          expect(body.tools).toContainEqual({
            type: "web_search",
            external_web_access: true,
            search_context_size: "medium",
          })
          expect(body.include).toContain("web_search_call.action.sources")
        },
      })
    } finally {
      if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = originalAuth
    }
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect(body.tools).toContainEqual({
          type: "web_search",
          external_web_access: true,
          search_context_size: "medium",
        })
        expect(body.tool_choice).toBe("auto")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      },
    })
  })

  test("maps Ultra to max through custom Responses providers", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "custom-responses"
    const modelID = "gpt-5.6-sol"
    const request = waitRequest(
      "/responses",
      createEventResponse(
        [
          {
            type: "response.created",
            response: {
              id: "resp-custom",
              created_at: Math.floor(Date.now() / 1000),
              model: modelID,
              service_tier: null,
            },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-custom",
            delta: "Hello custom",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 2,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ],
        true,
      ),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "Custom Responses",
                wire_api: "responses",
                backend_semantics: "codex",
                env: [],
                models: {
                  [modelID]: {
                    reasoning: true,
                  },
                },
                options: {
                  apiKey: "test-custom-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(modelID))
        const sessionID = SessionID.make("session-test-custom-responses")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-custom-responses"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "ultra" },
        } satisfies MessageV2.User

        const events = await llm.runPromise((svc) =>
          svc
            .stream({
              user,
              sessionID,
              model: resolved,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            })
            .pipe(
              Stream.runCollect,
              Effect.map((items) => [...items]),
            ),
        )

        const capture = await request
        expect(capture.url.pathname).toBe("/v1/responses")
        expect(capture.headers.get("authorization")).toBe("Bearer test-custom-key")
        expect(capture.body.model).toBe(modelID)
        expect(capture.body.stream).toBe(true)
        expect(capture.body.store).toBe(false)
        expect(promptForRole(capture.body, "developer")).toContain("Proactive multi-agent delegation is active for this root session.")
        expect((capture.body.input as Array<{ role?: string }>).some((message) => message.role === "system")).toBe(false)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("max")
        expect(events.some((event) => event.type === "text-delta" && event.text === "Hello custom")).toBe(true)
        expect(events.some((event) => event.type === "finish")).toBe(true)
      },
    })
  })


  test("accepts user image attachments as data URLs for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-data-url",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-data-url",
        delta: "Looks good",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))
    const image = `data:image/png;base64,${Buffer.from(
      await Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
    ).toString("base64")}`

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                {
                  type: "file",
                  mediaType: "image/png",
                  filename: "large-image.png",
                  data: image,
                },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = await request
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      },
    })
  })

  test("sends messages API payload for Anthropic Compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "minimax"
    const modelID = "MiniMax-M2.5"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("minimax"), modelID: ModelID.make("MiniMax-M2.5") },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends anthropic tool_use blocks with tool_result immediately after them", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("anthropic", "claude-opus-4-6")
    const model = source.model
    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-tool-order",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: {
                name: "Anthropic",
                env: ["ANTHROPIC_API_KEY"],
                npm: "@ai-sdk/anthropic",
                api: "https://api.anthropic.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make("anthropic"), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies MessageV2.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: await MessageV2.toModelMessages(input as any, resolved),
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({
                filePath: z.string(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({
                pattern: z.string(),
                path: z.string().optional(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.messages).toStrictEqual([
          {
            role: "user",
            content: [{ type: "text", text: "Can you check whether there are any PDF files in my home directory?" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
              },
              {
                type: "tool_use",
                id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                name: "read",
                input: { filePath: "/root" },
              },
              {
                type: "tool_use",
                id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                name: "glob",
                input: { pattern: "**/*.pdf", path: "/root" },
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                content: "<path>/root</path>",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                content: "No files found",
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
        ])
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "chimera.json"),
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})
