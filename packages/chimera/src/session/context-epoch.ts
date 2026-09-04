import { and, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SystemContext } from "@opencode-ai/core/system-context"
import { makeRuntime } from "@/effect/run-service"
import { Database } from "@/storage/db"
import { SyncEvent } from "@/sync"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { ContextSnapshotDecodeError } from "./error"
import { MessageID, SessionID } from "./schema"
import { MessageTable, SessionContextEpochTable } from "./session.sql"

export interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
  // Set only when reconcile produced a source update: the rendered delta
  // text for this turn. The stored baseline stays unchanged; the caller
  // injects the delta as an additional system message.
  readonly delta?: string
}

export interface Input {
  readonly sessionID: SessionID
  readonly context: Effect.Effect<SystemContext.SystemContext>
}

export interface Interface {
  readonly initialize: (input: Input) => Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked>
  readonly prepare: (
    input: Input,
  ) => Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError>
  readonly reset: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ContextEpoch") {}

const exists = Effect.fnUntraced(function* (sessionID: SessionID) {
  return (
    Database.use((db) =>
      db
        .select({ sessionID: SessionContextEpochTable.session_id })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get(),
    ) !== undefined
  )
})

const find = Effect.fnUntraced(function* (sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, sessionID)).get(),
  )
})

// Fork adaptation: upstream reads the latest "compaction" message row and its
// durable event sequence. Fork V1 records compaction as an assistant summary
// message (`info.summary`), so the newest summary message's creation time is
// the compaction position. It compares against `baseline_seq`, which this
// module keeps in the same wall-clock millisecond domain (see `insert`).
const latestCompaction = Effect.fnUntraced(function* (sessionID: SessionID) {
  const row = Database.use((db) =>
    db
      .select({ seq: sql<number | null>`MAX(${MessageTable.time_created})` })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, sessionID), sql`json_extract(${MessageTable.data}, '$.summary') = 1`))
      .get(),
  )
  if (row?.seq == null) return undefined
  return { seq: row.seq }
})

const insert = Effect.fnUntraced(function* (sessionID: SessionID, generation: SystemContext.Generation) {
  // Fork adaptation: upstream reads the latest durable event sequence for the
  // session aggregate. The fork event channel does not persist per-aggregate
  // sequences, so baseline_seq uses wall-clock milliseconds instead; it only
  // needs to order against MessageTable.time_created in `latestCompaction`.
  const baselineSeq = Date.now()
  Database.use((db) =>
    db
      .insert(SessionContextEpochTable)
      .values({
        session_id: sessionID,
        baseline: generation.baseline,
        snapshot: generation.snapshot,
        baseline_seq: baselineSeq,
      })
      .run(),
  )
  return baselineSeq
})

const replace = Effect.fnUntraced(function* (
  sessionID: SessionID,
  baselineSeq: number,
  generation: SystemContext.Generation,
) {
  const updated = Database.use((db) =>
    db
      .update(SessionContextEpochTable)
      .set({
        baseline: generation.baseline,
        snapshot: generation.snapshot,
        baseline_seq: baselineSeq,
      })
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .returning({ sessionID: SessionContextEpochTable.session_id })
      .get(),
  )
  if (!updated) return yield* Effect.die("Context Epoch not found")
})

const advance = Effect.fnUntraced(function* (sessionID: SessionID, snapshot: SystemContext.Snapshot) {
  const updated = Database.use((db) =>
    db
      .update(SessionContextEpochTable)
      .set({ snapshot })
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .returning({ sessionID: SessionContextEpochTable.session_id })
      .get(),
  )
  if (!updated) return yield* Effect.die("Context Epoch not found")
})

const initializeOnce = Effect.fnUntraced(function* (
  sessionID: SessionID,
  context: Effect.Effect<SystemContext.SystemContext>,
) {
  if (yield* exists(sessionID)) return
  const generation = yield* context.pipe(Effect.flatMap(SystemContext.initialize))
  const baselineSeq = yield* insert(sessionID, generation)
  return { baseline: generation.baseline, baselineSeq }
})

const prepareOnce = Effect.fnUntraced(function* (
  sync: SyncEvent.Interface,
  sessionID: SessionID,
  context: Effect.Effect<SystemContext.SystemContext>,
) {
  const [value, stored, compaction] = yield* Effect.all(
    [context, find(sessionID), latestCompaction(sessionID)],
    { concurrency: "unbounded" },
  )
  if (!stored) {
    const generation = yield* SystemContext.initialize(value)
    const baselineSeq = yield* insert(sessionID, generation)
    return { baseline: generation.baseline, baselineSeq }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const replacementSeq = compaction !== undefined && compaction.seq > stored.baseline_seq ? compaction.seq : undefined
  const result = replacementSeq
    ? yield* SystemContext.replace(value, snapshot)
    : yield* SystemContext.reconcile(value, snapshot)
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked")
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
  if (result._tag === "ReplacementReady") {
    // Fork adaptation: the non-compaction fallback is Date.now() for the same
    // reason `insert` uses it (no durable event sequence in the fork channel).
    const baselineSeq = replacementSeq ?? Date.now()
    yield* replace(sessionID, baselineSeq, result.generation)
    return { baseline: result.generation.baseline, baselineSeq }
  }

  // Fork adaptation: upstream advances the stored snapshot atomically inside
  // the durable event publish via a commit hook. The fork EventV2 channel has
  // no transactional commit hook, so the snapshot is persisted first and the
  // event is emitted after the write succeeds; with the event flag off the
  // emit is a no-op and the persisted snapshot remains consistent.
  yield* advance(sessionID, result.snapshot)
  yield* EventV2.run(sync, SessionEvent.ContextUpdated.Sync, {
    sessionID,
    messageID: SessionEvent.messageID(MessageID.ascending()),
    timestamp: DateTime.makeUnsafe(Date.now()),
    text: result.text,
  })
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, delta: result.text }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sync = yield* SyncEvent.Service

    const initialize = Effect.fn("ContextEpoch.initialize")(function* (input: Input) {
      return yield* initializeOnce(input.sessionID, input.context)
    })

    const prepare = Effect.fn("ContextEpoch.prepare")(function* (input: Input) {
      return yield* prepareOnce(sync, input.sessionID, input.context)
    })

    const reset = Effect.fn("ContextEpoch.reset")(function* (sessionID: SessionID) {
      Database.use((db) =>
        db.delete(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, sessionID)).run(),
      )
    })

    return Service.of({ initialize, prepare, reset })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SyncEvent.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function initialize(input: Input) {
  return runPromise((svc) => svc.initialize(input))
}

export async function prepare(input: Input) {
  return runPromise((svc) => svc.prepare(input))
}

export async function reset(sessionID: SessionID) {
  return runPromise((svc) => svc.reset(sessionID))
}

export * as ContextEpoch from "./context-epoch"
