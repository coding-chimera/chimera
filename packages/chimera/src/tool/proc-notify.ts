import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ProcessRegistry } from "@/chimera/process-registry"
import { ProcessWatch } from "@/chimera/process-watch"
import { PositiveInt } from "@/util/schema"
import * as Tool from "./tool"
import DESCRIPTION from "./proc_notify.txt"

export const Parameters = Schema.Struct({
  pid: Schema.Number.annotate({
    description: "The OS pid of a registered process in this project's Session Processes registry to watch.",
  }),
  timeout_s: Schema.optional(PositiveInt).annotate({
    description: "Optional bound in seconds; on expiry a <process_watch_timeout> notice is injected instead.",
  }),
})

function activePidList(entries: ProcessRegistry.ProcessEntry[]) {
  if (entries.length === 0) return "none"
  return entries.map((entry) => `${entry.pid} ("${entry.command}", session ${entry.sessionID})`).join(", ")
}

type ProcNotifyMetadata = { pid: number; status: string; subscribed: boolean; timeout_s?: number | null }

export const ProcNotifyTool = Tool.define(
  "proc_notify",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const projectRoot = instance.worktree === "/" ? instance.directory : instance.worktree
          const pid = params.pid

          const rows = yield* Effect.promise(() => ProcessRegistry.getByPids(projectRoot, [pid])).pipe(
            Effect.catch(() => Effect.succeed([] as ProcessRegistry.ProcessEntry[])),
          )
          const resolution = ProcessWatch.resolveWatchTarget(rows)

          if (resolution.kind === "missing") {
            const active = yield* Effect.promise(() => ProcessRegistry.listActive(projectRoot)).pipe(
              Effect.catch(() => Effect.succeed([] as ProcessRegistry.ProcessEntry[])),
            )
            return yield* Effect.fail(
              new Error(
                `No registered process with pid ${pid} in this project. Active registered pids: ${activePidList(active)}. proc_notify only watches processes spawned by the bash tool in this project.`,
              ),
            )
          }

          if (resolution.kind === "terminal") {
            const entry = resolution.entry
            const metadata: ProcNotifyMetadata = { pid, status: entry.status, subscribed: false }
            yield* ctx.metadata({ title: `proc_notify: pid ${pid}`, metadata })
            return {
              title: `proc_notify: pid ${pid}`,
              metadata,
              output: `pid ${pid} ("${entry.command}") is already terminal (status ${entry.status}, exit code ${entry.exitCode ?? "-"}, exited_at ${entry.exitedAt ?? "-"}) — no subscription created.`,
            }
          }

          const entry = resolution.entry
          const timeoutMs = params.timeout_s === undefined ? undefined : params.timeout_s * 1000
          ProcessWatch.subscribe({
            projectRoot,
            sessionID: ctx.sessionID,
            pid: entry.pid,
            command: entry.command,
            ownerSession: entry.sessionID,
            startedAt: entry.startedAt,
            timeoutMs,
          })
          const metadata: ProcNotifyMetadata = { pid, status: "watching", subscribed: true, timeout_s: params.timeout_s ?? null }
          yield* ctx.metadata({ title: `proc_notify: pid ${pid}`, metadata })
          const timeoutNote =
            timeoutMs === undefined
              ? ""
              : ` A ${params.timeout_s}s timeout will inject a <process_watch_timeout> notice instead if it is still running.`
          return {
            title: `proc_notify: pid ${pid}`,
            metadata,
            output: `Subscribed to pid ${pid} ("${entry.command}", owned by session ${entry.sessionID}). You will receive a one-shot <process_exited> notice when it exits — no polling needed.${timeoutNote}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)