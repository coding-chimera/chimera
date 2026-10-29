import { describe, expect, test } from "bun:test"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { AppRuntime } from "../../src/composition/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { Session as SessionNs } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Database } from "@/storage/db"
import { SessionTable } from "@/storage/tables/session.sql"
import { MessageID, PartID, SessionID } from "../../src/contracts/session-ids"
import { MessageV2 } from "@/session/message-v2"
import { parseDuration } from "@/cli/cmd/session"
import { Snapshot } from "../../src/snapshot"

void Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")
const DAY = 86_400_000
const cutoff = () => Date.now() - 30 * DAY

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function prune(input: SessionNs.PruneInput) {
  return AppRuntime.runPromise(
    SessionNs.Service.use((svc) => {
      if (!svc.prune) throw new Error("Session prune is not available")
      return svc.prune(input)
    }),
  )
}

function setStatus(id: SessionID, status: SessionStatus.Info) {
  return AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.set(id, status)))
}

function backdate(id: SessionID, timeUpdated: number) {
  Database.use((d) => d.update(SessionTable).set({ time_updated: timeUpdated }).where(eq(SessionTable.id, id)).run())
}

async function addMessageWithPart(sessionID: SessionID) {
  const messageID = MessageID.ascending()
  await AppRuntime.runPromise(
    SessionNs.Service.use((svc) =>
      svc.updateMessage({
        id: messageID,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info),
    ),
  )
  await AppRuntime.runPromise(
    SessionNs.Service.use((svc) =>
      svc.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "text",
        text: "hello",
      }),
    ),
  )
}

const diffs = [
  {
    file: "file.txt",
    additions: 1,
    deletions: 0,
    status: "modified" as const,
    patch: "@@ -0,0 +1 @@\n+x\n",
  },
]

function writeDiff(sessionID: SessionID) {
  return AppRuntime.runPromise(Storage.Service.use((svc) => svc.write(["session_diff", sessionID], diffs)))
}

function readDiff(sessionID: SessionID) {
  return AppRuntime.runPromise(
    Storage.Service.use((svc) => svc.read<Snapshot.FileDiff[]>(["session_diff", sessionID])),
  )
}

describe("Session.prune", () => {
  test("dry run reports stats and deletes nothing", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await create({ title: "old session" })
        await addMessageWithPart(info.id)
        backdate(info.id, Date.now() - 40 * DAY)


        const result = await prune({ cutoff: cutoff(), dryRun: true })
        const candidate = result.sessions.find((session) => session.id === info.id)

        expect(result.dryRun).toBe(true)
        expect(candidate).toBeDefined()
        expect(candidate!.messages).toBe(1)
        expect(candidate!.parts).toBe(1)
        expect(candidate!.bytes).toBeGreaterThan(0)
        expect(result.totalMessages).toBeGreaterThanOrEqual(1)
        expect(result.removedSessions).toBe(0)
        expect(result.removedOrphanDiffs).toBe(0)
        // The session row is still there after a dry run.
        await expect(get(info.id)).resolves.toBeDefined()

        await remove(info.id)
      },
    })
  })

  test("--yes removes old sessions and keeps recent ones", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const old = await create({ title: "old" })
        const recent = await create({ title: "recent" })
        backdate(old.id, Date.now() - 40 * DAY)

        const result = await prune({ cutoff: cutoff(), dryRun: false })

        expect(result.sessions.map((session) => session.id)).toContain(old.id)
        expect(result.sessions.map((session) => session.id)).not.toContain(recent.id)
        expect(result.removedSessions).toBeGreaterThanOrEqual(1)
        await expect(get(old.id)).rejects.toThrow()
        await expect(get(recent.id)).resolves.toBeDefined()

        await remove(recent.id)
      },
    })
  })

  test("skips sessions that are active in this process", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const active = await create({ title: "active" })
        backdate(active.id, Date.now() - 40 * DAY)
        await setStatus(active.id, { type: "busy" })

        const result = await prune({ cutoff: cutoff(), dryRun: true })

        expect(result.sessions.map((session) => session.id)).not.toContain(active.id)
        expect(result.skippedActive).toBeGreaterThanOrEqual(1)
        await expect(get(active.id)).resolves.toBeDefined()

        await setStatus(active.id, { type: "idle" })
        await remove(active.id)
      },
    })
  })

  test("removes descendants of an old session even when they are newer", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await create({ title: "old parent" })
        const child = await create({ parentID: parent.id, title: "newer child" })
        await writeDiff(parent.id)
        await writeDiff(child.id)
        backdate(parent.id, Date.now() - 40 * DAY)

        const result = await prune({ cutoff: cutoff(), dryRun: false })

        expect(result.sessions.map((session) => session.id)).toContain(child.id)
        await expect(get(parent.id)).rejects.toThrow()
        await expect(get(child.id)).rejects.toThrow()
        await expect(readDiff(parent.id)).rejects.toThrow()
        await expect(readDiff(child.id)).rejects.toThrow()
      },
    })
  })

  test("GC removes orphan session_diff files without session rows", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const orphan = SessionID.make(`ses_orphan_${Math.random().toString(36).slice(2)}`)
        await writeDiff(orphan)

        // cutoff 0 selects no sessions, but a real run still sweeps orphans.
        const result = await prune({ cutoff: 0, dryRun: false })

        expect(result.sessions).toHaveLength(0)
        expect(result.removedOrphanDiffs).toBeGreaterThanOrEqual(1)
        await expect(readDiff(orphan)).rejects.toThrow()
      },
    })
  })
})

describe("parseDuration", () => {
  test("parses compact retention windows", () => {
    expect(parseDuration("30d")).toBe(30 * DAY)
    expect(parseDuration("12h")).toBe(12 * 3_600_000)
    expect(parseDuration("90m")).toBe(90 * 60_000)
    expect(parseDuration("2w")).toBe(14 * DAY)
    expect(parseDuration("3600s")).toBe(3_600_000)
  })

  test("rejects malformed windows", () => {
    expect(parseDuration("30")).toBeUndefined()
    expect(parseDuration("d30")).toBeUndefined()
    expect(parseDuration("30 days")).toBeUndefined()
    expect(parseDuration("")).toBeUndefined()
  })
})