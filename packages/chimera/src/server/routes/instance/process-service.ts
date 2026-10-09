import { Effect, Option, Schema } from "effect"
import { ProcessRegistry } from "@/chimera/process-registry"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { PositiveInt } from "@/util/schema"

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

/**
 * One liveness-swept registry row joined with display fields from the owning
 * session. Shared by the legacy Hono process route and the HttpApi group so
 * both surfaces expose an identical response shape.
 */
export const ProcessItem = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  hostBootID: Schema.NullOr(Schema.String),
  pid: PositiveInt,
  pgid: Schema.NullOr(PositiveInt),
  command: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  status: Schema.Union([
    Schema.Literal("running"),
    Schema.Literal("exited"),
    Schema.Literal("killed"),
    Schema.Literal("expired"),
    Schema.Literal("released"),
  ]),
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: Schema.String,
  exitedAt: Schema.NullOr(Schema.String),
  sessionTitle: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Process" })

export type ProcessItem = Schema.Schema.Type<typeof ProcessItem>

const decodeSessionID = Schema.decodeUnknownOption(SessionID)

export const listActiveProcesses = Effect.fn("ProcessService.list")(function* () {
  const root = projectRoot(yield* InstanceState.context)
  const session = yield* Session.Service
  const entries = yield* Effect.promise(() => ProcessRegistry.listActive(root))
  // The registry is cross-session, so rows cluster by owner: one session
  // lookup per unique sessionID, not per row. A removed or malformed session
  // degrades the join fields to null instead of failing the request.
  const ids = [...new Set(entries.map((entry) => entry.sessionID))]
  const infos = yield* Effect.forEach(
    ids,
    (id) =>
      Effect.gen(function* () {
        const decoded = Option.getOrUndefined(decodeSessionID(id))
        if (decoded === undefined) return undefined
        return yield* session.get(decoded).pipe(Effect.catch(() => Effect.succeed(undefined)))
      }),
    { concurrency: "unbounded" },
  )
  const bySession = new Map(
    ids.flatMap((id, index) => {
      const info = infos[index]
      return info ? [[id, info] as const] : []
    }),
  )
  return entries.map(
    (entry): ProcessItem => ({
      ...entry,
      sessionTitle: bySession.get(entry.sessionID)?.title ?? null,
      agent: bySession.get(entry.sessionID)?.agent ?? null,
    }),
  )
})

export * as ProcessService from "./process-service"
