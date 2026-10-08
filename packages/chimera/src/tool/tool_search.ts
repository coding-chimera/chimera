import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./tool_search.txt"
import { ToolSearch } from "@/session/tool-search"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { PositiveInt } from "@/util/schema"

type Metadata = {
  revealed?: string[]
  alreadyRevealed?: string[]
}

// Subagent-mode registry views hide the preference-mutation tools (see
// ToolRegistry.tools); tool_search must not promise to reveal what the
// registry will never list for this agent mode.
const SUBAGENT_HIDDEN = ["subagent_model_prefer", "subagent_model_suppress"]

export const ToolSearchParameters = Schema.Struct({
  query: Schema.String.annotate({
    description: 'Keyword query for deferred tools, e.g. "browser", "references", "model route".',
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: `Maximum number of tools to reveal. Defaults to ${ToolSearch.DEFAULT_REVEAL_LIMIT}, capped at ${ToolSearch.MAX_REVEAL_LIMIT}.`,
  }),
})

export const ToolSearchTool = Tool.define<
  typeof ToolSearchParameters,
  Metadata,
  ToolSearch.Service | Agent.Service | Session.Service
>("tool_search", Effect.gen(function* () {
  const toolSearch = yield* ToolSearch.Service
  const agents = yield* Agent.Service
  const sessions = yield* Session.Service

  return {
    description: DESCRIPTION,
    parameters: ToolSearchParameters,
    execute: (params: Schema.Schema.Type<typeof ToolSearchParameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "tool_search",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const denied = Permission.disabled(
          ToolSearch.DEFERRED_TOOLS.map((tool) => tool.id),
          Permission.merge(agent.permission, session.permission ?? []),
        )
        const candidates = ToolSearch.DEFERRED_TOOLS.filter(
          (tool) =>
            !denied.has(tool.id) &&
            !(agent.mode === "subagent" && SUBAGENT_HIDDEN.includes(tool.id)),
        ).map((tool) => ({ id: tool.id, description: tool.summary }))
        const matches = toolSearch.search({
          query: params.query,
          limit: params.limit ?? ToolSearch.DEFAULT_REVEAL_LIMIT,
          candidates,
        })
        if (matches.length === 0)
          return {
            title: "Tool Search",
            metadata: {},
            output: `No deferred tools matched "${params.query}"; try another keyword. Deferred categories: browser_* (browser automation), lsp (language-server intelligence), subagent_model_* (subagent model routing).`,
          }
        const revealed = toolSearch.revealed(ctx.sessionID)
        const already = matches.filter((match) => revealed.has(match.id))
        const fresh = matches.filter((match) => !revealed.has(match.id))
        toolSearch.reveal(
          ctx.sessionID,
          matches.map((match) => match.id),
        )
        const summary = (id: string) => ToolSearch.DEFERRED_TOOLS.find((tool) => tool.id === id)!.summary
        const sections = []
        if (fresh.length > 0)
          sections.push(
            [
              "Revealed tools:",
              ...fresh.map((match) => `- \`${match.id}\`: ${summary(match.id)}`),
              "These tools are now in your tool list and callable from your next model call.",
            ].join("\n"),
          )
        if (already.length > 0)
          sections.push(
            [
              "Already revealed in this session (still callable):",
              ...already.map((match) => `- \`${match.id}\`: ${summary(match.id)}`),
            ].join("\n"),
          )
        return {
          title: "Tool Search",
          metadata: {
            revealed: fresh.map((match) => match.id),
            alreadyRevealed: already.map((match) => match.id),
          },
          output: sections.join("\n\n"),
        }
      }),
  } satisfies Tool.DefWithoutID<typeof ToolSearchParameters, Metadata>
}))
