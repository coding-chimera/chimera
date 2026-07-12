import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import DESCRIPTION from "./browser_screenshot.txt"
import { askForTab, run } from "./browser-shared"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tabID: Schema.optional(Schema.String).annotate({ description: "Browser tab ID; defaults to the current tab" }),
  name: Schema.optional(Schema.String).annotate({ description: "Optional artifact name" }),
  fullPage: Schema.optional(Schema.Boolean).annotate({ description: "Capture the full page instead of the viewport" }),
})

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const tab = yield* askForTab(runtime, ctx, "browser_screenshot", params.tabID, {
            fullPage: params.fullPage ?? false,
          })
          const screenshot = yield* run(
            runtime.screenshot({
              sessionID: ctx.sessionID,
              tabID: tab.id,
              name: params.name,
              fullPage: params.fullPage,
            }),
          )
          return {
            title: `Browser screenshot: ${screenshot.artifact.filename}`,
            output: `Screenshot saved to ${screenshot.artifact.path}`,
            metadata: {
              tabID: tab.id,
              artifactPath: screenshot.artifact.path,
              filename: screenshot.artifact.filename,
            },
            attachments: [screenshot.attachment],
          }
        }),
    }
  }),
)
