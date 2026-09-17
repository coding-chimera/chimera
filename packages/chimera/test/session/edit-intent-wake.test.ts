import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Chimera } from "@/chimera"
import { EditIntentClaims } from "@/chimera/edit-intent"
import { readActiveEditIntentClaims, readEditIntentWaiters, releaseEditIntentClaims } from "@/chimera/store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { InstanceState } from "@/effect/instance-state"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(makePromptHarness())

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function userMessage(sessionID: SessionID): MessageV2.User {
  return {
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: "build",
    model: ref,
  } satisfies MessageV2.User
}

function assistantMessage(sessionID: SessionID, parentID: MessageID): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  } satisfies MessageV2.Assistant
}

function syntheticTextParts(msgs: MessageV2.WithParts[]) {
  return msgs.flatMap((msg) => msg.parts).filter((part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true)
}

function plainTexts(msgs: MessageV2.WithParts[]) {
  return msgs
    .filter((msg) => msg.info.role === "assistant")
    .flatMap((msg) => msg.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text)
}

// A fully initialized graph makes the claims DB reachable exactly like a
// production project; claim storage lives in the project codegraph.db.
const initGraph = Effect.fnUntraced(function* () {
  return yield* Chimera.initProjectGraph({ watch: false })
})

const projectRoot = Effect.fnUntraced(function* () {
  const instance = yield* InstanceState.context
  return instance.worktree === "/" ? instance.directory : instance.worktree
})

/** Poll the target session until the injected release notice AND the woken turn's reply are persisted. */
const pollWake = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: SessionID, reply: string) {
  for (let i = 0; i < 200; i++) {
    const msgs = yield* sessions.messages({ sessionID, limit: 20 })
    const wake = syntheticTextParts(msgs)
      .map((part) => part.text)
      .find((text) => text.includes("<edit_intent_release>"))
    const assistant = plainTexts(msgs)
    if (wake && assistant.includes(reply)) return { wake, assistant }
    yield* Effect.sleep(50)
  }
  return yield* Effect.fail(new Error(`wake notice or reply (${reply}) never arrived for ${sessionID}`))
})

/**
 * Seed a parked waiter session and arm the instance's release watcher: the
 * noReply prompt runs prompt()'s arming path without consuming a queued LLM
 * response or starting a loop.
 */
const seedWaiter = Effect.fnUntraced(function* (sessions: Session.Interface, title: string, reply: string, llm: { text: (value: string) => Effect.Effect<void> }) {
  const session = yield* sessions.create({ title })
  const first = yield* sessions.updateMessage(userMessage(session.id))
  yield* sessions.updateMessage(assistantMessage(session.id, first.id))
  yield* llm.text(reply)
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID: session.id, agent: "build", noReply: true, parts: [{ type: "text", text: "seed" }] })
  return session
})

describe("edit-intent claims L2 wake (release → inject)", () => {
  it.live(
    "holder run completion (idle) releases its claims and wakes the queued session with an injected release notice that auto-continues its loop",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          yield* initGraph()
          const root = yield* projectRoot()
          const sessions = yield* Session.Service
          const status = yield* SessionStatus.Service

          const holder = yield* sessions.create({ title: "Holder" })
          const waiter = yield* seedWaiter(sessions, "Waiter", "woken-echo", llm)

          yield* EditIntentClaims.registerFromPredesign({
            projectRoot: root,
            sessionID: holder.id,
            agent: "build",
            predesignID: "predesign_holder",
            intent: "holder refactor",
            files: ["shared.ts"],
          })
          const queued = yield* EditIntentClaims.registerFromPredesign({
            projectRoot: root,
            sessionID: waiter.id,
            agent: "build",
            predesignID: "predesign_waiter",
            intent: "waiter refactor",
            files: ["shared.ts"],
          })
          expect(queued.conflicts).toHaveLength(1)
          expect(queued.conflicts[0]!.holder.sessionID).toBe(holder.id)

          // The holder's run completes: idle transition drives release + wake.
          yield* status.set(holder.id, { type: "idle" })

          const { wake } = yield* pollWake(sessions, waiter.id, "woken-echo")
          expect(wake).toContain("<edit_intent_release>")
          expect(wake).toContain("shared.ts")
          expect(wake).toContain(holder.id)
          expect(wake).toContain("the holder's run completed")
          expect(wake).toContain("re-read each file's current content first")

          // Exactly-once bookkeeping and released state are persisted.
          const woken = yield* Effect.promise(() => readEditIntentWaiters(root, { sessionID: waiter.id, status: "woken" }))
          expect(woken).toHaveLength(1)
          expect(woken[0]!.filePath).toBe("shared.ts")
          const holderActive = yield* Effect.promise(() => readActiveEditIntentClaims(root, { sessionID: holder.id }))
          expect(holderActive).toHaveLength(0)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live("a session busy while its blocker released is drained and woken on its own idle transition", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        void dir
        yield* initGraph()
        const root = yield* projectRoot()
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        const holder = yield* sessions.create({ title: "Holder" })
        const waiter = yield* seedWaiter(sessions, "Waiter", "drained-echo", llm)
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: holder.id,
          agent: "build",
          predesignID: "predesign_holder",
          intent: "holder refactor",
          files: ["shared.ts"],
        })
        // The waiter registers through the mutation gate (a blocked edit) and
        // holds no claim of its own — so its idle transition releases nothing
        // and the wake can only come from the drain path.
        const conflicts = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: waiter.id,
          toolID: "edit",
          files: [{ absolutePath: `${root}/shared.ts`, graphPath: "shared.ts" }],
        })
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0]!.holder.sessionID).toBe(holder.id)

        // Model a release whose wake pass could not reach the busy waiter: the
        // raw store release leaves the waiter pending (no take, no inject).
        yield* Effect.promise(() => releaseEditIntentClaims(root, holder.id, "session_idle"))
        const stillWaiting = yield* Effect.promise(() => readEditIntentWaiters(root, { sessionID: waiter.id, status: "waiting" }))
        expect(stillWaiting).toHaveLength(1)

        // The waiter's own idle transition drains the freed entry and wakes it.
        yield* status.set(waiter.id, { type: "idle" })

        const { wake } = yield* pollWake(sessions, waiter.id, "drained-echo")
        expect(wake).toContain("<edit_intent_release>")
        expect(wake).toContain("shared.ts")
        // The drain path has no release reason attached.
        expect(wake).toContain("the holder finished")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("removing the holder session releases its claims and wakes queued sessions", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        void dir
        yield* initGraph()
        const root = yield* projectRoot()
        const sessions = yield* Session.Service

        const holder = yield* sessions.create({ title: "Holder" })
        const waiter = yield* seedWaiter(sessions, "Waiter", "removed-echo", llm)
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: holder.id,
          agent: "build",
          predesignID: "predesign_holder",
          intent: "holder refactor",
          files: ["shared.ts"],
        })
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: waiter.id,
          agent: "build",
          predesignID: "predesign_waiter",
          intent: "waiter refactor",
          files: ["shared.ts"],
        })

        yield* sessions.remove(holder.id)

        const { wake } = yield* pollWake(sessions, waiter.id, "removed-echo")
        expect(wake).toContain("<edit_intent_release>")
        expect(wake).toContain("the holder's session was removed")
        const holderActive = yield* Effect.promise(() => readActiveEditIntentClaims(root, { sessionID: holder.id }))
        expect(holderActive).toHaveLength(0)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )
})
