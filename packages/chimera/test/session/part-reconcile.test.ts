import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { WithInstance } from "../../src/project/with-instance"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/contracts/session-ids"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Log from "@opencode-ai/core/util/log"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { MessageTable, PartTable } from "../../src/storage/tables/session.sql"
import { StorageMaintenanceTable } from "../../src/storage/maintenance.sql"
import { SessionPartReconcile } from "../../src/session/part-reconcile"
import { SessionTurnLease } from "../../src/session/turn-lease"
import { SessionTurnLeaseTable } from "../../src/session/turn-lease.sql"

const root = path.join(__dirname, "../..")
void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

/** A pid that cannot exist on any supported platform, so kill(pid, 0) => ESRCH. */
const DEAD_PID = 2147483000

async function addUser(sessionID: SessionID) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  return id
}

/** Assistant message WITHOUT time.completed — the crash-leftover shape. */
async function addAssistant(sessionID: SessionID, parentID: MessageID) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return id
}

async function addToolPart(sessionID: SessionID, messageID: MessageID, state: MessageV2.ToolState) {
  const id = PartID.ascending()
  await svc.updatePart({
    id,
    sessionID,
    messageID,
    type: "tool",
    tool: "bash",
    callID: `call_${id}`,
    state,
  } as MessageV2.ToolPart)
  return id
}

async function addTextPart(sessionID: SessionID, messageID: MessageID, text: string) {
  const id = PartID.ascending()
  await svc.updatePart({ id, sessionID, messageID, type: "text", text })
  return id
}

function readPartState(sessionID: SessionID, partID: PartID): MessageV2.ToolState | undefined {
  const row = Database.use((db) =>
    db
      .select({ data: PartTable.data })
      .from(PartTable)
      .where(and(eq(PartTable.id, partID), eq(PartTable.session_id, sessionID)))
      .get(),
  )
  return (row?.data as { state?: MessageV2.ToolState } | undefined)?.state
}

function readMessageCompleted(sessionID: SessionID, messageID: MessageID): number | undefined {
  const row = Database.use((db) =>
    db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
      .get(),
  )
  return (row?.data as { time?: { completed?: number } } | undefined)?.time?.completed
}

function marker(sessionID: SessionID, bootID: string) {
  return Database.use((db) =>
    db
      .select()
      .from(StorageMaintenanceTable)
      .where(eq(StorageMaintenanceTable.key, SessionPartReconcile.markerKey(sessionID, bootID)))
      .get(),
  )
}

function markersFor(sessionID: SessionID) {
  const prefix = `part-orphan-reconcile:${sessionID}:`
  return Database.use((db) =>
    db.select().from(StorageMaintenanceTable).where(sql`${StorageMaintenanceTable.key} LIKE ${prefix + "%"}`).all(),
  ).filter((row) => row.key.startsWith(prefix))
}

function insertLease(sessionID: SessionID, input: { ownerBootID: string; ownerPID: number; expiresAt: number }) {
  Database.use((db) =>
    db
      .insert(SessionTurnLeaseTable)
      .values({
        session_id: sessionID,
        owner_boot_id: input.ownerBootID,
        owner_pid: input.ownerPID,
        acquired_at: Date.now(),
        expires_at: input.expiresAt,
      })
      .run(),
  )
}

function clearLease(sessionID: SessionID) {
  Database.use((db) => db.delete(SessionTurnLeaseTable).where(eq(SessionTurnLeaseTable.session_id, sessionID)).run())
}

const totalChanges = () => Database.use((db) => db.get(sql`select total_changes() as n`)) as { n: number }

/** The full crash residue: one assistant turn with running + pending tool parts and no time.completed. */
async function crashResidue(sessionID: SessionID) {
  const user = await addUser(sessionID)
  const assistant = await addAssistant(sessionID, user)
  const startedAt = Date.now() - 60_000
  const running = await addToolPart(sessionID, assistant, {
    status: "running",
    input: { command: "sleep 100" },
    metadata: { foo: "bar" },
    time: { start: startedAt },
  })
  const pending = await addToolPart(sessionID, assistant, {
    status: "pending",
    input: {},
    raw: "",
  })
  const text = await addTextPart(sessionID, assistant, "partial answer")
  const completed = await addToolPart(sessionID, assistant, {
    status: "completed",
    input: {},
    output: "done",
    title: "done",
    metadata: {},
    time: { start: startedAt, end: startedAt + 10 },
  })
  return { user, assistant, running, pending, text, completed, startedAt }
}

describe("SessionPartReconcile crash-orphan repair", () => {
  test("read path terminalizes orphaned tool parts and backfills assistant time.completed", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const residue = await crashResidue(session.id)

        // The read that triggers reconciliation must already return healed data.
        const paged = MessageV2.page({ sessionID: session.id, limit: 10 })
        const healed = paged.items.find((item) => item.info.id === residue.assistant)
        expect(healed).toBeDefined()

        const running = readPartState(session.id, residue.running)
        expect(running?.status).toBe("error")
        if (running?.status !== "error") throw new Error("expected error state")
        expect(running.error).toBe(SessionPartReconcile.ORPHAN_TOOL_ERROR)
        expect(running.metadata?.interrupted).toBe(true)
        // Pre-existing running metadata survives; the start time is preserved.
        expect(running.metadata?.foo).toBe("bar")
        expect(running.time.start).toBe(residue.startedAt)
        expect(running.time.end).toBeGreaterThanOrEqual(residue.startedAt)
        expect(running.input).toEqual({ command: "sleep 100" })

        const pending = readPartState(session.id, residue.pending)
        expect(pending?.status).toBe("error")
        if (pending?.status !== "error") throw new Error("expected error state")
        expect(pending.metadata?.interrupted).toBe(true)
        // A pending part never had a start time; errorToolPart semantics fall back to end.
        expect(pending.time.start).toBe(pending.time.end)

        const completed = readMessageCompleted(session.id, residue.assistant)
        expect(completed).toBeDefined()
        expect(completed!).toBeGreaterThanOrEqual(residue.startedAt)

        // Terminal parts and non-tool parts are untouched.
        const untouched = readPartState(session.id, residue.completed)
        expect(untouched?.status).toBe("completed")
        const textRow = Database.use((db) =>
          db.select({ data: PartTable.data }).from(PartTable).where(eq(PartTable.id, residue.text)).get(),
        )
        expect((textRow?.data as MessageV2.TextPart).text).toBe("partial answer")
        // The user message is untouched.
        expect(readMessageCompleted(session.id, residue.user)).toBeUndefined()

        expect(marker(session.id, SessionTurnLease.currentBootID())).toBeDefined()

        await svc.remove(session.id)
      },
    })
  })

  test("repeated reads are idempotent and perform no further writes", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const residue = await crashResidue(session.id)

        MessageV2.page({ sessionID: session.id, limit: 10 })
        const runningAfterFirst = readPartState(session.id, residue.running)

        const before = totalChanges().n
        MessageV2.page({ sessionID: session.id, limit: 10 })
        MessageV2.page({ sessionID: session.id, limit: 5 })
        MessageV2.get({ sessionID: session.id, messageID: residue.assistant })
        expect(Array.from(MessageV2.stream(session.id)).length).toBe(2)
        expect(totalChanges().n - before).toBe(0)
        expect(readPartState(session.id, residue.running)).toEqual(runningAfterFirst)

        await svc.remove(session.id)
      },
    })
  })

  test("a fresh boot rescans once and heals residue created after the previous scan", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await crashResidue(session.id)
        MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(markersFor(session.id)).toHaveLength(1)

        // Simulate a later crash (e.g. a sibling process died mid-turn) and a
        // process restart: the fresh boot id has no marker, so the first touch
        // rescans and heals.
        const lateAssistant = await addAssistant(session.id, await addUser(session.id))
        const latePart = await addToolPart(session.id, lateAssistant, {
          status: "running",
          input: {},
          time: { start: Date.now() },
        })
        MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(readPartState(session.id, latePart)?.status).toBe("running")

        SessionPartReconcile.ensureOrphansReconciled(session.id, { bootID: "boot_next_1" })
        expect(readPartState(session.id, latePart)?.status).toBe("error")
        expect(readMessageCompleted(session.id, lateAssistant)).toBeDefined()
        // The stale-boot marker was pruned; exactly one marker row remains.
        const markers = markersFor(session.id)
        expect(markers).toHaveLength(1)
        expect(markers[0].key).toBe(SessionPartReconcile.markerKey(session.id, "boot_next_1"))

        // The rescanned boot memoizes: an immediate rerun is a no-op.
        const before = totalChanges().n
        SessionPartReconcile.ensureOrphansReconciled(session.id, { bootID: "boot_next_1" })
        expect(totalChanges().n - before).toBe(0)

        await svc.remove(session.id)
      },
    })
  })

  test("skips while this process's runner is busy and retries after idle", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const residue = await crashResidue(session.id)
        SessionPartReconcile.markBusy(session.id)
        try {
          MessageV2.page({ sessionID: session.id, limit: 10 })
          // Live turn state is untouched and nothing is marked, so the next
          // read after idle retries.
          expect(readPartState(session.id, residue.running)?.status).toBe("running")
          expect(readMessageCompleted(session.id, residue.assistant)).toBeUndefined()
          expect(markersFor(session.id)).toHaveLength(0)
        } finally {
          SessionPartReconcile.markIdle(session.id)
        }

        MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(readPartState(session.id, residue.running)?.status).toBe("error")
        expect(readMessageCompleted(session.id, residue.assistant)).toBeDefined()
        expect(markersFor(session.id)).toHaveLength(1)

        await svc.remove(session.id)
      },
    })
  })

  test("skips while a foreign live process holds an unexpired lease", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const residue = await crashResidue(session.id)
        // Foreign boot id, but stamped with our own pid: while this process
        // runs no other process can hold the pid, so the probe counts it alive.
        insertLease(session.id, {
          ownerBootID: "boot_123_456",
          ownerPID: process.pid,
          expiresAt: Date.now() + 60_000,
        })
        try {
          MessageV2.page({ sessionID: session.id, limit: 10 })
          expect(readPartState(session.id, residue.running)?.status).toBe("running")
          expect(markersFor(session.id)).toHaveLength(0)
        } finally {
          clearLease(session.id)
        }

        MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(readPartState(session.id, residue.running)?.status).toBe("error")

        await svc.remove(session.id)
      },
    })
  })

  test("an unexpired lease whose owner is provably dead does not block reconciliation", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const residue = await crashResidue(session.id)
        insertLease(session.id, {
          ownerBootID: "boot_crashed_1",
          ownerPID: DEAD_PID,
          expiresAt: Date.now() + 30 * 60_000,
        })
        try {
          MessageV2.page({ sessionID: session.id, limit: 10 })
          expect(readPartState(session.id, residue.running)?.status).toBe("error")
          expect(readMessageCompleted(session.id, residue.assistant)).toBeDefined()
        } finally {
          clearLease(session.id)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("an expired foreign lease does not block reconciliation", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const residue = await crashResidue(session.id)
        insertLease(session.id, {
          ownerBootID: "boot_123_456",
          ownerPID: process.pid,
          expiresAt: Date.now() - 1,
        })
        try {
          MessageV2.page({ sessionID: session.id, limit: 10 })
          expect(readPartState(session.id, residue.running)?.status).toBe("error")
        } finally {
          clearLease(session.id)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("reconcileOrphansNow heals past the boot marker at turn start", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await crashResidue(session.id)
        MessageV2.page({ sessionID: session.id, limit: 10 })

        // A sibling process crashes mid-turn AFTER this process's boot marker
        // was written; the lazy read path memoizes and would never rescan.
        const assistant = await addAssistant(session.id, await addUser(session.id))
        const part = await addToolPart(session.id, assistant, {
          status: "running",
          input: {},
          time: { start: Date.now() },
        })
        MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(readPartState(session.id, part)?.status).toBe("running")

        // The turn-start path (SessionRunState onBusy, after lease acquire)
        // forces the scan without guards.
        SessionPartReconcile.reconcileOrphansNow(session.id)
        expect(readPartState(session.id, part)?.status).toBe("error")
        expect(readMessageCompleted(session.id, assistant)).toBeDefined()

        await svc.remove(session.id)
      },
    })
  })
})
