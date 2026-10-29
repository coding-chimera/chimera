import * as Tool from "./tool"
import DESCRIPTION from "./orchestrate.txt"
import { SubagentDispatch, type SubagentPromptOps } from "../agent/subagent-dispatch"
import { BackgroundJob } from "../agent/background-job"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import {
  makeOrchestrationBindingsFrom,
  type OrchestrationAgentEvent,
  type OrchestrationHost,
  type OrchestrationSettledEvent,
} from "../orchestrate/host-bindings"
import { OrchestrateRuntime, type ErrorKind, type Result } from "../orchestrate/runtime"
import type { JsonValue } from "../orchestrate/protocol"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Fiber, Option, Queue, Schema, Scope } from "effect"

const id = "orchestrate"

const DEFAULT_MAX_TOTAL_AGENTS = 64
const MAX_TOTAL_AGENTS = 256
const MAX_CONCURRENT = 16

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description:
      "Body of an async JavaScript function. Receives `orche` with agent/parallel/pipeline/log; use top-level await and return the curated JSON result.",
  }),
  description: Schema.String.annotate({
    description: "A short (3-5 words) UI label describing what this orchestration does",
  }),
  maxTotalAgents: Schema.optional(Schema.Number).annotate({
    description: "Maximum total subagent dispatches across the whole program. Defaults to 64; hard cap 256.",
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description:
      "Wall-clock budget for the whole program in milliseconds. Use `timeoutMs: 0` for an unlimited run (the default); negative values and omission also mean unlimited, with no global timer. `null` is rejected by the schema. A finite positive number enables a deadline; it is rounded down to whole milliseconds with a 1ms floor and no upper cap. Set a positive budget only when you deliberately want a time limit.",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the orchestration program in the background and return a start receipt immediately. Each subagent completion injects an <orchestrate_worker_result> notification into this session, and the program's final result arrives as an <orchestrate_result> notification. Do not sleep, poll, or proactively check on progress. Rejected when delegation.background_subagents is false.",
  }),
  block_reason: Schema.optional(Schema.String).annotate({
    description:
      "For long foreground orchestration runs (background omitted or false): state the concrete dependency that forces this turn to wait for the program inline. Omit for background runs.",
  }),
})

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

type AgentProgress = {
  readonly label: string
  readonly agent: string
  readonly sessionId: string
  readonly status: "running" | "completed" | "failed" | "aborted"
}

type OrchestrateMetadata = {
  background?: boolean
  jobId?: string
  agents?: AgentProgress[]
  logs?: string[]
  error?: ErrorKind
}

/** Metadata log tail stays small so every publish is a bounded write. */
export const ORCHESTRATE_LOG_LIMIT = 50
const LOG_PUBLISH_INTERVAL_MS = 1_000

/** Append one program log line, keeping only the most recent `limit` lines. */
export function appendOrchestrateLog(logs: string[], line: string, limit = ORCHESTRATE_LOG_LIMIT) {
  logs.push(line)
  if (logs.length > limit) logs.splice(0, logs.length - limit)
}

const ERROR_HEADINGS: Record<ErrorKind, string> = {
  timeout: "Orchestration timed out",
  abort: "Orchestration aborted",
  exception: "Orchestration program failed",
  "worker-exit": "Orchestration worker exited",
  "invalid-output": "Orchestration returned invalid output",
  "output-limit": "Orchestration exceeded its output budget",
  protocol: "Orchestration protocol error",
}

function truncateText(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated, ${text.length} chars)`
}

function renderLogs(logs: string[], limit?: number) {
  if (!logs.length) return ""
  const shown = limit === undefined ? logs : logs.slice(-limit)
  const omitted = logs.length - shown.length
  const header = omitted > 0 ? `## Logs (last ${shown.length} of ${logs.length})` : "## Logs"
  return [header, ...shown].join("\n")
}

function renderSuccess(result: Result) {
  const sections: string[] = []
  const logs = renderLogs(result.logs)
  if (logs) sections.push(logs)
  if (result.value !== undefined) {
    const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value as JsonValue, null, 2)
    sections.push(["## Result", value].join("\n"))
  }
  if (!sections.length) sections.push("Orchestration completed with no result and no logs.")
  return sections.join("\n\n")
}

function renderError(result: Result & { error: NonNullable<Result["error"]> }) {
  const heading = ERROR_HEADINGS[result.error.kind] ?? "Orchestration failed"
  const sections = [`${heading} (${result.error.kind}): ${result.error.message}`]
  const logs = renderLogs(result.logs, 20)
  if (logs) sections.push(logs)
  return sections.join("\n\n")
}

/** Background delivery bounds the return value and keeps the log tail last. */
function renderBackgroundSummary(result: Result) {
  const sections: string[] = []
  if (result.error) {
    const heading = ERROR_HEADINGS[result.error.kind] ?? "Orchestration failed"
    sections.push(`${heading} (${result.error.kind}): ${result.error.message}`)
  } else if (result.value !== undefined) {
    const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value as JsonValue, null, 2)
    sections.push(["## Result", truncateText(value, 4000)].join("\n"))
  }
  const logs = renderLogs(result.logs, 20)
  if (logs) sections.push(logs)
  if (!sections.length) sections.push("Orchestration completed with no result and no logs.")
  return sections.join("\n\n")
}

function resultSummary(result: JsonValue | undefined) {
  if (result === undefined || result === null) return undefined
  const text =
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as { text?: unknown }).text === "string"
      ? (result as { text: string }).text
      : (JSON.stringify(result) ?? "")
  const summary = truncateText(text.replace(/<task_result>|<\/task_result>/g, "").trim(), 1000)
  return summary.length > 0 ? summary : undefined
}

/** Per-worker background notification injected into the dispatching session. */
export function orchestrateWorkerResultText(event: OrchestrationSettledEvent) {
  const status = event.status ?? "completed"
  const summary = status === "completed" ? resultSummary(event.result) : undefined
  return [
    `task_id: ${event.sessionId} (orchestrate worker ${status})`,
    "<orchestrate_worker_result>",
    `index: ${event.index}`,
    `label: ${event.label}`,
    `status: ${status}`,
    ...(summary ? [`summary: ${summary}`] : []),
    "</orchestrate_worker_result>",
  ].join("\n")
}

/** Final program notification injected into the dispatching session. */
export function orchestrateResultText(jobId: string, status: string, text: string) {
  return [
    `task_id: ${jobId} (orchestrate program ${status})`,
    "<orchestrate_result>",
    truncateText(text, 8000),
    "</orchestrate_result>",
  ].join("\n")
}

export const OrchestrateTool = Tool.define(
  id,
  Effect.gen(function* () {
    const dispatch = yield* SubagentDispatch
    const config = yield* Config.Service
    const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
    const scope = yield* Scope.Scope

    const run = Effect.fn("OrchestrateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const promptOps = ctx.extra?.promptOps as SubagentPromptOps | undefined
      if (!promptOps) return yield* Effect.fail(new Error("OrchestrateTool requires promptOps in ctx.extra"))

      const runInBackground = params.background === true
      if (runInBackground) {
        const cfg = yield* config.get()
        const enabled = cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
        if (!enabled) {
          return yield* Effect.fail(
            new Error(
              "Background orchestration is disabled by the kill-switch: delegation.background_subagents is false. Re-enable it to run orchestrate programs asynchronously, or omit background to run synchronously.",
            ),
          )
        }
        if (!background) {
          return yield* Effect.fail(new Error("Background job service is not available in this runtime"))
        }
      }

      yield* ctx.ask({
        permission: id,
        patterns: ["*"],
        always: ["*"],
        metadata: { description: params.description },
      })

      const maxTotalAgents = clamp(params.maxTotalAgents, DEFAULT_MAX_TOTAL_AGENTS, 1, MAX_TOTAL_AGENTS)

      const progress = new Map<string, AgentProgress>()
      const logs: string[] = []
      const logQueue = yield* Queue.unbounded<string, Cause.Done>()
      const publish = () =>
        ctx.metadata({
          title: params.description,
          metadata: {
            agents: [...progress.values()],
            ...(logs.length ? { logs: [...logs] } : {}),
          },
        })

      // Background work outlives this tool call: its progress is projected through
      // the job/session surfaces instead of ctx.metadata, which is terminal once
      // the start receipt returns. Log-only bursts still publish at most once per
      // window on the foreground path; Queue.offerUnsafe bridges the synchronous
      // runtime callback back into this Effect context.
      const logPublisher = runInBackground
        ? undefined
        : yield* Effect.gen(function* () {
            while (true) {
              yield* Queue.take(logQueue)
              yield* publish()
              yield* Effect.sleep(`${LOG_PUBLISH_INTERVAL_MS} millis`)
            }
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const onLog = (line: string) => {
        appendOrchestrateLog(logs, line)
        if (!runInBackground) Queue.offerUnsafe(logQueue, line)
      }

      const onEvent = runInBackground
        ? undefined
        : (event: OrchestrationAgentEvent) =>
            Effect.gen(function* () {
              progress.set(event.sessionId, {
                label: event.label,
                agent: event.agent,
                sessionId: event.sessionId,
                status: event.status ?? "running",
              })
              yield* publish()
            })

      // Background notifications are fire-and-forget: the program must not wait
      // for a woken parent turn before its next worker can settle.
      const inject = (text: string) =>
        (promptOps.injectSynthetic?.({ sessionID: ctx.sessionID, text }) ?? Effect.void).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      const onSettled = runInBackground
        ? (event: OrchestrationSettledEvent) => inject(orchestrateWorkerResultText(event))
        : undefined

      // A detached program must not inherit the tool call's abort signal: the
      // engine job (and its onInterrupt) owns cancellation instead.
      const backgroundAbort = new AbortController()
      const signal = runInBackground ? backgroundAbort.signal : ctx.abort

      const host: OrchestrationHost = {
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        signal,
        ask: (input) =>
          ctx.ask({
            permission: input.permission,
            patterns: input.patterns,
            always: input.always,
            metadata: input.metadata,
          }),
        ...(onEvent ? { onEvent } : {}),
        ...(onSettled ? { onSettled } : {}),
      }

      const bindings = yield* makeOrchestrationBindingsFrom(dispatch, promptOps, host, {
        maxTotalAgents,
        maxConcurrent: MAX_CONCURRENT,
      })

      const program = Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({
          code: params.code,
          timeoutMs: params.timeoutMs,
          signal,
          bindings: bindings.bindings,
          onLog,
        })
        return yield* runtime.run(spec)
      }).pipe(Effect.provide(OrchestrateRuntime.defaultLayer), Effect.ensuring(bindings.disposeAll()))

      if (runInBackground) {
        const jobs = background
        if (!jobs) return yield* Effect.fail(new Error("Background job service is not available in this runtime"))
        const jobId = `orchestrate-${randomUUID()}`
        const started = yield* jobs.start({
            id: jobId,
            type: "orchestrate",
            title: params.description,
            ownerSessionId: ctx.sessionID,
            metadata: { background: true },
            onInterrupt: Effect.all([Effect.sync(() => backgroundAbort.abort()), bindings.cancelAll()], {
              discard: true,
            }),
            run: program.pipe(
              Effect.flatMap((result) =>
                result.error
                  ? Effect.fail(new Error(renderBackgroundSummary(result)))
                  : Effect.succeed(renderBackgroundSummary(result)),
              ),
            ),
          })
          .pipe(
            Effect.catchTag("BackgroundJobLimitError", (error) => Effect.fail(new Error(error.message))),
          )
        yield* jobs
          .wait({ id: jobId })
          .pipe(
            Effect.flatMap((waited) => {
              const info = waited.info
              if (!info || info.status === "cancelled") return Effect.void
              const text =
                info.status === "completed" ? (info.output ?? "") : (info.error ?? `orchestrate program ${info.status}`)
              return (
                promptOps.injectSynthetic?.({
                  sessionID: ctx.sessionID,
                  text: orchestrateResultText(jobId, info.status, text),
                }) ?? Effect.void
              )
            }),
            Effect.ignoreCause({ log: true }),
            // Delivery is final only after injectSynthetic's woken turn completed;
            // the generation binds the mark to this run.
            Effect.ensuring(jobs.markDelivered(jobId, started.generation).pipe(Effect.ignore)),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        return {
          title: params.description,
          metadata: { background: true, jobId },
          output: JSON.stringify(
            {
              background: true,
              job_id: jobId,
              title: params.description,
              note: "The orchestration program is running in the background. Each subagent completion injects an <orchestrate_worker_result> notification; the program's final result arrives as an <orchestrate_result> notification. Do not sleep, poll, or proactively check on progress. Cancel the program with task_cancel using job_id.",
            },
            null,
            2,
          ),
        }
      }

      yield* publish()

      const result = yield* program

      if (logPublisher) yield* Fiber.interrupt(logPublisher).pipe(Effect.ignore)

      const metadata = {
        agents: [...progress.values()],
        ...(logs.length ? { logs: [...logs] } : {}),
        ...(result.error ? { error: result.error.kind } : {}),
      }

      if (result.error) return yield* Effect.fail(new Error(renderError({ ...result, error: result.error })))

      return {
        title: params.description,
        metadata,
        output: renderSuccess(result),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<OrchestrateMetadata>> => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)