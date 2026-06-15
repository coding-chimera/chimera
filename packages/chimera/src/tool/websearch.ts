import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Tool from "./tool"
import * as McpExa from "./mcp-exa"
import DESCRIPTION from "./websearch.txt"

type WebSearchMetadata = {
  provider?: "opencode-exa"
  numResults?: number
}

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function activeProviderID(model: unknown) {
  if (!isRecord(model)) return
  return typeof model.providerID === "string" ? model.providerID : undefined
}

const searchExa = Effect.fn("WebSearch.searchExa")(function* (
  http: HttpClient.HttpClient,
  params: Schema.Schema.Type<typeof Parameters>,
) {
  return (
    (yield* McpExa.call(
      http,
      "web_search_exa",
      McpExa.SearchArgs,
      {
        query: params.query,
        type: params.type || "auto",
        numResults: params.numResults || 8,
        livecrawl: params.livecrawl || "fallback",
        contextMaxCharacters: params.contextMaxCharacters,
      },
      "25 seconds",
    )) ?? "No search results found. Please try a different query."
  )
})

function legacyExaAvailable(ctx: Tool.Context) {
  return Flag.OPENCODE_ENABLE_EXA || activeProviderID(ctx.extra?.model) === "opencode"
}

function webSearchResult(input: {
  query: string
  output: string
  metadata: WebSearchMetadata
}): Tool.ExecuteResult<WebSearchMetadata> {
  return {
    output: input.output,
    title: `Web search: ${input.query}`,
    metadata: input.metadata,
  }
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<WebSearchMetadata>> =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
            },
          })

          if (!legacyExaAvailable(ctx)) {
            return webSearchResult({
              query: params.query,
              output:
                "Web search is unavailable: no configured Kimi/Exa search provider. Kimi search is not implemented yet; explicitly enable opencode-exa for current builds.",
              metadata: {},
            })
          }

          const result = yield* searchExa(http, params)

          return webSearchResult({
            query: params.query,
            output: result,
            metadata: { provider: "opencode-exa", numResults: params.numResults },
          })
        }).pipe(Effect.orDie),
    }
  }),
)
