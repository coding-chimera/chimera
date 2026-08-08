import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Effect, Exit } from "effect"
import type { SessionPrompt } from "../session/prompt"
import { Agent } from "./agent"
import { deriveSubagentSessionPermission } from "./subagent-permissions"
import { resolveSubagentExecution, type SubagentExecutionMetadata } from "./subagent-execution"
import { NotFoundError } from "@/storage/storage"

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
  taskID?: string
  promptOps: SubagentPromptOps
  abort: AbortSignal
  nestedDelegation?: "inherit" | "deny"
  authorizeProfile?: (profile: string) => Effect.Effect<void>
  onStarted?: (input: SubagentDispatchStarted) => Effect.Effect<void>
}

export const SubagentDispatch = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const provider = yield* Provider.Service

  const run = Effect.fn("SubagentDispatch.run")(function* (input: SubagentDispatchInput) {
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
        return yield* Effect.fail(
          new Error(`Cannot resume session ${existing.id}: it belongs to a different project`),
        )
      }
      if (existing.workspaceID !== parent.workspaceID) {
        return yield* Effect.fail(
          new Error(`Cannot resume session ${existing.id}: it belongs to a different workspace`),
        )
      }
    }

    const resolved = yield* resolveSubagentExecution({
      subagentType: input.subagentType,
      modelProfile: input.modelProfile,
      parent: {
        providerID: msg.info.providerID,
        modelID: msg.info.modelID,
        variant: msg.info.variant,
      },
      subagent,
      delegation: cfg.delegation,
      existing,
      validateModel: (p, m) => provider.getModel(p, m),
    })
    if (resolved.profile !== undefined) {
      yield* input.authorizeProfile?.(resolved.profile) ?? Effect.void
    }
    const parentAgent = parent.agent
      ? yield* agents.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      parentAgent,
      subagent,
    })

    const nestedDenyRules =
      input.nestedDelegation === "deny"
        ? [
            { pattern: "*", action: "deny" as const, permission: "task" as const },
            { pattern: "*", action: "deny" as const, permission: "chimera_swarm" as const },
          ]
        : []

    const nextSession =
      existing ??
      (yield* sessions.create({
        parentID: input.parentSessionID,
        title: input.description + ` (@${subagent.name} subagent)`,
        agent: subagent.name,
        model: { id: resolved.model.modelID, providerID: resolved.model.providerID, variant: resolved.model.variant },
        permission: [
          ...derived,
          ...(cfg.experimental?.primary_tools?.map((item) => ({
            pattern: "*",
            action: "allow" as const,
            permission: item,
          })) ?? []),
          ...(nestedDenyRules),
        ],
      }))

    if (existing) {
      yield* sessions.updatePermissionSlots({
        sessionID: existing.id,
        rules: [...derived.filter((rule) => rule.action === "deny"), ...nestedDenyRules],
      })
    }

    const execution: SubagentExecutionMetadata = {
      version: 2,
      parentSessionId: input.parentSessionID,
      agent: subagent.name,
      modelProfile: resolved.profile,
      source: resolved.source,
      resumed: Boolean(existing),
    }
    yield* input.onStarted?.({ sessionId: nextSession.id, model: resolved.model, execution }) ?? Effect.void

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
              modelID: resolved.model.modelID,
              providerID: resolved.model.providerID,
            },
            variant: resolved.model.variant,
            agent: subagent.name,
            tools: {
              ...(subagent.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
              ...(subagent.permission.some((rule) => rule.permission === "task") ? {} : { task: false }),
              ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
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
      model: resolved.model,
      profile: resolved.profile,
      execution,
      metadata: {
        sessionId: nextSession.id,
        model: resolved.model,
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

  return { run }
})
