import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"
import { SessionDataPlane } from "@/session/data-plane"
import { tmpdir } from "../fixture/fixture"

function driver(
  finish: SessionDataPlane.SpoolFinish,
  onAppend?: (chunk: Uint8Array) => void,
): SessionDataPlane.SpoolDriver {
  return {
    contractInfo: () => ({ abiMajor: 1, abiMinor: 0, capabilities: ["tool-output.spool.v1"] }),
    spoolStart: () => 7,
    spoolAppend: async (_id, chunk) => {
      onAppend?.(chunk)
    },
    spoolFinish: async () => finish,
    spoolAbort: () => {},
  }
}

const finish: SessionDataPlane.SpoolFinish = {
  content: "a\nb",
  truncated: false,
  removed: 0,
  unit: "lines",
  totalBytes: 3,
  totalLines: 2,
}

afterEach(() => {
  SessionDataPlane.setSpoolDriverForTests(undefined)
  SessionDataPlane.setHistoryDriverForTests(undefined)
  SessionDataPlane.setWriterDriverForTests(undefined)
  SessionDataPlane.resetNativeHistoriesForTests()
})

describe("SessionDataPlane", () => {
  test("spoolChunks forwards chunks and finishes the handle", async () => {
    const chunks: number[] = []
    const result = await SessionDataPlane.spoolChunks(
      driver(finish, (chunk) => chunks.push(chunk.length)),
      { filePath: "/tmp/unused", maxLines: 10, maxBytes: 100, direction: "head" },
      SessionDataPlane.stringChunks("a\nb", 1),
    )
    expect(result).toEqual(finish)
    expect(chunks).toEqual([1, 1, 1])
  })

  test("spoolChunks aborts the handle when append fails", async () => {
    let aborted = false
    const failing = driver(finish)
    failing.spoolAppend = async () => {
      throw new Error("append failed")
    }
    failing.spoolAbort = () => {
      aborted = true
    }
    await expect(
      SessionDataPlane.spoolChunks(
        failing,
        { filePath: "/tmp/unused", maxLines: 10, maxBytes: 100, direction: "head" },
        [new Uint8Array([1])],
      ),
    ).rejects.toThrow("append failed")
    expect(aborted).toBe(true)
  })

  test("spoolChunks also aborts when finish fails", async () => {
    let aborted = false
    const failing = driver(finish)
    failing.spoolFinish = async () => {
      throw new Error("finish failed")
    }
    failing.spoolAbort = () => {
      aborted = true
    }
    await expect(
      SessionDataPlane.spoolChunks(
        failing,
        { filePath: "/tmp/unused", maxLines: 10, maxBytes: 100, direction: "head" },
        [],
      ),
    ).rejects.toThrow("finish failed")
    expect(aborted).toBe(true)
  })

  test("an explicitly injected driver is returned without native loading", () => {
    const injected = driver(finish)
    SessionDataPlane.setSpoolDriverForTests(injected)
    expect(SessionDataPlane.getSpoolDriver()).toBe(injected)
  })

  test("an explicitly injected history driver is returned without native loading", () => {
    const injected: SessionDataPlane.HistoryDriver = {
      historyNew: () => 1,
      historyRebuild: async () => 1,
      historyUpsertMessage: () => false,
      historyUpsertPart: () => false,
      historyRemoveMessage: () => true,
      historyRemovePart: () => true,
      historyHash: () => "hh1:test",
      historyCounts: () => ({ messages: 0, parts: 0 }),
      historyView: () => ({ historyHash: "hh1:test", json: "[]" }),
      historyCompactionView: () => ({ historyHash: "hh1:test", json: "[]", hasRemoteCompaction: false }),
      historyDrop: () => true,
    }
    SessionDataPlane.setHistoryDriverForTests(injected)
    expect(SessionDataPlane.getHistoryDriver()).toBe(injected)
  })
})

const native = SessionDataPlane.getWriterDriver()
const nativeTest = native ? test : test.skip

function requireNative() {
  if (!native) throw new Error("native session data addon unavailable")
  return native
}

function nativeDatabase(filePath: string) {
  const db = new Database(filePath)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);
    CREATE TABLE event (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, aggregate_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
  `)
  return db
}

describe("SessionDataPlane native writer", () => {
  nativeTest("commits rows idempotently and rebuilds the same history hash", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "writer.db")
    const db = nativeDatabase(dbPath)
    db.run("INSERT INTO session (id) VALUES ('ses_native')")
    const driver = requireNative()
    const options = { dbPath, sessionId: "ses_native", eventV2: false, workspaces: false }
    const handle = driver.writerNew(options)
    try {
      expect(() => driver.writerNew(options)).toThrow("writer already active")
      const message: SessionDataPlane.HistoryMessageInput = {
        id: "msg_a",
        timeCreated: 11,
        timeUpdated: 12,
        data: JSON.stringify({ role: "user" }),
      }
      expect((await driver.writerUpsertMessage(handle, message)).status).toBe("committed")
      expect((await driver.writerUpsertMessage(handle, message)).status).toBe("already_committed")
      await driver.writerUpsertMessage(handle, {
        ...message,
        timeCreated: 99,
        timeUpdated: 13,
        data: JSON.stringify({ role: "assistant" }),
      })
      const part: SessionDataPlane.HistoryPartInput = {
        id: "prt_a",
        messageId: "msg_a",
        timeCreated: 14,
        timeUpdated: 15,
        data: JSON.stringify({ type: "text", text: "hello" }),
      }
      await driver.writerUpsertPart(handle, part)
      await driver.writerUpsertPart(handle, { ...part, timeCreated: 100, timeUpdated: 16 })
      const messageRow = db.query("SELECT time_created, time_updated, data FROM message WHERE id = 'msg_a'").get() as {
        time_created: number
        time_updated: number
        data: string
      }
      expect(messageRow.time_created).toBe(11)
      expect(messageRow.time_updated).toBe(13)
      expect(JSON.parse(messageRow.data)).toEqual({ role: "assistant" })
      const partRow = db.query("SELECT message_id, time_created, time_updated FROM part WHERE id = 'prt_a'").get() as {
        message_id: string
        time_created: number
        time_updated: number
      }
      expect(partRow).toEqual({ message_id: "msg_a", time_created: 14, time_updated: 16 })
      const hash = await driver.writerHistoryHash(handle)
      const history = driver as SessionDataPlane.WriterDriver & SessionDataPlane.HistoryDriver
      const replica = await history.historyRebuild("ses_native", dbPath)
      expect(history.historyHash(replica)).toBe(hash)
      expect(history.historyCounts(replica)).toEqual({ messages: 1, parts: 1 })
      expect(history.historyDrop(replica)).toBe(true)
      await driver.writerRemovePart(handle, {
        partId: "prt_a",
        messageId: "msg_a",
        timeUpdated: 17,
      })
      await driver.writerRemoveMessage(handle, { messageId: "msg_a", timeUpdated: 18 })
      expect(db.query("SELECT count(*) AS count FROM message").get()).toEqual({ count: 0 })
      expect(db.query("SELECT count(*) AS count FROM part").get()).toEqual({ count: 0 })
      expect((await driver.writerRemoveMessage(handle, { messageId: "msg_a", timeUpdated: 19 })).status).toBe(
        "already_committed",
      )
    } finally {
      driver.writerDrop(handle)
      db.close()
    }
  })

  nativeTest("appends workspace events in order without persisting deltas", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "events.db")
    const db = nativeDatabase(dbPath)
    db.run("INSERT INTO session (id) VALUES ('ses_events')")
    const driver = requireNative()
    const handle = driver.writerNew({ dbPath, sessionId: "ses_events", eventV2: false, workspaces: true })
    try {
      const message: SessionDataPlane.HistoryMessageInput = {
        id: "msg_a",
        timeCreated: 1,
        timeUpdated: 2,
        data: JSON.stringify({ role: "user" }),
        eventId: "evt_message",
        eventData: JSON.stringify({ sessionID: "ses_events", info: { id: "msg_a" } }),
      }
      expect((await driver.writerUpsertMessage(handle, message)).aggregateSeq).toBe(0)
      expect((await driver.writerUpsertMessage(handle, message)).status).toBe("already_committed")
      const part: SessionDataPlane.HistoryPartInput = {
        id: "prt_a",
        messageId: "msg_a",
        timeCreated: 3,
        timeUpdated: 4,
        data: JSON.stringify({ type: "text", text: "hello" }),
        eventId: "evt_part",
        eventData: JSON.stringify({ sessionID: "ses_events", part: { id: "prt_a" }, time: 3 }),
      }
      expect((await driver.writerUpsertPart(handle, part)).aggregateSeq).toBe(1)
      expect(
        (
          await driver.writerRemovePart(handle, {
            partId: "prt_a",
            messageId: "msg_a",
            timeUpdated: 5,
            eventId: "evt_part_removed",
            eventData: JSON.stringify({ sessionID: "ses_events", messageID: "msg_a", partID: "prt_a" }),
          })
        ).aggregateSeq,
      ).toBe(2)
      expect(
        (
          await driver.writerRemoveMessage(handle, {
            messageId: "msg_a",
            timeUpdated: 6,
            eventId: "evt_message_removed",
            eventData: JSON.stringify({ sessionID: "ses_events", messageID: "msg_a" }),
          })
        ).aggregateSeq,
      ).toBe(3)
      const events = db.query("SELECT id, seq, type FROM event ORDER BY seq").all() as Array<{
        id: string
        seq: number
        type: string
      }>
      expect(events).toEqual([
        { id: "evt_message", seq: 0, type: "message.updated.1" },
        { id: "evt_part", seq: 1, type: "message.part.updated.1" },
        { id: "evt_part_removed", seq: 2, type: "message.part.removed.1" },
        { id: "evt_message_removed", seq: 3, type: "message.removed.1" },
      ])
      expect(events.some((event) => event.type.includes("delta"))).toBe(false)
      expect(db.query("SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_events'").get()).toEqual({ seq: 3 })
    } finally {
      driver.writerDrop(handle)
      db.close()
    }
  })

  nativeTest("arbitrates a real post-commit failure through the read-only probe", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "fault.db")
    const db = nativeDatabase(dbPath)
    db.run("INSERT INTO session (id) VALUES ('ses_fault')")
    const driver = requireNative()
    const handle = driver.writerNew({
      dbPath,
      sessionId: "ses_fault",
      eventV2: false,
      workspaces: false,
      failAfterCommit: true,
    })
    const input: SessionDataPlane.HistoryMessageInput = {
      id: "msg_fault",
      timeCreated: 10,
      timeUpdated: 11,
      data: JSON.stringify({ role: "user" }),
    }
    try {
      await expect(driver.writerUpsertMessage(handle, input)).rejects.toThrow("injected post-commit failure")
      expect((await driver.writerProbeMessage(handle, input)).status).toBe("already_committed")
      expect(db.query("SELECT time_updated FROM message WHERE id = 'msg_fault'").get()).toEqual({ time_updated: 11 })
    } finally {
      driver.writerDrop(handle)
      db.close()
    }
  })
})

describe("SessionDataPlane native compaction view", () => {
  nativeTest("matches the bounded boundary and incrementally fences new writes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "compaction.db")
    const db = nativeDatabase(dbPath)
    const sessionID = "ses_compact"
    db.run("INSERT INTO session (id) VALUES (?)", [sessionID])
    const message = (id: string, created: number, data: Record<string, unknown>) => {
      db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
        id,
        sessionID,
        created,
        created,
        JSON.stringify(data),
      )
    }
    const part = (id: string, messageID: string, created: number, data: Record<string, unknown>) => {
      db.query(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, messageID, sessionID, created, created, JSON.stringify(data))
    }
    const user = (id: string, created: number) => message(id, created, { role: "user", time: { created } })
    user("msg_u1", 1)
    message("msg_a1", 2, { role: "assistant", parentID: "msg_u1", time: { created: 2 } })
    user("msg_ut", 3)
    message("msg_at", 4, { role: "assistant", parentID: "msg_ut", time: { created: 4 } })
    user("msg_uc", 5)
    message("msg_summary", 6, {
      role: "assistant",
      parentID: "msg_uc",
      summary: true,
      finish: "stop",
      time: { created: 6 },
    })
    part("prt_compaction", "msg_uc", 5, { type: "compaction", auto: true, tail_start_id: "msg_ut" })
    part("prt_tool", "msg_at", 4, {
      type: "tool",
      state: {
        status: "completed",
        output: "SECRET",
        time: { compacted: 1 },
        attachments: [{ type: "file", url: "data:image/png;base64,AA==" }],
      },
    })

    try {
      const first = await SessionDataPlane.readNativeCompaction(dbPath, sessionID, "local")
      if (!first) throw new Error("compaction view unavailable")
      const messages = JSON.parse(first.json) as Array<{
        info: { id: string }
        parts: Array<{ state?: { output?: string; attachments?: unknown[] } }>
      }>
      expect(messages.map((item) => item.info.id)).toEqual(["msg_uc", "msg_summary", "msg_ut", "msg_at"])
      expect(first.hasRemoteCompaction).toBe(false)
      expect(messages[3]?.parts[0]?.state?.output).toBe("[Old tool result content cleared]")
      expect(messages[3]?.parts[0]?.state?.attachments).toBeUndefined()

      const created = 7
      message("msg_new", created, { role: "user", time: { created } })
      expect(
        await SessionDataPlane.recordNativeMessage(dbPath, sessionID, {
          id: "msg_new",
          timeCreated: created,
          timeUpdated: created,
          data: JSON.stringify({ role: "user", time: { created } }),
        }),
      ).toBe(true)
      const second = await SessionDataPlane.readNativeCompaction(dbPath, sessionID, "local")
      if (!second) throw new Error("incremental compaction view unavailable")
      expect(second.historyHash).not.toBe(first.historyHash)
      expect((JSON.parse(second.json) as Array<{ info: { id: string } }>).map((item) => item.info.id)).toEqual([
        "msg_uc",
        "msg_summary",
        "msg_ut",
        "msg_at",
        "msg_new",
      ])
      expect(await SessionDataPlane.readNativeCompaction(dbPath, sessionID, "local", first.historyHash)).toBeUndefined()
      const rebuilt = await SessionDataPlane.readNativeCompaction(dbPath, sessionID, "local")
      expect(rebuilt?.historyHash).toBe(second.historyHash)
    } finally {
      SessionDataPlane.resetNativeHistoriesForTests()
      db.close()
    }
  })
})

describe("SessionDataPlane history lifecycle", () => {
  test("drops a native handle whose rebuild was invalidated before completion", async () => {
    let complete!: (handle: number) => void
    const rebuilding = new Promise<number>((resolve) => {
      complete = resolve
    })
    const dropped: number[] = []
    const driver: SessionDataPlane.HistoryDriver = {
      historyNew: () => 1,
      historyRebuild: () => rebuilding,
      historyUpsertMessage: () => true,
      historyUpsertPart: () => true,
      historyRemoveMessage: () => true,
      historyRemovePart: () => true,
      historyHash: () => "hh1:test",
      historyCounts: () => ({ messages: 0, parts: 0 }),
      historyView: () => ({ historyHash: "hh1:test", json: "[]" }),
      historyCompactionView: () => ({ historyHash: "hh1:test", json: "[]", hasRemoteCompaction: false }),
      historyDrop: (id) => {
        dropped.push(id)
        return true
      },
    }
    SessionDataPlane.setHistoryDriverForTests(driver)
    const pending = SessionDataPlane.readNativeCompaction("/tmp/rebuild-race.db", "ses_race", "local")
    await Promise.resolve()
    SessionDataPlane.resetNativeHistoriesForTests()
    complete(11)
    expect(await pending).toBeUndefined()
    expect(dropped).toEqual([11])
  })
})
