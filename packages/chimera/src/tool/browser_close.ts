import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import DESCRIPTION from "./browser_close.txt"
import { askForTab, run } from "./browser-shared"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tabID: Schema.optional(Schema.String).annotate({
    description: "Close only this browser tab; omit to close all browser state for the current session",
  }),
})

export const BrowserCloseTool = Tool.define(
  "browser_close",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const tab = yield* askForTab(runtime, ctx, "browser_close", params.tabID, {
            scope: params.tabID ? "tab" : "session",
          })
          if (params.tabID) yield* run(runtime.closeTab({ sessionID: ctx.sessionID, tabID: tab.id }))
          else yield* run(runtime.closeSession(ctx.sessionID))
          return {
            title: params.tabID ? `Closed browser tab ${tab.id}` : "Closed browser session",
            output: params.tabID
              ? `Closed browser tab ${tab.id}.`
              : `Closed all browser tabs and browser context for session ${ctx.sessionID}.`,
            metadata: { tabID: params.tabID ? tab.id : undefined, scope: params.tabID ? "tab" : "session" },
          }
        }),
    }
  }),
)
