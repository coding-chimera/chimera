import type { Argv } from "yargs"
import { Effect, Stream } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../contracts/session-ids"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "../../util/which"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const pageOutput = Effect.fnUntraced(
  function* (cmd: string[], output: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(cmd[0], cmd.slice(1), {
        extendEnv: true,
        stdin: { stream: Stream.make(new TextEncoder().encode(output)) },
        stdout: "inherit",
        stderr: "inherit",
        forceKillAfter: "5 seconds",
      }),
    )
    return yield* handle.exitCode
  },
  Effect.scoped,
)

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionDeleteCommand).command(SessionPruneCommand).demandCommand(),
  async handler() {},
})

const DURATION_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** Parses a compact retention window such as `30d`, `12h`, `90m`, `3600s`, `2w`. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)([smhdw])$/.exec(value.trim())
  if (!match) return undefined
  return Number(match[1]) * DURATION_MS[match[2]]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${units[exponent - 1]}`
}

export const SessionPruneCommand = effectCmd({
  command: "prune",
  describe: "delete sessions older than a retention window",
  builder: (yargs) =>
    yargs
      .option("older-than", {
        describe: "retention window, e.g. 30d, 12h, 90m (units: s/m/h/d/w)",
        type: "string",
        demandOption: true,
      })
      .option("yes", {
        describe: "actually delete; without it prune is a dry run",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.session.prune")(function* (args) {
    const age = parseDuration(args.olderThan)
    if (age === undefined) return yield* fail(`Invalid --older-than value: ${args.olderThan} (use e.g. 30d, 12h, 90m)`)
    const result = yield* Session.Service.use((svc) => {
      if (!svc.prune) return fail("Session pruning is unavailable")
      return svc.prune({ cutoff: Date.now() - age, dryRun: !args.yes })
    })
    if (result.sessions.length === 0) {
      UI.println(`No sessions older than ${args.olderThan}`)
      return
    }
    const planned = result.dryRun ? `Would delete ${result.sessions.length}` : `Deleted ${result.removedSessions}`
    UI.println(
      `${planned} session(s), ${result.totalMessages} message(s), ${result.totalParts} part(s), ${formatBytes(result.totalBytes)}`,
    )
    if (result.skippedActive > 0) UI.println(`Skipped ${result.skippedActive} active session(s)`)
    if (result.dryRun) {
      for (const session of result.sessions) {
        UI.println(
          `  ${session.id}  ${Locale.truncate(session.title, 60)}  ${Locale.todayTimeOrDateTime(session.timeUpdated)}`,
        )
      }
      UI.println("Dry run: re-run with --yes to delete")
      return
    }
    if (result.removedOrphanDiffs > 0) UI.println(`Removed ${result.removedOrphanDiffs} orphan session_diff file(s)`)
  }),
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* pageOutput(pagerCmd(), output).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer), Effect.orDie)
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
