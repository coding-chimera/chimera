import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import DESCRIPTION from "./browser_open.txt"
import { httpURL, origin, run } from "./browser-shared"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http:// or https:// URL to open" }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional navigation timeout in milliseconds" }),
})

export const BrowserOpenTool = Tool.define(
  "browser_open",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const url = httpURL(params.url)
          yield* ctx.ask({
            permission: "browser_open",
            patterns: [url.origin],
            always: [url.origin],
            metadata: { origin: url.origin },
          })
          const tab = yield* run(
            runtime.open({
              sessionID: ctx.sessionID,
              url: url.href,
              launch: params.timeout === undefined ? undefined : { timeout: params.timeout },
            }),
          )
          const currentOrigin = origin(tab.url)
          return {
            title: `Opened browser tab: ${tab.title || currentOrigin}`,
            output: `Opened ${currentOrigin} in browser tab ${tab.id}. Run browser_snapshot before interacting.`,
            metadata: { tabID: tab.id, origin: currentOrigin, title: tab.title },
          }
        }),
    }
  }),
)
