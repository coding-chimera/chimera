import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { EffectBridge } from "@/effect/bridge"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Effect, Exit } from "effect"
import type { SessionPrompt } from "../session/prompt"
import { Agent } from "./agent"
import { resolveSubagentExecution, type ResolvedSubagentExecution, type SubagentExecutionMetadata } from "./subagent-execution"
import { SubagentModelCatalog } from "./subagent-model-catalog"
import { deriveSubagentSessionPermission } from "./subagent-permissions"

export interface SubagentPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

export type SubagentDispatchStarted = {
  sessionId: SessionID
  model: { providerID: ProviderID; modelID: ModelID; variant?: string }
  execution: SubagentExecutionMetadata
}

export type SubagentDispatchInput = {
  parentSessionID: SessionID
  parentMessageID: MessageID
  description: string
  prompt: string
  subagentType: string
  modelProfile?: string
  model?: string
  modelIdentity?: string
  provider?: string
  variant?: string
  workload?: string
  taskID?: string
  promptOps: SubagentPromptOps
  abort: AbortSignal
  nestedDelegation?: "inherit" | "deny"
  authorizeProfile?: (profile: string) => Effect.Effect<void>
  authorizeModel?: (model: { providerID: ProviderID; modelID: ModelID; variant?: string }) => Effect.Effect<void>
  onStarted?: (input: SubagentDispatchStarted) => Effect.Effect<void>
}

export type SubagentDispatchPrepared = {
  parentSessionID: SessionID
  parent: Session.Info
  subagent: Agent.Info
  existing?: Session.Info
  config: Config.Info
  resolved: ResolvedSubagentExecution
  workload?: string
}

export type SubagentDispatchPrepareInput = Pick<
  SubagentDispatchInput,
  | "parentSessionID"
  | "parentMessageID"
  | "subagentType"
  | "modelProfile"
  | "model"
  | "modelIdentity"
  | "provider"
  | "variant"
  | "taskID"
  | "workload"
  | "authorizeProfile"
  | "authorizeModel"
>

export type SubagentDispatchRunPreparedInput = Pick<
  SubagentDispatchInput,
  "description" | "prompt" | "promptOps" | "abort" | "nestedDelegation" | "onStarted"
> & { prepared: SubagentDispatchPrepared }

export const SubagentDispatch = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const provider = yield* Provider.Service
  const routing = yield* ConfigSubagentRouting.Service

  const prepare = Effect.fn("SubagentDispatch.prepare")(function* (input: SubagentDispatchPrepareInput) {
    const cfg = yield* config.get()
    const parent = yield* sessions.get(input.parentSessionID)
    const msg = yield* Effect.sync(() =>
      MessageV2.get({ sessionID: input.parentSessionID, messageID: input.parentMessageID }),
    )
    if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

    const subagent = yield* agents.get(input.subagentType)
    if (!subagent) {
      return yield* Effect.fail(new Error(`Unknown agent type: ${input.subagentType} is not a valid agent type`))
    }

    const existing = input.taskID
      ? yield* sessions
          .get(SessionID.make(input.taskID))
          .pipe(Effect.catch((error) => (NotFoundError.isInstance(error) ? Effect.succeed(undefined) : Effect.fail(error))))
      : undefined

    if (existing) {
      if (existing.parentID !== input.parentSessionID) {
        return yield* Effect.fail(
          new Error(`Cannot resume session ${existing.id}: it belongs to a different parent session`),
        )
      }
      if (existing.projectID !== parent.projectID) {
        return yield* Effect.fail(new Error(`Cannot resume session ${existing.id}: it belongs to a different project`))
      }
      if (existing.workspaceID !== parent.workspaceID) {
        return yield* Effect.fail(
          new Error(`Cannot resume session ${existing.id}: it belongs to a different workspace`),
        )
      }
    }

    const catalog =
      input.modelIdentity === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const caller = yield* agents.get(msg.info.agent)
            if (!caller) return yield* Effect.fail(new Error(`Unknown parent agent: ${msg.info.agent}`))
            return yield* SubagentModelCatalog.withPreferences(
              SubagentModelCatalog.visible(
                SubagentModelCatalog.buildSnapshot({
                  providers: yield* provider.list(),
                  configuredProviders: cfg.provider,
                }),
                Permission.merge(caller.permission, parent.permission ?? []),
              ),
              parent.projectID,
              routing,
            )
          })

    const resolved = yield* resolveSubagentExecution({
      subagentType: input.subagentType,
      modelProfile: input.modelProfile,
      model: input.model,
      modelIdentity: input.modelIdentity,
      provider: input.provider,
      variant: input.variant,
      parent: {
        providerID: msg.info.providerID,
        modelID: msg.info.modelID,
        variant: msg.info.variant,
      },
      subagent,
      delegation: cfg.delegation,
      existing,
      validateModel: (providerID, modelID) => provider.getModel(providerID, modelID),
      resolveModelIdentity: catalog
        ? (intent) =>
            SubagentModelCatalog.resolveRoute(catalog, intent).pipe(
              Effect.map((route) => ({
                providerID: ProviderID.make(route.providerID),
                modelID: ModelID.make(route.modelID),
              })),
            )
        : undefined,
    })
    if (resolved.profile !== undefined) {
      yield* (input.authorizeProfile?.(resolved.profile) ?? Effect.void)
    }
    if (input.model !== undefined || input.modelIdentity !== undefined) {
      yield* (input.authorizeModel?.(resolved.model) ?? Effect.void)
    }
    return { parentSessionID: input.parentSessionID, parent, subagent, existing, config: cfg, resolved, workload: input.workload }
  })

  const runPrepared = Effect.fn("SubagentDispatch.runPrepared")(function* (input: SubagentDispatchRunPreparedInput) {
    const prepared = input.prepared
    const parentAgent = prepared.parent.agent
      ? yield* agents.get(prepared.parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: prepared.parent.permission ?? [],
      parentAgent,
      subagent: prepared.subagent,
    })

    const nestedDenyRules =
      input.nestedDelegation === "deny"
        ? [
            { pattern: "*", action: "deny" as const, permission: "task" as const },
            { pattern: "*", action: "deny" as const, permission: "chimera_swarm" as const },
          ]
        : []

    const nextSession =
      prepared.existing ??
      (yield* sessions.create({
        parentID: prepared.parentSessionID,
        title: input.description + ` (@${prepared.subagent.name} subagent)`,
        agent: prepared.subagent.name,
        model: {
          id: prepared.resolved.model.modelID,
          providerID: prepared.resolved.model.providerID,
          variant: prepared.resolved.model.variant,
        },
        permission: [
          ...derived,
          ...(prepared.config.experimental?.primary_tools?.map((item) => ({
            pattern: "*",
            action: "allow" as const,
            permission: item,
          })) ?? []),
          ...nestedDenyRules,
        ],
      }))

    if (prepared.existing) {
      yield* sessions.updatePermissionSlots({
        sessionID: prepared.existing.id,
        rules: [...derived.filter((rule) => rule.action === "deny"), ...nestedDenyRules],
      })
    }

    const execution: SubagentExecutionMetadata = {
      version: 2,
      parentSessionId: prepared.parentSessionID,
      agent: prepared.subagent.name,
      modelProfile: prepared.resolved.profile,
      workload: prepared.workload,
      source: prepared.resolved.source,
      resumed: Boolean(prepared.existing),
    }
    yield* (input.onStarted?.({ sessionId: nextSession.id, model: prepared.resolved.model, execution }) ?? Effect.void)

    const runCancel = yield* EffectBridge.make()
    const cancel = input.promptOps.cancel(nextSession.id)
    function onAbort() {
      runCancel.fork(cancel)
    }

    const messageID = MessageID.ascending()
    const result = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        input.abort.addEventListener("abort", onAbort, { once: true })
      }),
      () =>
        Effect.gen(function* () {
          if (input.abort.aborted) return yield* Effect.interrupt
          const parts = (yield* input.promptOps.resolvePromptParts(input.prompt)).map((part) =>
            part.type === "text"
              ? { ...part, metadata: { ...part.metadata, memorySource: "delegated" } }
              : part,
          )
          const result = yield* input.promptOps.prompt({
            messageID,
            sessionID: nextSession.id,
            model: {
              modelID: prepared.resolved.model.modelID,
              providerID: prepared.resolved.model.providerID,
            },
            variant: prepared.resolved.model.variant,
            agent: prepared.subagent.name,
            tools: {
              ...(prepared.subagent.permission.some((rule) => rule.permission === "todowrite")
                ? {}
                : { todowrite: false }),
              ...(prepared.subagent.permission.some((rule) => rule.permission === "task") ? {} : { task: false }),
              ...Object.fromEntries(
                (prepared.config.experimental?.primary_tools ?? []).map((item) => [item, false]),
              ),
              ...(input.nestedDelegation === "deny" ? { task: false, chimera_swarm: false } : {}),
            },
            parts,
          })
          if (input.abort.aborted) return yield* Effect.interrupt
          return result
        }),
      (_, exit) =>
        Effect.gen(function* () {
          if (Exit.hasInterrupts(exit)) yield* cancel
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              input.abort.removeEventListener("abort", onAbort)
            }),
          ),
        ),
    )

    return {
      title: input.description,
      sessionId: nextSession.id,
      model: prepared.resolved.model,
      profile: prepared.resolved.profile,
      execution,
      metadata: {
        sessionId: nextSession.id,
        model: prepared.resolved.model,
        execution,
      },
      message: result,
      output: [
        `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        result.parts.findLast((item) => item.type === "text")?.text ?? "",
        "</task_result>",
      ].join("\n"),
    }
  })

  const run = Effect.fn("SubagentDispatch.run")(function* (input: SubagentDispatchInput) {
    const prepared = yield* prepare(input)
    return yield* runPrepared({
      prepared,
      description: input.description,
      prompt: input.prompt,
      promptOps: input.promptOps,
      abort: input.abort,
      nestedDelegation: input.nestedDelegation,
      onStarted: input.onStarted,
    })
  })

  return { prepare, runPrepared, run }
})
