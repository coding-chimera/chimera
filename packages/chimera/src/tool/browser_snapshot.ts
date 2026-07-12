import { Effect, Schema } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import DESCRIPTION from "./browser_snapshot.txt"
import { askForTab, run } from "./browser-shared"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tabID: Schema.optional(Schema.String).annotate({ description: "Browser tab ID; defaults to the current tab" }),
  preset: Schema.optional(Schema.Literals(["efficient"])).annotate({
    description: "Snapshot preset; defaults to efficient",
  }),
  interactive: Schema.optional(Schema.Boolean).annotate({ description: "Include only interactive nodes" }),
  compact: Schema.optional(Schema.Boolean).annotate({ description: "Use compact snapshot formatting" }),
  depth: Schema.optional(Schema.Number).annotate({ description: "Maximum accessibility-tree depth" }),
  maxChars: Schema.optional(Schema.Number).annotate({ description: "Maximum snapshot output characters" }),
})

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const tab = yield* askForTab(runtime, ctx, "browser_snapshot", params.tabID)
          const snapshot = yield* run(
            runtime.snapshot({
              sessionID: ctx.sessionID,
              tabID: tab.id,
              options: {
                preset: params.preset ?? "efficient",
                interactive: params.interactive,
                compact: params.compact,
                depth: params.depth,
                maxChars: params.maxChars,
              },
            }),
          )
          return {
            title: `Browser snapshot: ${snapshot.title || snapshot.trust.origin}`,
            output: snapshot.text,
            metadata: {
              tabID: snapshot.tabID,
              generation: snapshot.generation,
              origin: snapshot.trust.origin,
              untrusted: snapshot.trust.untrusted,
              truncated: snapshot.truncated,
              omittedLines: snapshot.omittedLines,
              refCount: snapshot.refs.size,
            },
          }
        }),
    }
  }),
)
