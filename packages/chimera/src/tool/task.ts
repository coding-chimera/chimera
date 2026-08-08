import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { SubagentDispatch, type SubagentPromptOps } from "../agent/subagent-dispatch"
import { Effect, Schema } from "effect"

export type TaskPromptOps = SubagentPromptOps

const id = "task"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model_profile: Schema.optional(Schema.String).annotate({
    description:
      "Name of a delegation.model_profiles entry to run this subagent with. Omit to use the subagent's configured model or the parent model; when resuming an existing session, the session's persisted model is used.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const dispatch = yield* SubagentDispatch

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!promptOps) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const result = yield* dispatch.run({
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        description: params.description,
        prompt: params.prompt,
        subagentType: params.subagent_type,
        modelProfile: params.model_profile,
        taskID: params.task_id,
        promptOps,
        abort: ctx.abort,
        nestedDelegation: ctx.extra?.swarmWorker === true ? "deny" : "inherit",
        authorizeProfile: (profile) =>
          ctx.ask({
            permission: "task_profile",
            patterns: [profile],
            always: ["*"],
            metadata: {
              description: params.description,
              model_profile: profile,
            },
          }),
        onStarted: ({ sessionId, model, execution }) =>
          ctx.metadata({
            title: params.description,
            metadata: {
              sessionId,
              model,
              execution,
            },
          }),
      })

      return {
        title: result.title,
        metadata: {
          sessionId: result.sessionId,
          model: result.model,
          execution: result.execution,
        },
        output: result.output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
