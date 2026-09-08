import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { BackgroundJob } from "@/agent/background-job"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
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

function runtimeContextParts(messages: MessageV2.WithParts[]) {
  return messages
    .flatMap((msg) => msg.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && Boolean(part.metadata?.runtimeContext))
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

const seedSession = Effect.fn("BgCtxTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Runtime background tasks" })
  const first = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updateMessage(assistantMessage(chat.id, first.id))
  return chat
})

const promptOnce = Effect.fn("BgCtxTest.promptOnce")(function* (sessionID: SessionID, text: string) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({
    sessionID,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text }],
  })
})

const startOwnedJob = Effect.fn("BgCtxTest.startOwnedJob")(function* (sessionID: SessionID, id: string) {
  const jobs = yield* BackgroundJob.Service
  yield* jobs.start({
    id,
    type: "task",
    title: "probe",
    metadata: {
      parentSessionId: sessionID,
      sessionId: id,
      model: { providerID: "test", modelID: "test-model", variant: "high" },
      background: true,
    },
    run: Effect.never,
  })
})

describe("session.prompt runtime context — Background Tasks section", () => {
  it.live(
    "emits no Background Tasks section and no extra bytes while nothing runs (byte stability)",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir }) {
          void dir
          const sessions = yield* Session.Service
          const chat = yield* seedSession()

          yield* promptOnce(chat.id, "first")
          const first = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(first).toHaveLength(1)
          expect(first[0]?.metadata?.runtimeContext.sections).not.toHaveProperty("backgroundTasks")
          expect(first[0]?.text).not.toContain("Background Tasks")

          // Another session owning a running job must not change this session's bytes.
          const other = yield* sessions.create({ title: "Other owner" })
          yield* startOwnedJob(other.id, "bg-other")
          yield* promptOnce(chat.id, "second")
          const unchanged = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(unchanged).toHaveLength(1)
          expect(unchanged[0]?.metadata?.runtimeContext.sections).not.toHaveProperty("backgroundTasks")

          const jobs = yield* BackgroundJob.Service
          yield* jobs.cancel("bg-other")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live(
    "emits a Background Tasks section only listing the session's own running jobs with task_id, title, elapsed, model, and guidance",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir }) {
          void dir
          const sessions = yield* Session.Service
          const chat = yield* seedSession()

          yield* promptOnce(chat.id, "first")
          const baseline = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(baseline).toHaveLength(1)
          expect(baseline[0]?.metadata?.runtimeContext.sections).not.toHaveProperty("backgroundTasks")

          yield* startOwnedJob(chat.id, "bg-own")
          const other = yield* sessions.create({ title: "Other owner" })
          yield* startOwnedJob(other.id, "bg-other")

          yield* promptOnce(chat.id, "second")
          const parts = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(parts).toHaveLength(2)
          expect(parts[1]?.metadata?.runtimeContext.kind).toBe("update")
          expect(parts[1]?.metadata?.runtimeContext.sections).toHaveProperty("backgroundTasks")
          expect(parts[1]?.text).toContain("## Background Tasks")
          expect(parts[1]?.text).toContain("task_id: bg-own")
          expect(parts[1]?.text).toContain("probe")
          expect(parts[1]?.text).toContain("running for")
          expect(parts[1]?.text).toContain("model: test/test-model @high")
          expect(parts[1]?.text).toContain("task_cancel")
          // Parent-session filter: another session's job is not listed.
          expect(parts[1]?.text).not.toContain("bg-other")

          // Cancelling the last owned job removes the section on the next update.
          const jobs = yield* BackgroundJob.Service
          yield* jobs.cancel("bg-own")
          yield* promptOnce(chat.id, "third")
          const after = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(after).toHaveLength(3)
          expect(after[2]?.metadata?.runtimeContext.sections).not.toHaveProperty("backgroundTasks")
          yield* jobs.cancel("bg-other")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live(
    "background kill-switch off keeps the runtime context byte-identical (no Background Tasks section even with a running own job)",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir }) {
          void dir
          const sessions = yield* Session.Service
          const chat = yield* seedSession()

          yield* startOwnedJob(chat.id, "bg-own")
          yield* promptOnce(chat.id, "first")
          const first = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(first).toHaveLength(1)
          expect(first[0]?.metadata?.runtimeContext.sections).not.toHaveProperty("backgroundTasks")
          expect(first[0]?.text).not.toContain("Background Tasks")
          expect(first[0]?.text).not.toContain("task_cancel")

          const jobs = yield* BackgroundJob.Service
          yield* jobs.cancel("bg-own")
        }),
        { git: true, config: (url) => ({ ...testProviderConfig(url), delegation: { background_subagents: false } }) },
      ),
  )
})