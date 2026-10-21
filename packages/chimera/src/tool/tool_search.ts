import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./tool_search.txt"
import { ToolSearch, ToolSearchParameters } from "@/session/tool-search"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"

type Metadata = {
  revealed?: string[]
  alreadyRevealed?: string[]
}

export const ToolSearchTool = Tool.define<
  typeof ToolSearchParameters,
  Metadata,
  ToolSearch.Service | Agent.Service | Session.Service
>(
  "tool_search",
  Effect.gen(function* () {
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
          const candidates = ToolSearch.deferredCandidates({
            agentMode: agent.mode,
            permission: Permission.merge(agent.permission, session.permission ?? []),
          })
          const matches = toolSearch.search({
            query: params.query,
            limit: params.limit ?? ToolSearch.DEFAULT_REVEAL_LIMIT,
            candidates,
          })
          if (matches.length === 0)
            return {
              title: "Tool Search",
              metadata: {},
              output: `No deferred tools matched "${params.query}"; try another keyword. Deferred categories: browser_* (browser automation), lsp (language-server intelligence), subagent_model_* (subagent model routing), chimera_obligation_* / chimera_obligations_sync (tracked follow-up), chimera_oracle_* (verification evidence recall).`,
            }
          const revealed = yield* toolSearch.revealed(ctx.sessionID)
          const already = matches.filter((match) => revealed.has(match.id))
          const fresh = matches.filter((match) => !revealed.has(match.id))
          yield* toolSearch.reveal(
            ctx.sessionID,
            matches.map((match) => match.id),
          )
          const summary = (id: string) => ToolSearch.deferredSummary(id) ?? "revealed deferred tool"
          const sections = []
          if (fresh.length > 0)
            sections.push(
              [
                "Revealed tools (callable by name immediately — they are NOT added to your tool list):",
                ...fresh.flatMap((match) => [
                  `- \`${match.id}\`: ${summary(match.id)}`,
                  `Full description for \`${match.id}\`:`,
                  ToolSearch.DEFERRED_DESCRIPTIONS[match.id] ??
                    "(description unavailable — call the tool and inspect its error guidance)",
                ]),
                "Call a revealed tool directly by name with arguments matching its schema; the runtime executes revealed calls through the normal path. The Revealed Deferred Tools section of the runtime context lists them with compact signatures. Reveals persist for this session and the tools join the tool list automatically at the next compaction.",
              ].join("\n"),
            )
          if (already.length > 0)
            sections.push(
              [
                "Already revealed in this session (still callable by name):",
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
  }),
)
