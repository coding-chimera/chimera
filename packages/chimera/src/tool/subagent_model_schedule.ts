import { Agent } from "@/agent/agent"
import { SubagentModelSchedulingRuntime } from "@/agent/subagent-model-scheduling-runtime"
import { validateWorkload } from "@/agent/subagent-model-scheduling"
import { Permission } from "@/permission"
import { ProjectID } from "@/project/schema"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./subagent_model_schedule.txt"

export { DESCRIPTION }

export const Parameters = Schema.Struct({
  workload: Schema.optional(Schema.String).annotate({
    description: "Optional workload archetype to narrow the current recommendations.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum recommendations per workload. Defaults to 3 and must be between 1 and 5.",
  }),
})

export const SubagentModelScheduleTool = Tool.define(
  "subagent_model_schedule",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const scheduling = yield* SubagentModelSchedulingRuntime.make

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 5)) {
            return yield* Effect.fail(new Error("limit must be an integer between 1 and 5"))
          }
          const agent = yield* agents.get(ctx.agent)
          const session = yield* sessions
            .get(ctx.sessionID)
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
          const view = yield* scheduling.currentView({
            ruleset: Permission.merge(agent.permission, session?.permission ?? []),
            projectID: session?.projectID ?? ProjectID.global,
            limit: params.limit,
          })
          if (!view) return yield* Effect.fail(new Error("Subagent workload scheduling is disabled"))
          const error = validateWorkload(params.workload, view.archetypes)
          if (error) return yield* Effect.fail(error)
          const recommendations = params.workload
            ? view.recommendations[params.workload] ?? []
            : view.recommendations
          return {
            title: params.workload ? `subagent_model_schedule: ${params.workload}` : "subagent_model_schedule",
            metadata: {
              workload: params.workload,
              priorVersion: view.priorVersion,
              recommendations,
            },
            output: JSON.stringify(
              {
                workload: params.workload,
                priorVersion: view.priorVersion,
                recommendations,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
