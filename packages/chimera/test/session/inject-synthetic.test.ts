import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
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

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function userMessage(sessionID: SessionID, text: string): MessageV2.User {
  void text
  return {
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: "build",
    model: ref,
  }
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
  }
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

describe("session.prompt.injectSynthetic", () => {
  it.live(
    "injects a synthetic user text message into an arbitrary target session (session-addressable) and auto-continues its loop",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const target = yield* sessions.create({ title: "Target" })
          const first = yield* sessions.updateMessage(userMessage(target.id, "first"))
          yield* sessions.updateMessage(assistantMessage(target.id, first.id))
          yield* llm.text("target-echo")

          const result = yield* prompt.injectSynthetic({ sessionID: target.id, text: "background-result" })

          expect(result.info.role).toBe("assistant")
          const msgs = yield* sessions.messages({ sessionID: target.id, limit: 10 })
          const injected = syntheticTextParts(msgs).find((part) => part.text === "background-result")
          expect(injected).toBeDefined()
          expect(plainTexts(msgs)).toContain("target-echo")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live(
    "injection into a target busy with a running loop persists the message, joins the running run, and the run consumes the injected turn",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Busy" })
          const first = yield* sessions.updateMessage(userMessage(chat.id, "first"))
          yield* sessions.updateMessage(assistantMessage(chat.id, first.id))

          const gate = defer<void>()
          yield* llm.hold("first-reply", gate.promise)
          yield* llm.text("notify-reply")

          const running = yield* prompt
            .prompt({ sessionID: chat.id, parts: [{ type: "text", text: "first" }] })
            .pipe(Effect.forkScoped)
          yield* llm.wait(1)

          // Target is busy: the injected user message lands in storage and the
          // loop call joins the in-flight run instead of scheduling a dupe.
          const injected = yield* prompt
            .injectSynthetic({ sessionID: chat.id, text: "background-result" })
            .pipe(Effect.forkScoped)
          yield* Effect.sleep(100)
          const whileBusy = yield* sessions.messages({ sessionID: chat.id, limit: 10 })
          expect(syntheticTextParts(whileBusy).some((part) => part.text === "background-result")).toBe(true)

          gate.resolve()
          const firstExit = yield* Fiber.join(running)
          const injectedExit = yield* Fiber.join(injected)
          expect(firstExit.info.role).toBe("assistant")
          expect(injectedExit.info.role).toBe("assistant")

          const final = yield* sessions.messages({ sessionID: chat.id, limit: 10 })
          expect(plainTexts(final)).toContain("first-reply")
          expect(plainTexts(final)).toContain("notify-reply")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live("injection into a missing target errors without disturbing the caller session", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        void dir
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const caller = yield* sessions.create({ title: "Caller" })
        const first = yield* sessions.updateMessage(userMessage(caller.id, "caller"))
        yield* sessions.updateMessage(assistantMessage(caller.id, first.id))

        const exit = yield* prompt
          .injectSynthetic({ sessionID: SessionID.make("ses_ghost"), text: "hello" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false)

        const distracted = yield* prompt
          .injectSynthetic({ sessionID: caller.id, text: "notice" })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(distracted)).toBe(true)
      }),
      { config: (url) => testProviderConfig(url) },
    ),
  )

  it.live(
    "injection into a removed session is a typed failure (not a defect) and the notify-shaped swallow completes quietly",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir }) {
          void dir
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Doomed" })
          const first = yield* sessions.updateMessage(userMessage(chat.id, "bye"))
          yield* sessions.updateMessage(assistantMessage(chat.id, first.id))
          yield* sessions.remove(chat.id)

          const direct = yield* prompt
            .injectSynthetic({ sessionID: chat.id, text: "late-result" })
            .pipe(Effect.exit)
          expect(Exit.isFailure(direct)).toBe(true)
          if (Exit.isFailure(direct)) expect(Cause.hasDies(direct.cause)).toBe(false)

          // The task tool notify arm swallows the whole cause (failure or defect)
          // and logs it; the fiber must survive.
          const fiber = yield* prompt
            .injectSynthetic({ sessionID: chat.id, text: "late-result" })
            .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped)
          const outcome = yield* Fiber.join(fiber)
          expect(outcome).toBeUndefined()

          const alive = yield* sessions.create({ title: "Alive" })
          const second = yield* sessions.updateMessage(userMessage(alive.id, "still"))
          yield* sessions.updateMessage(assistantMessage(alive.id, second.id))
          const after = yield* prompt.injectSynthetic({ sessionID: alive.id, text: "notice" }).pipe(Effect.exit)
          expect(Exit.isSuccess(after)).toBe(true)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live(
    "injections on both sides of a compaction boundary keep message storage consistent and digest exactly once",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Compacting" })
          const first = yield* sessions.updateMessage(userMessage(chat.id, "turn a"))
          yield* sessions.updateMessage(assistantMessage(chat.id, first.id))
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: first.id,
            sessionID: chat.id,
            type: "compaction",
            auto: false,
          })

          const gate1 = defer<void>()
          const gate2 = defer<void>()
          yield* llm.hold("compact-summary", gate1.promise)
          yield* llm.hold("post-compact-reply", gate2.promise)
          yield* llm.text("final-reply")

          const running = yield* prompt
            .prompt({ sessionID: chat.id, parts: [{ type: "text", text: "turn a" }] })
            .pipe(Effect.forkScoped)

          // Wait for the compaction summary request to be in flight.
          yield* llm.wait(1)

          // Injection lands while the loop is inside compaction.process (pre-boundary).
          const injectedBefore = yield* prompt
            .injectSynthetic({ sessionID: chat.id, text: "before-boundary" })
            .pipe(Effect.forkScoped)
          let persisted = false
          for (let i = 0; i < 200 && !persisted; i++) {
            const msgs = yield* sessions.messages({ sessionID: chat.id, limit: 20 })
            persisted = msgs.some((msg) =>
              msg.parts.some((p) => p.type === "text" && p.synthetic === true && p.text === "before-boundary"),
            )
            if (!persisted) yield* Effect.sleep(10)
          }
          if (!persisted) return yield* Effect.fail(new Error("injected before-boundary message never persisted"))

          gate1.resolve()
          // Wait for the post-compaction digest turn to be in flight.
          yield* llm.wait(2)

          // Injection lands after the compaction boundary, while the digest turn is in flight.
          const injectedAfter = yield* prompt
            .injectSynthetic({ sessionID: chat.id, text: "after-boundary" })
            .pipe(Effect.forkScoped)

          gate2.resolve()
          const result = yield* Fiber.join(running)
          expect(result.info.role).toBe("assistant")

          const all = yield* sessions.messages({ sessionID: chat.id, limit: 30 })
          const countOf = (text: string) =>
            all
              .flatMap((msg) => msg.parts)
              .filter((p): p is MessageV2.TextPart => p.type === "text" && p.text === text).length
          expect(countOf("before-boundary")).toBe(1)
          expect(countOf("after-boundary")).toBe(1)
          expect(countOf("compact-summary")).toBe(1)
          expect(countOf("post-compact-reply")).toBe(1)
          expect(countOf("final-reply")).toBe(1)

          yield* Fiber.join(injectedBefore)
          yield* Fiber.join(injectedAfter)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )
})