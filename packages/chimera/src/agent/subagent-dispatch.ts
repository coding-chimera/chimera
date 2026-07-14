import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Effect, Exit } from "effect"
import type { SessionPrompt } from "../session/prompt"
import { Agent } from "./agent"
import { deriveSubagentSessionPermission } from "./subagent-permissions"

export interface SubagentPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

export type SubagentDispatchStarted = {
  sessionId: SessionID
  model: NonNullable<Agent.Info["model"]>
}

export type SubagentDispatchInput = {
  parentSessionID: SessionID
  parentMessageID: MessageID
  description: string
  prompt: string
  subagentType: string
  taskID?: string
  promptOps: SubagentPromptOps
  abort: AbortSignal
  nestedDelegation?: "inherit" | "deny"
  onStarted?: (input: SubagentDispatchStarted) => Effect.Effect<void>
}

export const SubagentDispatch = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service

  const run = Effect.fn("SubagentDispatch.run")(function* (input: SubagentDispatchInput) {

    const cfg = yield* config.get()
    const subagent = yield* agents.get(input.subagentType)
    if (!subagent) {
      return yield* Effect.fail(new Error(`Unknown agent type: ${input.subagentType} is not a valid agent type`))
    }

    const existing = input.taskID
      ? yield* sessions.get(SessionID.make(input.taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    const parent = yield* sessions.get(input.parentSessionID)
    const parentAgent = parent.agent
      ? yield* agents.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    const nextSession =
      existing ??
      (yield* sessions.create({
        parentID: input.parentSessionID,
        title: input.description + ` (@${subagent.name} subagent)`,
        permission: [
          ...deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            parentAgent,
            subagent,
          }),
          ...(cfg.experimental?.primary_tools?.map((item) => ({
            pattern: "*",
            action: "allow" as const,
            permission: item,
          })) ?? []),
          ...(input.nestedDelegation === "deny"
            ? [
                { pattern: "*", action: "deny" as const, permission: "task" },
                { pattern: "*", action: "deny" as const, permission: "chimera_swarm" },
              ]
            : []),
        ],
      }))

    const msg = yield* Effect.sync(() =>
      MessageV2.get({ sessionID: input.parentSessionID, messageID: input.parentMessageID }),
    )
    if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

    const model = subagent.model ?? {
      modelID: msg.info.modelID,
      providerID: msg.info.providerID,
    }
    yield* input.onStarted?.({ sessionId: nextSession.id, model }) ?? Effect.void

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
              modelID: model.modelID,
              providerID: model.providerID,
            },
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
      model,
      metadata: {
        sessionId: nextSession.id,
        model,
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
