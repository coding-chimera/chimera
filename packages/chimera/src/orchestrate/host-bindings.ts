/**
 * Host-side bindings for the orchestrate worker's `orche` namespace.
 *
 * The worker program calls `orche.agent({ prompt, agent?, model?, label?, schema? })`
 * or `orche.batch({ items?, from?, preset?, concurrency?, scope? })`. Each call
 * becomes a real subagent dispatch through `SubagentDispatch`, so the
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

import { BatchPreset, type ExplicitItem, type PresetName } from "@/agent/batch-preset"
import { BatchSource, type SourceName } from "@/agent/batch-source"
import { WorkerBatch } from "@/agent/worker-batch"
import { SubagentDispatch, type SubagentPromptOps } from "@/agent/subagent-dispatch"
import { EffectBridge } from "@/effect/bridge"
import { SessionPrompt } from "@/session/prompt"
import { Truncate } from "@/tool/truncate"
import type { MessageID, SessionID } from "@/contracts/session-ids"
import type { MessageV2 } from "@/session/message-v2"
import { Cause, Effect, Exit, Option, Schema } from "effect"
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
  /** Called once per finished subagent; background orchestrate projects it into a parent notification. */
  readonly onSettled?: (event: OrchestrationSettledEvent) => Effect.Effect<void>
}

export interface OrchestrationLimits {
  readonly maxTotalAgents: number
  readonly maxConcurrent: number
}

export interface OrchestrationAgentEvent {
  readonly type: "start" | "finish"
  /** 1-based dispatch order for this program; stable even when finishes are out of order. */
  readonly index: number
  readonly label: string
  readonly agent: string
  readonly sessionId: string
  readonly status?: "completed" | "failed" | "aborted"
  /** Curated child result on finish: `{ text }` or `{ structured }`. */
  readonly result?: JsonValue
}

/** A finished subagent, projected into background per-worker notifications. */
export type OrchestrationSettledEvent = OrchestrationAgentEvent & { readonly type: "finish" }

export interface OrchestrationBindings {
  readonly bindings: Bindings
  /** Cancel one in-flight subagent by session id; a settled or unknown id is a no-op. */
  readonly cancel: (sessionId: string) => Effect.Effect<void>
  /** Cancel every in-flight subagent (the program job's onInterrupt cascade). */
  readonly cancelAll: () => Effect.Effect<void>
  /** Cancel every in-flight subagent and wait for their cleanup (stray harvest). */
  readonly disposeAll: () => Effect.Effect<void>
}

const AGENT_FIELDS = new Set(["prompt", "agent", "model", "label", "schema"])
const DEFAULT_AGENT = "general"
const DEFAULT_MAX_CONCURRENT = 16
const BATCH_FIELDS = new Set(["items", "from", "preset", "concurrency", "scope"])
const BATCH_SCOPE_FIELDS = new Set(["files", "file", "path", "target"])
const DEFAULT_BATCH_CONCURRENCY = 16
const MAX_BATCH_CONCURRENCY = 16
const DEFAULT_SOURCE_LIMIT = 20
/** Explicit items without a preset still get a numbered, swarm-style prompt. */
const DEFAULT_BATCH_TEMPLATE = ["Item {{index}}/{{total}}:", "{{item}}"].join("\n")

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

type BatchRequest = {
  readonly items?: ExplicitItem[]
  readonly from?: SourceName
  readonly preset?: PresetName
  readonly concurrency: number
  /** Batch-wide advisory edit scope, rendered as a prefix on every worker prompt. */
  readonly scopeFiles: string[]
}

function parseBatchItems(value: unknown): ExplicitItem[] {
  if (!Array.isArray(value)) throw new Error("orche.batch.items must be an array")
  return value.map((item, index) => {
    if (typeof item === "string") return item
    if (BatchPreset.objectRecord(item)) return item
    throw new Error(`orche.batch.items[${index}] must be a string or an object`)
  })
}

function parseBatchScope(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value === "string") {
    if (value.length === 0) throw new Error("orche.batch.scope must not be an empty string")
    return [value]
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`orche.batch.scope[${index}] must be a non-empty string`)
      }
      return entry
    })
  }
  if (!BatchPreset.objectRecord(value)) {
    throw new Error("orche.batch.scope must be a string, an array of strings, or an object with files/file/path/target")
  }
  for (const key of Object.keys(value)) {
    if (!BATCH_SCOPE_FIELDS.has(key)) throw new Error(`orche.batch.scope received unknown field: ${key}`)
  }
  const files = BatchPreset.itemScopeFiles({ scope: value })
  if (files.length === 0) throw new Error("orche.batch.scope must name at least one file")
  return files
}

function parseBatchRequest(args: JsonValue): BatchRequest {
  const problem = checkLosslessJson(args)
  if (problem) throw new Error(`orche.batch arguments are not lossless JSON: ${problem}`)
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("orche.batch expects an object argument")
  }
  for (const key of Object.keys(args)) {
    if (!BATCH_FIELDS.has(key)) throw new Error(`orche.batch received unknown field: ${key}`)
  }

  const from = args.from
  const preset = args.preset
  if (args.items !== undefined && from !== undefined) {
    throw new Error("orche.batch accepts either explicit items or from, not both")
  }
  if (args.items === undefined && from === undefined) {
    throw new Error(
      "orche.batch requires items or from: pass explicit items, or a Chimera evidence source such as pending_obligations",
    )
  }
  if (from !== undefined && !Schema.is(BatchSource.Source)(from)) {
    throw new Error(
      "orche.batch.from must be a Chimera evidence source (pending_obligations, claimed_obligations, stale_obligations, active_obligations, failing_oracles, unknown_oracles, or failing_or_unknown_oracles)",
    )
  }
  if (preset !== undefined && !Schema.is(BatchPreset.Preset)(preset)) {
    throw new Error("orche.batch.preset must be audit-followup, audit-review, oracle-followup, or file-review")
  }
  if (args.concurrency !== undefined && (typeof args.concurrency !== "number" || !Number.isFinite(args.concurrency))) {
    throw new Error("orche.batch.concurrency must be a finite number")
  }

  return {
    ...(args.items === undefined ? {} : { items: parseBatchItems(args.items) }),
    ...(from === undefined ? {} : { from }),
    ...(preset === undefined ? {} : { preset }),
    concurrency:
      typeof args.concurrency === "number"
        ? Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.trunc(args.concurrency)))
        : DEFAULT_BATCH_CONCURRENCY,
    scopeFiles: parseBatchScope(args.scope),
  }
}

/** FIFO slot queue for one batch's own concurrency window (the program window still applies). */
function batchSlots(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  return {
    acquire: () =>
      new Promise<void>((resolve) => {
        if (active < limit) {
          active += 1
          resolve()
          return
        }
        queue.push(() => {
          active += 1
          resolve()
        })
      }),
    release: () => {
      active -= 1
      const next = queue.shift()
      if (next) next()
    },
  }
}

function withDeclaredScope(files: readonly string[], prompt: string) {
  if (files.length === 0) return prompt
  return [`Declared batch scope: keep edits within ${files.join(", ")} and report deviations.`, prompt].join("\n\n")
}

function textOfResult(value: JsonValue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return typeof value.text === "string" ? value.text : undefined
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
    const truncate = Option.getOrUndefined(yield* Effect.serviceOption(Truncate.Service))

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
    /** Child sessions currently running, keyed by session id (job-interrupt cascade). */
    const inflightSessions = new Map<string, SessionID>()

    const emit = (event: OrchestrationAgentEvent) =>
      host.onEvent ? bridge.promise(host.onEvent(event).pipe(Effect.ignore)) : Promise.resolve()

    const settle = (event: OrchestrationSettledEvent) =>
      host.onSettled ? bridge.promise(host.onSettled(event).pipe(Effect.ignore)) : Promise.resolve()

    const agent = async (args: JsonValue): Promise<JsonValue> => {
      const request = parseAgentRequest(args)
      total += 1
      const index = total
      if (total > maxTotalAgents) {
        throw new Error(`orche.agent exceeded maxTotalAgents (${maxTotalAgents})`)
      }

      const controller = new AbortController()
      const onHostAbort = () => controller.abort()
      if (host.signal.aborted) controller.abort()
      else host.signal.addEventListener("abort", onHostAbort, { once: true })
      controllers.add(controller)
      /** Set once materialize creates the child session; the finally below unregisters it. */
      let childSessionID: SessionID | undefined

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
          const sessionId = materialized.nextSession.id
          childSessionID = sessionId
          inflightSessions.set(sessionId, sessionId)
          await emit({
            type: "start",
            index,
            label: request.label,
            agent: request.agent,
            sessionId,
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

          const finish = (status: "completed" | "failed" | "aborted") => ({
            type: "finish" as const,
            index,
            label: request.label,
            agent: request.agent,
            sessionId,
            status,
          })

          if (Exit.isFailure(exit)) {
            const aborted = controller.signal.aborted || Cause.hasInterruptsOnly(exit.cause)
            const event = finish(aborted ? "aborted" : "failed")
            await emit(event)
            await settle(event)
            if (Cause.hasDies(exit.cause) && !aborted) throw new Error(Cause.pretty(exit.cause))
            return null
          }

          const value = readResult(exit.value.message)
          await emit(finish("completed"))
          await settle({ ...finish("completed"), result: value })
          return value
        } finally {
          if (childSessionID) inflightSessions.delete(childSessionID)
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

    const batch = async (args: JsonValue): Promise<JsonValue> => {
      const request = parseBatchRequest(args)
      const sourceItems = request.from
        ? await bridge.promise(BatchSource.materializeSource(request.from, DEFAULT_SOURCE_LIMIT))
        : undefined
      const items: ExplicitItem[] = request.items ?? sourceItems ?? []
      if (items.length === 0) {
        throw new Error(
          request.from
            ? `orche.batch found no items from source: ${request.from}. Run \`chimera_audit_recent\` / \`chimera_obligations_list\` first to confirm pending evidence.`
            : "orche.batch requires a non-empty items array or a from source",
        )
      }

      const scopeWarnings = request.items ? BatchPreset.collectScopeWarnings(items) : []
      const preset = request.preset ?? BatchPreset.inferPreset(request.from)
      const template = preset ? BatchPreset.DEFAULT_TEMPLATES[preset] : DEFAULT_BATCH_TEMPLATE
      const subagent = BatchPreset.inferSubagent(preset)
      const slots = batchSlots(request.concurrency)

      const results = await Promise.all(
        items.map(async (item, offset) => {
          const index = offset + 1
          const prompt = withDeclaredScope(
            request.scopeFiles,
            BatchPreset.renderTemplate(template, item, index, items.length, scopeWarnings),
          )
          await slots.acquire()
          try {
            const value = await agent({
              prompt,
              agent: subagent,
              label: `${preset ?? "batch item"} ${index}/${items.length}`,
            })
            if (value === null) return null
            const text = textOfResult(value)
            const outputFile = text && truncate ? await bridge.promise(truncate.write(text)) : undefined
            return {
              item,
              index,
              status: "completed" as const,
              summary: text ? WorkerBatch.extractSummary(text) : {},
              ...(outputFile === undefined ? {} : { outputFile }),
            }
          } finally {
            slots.release()
          }
        }),
      )
      // Explicit items are already lossless; materialized evidence records may
      // carry undefined optional fields, which a reply frame cannot encode.
      return JSON.parse(JSON.stringify(results)) as JsonValue
    }

    const cancel = (sessionId: string) => {
      const id = inflightSessions.get(sessionId)
      if (!id) return Effect.void
      return promptOps.cancel(id).pipe(Effect.ignore)
    }

    const cancelAll = () =>
      Effect.forEach([...inflightSessions.values()], (id) => promptOps.cancel(id).pipe(Effect.ignore), {
        concurrency: "unbounded",
        discard: true,
      })

    const disposeAll = () =>
      Effect.gen(function* () {
        yield* cancelAll()
        yield* Effect.promise(async () => {
          for (const controller of controllers) controller.abort()
          await Promise.allSettled([...inflight])
        })
      })

    return {
      bindings: { orche: { agent, batch } },
      cancel,
      cancelAll,
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