import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./tool_search.txt"
import { ToolSearch } from "@/session/tool-search"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { PositiveInt } from "@/util/schema"

// Full description text for the deferred catalog. These are the exact .txt
// files the tool definitions import as their description, so tool_search can
// hand the model the complete contract at reveal time (the runtime-context
// tail section only carries id + compact signature + summary).
import DESC_BROWSER_OPEN from "./browser_open.txt"
import DESC_BROWSER_SNAPSHOT from "./browser_snapshot.txt"
import DESC_BROWSER_CLICK from "./browser_click.txt"
import DESC_BROWSER_TYPE from "./browser_type.txt"
import DESC_BROWSER_SCREENSHOT from "./browser_screenshot.txt"
import DESC_BROWSER_CLOSE from "./browser_close.txt"
import DESC_LSP from "./lsp.txt"
import DESC_SUBAGENT_ROUTES from "./subagent_model_routes.txt"
import DESC_SUBAGENT_SCHEDULE from "./subagent_model_schedule.txt"
import DESC_SUBAGENT_PREFER from "./subagent_model_prefer.txt"
import DESC_SUBAGENT_SUPPRESS from "./subagent_model_suppress.txt"
import DESC_OBLIGATIONS_SYNC from "./chimera_obligations_sync.txt"
import DESC_OBLIGATION_CLAIM from "./chimera_obligation_claim.txt"
import DESC_OBLIGATION_RESOLVE from "./chimera_obligation_resolve.txt"
import DESC_OBLIGATION_IGNORE from "./chimera_obligation_ignore.txt"
import DESC_ORACLE_RECENT from "./chimera_oracle_recent.txt"
import DESC_ORACLE_GET from "./chimera_oracle_get.txt"

const DEFERRED_DESCRIPTIONS: Record<string, string> = {
  browser_open: DESC_BROWSER_OPEN,
  browser_snapshot: DESC_BROWSER_SNAPSHOT,
  browser_click: DESC_BROWSER_CLICK,
  browser_type: DESC_BROWSER_TYPE,
  browser_screenshot: DESC_BROWSER_SCREENSHOT,
  browser_close: DESC_BROWSER_CLOSE,
  lsp: DESC_LSP,
  subagent_model_routes: DESC_SUBAGENT_ROUTES,
  subagent_model_schedule: DESC_SUBAGENT_SCHEDULE,
  subagent_model_prefer: DESC_SUBAGENT_PREFER,
  subagent_model_suppress: DESC_SUBAGENT_SUPPRESS,
  chimera_obligations_sync: DESC_OBLIGATIONS_SYNC,
  chimera_obligation_claim: DESC_OBLIGATION_CLAIM,
  chimera_obligation_resolve: DESC_OBLIGATION_RESOLVE,
  chimera_obligation_ignore: DESC_OBLIGATION_IGNORE,
  chimera_oracle_recent: DESC_ORACLE_RECENT,
  chimera_oracle_get: DESC_ORACLE_GET,
}

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
          const denied = Permission.disabled(
            ToolSearch.DEFERRED_TOOLS.map((tool) => tool.id),
            Permission.merge(agent.permission, session.permission ?? []),
          )
          const candidates = ToolSearch.DEFERRED_TOOLS.filter(
            (tool) => !denied.has(tool.id) && !(agent.mode === "subagent" && SUBAGENT_HIDDEN.includes(tool.id)),
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
                  DEFERRED_DESCRIPTIONS[match.id] ??
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
