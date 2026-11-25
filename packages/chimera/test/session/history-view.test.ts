import { afterEach, describe, expect, test } from "bun:test"
import { NotFoundError } from "@/storage/storage"
import { Effect } from "effect"
import { SessionID, MessageID, PartID } from "@/contracts/session-ids"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SessionDataPlane } from "@/session/data-plane"
import { SessionHistoryView } from "@/session/history-view"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { AppRuntime } from "@/composition/app-runtime"
import { WithInstance } from "@/project/with-instance"
import path from "path"

const root = path.join(__dirname, "../..")
const sessionID = SessionID.descending("ses_history_view")

function viewDriver(json: string) {
  const state = { hash: "hh1:view", rebuilds: 0, drops: 0 }
  const view = { historyHash: state.hash, json, hasRemoteCompaction: false }
  const driver: SessionDataPlane.HistoryDriver = {
    historyNew: () => 1,
    historyRebuild: async () => {
      state.rebuilds += 1
      return 1
    },
    historyUpsertMessage: () => true,
    historyUpsertPart: () => true,
    historyRemoveMessage: () => true,
    historyRemovePart: () => true,
    historyHash: () => state.hash,
    historyCounts: () => ({ messages: 0, parts: 0 }),
    historyView: () => view,
    historyCompactionView: (_id, _mode, expected) => {
      if (expected && expected !== state.hash) throw new Error("revision conflict")
      return view
    },
    historyDrop: () => {
      state.drops += 1
      return true
    },
  }
  return { driver, state }
}

function arm(driver: SessionDataPlane.HistoryDriver | null) {
  const previous = {
    reader: process.env.CHIMERA_SESSION_DATA_READER,
    writer: process.env.CHIMERA_SESSION_DATA_WRITER,
    event: Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM,
    workspaces: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
  }
  process.env.CHIMERA_SESSION_DATA_READER = "1"
  process.env.CHIMERA_SESSION_DATA_WRITER = "1"
  Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = false
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = false
  SessionDataPlane.setWriterDriverForTests(null)
  SessionDataPlane.setHistoryDriverForTests(driver)
  return () => {
    if (previous.reader === undefined) delete process.env.CHIMERA_SESSION_DATA_READER
    else process.env.CHIMERA_SESSION_DATA_READER = previous.reader
    if (previous.writer === undefined) delete process.env.CHIMERA_SESSION_DATA_WRITER
    else process.env.CHIMERA_SESSION_DATA_WRITER = previous.writer
    Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = previous.event
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = previous.workspaces
    SessionDataPlane.setHistoryDriverForTests(undefined)
    SessionDataPlane.setWriterDriverForTests(undefined)
    SessionDataPlane.resetNativeHistoriesForTests()
  }
}

afterEach(() => {
  SessionDataPlane.setHistoryDriverForTests(undefined)
  SessionDataPlane.setWriterDriverForTests(undefined)
  SessionDataPlane.resetNativeHistoriesForTests()
})

describe("SessionHistoryView", () => {
  test("decodes fresh mutable views and enforces the exact hash fence", async () => {
    const message = {
      info: {
        id: MessageID.ascending("msg_view"),
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [
        {
          id: PartID.ascending("prt_view"),
          sessionID,
          messageID: MessageID.ascending("msg_view"),
          type: "text",
          text: "hello",
        },
      ],
    }
    const fixture = viewDriver(JSON.stringify([message]))
    const restore = arm(fixture.driver)
    try {
      const first = await Effect.runPromise(SessionHistoryView.readCompactionView({ sessionID }))
      expect(first?.messages).toHaveLength(1)
      expect(first?.historyHash).toBe("hh1:view")
      first?.messages.push(message as MessageV2.WithParts)
      const second = await Effect.runPromise(SessionHistoryView.readCompactionView({ sessionID }))
      expect(second?.messages).toHaveLength(1)
      expect(
        await Effect.runPromise(SessionHistoryView.readCompactionView({ sessionID, expectedHistoryHash: "hh1:stale" })),
      ).toBeUndefined()
      expect(fixture.state.drops).toBe(1)
      const rebuilt = await Effect.runPromise(SessionHistoryView.readCompactionView({ sessionID }))
      expect(rebuilt?.messages).toHaveLength(1)
      expect(fixture.state.rebuilds).toBe(2)
    } finally {
      restore()
    }
  })

  test("returns undefined for malformed native payloads", async () => {
    const fixture = viewDriver("{not-json")
    const restore = arm(fixture.driver)
    try {
      expect(await Effect.runPromise(SessionHistoryView.readCompactionView({ sessionID }))).toBeUndefined()
      expect(fixture.state.drops).toBe(1)
    } finally {
      restore()
    }
  })

  test("falls back to the legacy scan without a history driver", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const restore = arm(null)
        try {
          const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
          const actual = await Effect.runPromise(SessionHistoryView.scanCompactionView(session.id))
          const baseline = await Effect.runPromise(MessageV2.scanCompactedEffect(session.id))
          expect(actual.messages).toEqual(baseline.messages)
          expect(actual.hasRemoteCompaction).toBe(baseline.hasRemoteCompaction)
          expect(actual.historyHash).toBeUndefined()
          await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(session.id)))
        } finally {
          restore()
        }
      },
    })
  })
})

describe("Session writer to history view", () => {
  test("feeds a committed native message into the next hot read", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const fixture = viewDriver("[]")
        let recorded: SessionDataPlane.HistoryMessageInput | undefined
        fixture.driver.historyUpsertMessage = (_id, input) => {
          recorded = input
          return true
        }
        fixture.driver.historyCompactionView = () => ({
          historyHash: "hh1:view",
          json: recorded
            ? JSON.stringify([{ info: { ...JSON.parse(recorded.data), id: recorded.id, sessionID }, parts: [] }])
            : "[]",
          hasRemoteCompaction: false,
        })
        const restore = arm(fixture.driver)
        const committed: SessionDataPlane.WriterResult = { status: "committed", changed: true, historyHash: "hh1:view" }
        const writer: SessionDataPlane.WriterDriver = {
          writerNew: () => 7,
          writerHistoryHash: async () => "hh1:view",
          writerUpsertMessage: async () => committed,
          writerUpsertPart: async () => committed,
          writerRemoveMessage: async () => committed,
          writerRemovePart: async () => committed,
          writerProbeMessage: async () => committed,
          writerProbePart: async () => committed,
          writerProbeRemoveMessage: async () => committed,
          writerProbeRemovePart: async () => committed,
          writerCommitToolResult: async () => committed,
          writerCreateSession: async () => committed,
          writerPatchSession: async () => committed,
          writerDeleteSession: async () => committed,
          writerProbeCreateSession: async () => committed,
          writerProbePatchSession: async () => committed,
          writerProbeDeleteSession: async () => committed,
          writerDrop: () => true,
        }
        SessionDataPlane.setWriterDriverForTests(writer)
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        try {
          const msg = {
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            tools: {},
          } as unknown as MessageV2.Info
          await AppRuntime.runPromise(Session.Service.use((svc) => svc.updateMessage(msg)))
          expect(recorded?.id).toBe(msg.id)
          const view = await Effect.runPromise(SessionHistoryView.readCompactionView({ sessionID: session.id }))
          expect(view?.messages.map((item) => item.info.id)).toEqual([msg.id])
          expect(view?.historyHash).toBe("hh1:view")
        } finally {
          restore()
          await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(session.id))).catch((error) => {
            if (error instanceof NotFoundError) return
            throw error
          })
        }
      },
  })
})
})
