import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { and, eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, type SessionID } from "@/contracts/session-ids"
import { WithInstance } from "@/project/with-instance"
import { Database } from "@/storage/db"
import { MessageTable } from "@/storage/tables/session.sql"

const root = path.join(__dirname, "../..")
const layer = Layer.mergeAll(SessionSummary.defaultLayer, Session.defaultLayer)
const run = <A, E>(fx: Effect.Effect<A, E, Session.Service | SessionSummary.Service>) =>
  Effect.runPromise(fx.pipe(Effect.provide(layer)))

function storedSummary(sessionID: SessionID, messageID: MessageID) {
  return Database.use((db) =>
    db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
      .get(),
  )?.data.summary
}

function addUserSummary(sessionID: SessionID, summary?: MessageV2.User["summary"]) {
  return run(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const id = MessageID.ascending()
      yield* sessions.updateMessage({
        id,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
        ...(summary ? { summary } : {}),
      } as unknown as MessageV2.Info)
      return id
    }),
  )
}

function summarize(sessionID: SessionID, messageID: MessageID) {
  return run(
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      yield* summary.summarize({ sessionID, messageID })
    }),
  )
}

describe("SessionSummary.summarize", () => {
  test("does not persist message summary diffs", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            return yield* sessions.create({})
          }),
        )
        const messageID = await addUserSummary(session.id)

        expect(storedSummary(session.id, messageID)).toBeUndefined()

        await summarize(session.id, messageID)

        expect(storedSummary(session.id, messageID)).toBeUndefined()
      },
    })
  })

  test("leaves an existing summary body untouched", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            return yield* sessions.create({})
          }),
        )
        const summary = { title: "title", body: "body", diffs: [] }
        const messageID = await addUserSummary(session.id, summary)

        await summarize(session.id, messageID)

        expect(storedSummary(session.id, messageID)).toEqual(summary)
      },
    })
  })
})
