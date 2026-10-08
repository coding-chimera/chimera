import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import GET_DESCRIPTION from "./goal_get.txt"
import CREATE_DESCRIPTION from "./goal_create.txt"
import UPDATE_DESCRIPTION from "./goal_update.txt"
import { Goal } from "../session/goal"
import { PositiveInt } from "@/util/schema"

type Metadata = {
  goal?: Goal.Info
}

const result = (goal: Goal.Info | undefined, output: string) => ({
  title: "Session Goal",
  output,
  metadata: { goal },
})

export const GoalGetParameters = Schema.Struct({})

export const GoalGetTool = Tool.define<typeof GoalGetParameters, Metadata, Goal.Service>(
  "goal_get",
  Effect.gen(function* () {
    const goal = yield* Goal.Service

    return {
      description: GET_DESCRIPTION,
      parameters: GoalGetParameters,
      execute: (_params: Schema.Schema.Type<typeof GoalGetParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          yield* goal.account(ctx.sessionID)
          const current = yield* goal.get(ctx.sessionID)
          return result(current, current ? Goal.format(current) : "No goal is set for this session.")
        }),
    } satisfies Tool.DefWithoutID<typeof GoalGetParameters, Metadata>
  }),
)

export const GoalCreateParameters = Schema.Struct({
  objective: Schema.String.annotate({
    description: "Compact statement of the objective this session is trying to accomplish.",
  }),
  token_budget: Schema.optional(PositiveInt).annotate({
    description:
      "Optional positive token budget for this goal. Set only when an explicit token budget was requested; omit when the goal is unbounded.",
  }),
})

export const GoalCreateTool = Tool.define<typeof GoalCreateParameters, Metadata, Goal.Service>(
  "goal_create",
  Effect.gen(function* () {
    const goal = yield* Goal.Service

    return {
      description: CREATE_DESCRIPTION,
      parameters: GoalCreateParameters,
      execute: (params: Schema.Schema.Type<typeof GoalCreateParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const created = yield* goal.create({
            sessionID: ctx.sessionID,
            objective: params.objective,
            ...(params.token_budget !== undefined ? { tokenBudget: params.token_budget } : {}),
          })
          return result(created, Goal.format(created))
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof GoalCreateParameters, Metadata>
  }),
)

export const GoalUpdateParameters = Schema.Struct({
  status: Schema.Literals(["complete", "blocked", "paused", "active"]).annotate({
    description:
      "New goal status. Use complete only when the objective is actually achieved, blocked only for a repeated unresolvable blocker, paused/active only at the user's explicit request.",
  }),
})

export const GoalUpdateTool = Tool.define<typeof GoalUpdateParameters, Metadata, Goal.Service>(
  "goal_update",
  Effect.gen(function* () {
    const goal = yield* Goal.Service

    return {
      description: UPDATE_DESCRIPTION,
      parameters: GoalUpdateParameters,
      execute: (params: Schema.Schema.Type<typeof GoalUpdateParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const updated = yield* goal.updateStatus({ sessionID: ctx.sessionID, status: params.status })
          const usage =
            updated.status === "complete" && updated.tokenBudget !== undefined
              ? `\n- Tokens used: ${updated.tokensUsed.toLocaleString("en-US")} / budget: ${updated.tokenBudget.toLocaleString("en-US")} (report this final usage to the user)`
              : ""
          return result(updated, `${Goal.format(updated)}${usage}`)
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof GoalUpdateParameters, Metadata>
  }),
)
