import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import { UNTRUSTED_MARKER } from "@/browser/snapshot"
import DESCRIPTION from "./browser_evaluate.txt"
import { currentTab, origin, run } from "./browser-shared"
import * as Tool from "./tool"

const MAX_OUTPUT_CHARS = 4_000

export const Parameters = Schema.Struct({
  script: Schema.String.annotate({
    description: "JavaScript expression or async IIFE to evaluate in the tab's page context",
  }),
  tabID: Schema.optional(Schema.String).annotate({ description: "Browser tab ID; defaults to the current tab" }),
})

function stringify(value: unknown) {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "symbol" || typeof value === "function") return value.toString()
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`.trim()
  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(
      value,
      (_key: string, item: unknown) => {
        if (typeof item === "bigint") return `${item}n`
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]"
          seen.add(item)
        }
        return item
      },
      2,
    )
    if (json !== undefined) return json
  } catch {
    return "[unserializable object]"
  }
  return "[unserializable object]"
}

function truncate(value: string) {
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value, truncated: false }
  return {
    text: `${value.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated: ${value.length - MAX_OUTPUT_CHARS} more characters]`,
    truncated: true,
  }
}

export const BrowserEvaluateTool = Tool.define(
  "browser_evaluate",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const tab = yield* currentTab(runtime, ctx.sessionID, params.tabID)
          const pattern = origin(tab.url)
          // Arbitrary page script runs with the tab's credentials, so approval is
          // per call: no origin-wide "always" rule is persisted.
          yield* ctx.ask({
            permission: "browser_evaluate",
            patterns: [pattern],
            always: [],
            metadata: { tabID: tab.id, origin: pattern, scriptLength: params.script.length },
          })
          const result = yield* run(
            runtime.evaluate({
              sessionID: ctx.sessionID,
              tabID: tab.id,
              script: params.script,
            }),
          )
          const formatted = truncate(stringify(result.value))
          return {
            title: `Evaluated browser script in tab ${result.tabID}`,
            output: `${UNTRUSTED_MARKER}\n${formatted.text}\nBrowser refs are now stale; run browser_snapshot again.`,
            metadata: {
              tabID: result.tabID,
              origin: origin(result.url),
              untrusted: true,
              refsInvalidated: true,
              truncated: formatted.truncated,
            },
          }
        }),
    }
  }),
)
