import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import DESCRIPTION from "./browser_type.txt"
import { askForTab, run } from "./browser-shared"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  ref: Schema.String.annotate({ description: "Generation-scoped ref from the latest browser snapshot" }),
  text: Schema.String.annotate({ description: "Text that replaces the target control's current value" }),
  tabID: Schema.optional(Schema.String).annotate({ description: "Browser tab ID; defaults to the current tab" }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional fill timeout in milliseconds" }),
})

export const BrowserTypeTool = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const tab = yield* askForTab(runtime, ctx, "browser_type", params.tabID, { ref: params.ref })
          yield* run(
            runtime.type({
              sessionID: ctx.sessionID,
              tabID: tab.id,
              ref: params.ref,
              text: params.text,
              timeout: params.timeout,
            }),
          )
          return {
            title: `Typed into browser ref ${params.ref}`,
            output: `Updated ${params.ref} in browser tab ${tab.id}. Browser refs are now stale; run browser_snapshot again.`,
            metadata: { tabID: tab.id, ref: params.ref },
          }
        }),
    }
  }),
)
