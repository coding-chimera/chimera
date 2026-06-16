import { Effect, Exit, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Auth } from "@/auth"
import * as Tool from "./tool"
import * as McpExa from "./mcp-exa"
import DESCRIPTION from "./websearch.txt"

type WebSearchMetadata = {
  provider?: "kimi-code" | "opencode-exa"
  authMode?: "api-key"
  numResults?: number
}

const KIMI_FOR_CODING_ID = "kimi-for-coding"
const KIMI_SEARCH_BASE_URL = "https://api.kimi.com/coding/v1"

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

export function usesProviderHostedWebSearch(providerID: string) {
  const id = providerID.toLowerCase()
  return id === "openai" || id === "codex"
}

function kimiApiKey(info: Auth.Info | undefined) {
  if (info?.type !== "api") return
  const key = info.key.trim()
  if (!key) return
  return key
}

const KimiSearchResult = Schema.Struct({
  site_name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  mime: Schema.optional(Schema.String),
})

const KimiSearchResponse = Schema.Struct({
  search_results: Schema.optional(Schema.Array(KimiSearchResult)),
})

const searchKimi = Effect.fn("WebSearch.searchKimi")(function* (
  http: HttpClient.HttpClient,
  apiKey: string,
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const response = yield* HttpClientRequest.post(`${KIMI_SEARCH_BASE_URL}/search`).pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    HttpClientRequest.bodyJson({
      text_query: params.query,
      limit: params.numResults || 8,
      enable_page_crawling: params.livecrawl === "preferred",
      timeout_seconds: 30,
    }),
    Effect.flatMap((request) => HttpClient.filterStatusOk(http).execute(request)),
    Effect.timeoutOrElse({
      duration: "25 seconds",
      orElse: () => Effect.die(new Error("kimi-code search request timed out")),
    }),
  )
  const json = yield* HttpClientResponse.schemaBodyJson(KimiSearchResponse)(response)
  const results = json.search_results ?? []
  if (results.length === 0) return "No search results found. Please try a different query."
  return results
    .map((result) =>
      [
        `Title: ${result.title ?? ""}`,
        result.date ? `Date: ${result.date}` : undefined,
        `URL: ${result.url ?? ""}`,
        `Snippet: ${result.snippet ?? ""}`,
        result.content ? `\n${result.content}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    )
    .join("\n\n---\n\n")
})

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
    const auth = yield* Auth.Service

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

          const providerID = activeProviderID(ctx.extra?.model)
          if (providerID && usesProviderHostedWebSearch(providerID)) {
            return webSearchResult({
              query: params.query,
              output:
                "Web search is handled by the active provider's hosted web_search. Chimera unified Kimi/Exa websearch is disabled for this model.",
              metadata: {},
            })
          }

          const apiKey = kimiApiKey(
            yield* auth.get(KIMI_FOR_CODING_ID).pipe(Effect.orElseSucceed(() => undefined)),
          )
          if (apiKey) {
            const result = yield* searchKimi(http, apiKey, params).pipe(Effect.exit)
            if (Exit.isSuccess(result)) {
              return webSearchResult({
                query: params.query,
                output: result.value,
                metadata: { provider: "kimi-code", authMode: "api-key", numResults: params.numResults },
              })
            }
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
