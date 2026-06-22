import { Effect, Exit, Schema } from "effect"
import * as Option from "effect/Option"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import * as Tool from "./tool"
import DESCRIPTION from "./websearch.txt"

type WebSearchMetadata = {
  provider?: "deepseek-web-search" | "kimi-code"
  authMode?: "api-key"
  numResults?: number
  fallbackFrom?: "deepseek-web-search"
  fallbackReason?: string
  fallbackErrors?: string[]
  model?: string
  webSearchRequests?: number
  sourceCount?: number
}

const DEEPSEEK_PROVIDER_ID = "deepseek"
const DEEPSEEK_SEARCH_MODEL = "deepseek-chat"
const DEEPSEEK_ANTHROPIC_MESSAGES_URL = "https://api.deepseek.com/anthropic/v1/messages"
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

function stringValue(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  return trimmed
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : undefined
}

function activeProviderID(model: unknown) {
  if (!isRecord(model)) return
  return stringValue(model.providerID)
}

export function usesProviderHostedWebSearch(providerID: string) {
  const id = providerID.toLowerCase()
  return id === "openai" || id === "codex"
}

function authApiKey(info: Auth.Info | undefined) {
  if (info?.type !== "api") return
  return stringValue(info.key)
}

const deepSeekApiKey = Effect.fn("WebSearch.deepSeekApiKey")(function* (auth: Auth.Interface) {
  const service = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
  if (service) {
    const key = yield* service.getProvider(ProviderID.make(DEEPSEEK_PROVIDER_ID)).pipe(
      Effect.map((provider) => stringValue(provider.key) ?? stringValue(provider.options.apiKey)),
      Effect.orElseSucceed(() => undefined),
    )
    if (key) return key
  }
  return authApiKey(yield* auth.get(DEEPSEEK_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined)))
})

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

const DeepSeekMessagesResponse = Schema.Struct({
  model: Schema.optional(Schema.String),
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

type DeepSeekSearchResult = {
  output: string
  model?: string
  webSearchRequests?: number
  sourceCount: number
}

function deepSeekAnswer(json: Schema.Schema.Type<typeof DeepSeekMessagesResponse>) {
  return json.content
    .flatMap((block) => (block.type === "text" ? [stringValue(block.text)] : []))
    .filter((text): text is string => text !== undefined)
    .join("\n\n")
}

function deepSeekSources(json: Schema.Schema.Type<typeof DeepSeekMessagesResponse>) {
  return json.content.flatMap((block) => {
    if (block.type !== "web_search_tool_result") return []
    if (!Array.isArray(block.content)) return []
    return block.content.flatMap((item) => {
      const result = recordValue(item)
      if (!result) return []
      const title = stringValue(result.title)
      const url = stringValue(result.url)
      if (!title && !url) return []
      return [{ title, url }]
    })
  })
}

function deepSeekWebSearchRequests(json: Schema.Schema.Type<typeof DeepSeekMessagesResponse>) {
  const serverToolUse = recordValue(json.usage?.server_tool_use)
  return typeof serverToolUse?.web_search_requests === "number" ? serverToolUse.web_search_requests : undefined
}

function formatDeepSeekSources(sources: { title?: string; url?: string }[]) {
  return sources
    .map((source, index) =>
      [`${index + 1}. ${source.title ?? source.url ?? "Untitled"}`, source.url ? `   ${source.url}` : undefined]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    )
    .join("\n")
}

const searchDeepSeek = Effect.fn("WebSearch.searchDeepSeek")(function* (
  http: HttpClient.HttpClient,
  apiKey: string,
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const response = yield* HttpClientRequest.post(DEEPSEEK_ANTHROPIC_MESSAGES_URL).pipe(
    HttpClientRequest.setHeaders({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    HttpClientRequest.bodyJson({
      model: DEEPSEEK_SEARCH_MODEL,
      max_tokens: 512,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 1,
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            "Use web_search to answer this query.",
            `Return a concise answer with up to ${params.numResults || 8} source URLs.`,
            `Query: ${params.query}`,
          ].join("\n"),
        },
      ],
    }),
    Effect.flatMap((request) => HttpClient.filterStatusOk(http).execute(request)),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error("DeepSeek web search request timed out")),
    }),
  )
  const json = yield* HttpClientResponse.schemaBodyJson(DeepSeekMessagesResponse)(response)
  const sources = deepSeekSources(json).slice(0, params.numResults || 8)
  const answer = deepSeekAnswer(json) || "DeepSeek web search completed but returned no text answer."
  return {
    output: [answer, sources.length ? ["", "Sources:", formatDeepSeekSources(sources)].join("\n") : undefined]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
    model: json.model,
    webSearchRequests: deepSeekWebSearchRequests(json),
    sourceCount: sources.length,
  }
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
                "Web search is handled by the active provider's hosted web_search. Chimera unified websearch is disabled for this model.",
              metadata: {},
            })
          }

          const failures: string[] = []
          const deepSeekKey = yield* deepSeekApiKey(auth)
          if (deepSeekKey) {
            const result = yield* searchDeepSeek(http, deepSeekKey, params).pipe(Effect.exit)
            if (Exit.isSuccess(result)) {
              return webSearchResult({
                query: params.query,
                output: result.value.output,
                metadata: {
                  provider: "deepseek-web-search",
                  authMode: "api-key",
                  numResults: params.numResults,
                  model: result.value.model,
                  webSearchRequests: result.value.webSearchRequests,
                  sourceCount: result.value.sourceCount,
                },
              })
            }
            failures.push("DeepSeek web search failed")
          } else {
            failures.push("DeepSeek web search is not configured")
          }

          const kimiKey = authApiKey(
            yield* auth.get(KIMI_FOR_CODING_ID).pipe(Effect.orElseSucceed(() => undefined)),
          )
          if (kimiKey) {
            const result = yield* searchKimi(http, kimiKey, params).pipe(Effect.exit)
            if (Exit.isSuccess(result)) {
              const fallbackReason = failures[0] ?? "DeepSeek web search was not used"
              return webSearchResult({
                query: params.query,
                output: [`${fallbackReason}; used Kimi search instead.`, "", result.value].join("\n"),
                metadata: {
                  provider: "kimi-code",
                  authMode: "api-key",
                  numResults: params.numResults,
                  fallbackFrom: "deepseek-web-search",
                  fallbackReason,
                },
              })
            }
            failures.push("Kimi search failed")
          } else {
            failures.push("Kimi search is not configured")
          }

          return webSearchResult({
            query: params.query,
            output: ["Web search unavailable.", ...failures.map((failure) => `- ${failure}`), "- Exa fallback is disabled."].join("\n"),
            metadata: { fallbackErrors: failures, numResults: params.numResults },
          })
        }).pipe(Effect.orDie),
    }
  }),
)
