import { describe, expect, beforeEach, afterEach, afterAll } from "bun:test"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { SyncEvent } from "../../src/sync"
import { Database } from "@/storage/db"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { MessageID } from "../../src/session/schema"
import { Flag } from "@opencode-ai/core/flag/flag"
import { initProjectors } from "../../src/server/projectors"
import { testEffect } from "../lib/effect"
import { EventV2 } from "../../src/v2/event"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Session } from "@/session/session"
import { eq } from "drizzle-orm"

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const it = testEffect(Layer.mergeAll(SyncEvent.defaultLayer, CrossSpawnSpawner.defaultLayer))

beforeEach(() => {
  Database.close()

  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(() => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
})

describe("SyncEvent", () => {
  function setup() {
    SyncEvent.reset()

    const Created = SyncEvent.define({
      type: "item.created",
      version: 1,
      aggregate: "id",
      schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
    })
    const Sent = SyncEvent.define({
      type: "item.sent",
      version: 1,
      aggregate: "item_id",
      schema: Schema.Struct({ item_id: Schema.String, to: Schema.String }),
    })

    SyncEvent.init({
      projectors: [SyncEvent.project(Created, () => {}), SyncEvent.project(Sent, () => {})],
    })

    return { Created, Sent }
  }

  function expectDefect<A, E, R>(effect: Effect.Effect<A, E, R>, pattern: RegExp) {
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(effect)
      if (exit._tag === "Success") throw new Error("Expected effect to fail")
      expect(String(exit.cause)).toMatch(pattern)
    })
  }

  afterAll(() => {
    SyncEvent.reset()
    initProjectors()
  })

  describe("run", () => {
    it.live(
      "inserts event row",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          const sync = yield* SyncEvent.Service
          yield* EventV2.run(sync, Created, { id: "evt_1", name: "first" })
          const rows = Database.use((db) => db.select().from(EventTable).all())
          expect(rows).toHaveLength(1)
          expect(rows[0].type).toBe("item.created.1")
          expect(rows[0].aggregate_id).toBe("evt_1")
        }),
      ),
    )

    it.live(
      "increments seq per aggregate",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          yield* SyncEvent.use.run(Created, { id: "evt_1", name: "first" })
          yield* SyncEvent.use.run(Created, { id: "evt_1", name: "second" })
          const rows = Database.use((db) => db.select().from(EventTable).all())
          expect(rows).toHaveLength(2)
          expect(rows[1].seq).toBe(rows[0].seq + 1)
        }),
      ),
    )

    it.live(
      "uses custom aggregate field from agg()",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Sent } = setup()
          yield* SyncEvent.use.run(Sent, { item_id: "evt_1", to: "james" })
          const rows = Database.use((db) => db.select().from(EventTable).all())
          expect(rows).toHaveLength(1)
          expect(rows[0].aggregate_id).toBe("evt_1")
        }),
      ),
    )

    it.live(
      "emits events",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          const events: Array<{
            type: string
            properties: { id: string; name: string }
          }> = []
          let resolve = () => {}
          const received = new Promise<void>((done) => {
            resolve = done
          })
          const dispose = Bus.subscribeAll((event) => {
            events.push(event)
            resolve()
          })
          try {
            yield* SyncEvent.use.run(Created, { id: "evt_1", name: "test" })
            yield* Effect.promise(() => received)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
              type: "item.created",
              properties: {
                id: "evt_1",
                name: "test",
              },
            })
          } finally {
            dispose()
          }
        }),
      ),
    )
  })

  describe("replay", () => {
    it.live(
      "inserts event from external payload",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const id = MessageID.ascending()
          yield* SyncEvent.use.replay({
            id: "evt_1",
            type: "item.created.1",
            seq: 0,
            aggregateID: id,
            data: { id, name: "replayed" },
          })
          const rows = Database.use((db) => db.select().from(EventTable).all())
          expect(rows).toHaveLength(1)
          expect(rows[0].aggregate_id).toBe(id)
        }),
      ),
    )

    it.live(
      "throws on sequence mismatch",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const id = MessageID.ascending()
          yield* SyncEvent.use.replay({
            id: "evt_1",
            type: "item.created.1",
            seq: 0,
            aggregateID: id,
            data: { id, name: "first" },
          })
          yield* expectDefect(
            SyncEvent.use.replay({
              id: "evt_1",
              type: "item.created.1",
              seq: 5,
              aggregateID: id,
              data: { id, name: "bad" },
            }),
            /Sequence mismatch/,
          )
        }),
      ),
    )

    it.live(
      "throws on unknown event type",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* expectDefect(
            SyncEvent.use.replay({
              id: "evt_1",
              type: "unknown.event.1",
              seq: 0,
              aggregateID: "x",
              data: {},
            }),
            /Unknown event type/,
          )
        }),
      ),
    )

    it.live(
      "replayAll accepts later chunks after the first batch",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          const id = MessageID.ascending()

          const one = yield* SyncEvent.use.replayAll([
            {
              id: "evt_1",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 0,
              aggregateID: id,
              data: { id, name: "first" },
            },
            {
              id: "evt_2",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 1,
              aggregateID: id,
              data: { id, name: "second" },
            },
          ])

          const two = yield* SyncEvent.use.replayAll([
            {
              id: "evt_3",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 2,
              aggregateID: id,
              data: { id, name: "third" },
            },
            {
              id: "evt_4",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 3,
              aggregateID: id,
              data: { id, name: "fourth" },
            },
          ])

          expect(one).toBe(id)
          expect(two).toBe(id)

          const rows = Database.use((db) => db.select().from(EventTable).all())
          expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
        }),
      ),
    )

    it.live(
      "claims unowned event sequence on replay with ownerID",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          const id = MessageID.ascending()

          yield* SyncEvent.use.replay(
            {
              id: "evt_1",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 0,
              aggregateID: id,
              data: { id, name: "owned" },
            },
            { publish: false, ownerID: "owner-1" },
          )

          const row = Database.use((db) =>
            db
              .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
              .from(EventSequenceTable)
              .get(),
          )
          expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
        }),
      ),
    )

    it.live(
      "ignores replay from a different owner after sequence is claimed",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          const id = MessageID.ascending()

          yield* SyncEvent.use.replay(
            {
              id: "evt_1",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 0,
              aggregateID: id,
              data: { id, name: "first" },
            },
            { publish: false, ownerID: "owner-1" },
          )
          yield* SyncEvent.use.replay(
            {
              id: "evt_2",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 1,
              aggregateID: id,
              data: { id, name: "ignored" },
            },
            { publish: false, ownerID: "owner-2" },
          )

          const events = Database.use((db) => db.select().from(EventTable).all())
          const sequence = Database.use((db) =>
            db
              .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
              .from(EventSequenceTable)
              .get(),
          )
          expect(events).toHaveLength(1)
          expect(events[0].id).toBe("evt_1")
          expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
        }),
      ),
    )
  })
})

describe("SyncEvent derived events", () => {
  const workspaceID = WorkspaceID.ascending("wrk_derive")
  // Same service combo as test/session/session.test.ts: bus events published
  // by the sync layer go through the shared standalone bus runtime, so
  // assertions use the module-level Bus subscribers.
  const sessionLayers = Layer.mergeAll(Session.defaultLayer, Bus.defaultLayer, SyncEvent.defaultLayer)
  const slotRules = [{ permission: "task", pattern: "*", action: "deny" as const }]

  const runInWorkspace = <A, E>(effect: Effect.Effect<A, E, never>, workspace: WorkspaceID) =>
    Effect.promise(() =>
      WorkspaceContext.provide({
        workspaceID: workspace,
        async fn() {
          return Effect.runPromise(effect)
        },
      }),
    )

  const capture = () => {
    const busEvents: Array<{ type: string }> = []
    const dispose = Bus.subscribeAll((event) => {
      busEvents.push(event)
    })
    const global: GlobalEvent[] = []
    const handler = (event: GlobalEvent) => global.push(event)
    GlobalBus.on("event", handler)
    return {
      busEvents,
      global,
      dispose() {
        dispose()
        GlobalBus.off("event", handler)
      },
    }
  }

  // These tests use the real session events and the globally installed server
  // projectors/deriveEvent (from test/preload.ts). They never reset or re-init
  // the sync module, so concurrently running test files in the shared process
  // never observe a partial projector map or a missing deriveEvent.
  it.live("run publishes the permission slot and its derived session.updated once each", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const sync = yield* SyncEvent.Service
        const info = yield* svc.create({})
        const captured = capture()
        try {
          yield* runInWorkspace(
            sync.run(Session.Event.PermissionSlot, {
              sessionID: info.id,
              rules: slotRules,
              timestamp: 1234,
            }),
            workspaceID,
          )
          // Macro-task settle: lets the async bus publish chain reach the
          // subscriber callbacks without holding a long real-time window.
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

          expect(captured.busEvents.map((event) => event.type).sort()).toEqual([
            "session.permission.slot",
            "session.updated",
          ])
          const syncs = captured.global.filter(
            (event) => event.payload.type === "sync" && event.payload.syncEvent.aggregateID === info.id,
          )
          expect(syncs.map((event) => event.payload.syncEvent.type).sort()).toEqual([
            "session.permission.slot.1",
            "session.updated.1",
          ])
          const slot = syncs.find((event) => event.payload.syncEvent.type === "session.permission.slot.1")
          const derived = syncs.find((event) => event.payload.syncEvent.type === "session.updated.1")
          for (const event of syncs) {
            expect(event.workspace).toBe(workspaceID)
            expect(event.payload.syncEvent.seq).toBe(slot!.payload.syncEvent.seq)
          }
          // Derived events carry an independent identity: they are never
          // replayed as source events, so they must not reuse the main
          // event id or look replayable.
          expect(slot?.payload.syncEvent.derived).toBeUndefined()
          expect(derived?.payload.syncEvent.derived).toBe(true)
          expect(derived?.payload.syncEvent.id).not.toBe(slot?.payload.syncEvent.id)
          expect(derived?.payload.syncEvent.data.info.permission).toEqual(slotRules)
          const rows = Database.use((db) =>
            db.select().from(EventTable).where(eq(EventTable.aggregate_id, info.id)).all(),
          )
          expect(rows.map((row) => row.type)).toEqual(["session.created.1", "session.permission.slot.1"])
        } finally {
          captured.dispose()
        }
      }).pipe(Effect.provide(sessionLayers)),
    ),
  )

  it.live("replay with publish emits the same main and derived events", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const sync = yield* SyncEvent.Service
        const info = yield* svc.create({})
        const captured = capture()
        try {
          yield* runInWorkspace(
            sync.replay(
              {
                id: "evt_slot",
                type: SyncEvent.versionedType(Session.Event.PermissionSlot.type, Session.Event.PermissionSlot.version),
                seq: 1,
                aggregateID: info.id,
                data: { sessionID: info.id, rules: slotRules, timestamp: 1234 },
              },
              { publish: true },
            ),
            workspaceID,
          )
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
          expect(captured.busEvents.map((event) => event.type).sort()).toEqual([
            "session.permission.slot",
            "session.updated",
          ])
          const syncs = captured.global.filter(
            (event) => event.payload.type === "sync" && event.payload.syncEvent.aggregateID === info.id,
          )
          expect(syncs.map((event) => event.payload.syncEvent.type).sort()).toEqual([
            "session.permission.slot.1",
            "session.updated.1",
          ])
          for (const event of syncs) {
            expect(event.workspace).toBe(workspaceID)
            expect(event.payload.syncEvent.seq).toBe(1)
          }
          const derived = syncs.find((event) => event.payload.syncEvent.type === "session.updated.1")
          expect(derived?.payload.syncEvent.derived).toBe(true)
          expect(derived?.payload.syncEvent.id).not.toBe("evt_slot")
        } finally {
          captured.dispose()
        }
      }).pipe(Effect.provide(sessionLayers)),
    ),
  )

  it.live("publish false emits nothing but still projects", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const sync = yield* SyncEvent.Service
        const info = yield* svc.create({})
        const captured = capture()
        try {
          yield* sync.run(
            Session.Event.PermissionSlot,
            { sessionID: info.id, rules: slotRules, timestamp: 1234 },
            { publish: false },
          )
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
          expect(captured.busEvents).toHaveLength(0)
          expect(
            captured.global.filter(
              (event) => event.payload.type === "sync" && event.payload.syncEvent.aggregateID === info.id,
            ),
          ).toHaveLength(0)
          const updated = yield* svc.get(info.id)
          expect(updated.permission).toEqual(slotRules)
          const rows = Database.use((db) =>
            db.select().from(EventTable).where(eq(EventTable.aggregate_id, info.id)).all(),
          )
          expect(rows.map((row) => row.type)).toEqual(["session.created.1", "session.permission.slot.1"])
        } finally {
          captured.dispose()
        }
      }).pipe(Effect.provide(sessionLayers)),
    ),
  )
})
