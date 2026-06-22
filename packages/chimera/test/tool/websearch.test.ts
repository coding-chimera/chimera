import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { WebSearchTool } from "../../src/tool/websearch"
import { Truncate } from "../../src/tool/truncate"
import type { Tool } from "../../src/tool/tool"
import { WithInstance } from "../../src/project/with-instance"
import { Auth } from "../../src/auth"

const projectRoot = path.join(import.meta.dir, "../..")

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  extra: { model: { providerID: "opencode" } },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function mockAuth(keys: { kimi?: string; deepseek?: string } = {}) {
  return Layer.mock(Auth.Service)({
    get: (providerID: string) =>
      Effect.succeed(
        providerID === "kimi-for-coding" && keys.kimi
          ? { type: "api" as const, key: keys.kimi }
          : providerID === "deepseek" && keys.deepseek
            ? { type: "api" as const, key: keys.deepseek }
            : undefined,
      ),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  })
}

function deepSeekResponse() {
  return new Response(
    JSON.stringify({
      model: "deepseek-v4-flash",
      content: [
        {
          type: "server_tool_use",
          id: "call_search",
          name: "web_search",
          input: { query: "latest AI news" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "call_search",
          content: [
            {
              type: "web_search_result",
              title: "DeepSeek source",
              url: "https://example.com/deepseek",
              encrypted_content: "encrypted",
            },
          ],
        },
        {
          type: "text",
          text: "DeepSeek answer",
        },
      ],
      usage: {
        server_tool_use: {
          web_search_requests: 1,
        },
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  )
}

function kimiResponse(text = "Kimi content") {
  return new Response(
    JSON.stringify({
      search_results: [
        {
          title: "Kimi result",
          url: "https://example.com/kimi",
          snippet: "Kimi snippet",
          date: "2026-06-16",
          content: text,
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  )
}

function execute(ctx: Tool.Context, http: Layer.Layer<HttpClient.HttpClient>, auth = mockAuth()) {
  return WebSearchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) =>
      tool.execute(
        {
          query: "latest AI news",
          numResults: 3,
          livecrawl: "preferred",
          type: "deep",
          contextMaxCharacters: 1000,
        },
        ctx,
      ),
    ),
    Effect.provide(Layer.mergeAll(http, auth, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.websearch", () => {
  test("routes configured DeepSeek search through stored deepseek API key", async () => {
    let url = ""
    let apiKey = ""
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          baseCtx,
          mockHttpClient((request) => {
            url = request.url
            apiKey = request.headers["x-api-key"] ?? request.headers["X-Api-Key"] ?? ""
            return deepSeekResponse()
          }),
          mockAuth({ deepseek: "deepseek-test-key", kimi: "kimi-test-key" }),
        ),
    })

    expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages")
    expect(apiKey).toBe("deepseek-test-key")
    expect(result.output).toContain("DeepSeek answer")
    expect(result.output).toContain("DeepSeek source")
    expect(result.output).toContain("https://example.com/deepseek")
    expect(result.metadata.provider).toBe("deepseek-web-search")
    expect(result.metadata.authMode).toBe("api-key")
    expect(result.metadata.model).toBe("deepseek-v4-flash")
    expect(result.metadata.webSearchRequests).toBe(1)
    expect(result.metadata.sourceCount).toBe(1)
  })

  test("uses Kimi with explicit fallback when DeepSeek is not configured", async () => {
    let url = ""
    let authorization = ""
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          baseCtx,
          mockHttpClient((request) => {
            url = request.url
            authorization = request.headers.authorization ?? request.headers.Authorization ?? ""
            return kimiResponse()
          }),
          mockAuth({ kimi: "kimi-test-key" }),
        ),
    })

    expect(url).toBe("https://api.kimi.com/coding/v1/search")
    expect(authorization).toBe("Bearer kimi-test-key")
    expect(result.output).toContain("DeepSeek web search is not configured; used Kimi search instead.")
    expect(result.output).toContain("Title: Kimi result")
    expect(result.output).toContain("URL: https://example.com/kimi")
    expect(result.output).toContain("Kimi content")
    expect(result.metadata.provider).toBe("kimi-code")
    expect(result.metadata.authMode).toBe("api-key")
    expect(result.metadata.fallbackFrom).toBe("deepseek-web-search")
    expect(result.metadata.fallbackReason).toBe("DeepSeek web search is not configured")
  })

  test("uses Kimi with explicit fallback when DeepSeek search fails", async () => {
    const urls: string[] = []
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          baseCtx,
          mockHttpClient((request) => {
            urls.push(request.url)
            if (request.url === "https://api.deepseek.com/anthropic/v1/messages") return new Response("failed", { status: 500 })
            return kimiResponse("kimi fallback result")
          }),
          mockAuth({ deepseek: "deepseek-test-key", kimi: "kimi-test-key" }),
        ),
    })

    expect(urls).toEqual(["https://api.deepseek.com/anthropic/v1/messages", "https://api.kimi.com/coding/v1/search"])
    expect(result.output).toContain("DeepSeek web search failed; used Kimi search instead.")
    expect(result.output).toContain("kimi fallback result")
    expect(result.metadata.provider).toBe("kimi-code")
    expect(result.metadata.fallbackFrom).toBe("deepseek-web-search")
    expect(result.metadata.fallbackReason).toBe("DeepSeek web search failed")
  })

  test("does not call Exa when no preferred search provider is configured", async () => {
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          baseCtx,
          mockHttpClient(() => {
            throw new Error("unexpected search request")
          }),
        ),
    })

    expect(result.output).toContain("Web search unavailable.")
    expect(result.output).toContain("DeepSeek web search is not configured")
    expect(result.output).toContain("Kimi search is not configured")
    expect(result.output).toContain("Exa fallback is disabled")
    expect(result.metadata.provider).toBeUndefined()
    expect(result.metadata.fallbackErrors).toEqual([
      "DeepSeek web search is not configured",
      "Kimi search is not configured",
    ])
  })

  test("does not call Exa when Kimi fails and DeepSeek is unavailable", async () => {
    const urls: string[] = []
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          baseCtx,
          mockHttpClient((request) => {
            urls.push(request.url)
            return new Response("failed", { status: 500 })
          }),
          mockAuth({ kimi: "kimi-test-key" }),
        ),
    })

    expect(urls).toEqual(["https://api.kimi.com/coding/v1/search"])
    expect(result.output).toContain("DeepSeek web search is not configured")
    expect(result.output).toContain("Kimi search failed")
    expect(result.output).toContain("Exa fallback is disabled")
    expect(result.metadata.provider).toBeUndefined()
  })

  test("does not use unified search for hosted OpenAI search models", async () => {
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          {
            ...baseCtx,
            extra: { model: { providerID: "openai" } },
          },
          mockHttpClient(() => {
            throw new Error("unexpected search request")
          }),
        ),
    })

    expect(result.output).toContain("hosted web_search")
    expect(result.metadata.provider).toBeUndefined()
  })
})
