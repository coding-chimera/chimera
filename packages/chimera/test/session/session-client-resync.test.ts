import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database } from "@/storage/db"
import { SessionTable } from "@/storage/tables/session.sql"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(makePromptHarness())

const allow = [{ permission: "*", pattern: "*", action: "allow" }] as const
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

function rowClient(id: Session.Info["id"]) {
  return Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())?.client
}

// Seed one completed turn so compaction has history to summarize, then stage a
// manual compaction the way the summarize route / v2 compact do.
const seedAndStage = (title: string, client: Session.Client) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* sessions.create({ title, client, permission: [...allow] })
    yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "hello" }] })
    yield* compaction.create({ sessionID: session.id, agent: "build", model, auto: false })
    return { session, prompt, sessions, compaction }
  })

describe("Session client compaction resync", () => {
  it.live("R1: a tui session compacted from webui adopts webui and the next turn uses the WebUI env", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, prompt, sessions } = yield* seedAndStage("R1", "tui")

          yield* prompt.loop({ sessionID: session.id, client: "webui" })

          expect((yield* sessions.get(session.id)).client).toBe("webui")
          expect(rowClient(session.id)).toBe("webui")

          yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "after" }] })
          expect(JSON.stringify((yield* llm.inputs).at(-1))).toContain("Chimera WebUI")
        }),
      { git: true, config: testProviderConfig },
    ),
  )

  it.live("R2: a compaction driven without a client leaves the frozen value untouched", () =>
    provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const { session, prompt, sessions } = yield* seedAndStage("R2", "tui")

          yield* prompt.loop({ sessionID: session.id })

          expect((yield* sessions.get(session.id)).client).toBe("tui")
          expect(rowClient(session.id)).toBe("tui")
        }),
      { git: true, config: testProviderConfig },
    ),
  )

  it.live("R3: a matching driving client is a no-op", () =>
    provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const { session, prompt, sessions } = yield* seedAndStage("R3", "tui")

          yield* prompt.loop({ sessionID: session.id, client: "tui" })

          // No client write happened. (time.updated cannot be asserted across
          // the compaction itself: the compaction window flag patches the row
          // and the schema's time_updated $onUpdate bumps it. The no-bump
          // invariant for the client write itself is R6.)
          expect((yield* sessions.get(session.id)).client).toBe("tui")
          expect(rowClient(session.id)).toBe("tui")
        }),
      { git: true, config: testProviderConfig },
    ),
  )

  it.live("R4: a failed compaction never resyncs the client", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, prompt, sessions } = yield* seedAndStage("R4", "tui")
          yield* llm.fail("compaction boom")

          yield* prompt.loop({ sessionID: session.id, client: "webui" }).pipe(Effect.exit)

          expect((yield* sessions.get(session.id)).client).toBe("tui")
          expect(rowClient(session.id)).toBe("tui")
        }),
      { git: true, config: testProviderConfig },
    ),
  )

  it.live("R5: a plain turn carrying a different client keeps the freeze", () =>
    provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "R5", client: "tui", permission: [...allow] })

          yield* prompt.prompt(
            { sessionID: session.id, agent: "build", parts: [{ type: "text", text: "hello" }] },
            "webui",
          )

          expect((yield* sessions.get(session.id)).client).toBe("tui")
          expect(rowClient(session.id)).toBe("tui")
        }),
      { git: true, config: testProviderConfig },
    ),
  )

  it.live("R6: updateClient writes only client; setTitle/touch still leave it alone", () =>
    provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "R6", client: "tui", permission: [...allow] })
          const before = (yield* sessions.get(session.id)).time.updated

          yield* sessions.updateClient!({ sessionID: session.id, client: "webui" })

          const updated = yield* sessions.get(session.id)
          expect(updated.client).toBe("webui")
          expect(updated.time.updated).toBe(before)
          expect(rowClient(session.id)).toBe("webui")

          yield* sessions.setTitle({ sessionID: session.id, title: "renamed" })
          yield* sessions.touch(session.id)
          expect((yield* sessions.get(session.id)).client).toBe("webui")
          expect(rowClient(session.id)).toBe("webui")
        }),
      { git: true, config: testProviderConfig },
    ),
  )

  it.live("R7: a webui session compacted from tui resyncs to tui", () =>
    provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const { session, prompt, sessions } = yield* seedAndStage("R7", "webui")

          yield* prompt.loop({ sessionID: session.id, client: "tui" })

          expect((yield* sessions.get(session.id)).client).toBe("tui")
          expect(rowClient(session.id)).toBe("tui")
        }),
      { git: true, config: testProviderConfig },
    ),
  )
})
