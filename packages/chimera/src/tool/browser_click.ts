import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import DESCRIPTION from "./browser_click.txt"
import { askForTab, run } from "./browser-shared"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  ref: Schema.String.annotate({ description: "Generation-scoped ref from the latest browser snapshot" }),
  tabID: Schema.optional(Schema.String).annotate({ description: "Browser tab ID; defaults to the current tab" }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional click timeout in milliseconds" }),
})

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const tab = yield* askForTab(runtime, ctx, "browser_click", params.tabID, { ref: params.ref })
          yield* run(
            runtime.click({
              sessionID: ctx.sessionID,
              tabID: tab.id,
              ref: params.ref,
              timeout: params.timeout,
            }),
          )
          return {
            title: `Clicked browser ref ${params.ref}`,
            output: `Clicked ${params.ref} in browser tab ${tab.id}. Browser refs are now stale; run browser_snapshot again.`,
            metadata: { tabID: tab.id, ref: params.ref },
          }
        }),
    }
  }),
)
