import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance"
import { SessionID, MessageID } from "@/contracts/session-ids"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"

type State = {
  commands: Record<string, Info>
  /** Per-instance memo of MCP prompt commands; first evaluation lists prompts once. */
  mcpCommands: Effect.Effect<Record<string, Info>>
}

export const Event = {
  Started: BusEvent.define(
    "command.started",
    Schema.Struct({
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
    }),
  ),
  Progress: BusEvent.define(
    "command.progress",
    Schema.Struct({
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      phase: Schema.String,
      current: Schema.Number,
      total: Schema.Number,
      currentFile: Schema.optional(Schema.String),
      elapsedMs: Schema.Number,
    }),
  ),
  Executed: BusEvent.define(
    "command.executed",
    Schema.Struct({
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    }),
  ),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown.annotate({ [ZodOverride]: z.promise(z.string()).or(z.string()) }),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
})
  .annotate({ identifier: "Command" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

// for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  INIT_GRAPH: "init-graph",
  REVIEW: "review",
  GOAL: "goal",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    type McpPrompt = Effect.Success<ReturnType<MCP.Interface["prompts"]>>[string]

    const promptCommand = (bridge: EffectBridge.Shape, name: string, prompt: McpPrompt): Info => ({
      name,
      source: "mcp",
      description: prompt.description,
      get template() {
        return bridge.promise(
          mcp
            .getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            )
            .pipe(
              Effect.map(
                (template) =>
                  template?.messages
                    .map((message) => (message.content.type === "text" ? message.content.text : ""))
                    .join("\n") || "",
              ),
            ),
        )
      },
      hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
    })

    const mcpPromptCommands = Effect.fnUntraced(function* (prompts: Record<string, McpPrompt>) {
      const entries = Object.entries(prompts)
      if (entries.length === 0) return {} as Record<string, Info>
      const bridge = yield* EffectBridge.make()
      return Object.fromEntries(entries.map(([name, prompt]) => [name, promptCommand(bridge, name, prompt)])) as Record<
        string,
        Info
      >
    })

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.INIT_GRAPH] = {
        name: Default.INIT_GRAPH,
        description: "initialize or sync Chimera graph data without editing AGENTS.md",
        source: "command",
        template: "",
        hints: [],
      }
      // /goal is a model-free built-in: SessionPrompt.command special-cases it
      // and dispatches to the Goal service (same shape as /init-graph above).
      commands[Default.GOAL] = {
        name: Default.GOAL,
        description: "show, set, clear, or resume the session goal: /goal [objective|clear|resume]",
        source: "command",
        template: "",
        hints: [],
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }
      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
        // One blocking prompts fetch per instance; list/get share this memo.
        mcpCommands: yield* Effect.cached(
          mcp.prompts().pipe(Effect.flatMap((prompts) => mcpPromptCommands(prompts))),
        ),
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))
    const isMcpSettled = Effect.map(mcp.statusSnapshot(), (statuses) =>
      Object.values(statuses).every((status) => status.status !== "connecting"),
    )

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      if (s.commands[name]) return s.commands[name]
      // Execution paths keep the blocking lookup (through the shared memo) so a lazily
      // connected MCP server is fully materialized before its prompt command runs.
      const mcpCommands = yield* s.mcpCommands
      return mcpCommands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      // While MCP is still connecting, return local commands immediately without
      // evaluating the memo (which would block on the handshake).
      if (!(yield* isMcpSettled)) return Object.values(s.commands)
      // MCP overrides config/skill commands, matching the pre-snapshot merge order.
      return Object.values({ ...s.commands, ...(yield* s.mcpCommands) })
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
