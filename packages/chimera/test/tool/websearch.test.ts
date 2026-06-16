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

function mockAuth(key?: string) {
  return Layer.mock(Auth.Service)({
    get: (providerID: string) =>
      Effect.succeed(providerID === "kimi-for-coding" && key ? { type: "api" as const, key } : undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  })
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
  test("routes configured Kimi search through kimi-code API key", async () => {
    let url = ""
    let authorization = ""
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          {
            ...baseCtx,
            extra: { model: { providerID: "deepseek" } },
          },
          mockHttpClient((request) => {
            url = request.url
            authorization = request.headers.authorization ?? request.headers.Authorization ?? ""
            return new Response(
              JSON.stringify({
                search_results: [
                  {
                    title: "Kimi result",
                    url: "https://example.com/kimi",
                    snippet: "Kimi snippet",
                    date: "2026-06-16",
                    content: "Kimi content",
                  },
                ],
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          }),
          mockAuth("kimi-test-key"),
        ),
    })

    expect(url).toBe("https://api.kimi.com/coding/v1/search")
    expect(authorization).toBe("Bearer kimi-test-key")
    expect(result.output).toContain("Title: Kimi result")
    expect(result.output).toContain("URL: https://example.com/kimi")
    expect(result.output).toContain("Kimi content")
    expect(result.metadata.provider).toBe("kimi-code")
    expect(result.metadata.authMode).toBe("api-key")
  })

  test("falls back to Exa when Kimi is not configured", async () => {
    let url = ""
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          baseCtx,
          mockHttpClient((request) => {
            url = request.url
            return new Response('data: {"result":{"content":[{"type":"text","text":"search result"}]}}\n\n')
          }),
        ),
    })

    expect(url.startsWith("https://mcp.exa.ai/mcp")).toBe(true)
    expect(result.output).toBe("search result")
    expect(result.metadata.provider).toBe("opencode-exa")
    expect(result.metadata.numResults).toBe(3)
  })

  test("falls back to Exa when Kimi search fails", async () => {
    const urls: string[] = []
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          {
            ...baseCtx,
            extra: { model: { providerID: "deepseek" } },
          },
          mockHttpClient((request) => {
            urls.push(request.url)
            if (request.url === "https://api.kimi.com/coding/v1/search") return new Response("failed", { status: 500 })
            return new Response('data: {"result":{"content":[{"type":"text","text":"exa fallback result"}]}}\n\n')
          }),
          mockAuth("kimi-test-key"),
        ),
    })

    expect(urls[0]).toBe("https://api.kimi.com/coding/v1/search")
    expect(urls[1]?.startsWith("https://mcp.exa.ai/mcp")).toBe(true)
    expect(result.output).toBe("exa fallback result")
    expect(result.metadata.provider).toBe("opencode-exa")
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
