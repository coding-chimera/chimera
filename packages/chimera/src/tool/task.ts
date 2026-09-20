import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import {
  SubagentDispatch,
  type SubagentDispatchMaterialized,
  type SubagentDispatchPrepared,
  type SubagentDispatchStarted,
  type SubagentPromptOps,
} from "../agent/subagent-dispatch"
import { BackgroundJob } from "../agent/background-job"
import * as ModelTelemetry from "../agent/model-telemetry"
import { validateSubagentModelSelection } from "../agent/subagent-execution"
import { Agent } from "../agent/agent"
import { SubagentModelSchedulingRuntime } from "../agent/subagent-model-scheduling-runtime"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Effect, Option, Schema, Scope } from "effect"

export type TaskPromptOps = SubagentPromptOps

const id = "task"

const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately while the task keeps working.",
  "Background mode is the default for delegation: pass background=true whenever the subagent's result is not needed inline immediately, then continue your own work.",
  "Foreground (blocking) dispatch is the exception: omit background only when you must wait for this result inline, and pass block_reason stating the concrete dependency that forces you to wait.",
  "Resuming an already-finished task with background=true starts a new background run on the same subagent session and returns immediately with the same task_id — it never blocks the current turn, and you are notified as usual when the new run finishes.",
  "You will be notified automatically when it finishes — do not sleep, poll for progress, or duplicate its work while it runs.",
  "When a dispatched subagent itself launches background tasks, its dispatch call is held open until every background result is delivered and the subagent's final response is ready; the parent receives periodic parked progress metadata (parked, waitingBackgroundTasks, parkElapsedMs) while waiting.",
].join(" ")

const BACKGROUND_STARTED = [
  `task_id: %s (background, running) — you will be notified automatically when the task finishes.`,
  "",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  "If it becomes unnecessary (e.g. another background task already answered the question) or the user asks you to stop it, cancel it with the task_cancel tool using this task_id.",
].join("\n")

const BACKGROUND_UPDATED = [
  `task_id: %s (background, running) — additional context appended to the running task; it runs your new prompt after finishing its current segment.`,
  "",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  workload: Schema.optional(Schema.String).annotate({
    description:
      "Delegation workload archetype. Without a model selector, the scheduler chooses a current route; with an explicit selector, workload is validation and attribution only. A model excluded from a workload by delegation.scheduling.archetypes.<workload>.excludeModels cannot be dispatched with that workload declaration (resume excepted).",
  }),
  model_profile: Schema.optional(Schema.String).annotate({
    description:
      "Name of a delegation.model_profiles entry to run this subagent with. Omit to use the subagent's configured model or the parent model; when resuming an existing session, the session's persisted model is used.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Exact provider/model route to run the subagent with. Mutually exclusive with model_profile and model_identity; when resuming an existing session, the session's persisted model must match.",
  }),
  model_identity: Schema.optional(Schema.String).annotate({
    description:
      "Current runtime model identity to resolve before starting the subagent. Mutually exclusive with model_profile and model; use provider to narrow an identity when needed.",
  }),
  provider: Schema.optional(Schema.String).annotate({
    description: "Current provider ID used only to narrow model_identity. Never use with exact model or model_profile.",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description:
      "Model variant to use with model or model_identity. Only allowed when the resolved model advertises it. Subagents do not support the ultra variant; it is reserved for root sessions. When omitted for a model that advertises variants but configures no default options, dispatch fills the highest non-ultra variant."
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

// Narrow parameter set exposed when the background kill-switch is off: the JSON
// schema derived from `parameters` must not advertise `background` at all.
const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background and return immediately. You will be notified automatically when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
  block_reason: Schema.optional(Schema.String).annotate({
    description:
      "Required when dispatching without background=true (a blocking/foreground dispatch): state the concrete dependency that forces the parent to wait for this result inline. Omit for background dispatches.",
  }),
})

function backgroundResultText(input: { sessionID: SessionID; state: "completed" | "error"; text: string }) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `task_id: ${input.sessionID} (background task ${input.state})`,
    "",
    `<${tag}>`,
    input.text,
    `</${tag}>`,
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const dispatch = yield* SubagentDispatch
    const agents = yield* Agent.Service
    const routing = yield* ConfigSubagentRouting.Service
    const sessions = yield* Session.Service
    const scheduling = yield* SubagentModelSchedulingRuntime.make
    const config = yield* Config.Service
    const background = yield* Effect.serviceOption(BackgroundJob.Service)
    const scope = yield* Scope.Scope

    const runBackgroundPrepared = Effect.fn("TaskTool.runBackgroundPrepared")(function* (
      prepared: SubagentDispatchPrepared,
      materialized: SubagentDispatchMaterialized,
      promptOps: TaskPromptOps,
      telemetry: ModelTelemetry.ShadowDelegation | undefined,
      prompt: string,
      description: string,
    ) {
      return yield* dispatch
        .runPreparedBackground({
          prepared,
          description,
          prompt,
          promptOps,
          abort: new AbortController().signal,
          telemetry,
          materialized,
        })
        .pipe(Effect.map((result) => result.output))
    })

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const backgroundEnabled =
        cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
      yield* validateSubagentModelSelection({
        modelProfile: params.model_profile,
        model: params.model,
        modelIdentity: params.model_identity,
        provider: params.provider,
        variant: params.variant,
      })
      const runInBackground = params.background === true
      if (runInBackground && !backgroundEnabled) {
        return yield* Effect.fail(
          new Error(
            "Background subagents are disabled by the kill-switch: delegation.background_subagents is false. Re-enable it to dispatch tasks asynchronously, or omit background to run synchronously.",
          ),
        )
      }
      const parent = yield* sessions.get(ctx.sessionID)
      const caller = yield* agents.get(ctx.agent)
      const existing = params.task_id
        ? yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        : undefined
      const workload = params.workload
        ? yield* scheduling.resolveWorkload({
            workload: params.workload,
            select:
              params.model_profile === undefined &&
              params.model === undefined &&
              params.model_identity === undefined &&
              !existing?.model,
            ruleset: Permission.merge(caller.permission, parent.permission ?? []),
            projectID: parent.projectID,
          })
        : undefined
      const model = workload?.selection?.model ?? params.model
      const variant = workload?.selection?.variant ?? params.variant

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            ...(params.workload ? { workload: params.workload } : {}),
          },
        })
      }

      const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!promptOps) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const prepared = yield* dispatch.prepare({
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        subagentType: params.subagent_type,
        modelProfile: params.model_profile,
        model,
        modelIdentity: params.model_identity,
        provider: params.provider,
        variant,
        workload: params.workload,
        taskID: params.task_id,
        authorizeProfile: (profile) =>
          ctx.ask({
            permission: "task_profile",
            patterns: [profile],
            always: [profile],
            metadata: {
              description: params.description,
              model_profile: profile,
            },
          }),
        authorizeModel: ({ providerID, modelID }) =>
          ctx.ask({
            permission: "task_model",
            patterns: [`${providerID}/${modelID}`],
            always: [`${providerID}/${modelID}`],
            metadata: {
              description: params.description,
              model: `${providerID}/${modelID}`,
            },
          }),
      })
      const selectionSource = prepared.resolved.source === "resume" ? "resume" : workload?.selection ? "scheduler" : "explicit"
      const telemetryState = (() => {
        if (!prepared.existing) return { enabled: true, lineage: undefined }
        try {
          return {
            enabled: true,
            lineage: ModelTelemetry.getShadowSessionLineage({
              projectID: parent.projectID,
              sessionID: prepared.existing.id,
            }),
          }
        } catch {
          return { enabled: false, lineage: undefined }
        }
      })()
      const action = ModelTelemetry.actionForRoute({
        route: `${prepared.resolved.model.providerID}/${prepared.resolved.model.modelID}`,
        identity: workload?.selection?.recommendation?.identity ?? params.model_identity,
        variant: prepared.resolved.model.variant,
        selectionSource,
        resolutionSource: prepared.resolved.source,
      })
      const decision = telemetryState.enabled
        ? ModelTelemetry.createShadowDecision({
            projectID: parent.projectID,
            workload: params.workload ?? "unknown",
            action,
            ...(telemetryState.lineage?.episodeID ? { episodeID: telemetryState.lineage.episodeID } : {}),
            ...(selectionSource === "scheduler"
              ? {
                  candidates: ModelTelemetry.candidatesFromRecommendations({
                    selected: action,
                    recommendations: workload?.view?.recommendations[params.workload ?? ""] ?? [],
                    resolutionSource: prepared.resolved.source,
                  }),
                }
              : {}),
          })
        : undefined
      const telemetry = decision
        ? ModelTelemetry.createShadowDelegation(decision, {
            ...(telemetryState.lineage?.parentDelegationID
              ? { parentDelegationID: telemetryState.lineage.parentDelegationID }
              : {}),
          })
        : undefined
      if (decision) void ModelTelemetry.recordShadowDecision(decision)

      const onStarted = (input: SubagentDispatchStarted) =>
        Effect.gen(function* () {
          yield* ctx.metadata({
            title: params.description,
            metadata: {
              sessionId: input.sessionId,
              model: input.model,
              execution: input.execution,
            },
          })
          if (parent.parentID || input.execution.resumed) return
          yield* routing.recordDelegation(parent.projectID).pipe(
            Effect.catchTag("SubagentRoutingStateFileError", (error) =>
              Effect.logWarning("failed to record subagent routing activity", { operation: error.operation }),
            ),
          )
        })

      // While a synchronous dispatch is parked on the child's owned background jobs,
      // publish the parked state so the parent sees the child is still working.
      const onParkProgress = (materialized: SubagentDispatchMaterialized) =>
        (info: { waiting: number; elapsedMs: number }) =>
          ctx.metadata({
            title: params.description,
            metadata: {
              sessionId: materialized.nextSession.id,
              model: prepared.resolved.model,
              execution: materialized.execution,
              parked: true,
              waitingBackgroundTasks: info.waiting,
              parkElapsedMs: info.elapsedMs,
            },
          })
      // ── Background branch ──────────────────────────────────────────────────
      if (runInBackground) {
        const jobs = Option.getOrUndefined(background)
        if (!jobs) {
          return yield* Effect.fail(new Error("Background job service is not available in this runtime"))
        }
        // Every dispatch that will call jobs.start (fresh session, resume with no
        // live job, or restart of a settled job) is pre-rejected against the
        // background concurrency cap BEFORE materialize, so an over-cap failure
        // never leaves an orphan empty child session behind: materialize creates
        // the child session (the job id) as a side effect. Only the running-job
        // extend path skips the precheck because it attaches to an
        // already-materialized session without consuming a new slot.
        const resumedID = prepared.existing?.id
        const existingJob = resumedID ? yield* jobs.get(resumedID) : undefined
        const willStartJob = !resumedID || !existingJob || existingJob.status !== "running"
        if (willStartJob) {
          const limit =
            cfg.delegation?.background_concurrent ?? ConfigDelegation.DEFAULT_BACKGROUND_CONCURRENT
          const runningCount =
            (yield* jobs.list()).filter((job: { status: string }) => job.status === "running").length
          if (runningCount >= limit) {
            return yield* Effect.fail(
              new Error(
                `Cannot start background task ${params.description}: concurrency limit reached (${runningCount} running >= background_concurrent ${limit}). Complete or cancel a running background task before starting another.`,
              ),
            )
          }
        }
        const materialized = yield* dispatch.materialize(prepared, params.description)
        const sessionID = materialized.nextSession.id
        const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string, generation: number) {
          yield* jobs
            .wait({ id: jobID })
            .pipe(
              Effect.flatMap((result) => {
                if (result.info?.status === "completed") {
                  return promptOps.injectSynthetic?.({
                    sessionID: ctx.sessionID,
                    text: backgroundResultText({ sessionID, state: "completed", text: result.info.output ?? "" }),
                  }).pipe(Effect.ignoreCause({ log: true })) ?? Effect.void
                }
                if (result.info?.status === "error") {
                  return promptOps.injectSynthetic?.({
                    sessionID: ctx.sessionID,
                    text: backgroundResultText({ sessionID, state: "error", text: result.info.error ?? "" }),
                  }).pipe(Effect.ignoreCause({ log: true })) ?? Effect.void
                }
                return Effect.void
              }),
              // Delivery is final once the notify fiber finishes, no matter how
              // the job settled, whether the injection succeeded, or whether the
              // owner session still exists — quiescence keys off delivery. The
              // generation binds the mark to this run: a same-id restart mid-
              // injection must not be marked delivered by this stale fiber.
              Effect.ensuring(jobs.markDelivered(jobID, generation).pipe(Effect.ignore)),
              Effect.ignoreCause({ log: true }),
              Effect.forkIn(scope, { startImmediately: true }),
            )
        })

        const freshStart = Effect.fn("TaskTool.backgroundFreshStart")(function* () {
          // The capacity precheck already ran before materialize for every path
          // that reaches start(), settled-resume restarts included; the engine
          // re-checks the cap atomically inside start(), and BackgroundJobLimitError
          // is mapped to a plain Error below.
          const metadata = {
            sessionId: sessionID,
            model: prepared.resolved.model,
            execution: materialized.execution,
            background: true,
            jobId: sessionID,
          }
          yield* ctx.metadata({ title: params.description, metadata })
          if (!parent.parentID && !materialized.execution.resumed) {
            yield* routing.recordDelegation(parent.projectID).pipe(
              Effect.catchTag("SubagentRoutingStateFileError", (error) =>
                Effect.logWarning("failed to record subagent routing activity", { operation: error.operation }),
              ),
            )
          }
          for (let attempt = 0; ; attempt++) {
            if (attempt >= 3) {
              return yield* Effect.fail(
                new Error(
                  `Failed to dispatch background task ${params.description}: the same task_id (${sessionID}) is being concurrently restarted and this dispatch did not take effect after 3 attempts. Retry once the concurrent restart settles.`,
                ),
              )
            }
            // Generation check against start()'s running short-circuit: if a
            // concurrent same-task_id dispatch restarted this session after our
            // extend probe failed, start() returns their snapshot with the
            // generation unchanged and never runs our prompt — the generation
            // tells the two outcomes apart so the prompt is appended via extend
            // instead of silently dropped behind a false STARTED.
            const before = (yield* jobs.get(sessionID))?.generation
            const info = yield* jobs
              .start({
                id: sessionID,
                type: "task",
                title: params.description,
                ownerSessionId: ctx.sessionID,
                metadata: {
                  model: prepared.resolved.model,
                  background: true,
                },
                onInterrupt: promptOps.cancel(sessionID).pipe(Effect.ignore),
                run: runBackgroundPrepared(prepared, materialized, promptOps, telemetry, params.prompt, params.description),
              })
              .pipe(
                Effect.catchTag("BackgroundJobLimitError", (error) =>
                  Effect.fail(new Error(error.message)),
                ),
              )
            if (info.generation !== before) {
              yield* notify(info.id, info.generation)
              return {
                title: params.description,
                metadata,
                output: BACKGROUND_STARTED.replace("%s", sessionID),
              }
            }
            const extended = yield* jobs.extend({
              id: sessionID,
              run: runBackgroundPrepared(prepared, materialized, promptOps, telemetry, params.prompt, params.description),
            })
            // The concurrent restart's own notify fiber owns result delivery, so
            // this path never forks a second one.
            if (extended) {
              return {
                title: params.description,
                metadata,
                output: BACKGROUND_UPDATED.replace("%s", sessionID),
              }
            }
          }
        })

        if (existingJob?.status === "running") {
          const extended = yield* jobs.extend({
            id: sessionID,
            run: runBackgroundPrepared(prepared, materialized, promptOps, telemetry, params.prompt, params.description),
          })
          if (extended) {
            yield* ctx.metadata({
              title: params.description,
              metadata: { sessionId: sessionID, model: prepared.resolved.model, background: true, jobId: sessionID },
            })
            return {
              title: params.description,
              metadata: { sessionId: sessionID, model: prepared.resolved.model, execution: materialized.execution, background: true, jobId: sessionID },
              output: BACKGROUND_UPDATED.replace("%s", sessionID),
            }
          }
        }
        // Settled (or never started) — restart a new background run on the same session id.
        return yield* freshStart()
      }

      // ── Synchronous path (unchanged) ───────────────────────────────────────
      // Materialize up front so the parked-progress metadata can address the child
      // session by id; runPrepared would create the same session right after anyway.
      const materialized = yield* dispatch.materialize(prepared, params.description)
      const result = yield* dispatch.runPrepared({
        prepared,
        description: params.description,
        prompt: params.prompt,
        promptOps,
        abort: ctx.abort,
        onStarted,
        telemetry,
        materialized,
        onParkProgress: onParkProgress(materialized),
      })

      return {
        title: result.title,
        metadata: result.metadata,
        output: result.output,
      }
    })

    // Tool definitions are resolved lazily at init() time (inside an instance
    // context), so killing the background kill-switch cannot be decided at the
    // registry layer build where config is not yet instance-bound.
    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const backgroundEnabled =
          cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
        return {
          description: backgroundEnabled ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n") : DESCRIPTION,
          parameters: (backgroundEnabled ? Parameters : BaseParameters) as unknown as typeof Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            run(params, ctx).pipe(Effect.orDie),
        }
      })
  }),
)
