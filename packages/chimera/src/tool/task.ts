import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { SubagentDispatch, type SubagentPromptOps } from "../agent/subagent-dispatch"
import * as ModelTelemetry from "../agent/model-telemetry"
import { validateSubagentModelSelection } from "../agent/subagent-execution"
import { Agent } from "../agent/agent"
import { SubagentModelSchedulingRuntime } from "../agent/subagent-model-scheduling-runtime"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Effect, Schema } from "effect"

export type TaskPromptOps = SubagentPromptOps

const id = "task"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  workload: Schema.optional(Schema.String).annotate({
    description:
      "Delegation workload archetype. Without a model selector, the scheduler chooses a current route; with an explicit selector, workload is validation and attribution only.",
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
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const dispatch = yield* SubagentDispatch
    const agents = yield* Agent.Service
    const routing = yield* ConfigSubagentRouting.Service
    const sessions = yield* Session.Service
    const scheduling = yield* SubagentModelSchedulingRuntime.make
    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* validateSubagentModelSelection({
        modelProfile: params.model_profile,
        model: params.model,
        modelIdentity: params.model_identity,
        provider: params.provider,
        variant: params.variant,
      })
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
      const result = yield* dispatch.runPrepared({
        prepared,
        description: params.description,
        prompt: params.prompt,
        promptOps,
        abort: ctx.abort,
        nestedDelegation: ctx.extra?.swarmWorker === true ? "deny" : "inherit",
        telemetry,
        onStarted: ({ sessionId, model, execution }) =>
          Effect.gen(function* () {
            yield* ctx.metadata({
              title: params.description,
              metadata: {
                sessionId,
                model,
                execution,
              },
            })
            if (parent.parentID || execution.resumed) return
            yield* routing.recordDelegation(parent.projectID).pipe(
              Effect.catchTag("SubagentRoutingStateFileError", (error) =>
                Effect.logWarning("failed to record subagent routing activity", { operation: error.operation }),
              ),
            )
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
