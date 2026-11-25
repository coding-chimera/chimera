import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "@/session/session"
import { Bus } from "../../src/bus"
import * as Log from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/contracts/session-ids"
import { AppRuntime } from "../../src/composition/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { Permission } from "@/permission"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@/storage/db"
import { SyncEvent } from "@/sync"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { SessionTable } from "@/storage/tables/session.sql"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { SessionDataPlane } from "@/session/data-plane"

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

function removeForCleanup(id: SessionID) {
  return remove(id).catch((error) => {
    if (error instanceof NotFoundError) return
    throw error
  })
}

const load = () => AppRuntime.runPromise(Config.Service.use((svc) => svc.get()))

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

function recordUsage(input: {
  sessionID: SessionID
  tokens: MessageV2.TokenUsage
  cost: number
  modelContextWindow?: number
}) {
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

        await removeForCleanup(info.id)
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

        await removeForCleanup(info.id)
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
          await removeForCleanup(info.id)
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
      await removeForCleanup(info.id)
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

        await removeForCleanup(info.id)
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
        yield* sync.replayAll([{ id: slot!.id, seq: 0, type: slot!.type, aggregateID: info.id, data: slot!.data }], {
          publish: false,
        })
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

  it.instance("publishes exactly one session.updated bus event reflecting the slot update", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      let payload: { sessionID: SessionID; info: SessionNs.Info } | undefined
      let count = 0
      let resolve: () => void
      const received = new Promise<void>((done) => {
        resolve = done
      })
      // Subscribe through the module-level Bus runtime: the sync layer's
      // derived publish also goes through the shared standalone runtime.
      const unsub = Bus.subscribe(SessionNs.Event.Updated, (event) => {
        if (event.properties.info.id === info.id) {
          count += 1
          payload = event.properties as { sessionID: SessionID; info: SessionNs.Info }
          resolve()
        }
      })
      try {
        yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [taskDeny] })
        yield* Effect.promise(() => received)
        yield* Effect.sleep("100 millis")
        expect(count).toBe(1)
        expect(payload).toBeDefined()
        expect(payload!.info.permission).toEqual([taskDeny])
        const updated = yield* svc.get(info.id)
        expect(payload!.info.time.updated).toBe(updated.time.updated)
      } finally {
        unsub()
      }
    }),
  )

  it.instance("keeps distinct rules whose NUL-joined keys collide", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      const left: Permission.Rule = { permission: "a", pattern: "\0b", action: "allow" }
      const right: Permission.Rule = { permission: "a\0", pattern: "b", action: "deny" }
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [left, right] })
      const updated = yield* svc.get(info.id)
      // Old NUL-joined keys both produced "a\0\0b", collapsing one rule.
      expect(updated.permission).toEqual([left, right])
    }),
  )

  it.instance("keeps a NUL-prefixed pattern distinct from a plain tuple", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      const plain: Permission.Rule = { permission: "a", pattern: "b", action: "allow" }
      const nul: Permission.Rule = { permission: "a\0", pattern: "b", action: "deny" }
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [plain, nul] })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([plain, nul])
    }),
  )

  it.instance("fully duplicate tuples collapse last-wins", () =>
    Effect.gen(function* () {
      const svc = yield* SessionNs.Service
      const info = yield* svc.create({})
      const allow: Permission.Rule = { permission: "a", pattern: "b", action: "allow" }
      const deny: Permission.Rule = { permission: "a", pattern: "b", action: "deny" }
      yield* svc.updatePermissionSlots({ sessionID: info.id, rules: [allow, deny] })
      const updated = yield* svc.get(info.id)
      expect(updated.permission).toEqual([deny])
    }),
  )

  it.instance(
    "survives NUL bytes loaded from a real config file",
    () =>
      Effect.gen(function* () {
        const svc = yield* SessionNs.Service
        const config = yield* Effect.promise(() => load())
        const ruleset = Permission.fromConfig(config.permission ?? {})
        expect(ruleset).toHaveLength(2)
        expect(Permission.evaluate("task\0sub", "agent", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "sub\0agent", ruleset).action).toBe("deny")

        const info = yield* svc.create({})
        yield* svc.updatePermissionSlots({ sessionID: info.id, rules: ruleset })
        const updated = yield* svc.get(info.id)
        expect(updated.permission).toHaveLength(2)
        expect(updated.permission).toEqual(ruleset)
      }),
    {
      config: {
        permission: {
          "task\0sub": { agent: "allow" },
          task: { "sub\0agent": "deny" },
        },
      },
    },
  )
})

function writerFixture(overrides: Partial<SessionDataPlane.WriterDriver> = {}) {
  const calls: Array<{ operation: string; input: unknown }> = []
  let opened = 0
  let dropped = 0
  const committed: SessionDataPlane.WriterResult = { status: "committed", changed: true }
  const record = (operation: string) => async (_id: number, input: unknown) => {
    calls.push({ operation, input })
    return committed
  }
  const driver: SessionDataPlane.WriterDriver = {
    writerNew: () => {
      opened += 1
      return 7
    },
    writerHistoryHash: async () => "hh1:test",
    writerUpsertMessage: record("message.upsert"),
    writerUpsertPart: record("part.upsert"),
    writerRemoveMessage: record("message.remove"),
    writerRemovePart: record("part.remove"),
    writerProbeMessage: record("message.probe"),
    writerProbePart: record("part.probe"),
    writerProbeRemoveMessage: record("message.remove-probe"),
    writerProbeRemovePart: record("part.remove-probe"),
    writerCommitToolResult: record("tool-result.commit"),
    writerCreateSession: async (_id, input) => {
      calls.push({ operation: "session.create", input })
      const info = JSON.parse(input.eventData!).info as SessionNs.Info
      await AppRuntime.runPromise(
        Effect.sync(() =>
          Database.use((db) =>
            db
              .insert(SessionTable)
              .values({
                id: info.id,
                project_id: info.projectID,
                workspace_id: info.workspaceID,
                parent_id: info.parentID,
                slug: info.slug,
                directory: info.directory,
                path: info.path,
                title: info.title,
                version: info.version,
                client: info.client,
                permission: info.permission,
                agent: info.agent,
                model: info.model,
                time_created: info.time.created,
                time_updated: info.time.updated,
              })
              .run(),
          ),
        ),
      )
      return committed
    },
    writerPatchSession: record("session.patch"),
    writerDeleteSession: record("session.delete"),
    writerProbeCreateSession: record("session.create-probe"),
    writerProbePatchSession: record("session.patch-probe"),
    writerProbeDeleteSession: record("session.delete-probe"),
    writerDrop: () => {
      dropped += 1
      return true
    },
    ...overrides,
  }
  return { driver, calls, opened: () => opened, dropped: () => dropped }
}

function testMessage(sessionID: SessionID): MessageV2.Info {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
  } as unknown as MessageV2.Info
}

function testTextPart(sessionID: SessionID, messageID: MessageID): MessageV2.TextPart {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text: "native writer",
  }
}

function armWriter(fixture: ReturnType<typeof writerFixture>) {
  const previous = {
    writer: process.env.CHIMERA_SESSION_DATA_WRITER,
    event: Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM,
    workspaces: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
  }
  process.env.CHIMERA_SESSION_DATA_WRITER = "1"
  Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = false
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = false
  SessionDataPlane.setWriterDriverForTests(fixture.driver)
  return () => {
    if (previous.writer === undefined) delete process.env.CHIMERA_SESSION_DATA_WRITER
    else process.env.CHIMERA_SESSION_DATA_WRITER = previous.writer
    Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = previous.event
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = previous.workspaces
    SessionDataPlane.setWriterDriverForTests(undefined)
  }
}

describe("Session native data writer", () => {
  test("routes upsert/remove through one writer and preserves bus payloads", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const fixture = writerFixture()
        const restore = armWriter(fixture)
        const info = await create({})
        const events: string[] = []
        const subscriptions = [
          Bus.subscribe(MessageV2.Event.Updated, (event) => {
            if (event.properties.sessionID === info.id) events.push("message.updated")
          }),
          Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            if (event.properties.sessionID === info.id) events.push("part.updated")
          }),
          Bus.subscribe(MessageV2.Event.PartRemoved, (event) => {
            if (event.properties.sessionID === info.id) events.push("part.removed")
          }),
          Bus.subscribe(MessageV2.Event.Removed, (event) => {
            if (event.properties.sessionID === info.id) events.push("message.removed")
          }),
        ]
        try {
          const msg = testMessage(info.id)
          const part = testTextPart(info.id, msg.id)
          await updateMessage(msg)
          await updatePart(part)
          await AppRuntime.runPromise(
            SessionNs.Service.use((svc) =>
              svc.removePart({
                sessionID: info.id,
                messageID: msg.id,
                partID: part.id,
              }),
            ),
          )
          await AppRuntime.runPromise(
            SessionNs.Service.use((svc) =>
              svc.removeMessage({
                sessionID: info.id,
                messageID: msg.id,
              }),
            ),
          )
          await new Promise((resolve) => setTimeout(resolve, 100))
          expect(fixture.opened()).toBe(1)
          expect(fixture.calls.map((call) => call.operation)).toEqual([
            "session.create",
            "message.upsert",
            "part.upsert",
            "part.remove",
            "message.remove",
          ])
          const messageInput = fixture.calls[1].input as SessionDataPlane.HistoryMessageInput
          expect(messageInput.timeCreated).toBe(msg.time.created)
          expect(JSON.parse(messageInput.data)).not.toHaveProperty("id")
          expect(JSON.parse(messageInput.data)).not.toHaveProperty("sessionID")
          const partInput = fixture.calls[2].input as SessionDataPlane.HistoryPartInput
          expect(partInput.messageId).toBe(msg.id)
          expect(JSON.parse(partInput.data)).toEqual({ type: "text", text: "native writer" })
          expect(events).toEqual(["message.updated", "part.updated", "part.removed", "message.removed"])
        } finally {
          for (const unsubscribe of subscriptions) unsubscribe()
          restore()
          await removeForCleanup(info.id)
        }
      },
    })
  })

  for (const flag of ["event", "workspaces"] as const) {
    test(`keeps legacy writer when ${flag} experiment is enabled`, async () => {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const fixture = writerFixture()
          const previous = process.env.CHIMERA_SESSION_DATA_WRITER
          const event = Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM
          const workspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
          process.env.CHIMERA_SESSION_DATA_WRITER = "1"
          if (flag === "event") Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = true
          else Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
          SessionDataPlane.setWriterDriverForTests(fixture.driver)
          const info = await create({})
          try {
            const msg = testMessage(info.id)
            const part = testTextPart(info.id, msg.id)
            await updateMessage(msg)
            await updatePart(part)
            const stored = await AppRuntime.runPromise(
              SessionNs.Service.use((svc) =>
                svc.getPart({
                  sessionID: info.id,
                  messageID: msg.id,
                  partID: part.id,
                }),
              ),
            )
            expect(stored).toEqual(part)
            expect(fixture.opened()).toBe(0)
          } finally {
            Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = event
            Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = workspaces
            if (previous === undefined) delete process.env.CHIMERA_SESSION_DATA_WRITER
            else process.env.CHIMERA_SESSION_DATA_WRITER = previous
            SessionDataPlane.setWriterDriverForTests(undefined)
            await removeForCleanup(info.id)
          }
        },
      })
    })
  }

  test("falls back before commit and arbitrates an unknown post-commit result without replay", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const before = writerFixture({
          writerUpsertMessage: async () => {
            throw new Error("pre-commit failure")
          },
          writerProbeMessage: async () => {
            throw new Error("not committed")
          },
        })
        const restoreBefore = armWriter(before)
        const first = await create({})
        try {
          const msg = testMessage(first.id)
          await updateMessage(msg)
          const stored = await AppRuntime.runPromise(
            SessionNs.Service.use((svc) => svc.messages({ sessionID: first.id })),
          )
          expect(stored.map((item) => item.info.id)).toEqual([msg.id])
          expect(before.dropped()).toBe(1)
        } finally {
          restoreBefore()
          await removeForCleanup(first.id)
        }

        const after = writerFixture({
          writerUpsertMessage: async () => {
            throw new Error("response lost after commit")
          },
          writerProbeMessage: async () => ({ status: "already_committed", changed: false }),
        })
        const restoreAfter = armWriter(after)
        const second = await create({})
        let published = 0
        const unsubscribe = Bus.subscribe(MessageV2.Event.Updated, (event) => {
          if (event.properties.sessionID === second.id) published += 1
        })
        try {
          const msg = testMessage(second.id)
          await updateMessage(msg)
          await new Promise((resolve) => setTimeout(resolve, 100))
          const stored = await AppRuntime.runPromise(
            SessionNs.Service.use((svc) => svc.messages({ sessionID: second.id })),
          )
          expect(stored).toHaveLength(0)
          expect(published).toBe(1)
          expect(after.dropped()).toBe(0)
        } finally {
          unsubscribe()
          restoreAfter()
          await removeForCleanup(second.id)
        }
      },
    })
  })

  test("does not republish an already committed retry", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const fixture = writerFixture({
          writerUpsertMessage: async () => ({ status: "already_committed", changed: false }),
        })
        const restore = armWriter(fixture)
        const info = await create({})
        let published = 0
        const unsubscribe = Bus.subscribe(MessageV2.Event.Updated, (event) => {
          if (event.properties.sessionID === info.id) published += 1
        })
        try {
          await updateMessage(testMessage(info.id))
          await new Promise((resolve) => setTimeout(resolve, 100))
          expect(published).toBe(0)
        } finally {
          unsubscribe()
          restore()
          await removeForCleanup(info.id)
        }
      },
    })
  })
})
