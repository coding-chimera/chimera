import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ToolSearch } from "@/session/tool-search"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        // A misnamed tool_search call must not receive guidance pointing back
        // at tool_search (self-lock): spell out the exact registered name and
        // invocation shape instead.
        output: ToolSearch.isToolSearchAlias(params.tool)
          ? ToolSearch.unknownToolGuidance(params.tool)
          : `The arguments provided to the tool are invalid: ${params.error}`,
        metadata: {},
      }),
  }),
)
