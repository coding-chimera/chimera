import * as Tool from "./tool"
import DESCRIPTION from "./orchestrate.txt"
import { SubagentDispatch, type SubagentPromptOps } from "../agent/subagent-dispatch"
import {
  makeOrchestrationBindingsFrom,
  type OrchestrationAgentEvent,
  type OrchestrationHost,
} from "../orchestrate/host-bindings"
import { OrchestrateRuntime, type ErrorKind, type Result } from "../orchestrate/runtime"
import type { JsonValue } from "../orchestrate/protocol"
import { Cause, Effect, Fiber, Queue, Schema, Scope } from "effect"

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
      "Optional wall-clock budget for the whole program in milliseconds. By default there is no wall-clock limit: the run ends when the program returns or throws, a subagent failure surfaces as `null`, or the user aborts the turn (which cancels the whole run). Set this only when you deliberately want a time budget; a provided value floors at 1ms and has no upper cap.",
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

export const OrchestrateTool = Tool.define(
  id,
  Effect.gen(function* () {
    const dispatch = yield* SubagentDispatch
    const scope = yield* Scope.Scope

    const run = Effect.fn("OrchestrateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const promptOps = ctx.extra?.promptOps as SubagentPromptOps | undefined
      if (!promptOps) return yield* Effect.fail(new Error("OrchestrateTool requires promptOps in ctx.extra"))

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

      // Log-only bursts must not republish on every line: a single consumer
      // publishes at most once per window, while agent events below still
      // publish immediately. Queue.offerUnsafe bridges the synchronous
      // runtime callback back into this Effect context.
      const logPublisher = yield* Effect.gen(function* () {
        while (true) {
          yield* Queue.take(logQueue)
          yield* publish()
          yield* Effect.sleep(`${LOG_PUBLISH_INTERVAL_MS} millis`)
        }
      }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const onLog = (line: string) => {
        appendOrchestrateLog(logs, line)
        Queue.offerUnsafe(logQueue, line)
      }

      const onEvent = (event: OrchestrationAgentEvent) =>
        Effect.gen(function* () {
          progress.set(event.sessionId, {
            label: event.label,
            agent: event.agent,
            sessionId: event.sessionId,
            status: event.status ?? "running",
          })
          yield* publish()
        })

      const host: OrchestrationHost = {
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        signal: ctx.abort,
        ask: (input) =>
          ctx.ask({
            permission: input.permission,
            patterns: input.patterns,
            always: input.always,
            metadata: input.metadata,
          }),
        onEvent,
      }

      const bindings = yield* makeOrchestrationBindingsFrom(dispatch, promptOps, host, {
        maxTotalAgents,
        maxConcurrent: MAX_CONCURRENT,
      })
      yield* publish()

      const result = yield* Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({
          code: params.code,
          timeoutMs: params.timeoutMs,
          signal: ctx.abort,
          bindings: bindings.bindings,
          onLog,
        })
        return yield* runtime.run(spec)
      }).pipe(Effect.provide(OrchestrateRuntime.defaultLayer), Effect.ensuring(bindings.disposeAll()))

      yield* Fiber.interrupt(logPublisher).pipe(Effect.ignore)

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
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)