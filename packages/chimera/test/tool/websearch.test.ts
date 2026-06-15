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

function execute(ctx: Tool.Context, http: Layer.Layer<HttpClient.HttpClient>) {
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
    Effect.provide(Layer.mergeAll(http, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.websearch", () => {
  test("routes available websearch through opencode-exa", async () => {
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

  test("does not use OpenAI as an aggregate search fallback", async () => {
    const result = await WithInstance.provide({
      directory: projectRoot,
      fn: () =>
        execute(
          {
            ...baseCtx,
            extra: { model: { providerID: "deepseek" } },
          },
          mockHttpClient(() => {
            throw new Error("unexpected search request")
          }),
        ),
    })

    expect(result.output).toContain("no configured Kimi/Exa search provider")
    expect(result.metadata.provider).toBeUndefined()
  })
})
