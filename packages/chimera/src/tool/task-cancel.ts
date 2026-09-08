import { BackgroundJob } from "../agent/background-job"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./task_cancel.txt"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The task_id (a session id) of the background task to cancel.",
  }),
})

function snapshotText(taskId: string, info: BackgroundJob.Info) {
  return `task_id: ${taskId} (already ${info.status}) — nothing to cancel.`
}

export const TaskCancelTool = Tool.define(
  "task_cancel",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const backgroundEnabled =
            cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
          if (!backgroundEnabled) {
            return yield* Effect.fail(
              new Error(
                "Background subagents are disabled by the kill-switch: delegation.background_subagents is false. Re-enable it to run or cancel asynchronous tasks.",
              ),
            )
          }
          if (!background) {
            return yield* Effect.fail(new Error("Background job service is not available in this runtime"))
          }
          const taskId = params.task_id
          const info = yield* background.get(taskId)
          if (!info) {
            return yield* Effect.fail(
              new Error(
                `No background task found with task_id: ${taskId}. Use the task tool with background=true to start one, or check the task_id you were given.`,
              ),
            )
          }
          if (info.metadata?.parentSessionId !== ctx.sessionID) {
            return yield* Effect.fail(
              new Error(
                `task_id ${taskId} was started by session ${String(info.metadata?.parentSessionId ?? "unknown")}, not this session (${ctx.sessionID}). You can only cancel background tasks you started yourself; a task started by another session is owned by it.`,
              ),
            )
          }
          if (info.status !== "running") {
            const metadata = { taskId, status: info.status, cancelled: false }
            yield* ctx.metadata({ title: `task_cancel: ${taskId}`, metadata })
            return { title: `task_cancel: ${taskId}`, metadata, output: snapshotText(taskId, info) }
          }
          const after = yield* background.cancel(taskId)
          const status = after?.status ?? "cancelled"
          const metadata = { taskId, status, cancelled: status === "cancelled" }
          yield* ctx.metadata({ title: `task_cancel: ${taskId}`, metadata })
          return {
            title: `task_cancel: ${taskId}`,
            metadata,
            output:
              status === "cancelled"
                ? `task_id: ${taskId} (cancelled) — its child run has been interrupted. If it had launched sub-work, that is being cancelled recursively.`
                : `task_id: ${taskId} (terminated as ${status}) — cancellation was requested but the task already settled.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)