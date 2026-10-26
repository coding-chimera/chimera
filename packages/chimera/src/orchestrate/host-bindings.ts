/**
 * Host-side bindings for the orchestrate worker's `orche` namespace.
 *
 * The worker program calls `orche.agent({ prompt, agent?, model?, label?, schema? })`.
 * Each call becomes a real subagent dispatch through `SubagentDispatch`, so the
 * child gets its own session/UI/persistence and its intermediate work never
 * enters the parent context — only the returned text/structured value does.
 *
 * Failure layering (matches the ultracode contract):
 * - child task failure (the dispatch's typed failure path) -> `null`, the
 *   program can keep going (`parallel`/`pipeline` treat it as a soft failure);
 * - host-side infrastructure problems (invalid args, prepare/DB/spawn errors,
 *   defects) -> the binding rejects, which aborts the program;
 * - approval denial -> the binding rejects as well (the ask effect fails).
 *
 * Limits are enforced per binding instance: `maxTotalAgents` is a hard cap and
 * `maxConcurrent` is a FIFO slot queue that defaults to 16 (the swarm default).
 */

import { SubagentDispatch, type SubagentPromptOps } from "@/agent/subagent-dispatch"
import { EffectBridge } from "@/effect/bridge"
import { SessionPrompt } from "@/session/prompt"
import type { MessageID, SessionID } from "@/contracts/session-ids"
import type { MessageV2 } from "@/session/message-v2"
import { Cause, Effect, Exit, Option } from "effect"
import { checkLosslessJson, type JsonValue } from "@/orchestrate/protocol"
import type { Bindings } from "@/orchestrate/runtime"

export interface OrchestrationAskInput {
  readonly permission: string
  readonly patterns: string[]
  readonly always: string[]
  readonly metadata: Record<string, unknown>
}

export interface OrchestrationHost {
  readonly parentSessionID: SessionID
  readonly parentMessageID: MessageID
  readonly signal: AbortSignal
  readonly ask: (input: OrchestrationAskInput) => Effect.Effect<void>
  /** Prompt primitives from the tool call (`ctx.extra.promptOps`); preferred over the service. */
  readonly promptOps?: SubagentPromptOps
  /** Optional structured progress; Phase 3 projects these into ToolPart.metadata. */
  readonly onEvent?: (event: OrchestrationAgentEvent) => Effect.Effect<void>
}

export interface OrchestrationLimits {
  readonly maxTotalAgents: number
  readonly maxConcurrent: number
}

export interface OrchestrationAgentEvent {
  readonly type: "start" | "finish"
  readonly label: string
  readonly agent: string
  readonly sessionId: string
  readonly status?: "completed" | "failed" | "aborted"
}

export interface OrchestrationBindings {
  readonly bindings: Bindings
  /** Cancel every in-flight subagent and wait for their cleanup (stray harvest). */
  readonly disposeAll: () => Effect.Effect<void>
}

const AGENT_FIELDS = new Set(["prompt", "agent", "model", "label", "schema"])
const DEFAULT_AGENT = "general"
const DEFAULT_MAX_CONCURRENT = 16

type AgentRequest = {
  readonly prompt: string
  readonly agent: string
  readonly model?: string
  readonly label: string
  readonly schema?: Record<string, JsonValue>
}

function deriveLabel(prompt: string) {
  const line = prompt.trim().split("\n")[0]?.trim() ?? ""
  return line.length <= 80 ? line : `${line.slice(0, 77)}...`
}

function parseAgentRequest(args: JsonValue): AgentRequest {
  const problem = checkLosslessJson(args)
  if (problem) throw new Error(`orche.agent arguments are not lossless JSON: ${problem}`)
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("orche.agent expects an object argument")
  }
  for (const key of Object.keys(args)) {
    if (!AGENT_FIELDS.has(key)) throw new Error(`orche.agent received unknown field: ${key}`)
  }

  if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
    throw new Error("orche.agent requires a non-empty prompt")
  }
  if (args.agent !== undefined && (typeof args.agent !== "string" || args.agent.length === 0)) {
    throw new Error("orche.agent.agent must be a non-empty string")
  }
  if (args.model !== undefined && typeof args.model !== "string") {
    throw new Error("orche.agent.model must be a string")
  }
  if (args.label !== undefined && typeof args.label !== "string") {
    throw new Error("orche.agent.label must be a string")
  }
  if (
    args.schema !== undefined &&
    (typeof args.schema !== "object" || args.schema === null || Array.isArray(args.schema))
  ) {
    throw new Error("orche.agent.schema must be a JSON object")
  }

  const prompt = args.prompt
  const agent = args.agent ?? DEFAULT_AGENT
  return {
    prompt,
    agent,
    ...(args.model === undefined ? {} : { model: args.model }),
    label: args.label && args.label.length > 0 ? args.label : deriveLabel(prompt),
    ...(args.schema === undefined ? {} : { schema: args.schema as Record<string, JsonValue> }),
  }
}

function readResult(message: MessageV2.WithParts): JsonValue {
  if (message.info.role === "assistant" && message.info.structured !== undefined) {
    return { structured: message.info.structured as JsonValue }
  }
  const text = message.parts.findLast((part) => part.type === "text")?.text ?? ""
  return { text }
}

type Waiter = {
  readonly resolve: (acquired: boolean) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
  cancelled: boolean
}

type SubagentDispatchService = Effect.Success<typeof SubagentDispatch>

export const makeOrchestrationBindingsFrom = (
  dispatch: SubagentDispatchService,
  promptOps: SubagentPromptOps,
  host: OrchestrationHost,
  limits: OrchestrationLimits,
) =>
  Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()

    const maxTotalAgents = Number.isFinite(limits.maxTotalAgents)
      ? Math.max(1, Math.trunc(limits.maxTotalAgents))
      : 1
    const maxConcurrent = Number.isFinite(limits.maxConcurrent)
      ? Math.max(1, Math.trunc(limits.maxConcurrent))
      : DEFAULT_MAX_CONCURRENT
    // FIFO slot queue over native promises: the binding surface is async, so a
    // Promise-based semaphore avoids coupling slot ownership to a fiber.
    let active = 0
    const waiters: Waiter[] = []

    const acquire = (signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false)
        if (active < maxConcurrent) {
          active += 1
          return resolve(true)
        }
        const waiter: Waiter = {
          resolve,
          signal,
          cancelled: false,
          onAbort: () => {
            waiter.cancelled = true
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            resolve(false)
          },
        }
        waiters.push(waiter)
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      })

    const release = () => {
      for (;;) {
        const next = waiters.shift()
        if (!next) {
          active -= 1
          return
        }
        if (next.cancelled) continue
        next.signal.removeEventListener("abort", next.onAbort)
        next.resolve(true)
        return
      }
    }

    let total = 0
    const controllers = new Set<AbortController>()
    const inflight = new Set<Promise<JsonValue>>()

    const emit = (event: OrchestrationAgentEvent) =>
      host.onEvent ? bridge.promise(host.onEvent(event).pipe(Effect.ignore)) : Promise.resolve()

    const agent = async (args: JsonValue): Promise<JsonValue> => {
      const request = parseAgentRequest(args)
      total += 1
      if (total > maxTotalAgents) {
        throw new Error(`orche.agent exceeded maxTotalAgents (${maxTotalAgents})`)
      }

      const controller = new AbortController()
      const onHostAbort = () => controller.abort()
      if (host.signal.aborted) controller.abort()
      else host.signal.addEventListener("abort", onHostAbort, { once: true })
      controllers.add(controller)

      const run = (async (): Promise<JsonValue> => {
        const acquired = await acquire(controller.signal)
        if (!acquired) return null
        try {
          await bridge.promise(
            host.ask({ permission: "task", patterns: [request.agent], always: ["*"], metadata: {} }),
          )
          if (controller.signal.aborted) return null

          // Prepare/materialize are infrastructure: failures reject the binding.
          const prepared = await bridge.promise(
            dispatch.prepare({
              parentSessionID: host.parentSessionID,
              parentMessageID: host.parentMessageID,
              subagentType: request.agent,
              ...(request.model === undefined ? {} : { model: request.model }),
            }),
          )
          const materialized = await bridge.promise(dispatch.materialize(prepared, request.label))
          await emit({
            type: "start",
            label: request.label,
            agent: request.agent,
            sessionId: materialized.nextSession.id,
          })

          const exit = await bridge.promise(
            Effect.exit(
              dispatch.runPrepared({
                prepared,
                materialized,
                description: request.label,
                prompt: request.prompt,
                promptOps,
                abort: controller.signal,
                ...(request.schema === undefined
                  ? {}
                  : {
                      format: {
                        type: "json_schema" as const,
                        schema: request.schema as Record<string, unknown>,
                        retryCount: 2,
                      },
                    }),
              }),
            ),
          )

          if (Exit.isFailure(exit)) {
            const aborted = controller.signal.aborted || Cause.hasInterruptsOnly(exit.cause)
            await emit({
              type: "finish",
              label: request.label,
              agent: request.agent,
              sessionId: materialized.nextSession.id,
              status: aborted ? "aborted" : "failed",
            })
            if (Cause.hasDies(exit.cause) && !aborted) throw new Error(Cause.pretty(exit.cause))
            return null
          }

          await emit({
            type: "finish",
            label: request.label,
            agent: request.agent,
            sessionId: materialized.nextSession.id,
            status: "completed",
          })
          return readResult(exit.value.message)
        } finally {
          release()
          controllers.delete(controller)
          host.signal.removeEventListener("abort", onHostAbort)
        }
      })()

      inflight.add(run)
      const settled = run.finally(() => inflight.delete(run))
      // Never leave an unobserved rejection when the caller ignores the result.
      settled.catch(() => undefined)
      return settled
    }

    const disposeAll = () =>
      Effect.promise(async () => {
        for (const controller of controllers) controller.abort()
        await Promise.allSettled([...inflight])
      })

    return {
      bindings: { orche: { agent } },
      disposeAll,
    } satisfies OrchestrationBindings
  })

/**
 * Service-resolved variant for tests and non-tool callers: resolves the dispatch
 * factory and prompt primitives from the current Effect context.
 */
export const makeOrchestrationBindings = (host: OrchestrationHost, limits: OrchestrationLimits) =>
  Effect.gen(function* () {
    const dispatch = yield* SubagentDispatch
    const prompt = host.promptOps
      ? undefined
      : Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
    const promptOps: SubagentPromptOps =
      host.promptOps ??
      (prompt
        ? {
            cancel: (sessionID) => prompt.cancel(sessionID),
            resolvePromptParts: (template) => prompt.resolvePromptParts(template),
            prompt: (input) => prompt.prompt(input).pipe(Effect.catch(Effect.die)),
            injectSynthetic: (input) => prompt.injectSynthetic(input),
          }
        : yield* Effect.die(new Error("orchestrate requires host.promptOps or SessionPrompt")))
    return yield* makeOrchestrationBindingsFrom(dispatch, promptOps, host, limits)
  })

export * as OrchestrateHostBindings from "./host-bindings"