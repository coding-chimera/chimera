import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const Message = EventV2.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventV2.define({
  type: "test.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

// Trunk event service over an isolated per-run db file (temp dir + dedicated
// chimera-v2 test filename; never the production fork chimera.db).
const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())
const dbLayer = Database.layerFromPath(path.join(tmp.path, "chimera-v2-trunk-event.db"))
const it = testEffect(Layer.merge(dbLayer, EventV2.layerWith().pipe(Layer.provide(dbLayer))))

describe("EventV2 trunk", () => {
  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("omits location when no location service is bound (minimal seam)", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(Message, { text: "hello" })
      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.message")
    }),
  )

  it.effect("commits durable events with monotonic per-aggregate sequences", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      const first = yield* events.publish(SyncMessage, { id: aggregateID, text: "one" })
      const second = yield* events.publish(SyncMessage, { id: aggregateID, text: "two" })
      expect(first.durable).toMatchObject({ aggregateID, seq: 0, version: 1 })
      expect(second.durable).toMatchObject({ aggregateID, seq: 1, version: 1 })

      const sequence = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)
      expect(sequence).toMatchObject({ aggregate_id: aggregateID, seq: 1 })

      const stored = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      expect(stored.map((row) => [row.seq, row.type])).toEqual([
        [0, "test.sync.1"],
        [1, "test.sync.1"],
      ])
    }),
  )

  it.effect("runs projectors and commit hooks inside the durable transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const aggregateID = EventV2.ID.create()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(`projector:${event.data.text}`)
        }),
      )

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        { commit: (seq) => Effect.sync(() => void received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector:hello", "commit:0"])
    }),
  )

  it.effect("removes every durable row of an aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "one" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "two" })

      yield* events.remove(aggregateID)

      const remaining = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequences = yield* db
        .select({ aggregate: EventSequenceTable.aggregate_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      expect(remaining).toEqual([])
      expect(sequences).toEqual([])
    }),
  )
})
