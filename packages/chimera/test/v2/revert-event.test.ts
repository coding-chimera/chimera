import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

// Bus publishing happens in a post-commit effect; give it a macro-task.
const settle = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

function captureRevertEvents() {
  const types: string[] = []
  const dispose = Bus.subscribeAll((event) => {
    if (String(event.type).startsWith("session.next.revert.")) types.push(event.type)
  })
  return { types, dispose }
}

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, dir: string) {
  const session = yield* Session.Service
  const userMsg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "default",
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: userMsg.id,
    sessionID,
    type: "text",
    text: "hello",
  })
  const assistantMsg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID: userMsg.id,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMsg.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return userMsg.id
})

describe("RevertEvent v2 emission", () => {
  it.live(
    "revert emits staged+committed and unrevert emits cleared when the flag is on",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          expect(Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM).toBe(true)
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const sessionID = (yield* session.create({})).id
          const messageID = yield* seed(sessionID, dir)

          const captured = captureRevertEvents()
          try {
            yield* revert.revert({ sessionID, messageID })
            yield* settle()
            expect(captured.types).toEqual(["session.next.revert.staged", "session.next.revert.committed"])

            const boundary = captured.types.length
            yield* revert.unrevert({ sessionID })
            yield* settle()
            expect(captured.types.slice(boundary)).toEqual(["session.next.revert.cleared"])
          } finally {
            captured.dispose()
          }
        }),
      { git: true },
    ),
  )

  it.live(
    "revert and unrevert emit nothing when the flag is off and V1 state still works",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const original = Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM
          Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = false
          try {
            const session = yield* Session.Service
            const revert = yield* SessionRevert.Service
            const sessionID = (yield* session.create({})).id
            const messageID = yield* seed(sessionID, dir)

            const captured = captureRevertEvents()
            try {
              yield* revert.revert({ sessionID, messageID })
              yield* settle()
              expect(captured.types).toEqual([])
              expect((yield* session.get(sessionID)).revert).toBeDefined()

              yield* revert.unrevert({ sessionID })
              yield* settle()
              expect(captured.types).toEqual([])
              expect((yield* session.get(sessionID)).revert).toBeUndefined()
            } finally {
              captured.dispose()
            }
          } finally {
            Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = original
          }
        }),
      { git: true },
    ),
  )
})
