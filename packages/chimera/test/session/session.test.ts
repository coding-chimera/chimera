import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "@/session/session"
import { Bus } from "../../src/bus"
import * as Log from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { Permission } from "@/permission"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@/storage/db"
import { SyncEvent } from "@/sync"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { Flag } from "@opencode-ai/core/flag/flag"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

function recordUsage(input: { sessionID: SessionID; tokens: MessageV2.TokenUsage; cost: number; modelContextWindow?: number }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.recordUsage(input)))
}

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.path).toBe(info.path)
        expect(receivedInfo?.title).toBe(info.title)

        await remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await remove(info.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})

          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
          // is the mutable domain type. Cast bridges the two — safe because the
          // test only reads the value afterwards.
          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part as MessageV2.Part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await WithInstance.provide({
      directory: tmp.path,
      fn: () => create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await remove(info.id)
    }).not.toThrow()

    let missing = false
    await get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })


  test("recordUsage persists total and last token usage", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await create({})

        await recordUsage({
          sessionID: info.id,
          tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 2, write: 3 } },
          cost: 0.01,
          modelContextWindow: 1000,
        })
        await recordUsage({
          sessionID: info.id,
          tokens: { total: 50, input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
          cost: 0.02,
        })

        expect((await get(info.id)).usage).toEqual({
          total: {
            total: 155,
            input: 110,
            output: 24,
            reasoning: 6,
            cache: { read: 12, write: 3 },
          },
          last: {
            total: 135,
            input: 100,
            output: 20,
            reasoning: 5,
            cache: { read: 10, write: 0 },
          },
          modelContextWindow: 1000,
          cost: {
            total: 0.03,
            last: 0.02,
          },
        })

        await remove(info.id)
      },
    })
  })
})

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Bus.defaultLayer, SyncEvent.defaultLayer))

describe("Session.updatePermissionSlots", () => {
  const taskAllow: Permission.Rule = { permission: "task", pattern: "*", action: "allow" }
  const taskDeny: Permission.Rule = { permission: "task", pattern: "*", action: "deny" }
  const bashAllow: Permission.Rule = { permission: "bash", pattern: "*", action: "allow" }
  const editAllow: Permission.Rule = { permission: "edit", pattern: "*.ts", action: "allow" }
  const sorted = (rules: Permission.Ruleset) =>
    rules.slice().sort((a, b) => a.permission.localeCompare(b.permission) || a.pattern.localeCompare(b.pattern))

  it.instance("replaces an existing slot and Permission.evaluate reflects it", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({ permission: [taskAllow] })
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([taskDeny])
      expect(Permission.evaluate("task", "*", updated.permission ?? []).action).toBe("deny")
    }),
  )

  it.instance("deny-then-allow regression collapses to a single deny slot", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({ permission: [taskDeny, taskAllow] })
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([taskDeny])
      expect(Permission.evaluate("task", "*", updated.permission ?? []).action).toBe("deny")
    }),
  )

  it.instance("preserves unrelated rules and their relative order, appending the new slot", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({ permission: [bashAllow, editAllow] })
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([bashAllow, editAllow, taskDeny])
    }),
  )

  it.instance("normalizes duplicate input slots deterministically (last wins)", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      yield* svc.updatePermissionSlots({
        sessionID: info.id,
        rules: [taskDeny, bashAllow, taskAllow],
      })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([taskAllow, bashAllow])
      expect(Permission.evaluate("task", "*", updated.permission ?? []).action).toBe("allow")
      expect(Permission.evaluate("bash", "*", updated.permission ?? []).action).toBe("allow")
    }),
  )

  it.instance("repeated identical updates are idempotent", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      const input = { sessionID: info.id, rules: [taskDeny, bashAllow, taskAllow] }
      yield* svc.updatePermissionSlots(input)
      yield* svc.updatePermissionSlots(input)
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([taskAllow, bashAllow])
      expect(Permission.evaluate("task", "*", updated.permission ?? []).action).toBe("allow")
      expect(Permission.evaluate("bash", "*", updated.permission ?? []).action).toBe("allow")
    }),
  )

  it.instance("concurrent disjoint slot updates both survive", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      yield* Effect.all(
        [
          svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] }),
          svc.updatePermissionSlots({ sessionID: info.id, rules: [bashAllow] }),
        ],
        { concurrency: "unbounded" },
      )
      const updated = yield* svc.get(info.id)
      const rules = updated.permission ?? []
      expect(sorted(rules)).toEqual(sorted([taskDeny, bashAllow]))
      expect(Permission.evaluate("task", "*", rules).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", rules).action).toBe("allow")
    }),
  )

  it.instance("fails with a typed NotFound error for a missing session", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const error = yield* Effect.flip(
        svc.updatePermissionSlots({ sessionID: SessionID.descending(), rules: [taskDeny] }),
      )
      expect(NotFoundError.isInstance(error)).toBe(true)
      expect(error.data.message).toContain("Session not found")
    }),
  )

  it.instance("empty rules are a no-op: no permission write and time.updated unchanged", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({ permission: [taskAllow] })
      const before = yield* svc.get(info.id)
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [] })
      const after = yield* svc.get(info.id)
      expect(after.permission).toEqual([taskAllow])
      expect(after.time.updated).toBe(before.time.updated)
    }),
  )

  it.instance("persists the serialized timestamp within the call window", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      const t0 = Date.now()
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
      const t1 = Date.now()
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([taskDeny])
      expect(updated.time.updated).toBeGreaterThanOrEqual(t0)
      expect(updated.time.updated).toBeLessThanOrEqual(t1)
    }),
  )

  it.instance("replays the stored permission slot event deterministically", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const sync = yield* SyncEvent.Service
      const info = yield* svc.create({})
      const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
      Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
      try {
        yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
        const after = yield* svc.get(info.id)
        const rows = Database.use((db) =>
          db.select().from(EventTable).where(eq(EventTable.aggregate_id, info.id)).all(),
        )
        const slot = rows.find((row) => row.type === "session.permission.slot.1")
        expect(slot).toBeDefined()
        // Rewind the aggregate's persisted events and diverge the permission state,
        // then replay the exact stored payload to prove replay determinism.
        yield* svc.setPermission({ sessionID: info.id, permission: [editAllow] })
        Database.transaction((tx) => {
          tx.delete(EventTable).where(eq(EventTable.aggregate_id, info.id)).run()
          tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, info.id)).run()
        })
        yield* sync.replayAll(
          [{ id: slot!.id, seq: 0, type: slot!.type, aggregateID: info.id, data: slot!.data }],
          { publish: false },
        )
        const replayed = yield* svc.get(info.id)
        expect(replayed.permission).toEqual([editAllow, taskDeny])
        expect(replayed.time.updated).toBe(after.time.updated)
      } finally {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
      }
    }),
  )

  it.instance("setPermission full replacement still works after the change", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      yield* svc.setPermission({ sessionID: info.id, permission: [taskAllow, bashAllow] })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([taskAllow, bashAllow])
    }),
  )

  it.instance("publishes a session.updated bus event reflecting the slot update", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const bus = yield* Bus.Service
      const info = yield* svc.create({})
      let payload: { sessionID: SessionID; info: SessionNs.Info } | undefined
      let resolve: () => void
      const received = new Promise<void>((done) => {
        resolve = done
      })
      const unsub = yield* bus.subscribeCallback(SessionNs.Event.Updated, (event) => {
        if (event.properties.info.id === info.id) {
          payload = event.properties as { sessionID: SessionID; info: SessionNs.Info }
          resolve()
        }
      })
      try {
        yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
        yield* Effect.promise(() => received)
        expect(payload).toBeDefined()
        expect(payload!.info.permission).toEqual([taskDeny])
      } finally {
        unsub()
      }
    }),
  )
})
