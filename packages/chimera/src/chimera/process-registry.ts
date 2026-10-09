import { Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import {
  markProcessExited,
  markProcessKilled,
  readActiveProcesses,
  registerProcess,
  releaseProcessesForSession,
  type ProcessRegistryRecord,
  type ProcessRegistryStatus,
} from "./store"

const log = Log.create({ service: "chimera.process-registry" })

/**
 * Session process registry: every bash-tool child process is recorded in the
 * shared per-project Chimera DB so concurrent sessions see each other's
 * spawned processes, cross-session kills are gated, and the owner learns when
 * a registered process is killed externally. The store surface is fully
 * degrade-open: any storage trouble yields no rows and never throws, so the
 * shell tool keeps executing commands when the registry is unavailable.
 */

/** One registered child process; the shared read shape for prompt context and HTTP routes. */
export type ProcessEntry = ProcessRegistryRecord

export type ProcessStatus = ProcessRegistryStatus

export type ProcessChange = "registered" | "exited" | "killed"

const ProcessEntrySchema = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  hostBootID: Schema.NullOr(Schema.String),
  pid: Schema.Number,
  pgid: Schema.NullOr(Schema.Number),
  command: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  status: Schema.Union([
    Schema.Literal("running"),
    Schema.Literal("exited"),
    Schema.Literal("killed"),
    Schema.Literal("expired"),
    Schema.Literal("released"),
  ]),
  exitCode: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  exitedAt: Schema.NullOr(Schema.String),
})

export const Changed = BusEvent.define(
  "process.changed",
  Schema.Struct({
    sessionID: Schema.String,
    change: Schema.Union([Schema.Literal("registered"), Schema.Literal("exited"), Schema.Literal("killed")]),
    process: ProcessEntrySchema,
  }),
)

// Fire-and-forget like the work-brief publish path: a failed event (e.g. no
// instance context in a detached runner) must never fail the registry call.
function publishChange(change: ProcessChange, entry: ProcessEntry) {
  void Bus.publish(Changed, { sessionID: entry.sessionID, change, process: entry }).catch((error) => {
    log.warn("process.changed publish failed", { change, pid: entry.pid, error })
  })
}

export async function register(input: {
  projectRoot: string
  sessionID: string
  pid: number
  pgid?: number | null
  command: string
  cwd?: string | null
  hostBootID?: string | null
  ttlMs?: number
}): Promise<ProcessEntry | undefined> {
  const entry = await registerProcess(input.projectRoot, {
    sessionID: input.sessionID,
    pid: input.pid,
    pgid: input.pgid,
    command: input.command,
    cwd: input.cwd,
    hostBootID: input.hostBootID,
    ttlMs: input.ttlMs,
  })
  if (entry) publishChange("registered", entry)
  return entry
}

/** Idempotent: only the first call on a running id transitions and publishes. */
export async function markExited(
  projectRoot: string,
  id: string,
  exitCode: number | null,
): Promise<ProcessEntry | undefined> {
  const entry = await markProcessExited(projectRoot, id, exitCode)
  if (entry) publishChange("exited", entry)
  return entry
}

/** Idempotent: only the first call on a running id transitions and publishes. */
export async function markKilled(projectRoot: string, id: string): Promise<ProcessEntry | undefined> {
  const entry = await markProcessKilled(projectRoot, id)
  if (entry) publishChange("killed", entry)
  return entry
}

/** Drop every running row of a removed session (status 'released', no event). */
export async function releaseForSession(projectRoot: string, sessionID: string): Promise<ProcessEntry[]> {
  return releaseProcessesForSession(projectRoot, sessionID)
}

/**
 * FIXED READ CONTRACT for the prompt-context and HTTP-route layers: the
 * liveness-swept active rows for one project, sorted by started_at ascending.
 * Degrade-open: an unavailable or uninitialized store yields an empty list.
 */
export async function listActive(projectRoot: string): Promise<ProcessEntry[]> {
  return readActiveProcesses(projectRoot)
}

/**
 * Confirmation marker the kill gate honors: when the command text itself sets
 * `CHIMERA_KILL_CONFIRM=1` (e.g. the env-prefix in the block message), the
 * kill targets are treated as intentional and the gate passes.
 */
const KILL_CONFIRM = /(?:^|[\s;&|(`$])CHIMERA_KILL_CONFIRM\s*=\s*1(?![0-9])/

/**
 * Conservative pure parser for the kill gate: numeric pids named by direct
 * `kill` invocations (`kill [-SIG] <pid>...`, `kill -- -<pgid>`), one entry
 * per number, deduplicated. Pattern-based kills (`pkill -f node`,
 * `killall node`) carry no numeric target and return nothing — the gate only
 * guards explicit numeric-pid kills. `CHIMERA_KILL_CONFIRM=1` anywhere in the
 * text yields nothing (the caller's explicit confirmation). Leading env
 * assignment prefixes are skipped (`FOO=1 kill 5` targets 5), and segments
 * whose command token is not a bare `kill` pay only this regex/scan and
 * never a registry read.
 */
export function extractKillTargets(command: string): number[] {
  if (KILL_CONFIRM.test(command)) return []
  const targets: number[] = []
  for (const segment of command.split(/[;&|\n()]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) index += 1
    const name = tokens[index]?.replace(/^.*[\\/]/, "").toLowerCase()
    if (name !== "kill") continue
    let afterLiteral = false
    let seenTarget = false
    for (const token of tokens.slice(index + 1)) {
      if (!afterLiteral && token === "--") {
        afterLiteral = true
        continue
      }
      const numeric = /^(-?\d+)$/.exec(token)
      if (numeric) {
        const value = Number(numeric[1])
        // A bare negative before the first target is a signal flag (`kill -9 123`
        // sends SIGKILL to 123); after `--` it is a negative pgid (`kill -- -45`).
        if (value < 0 && !afterLiteral && !seenTarget) continue
        if (value !== 0) targets.push(Math.abs(value))
        seenTarget = true
        continue
      }
      // Other flags and non-numeric operands (-TERM, -s, %jobspec, $VAR): ignore.
    }
  }
  return [...new Set(targets)]
}

/**
 * Kill-gate matcher: the first active entry whose pid or pgid one of the
 * extracted targets names and that belongs to a DIFFERENT session.
 * A defined result means the command would kill another session's registered
 * process and must be refused unless re-confirmed; undefined (including the
 * same-session match and any degrade-open empty read) lets it run.
 */
export function findForeignKillTarget(
  entries: ProcessEntry[],
  targets: number[],
  sessionID: string,
): ProcessEntry | undefined {
  return entries.find(
    (entry) =>
      entry.sessionID !== sessionID &&
      (targets.includes(entry.pid) || (entry.pgid !== null && targets.includes(entry.pgid))),
  )
}

export * as ProcessRegistry from "./process-registry"
