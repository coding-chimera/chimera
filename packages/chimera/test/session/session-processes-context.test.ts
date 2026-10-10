import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Chimera } from "@/chimera"
import { ProcessRegistry } from "@/chimera/process-registry"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/contracts/session-ids"
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

const seedSession = Effect.fn("SProcCtxTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Runtime session processes" })
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

const promptOnce = Effect.fn("SProcCtxTest.promptOnce")(function* (sessionID: SessionID, text: string) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({
    sessionID,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text }],
  })
})

// A fully initialized graph makes the shared process-registry DB reachable exactly
// like a production project; the registry rows live in the project store DB.
const initGraph = Effect.fnUntraced(function* () {
  return yield* Chimera.initProjectGraph({ watch: false })
})

// Same resolution rule as the Session Processes builder in prompt.ts.
const projectRoot = Effect.fnUntraced(function* () {
  const instance = yield* InstanceState.context
  return instance.worktree === "/" ? instance.directory : instance.worktree
})

// Seed through the real registry surface (temp-DB store, no mocks). process.pid is
// provably alive, so the liveness sweep keeps the row running across turns.
const registerProcess = Effect.fn("SProcCtxTest.register")(function* (
  root: string,
  sessionID: SessionID,
  command: string,
  pgid?: number | null,
) {
  const entry = yield* Effect.promise(() =>
    ProcessRegistry.register({ projectRoot: root, sessionID, pid: process.pid, pgid, command }),
  )
  if (!entry) return yield* Effect.fail(new Error(`process registry refused to register "${command}"`))
  return entry
})

const markExited = Effect.fn("SProcCtxTest.markExited")(function* (root: string, id: string) {
  yield* Effect.promise(() => ProcessRegistry.markExited(root, id, 0))
})

describe("session.prompt runtime context — Session Processes section", () => {
  it.live(
    "emits no Session Processes section while nothing is registered (degrade-open store, byte stability)",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          const sessions = yield* Session.Service
          const chat = yield* seedSession()

          yield* promptOnce(chat.id, "first")
          const first = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(first).toHaveLength(1)
          expect(first[0]?.metadata?.runtimeContext.sections).not.toHaveProperty("sessionProcesses")
          expect(first[0]?.text).not.toContain("Session Processes")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live(
    "lists active processes with absolute timestamps and ownership, stays byte-stable across turns, and disappears when the set empties",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          yield* initGraph()
          const root = yield* projectRoot()
          const sessions = yield* Session.Service
          const chat = yield* seedSession()
          const other = yield* sessions.create({ title: "Other owner" })

          const own = yield* registerProcess(root, chat.id, "sleep 111", process.pid)
          const foreign = yield* registerProcess(root, other.id, "tail -f server.log")
          expect(foreign.pgid).toBeNull()

          yield* promptOnce(chat.id, "first")
          const parts = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(parts).toHaveLength(1)
          expect(parts[0]?.metadata?.runtimeContext.kind).toBe("snapshot")
          expect(parts[0]?.metadata?.runtimeContext.sections).toHaveProperty("sessionProcesses")
          const text = parts[0]?.text ?? ""
          expect(text).toContain("## Session Processes")
          // Exact line shape: absolute ISO timestamps only, ownership marked per session.
          expect(text).toContain(
            `- pid ${process.pid} pgid ${process.pid} "sleep 111" started_at ${own.startedAt} (this session)`,
          )
          expect(text).toContain(
            `- pid ${process.pid} pgid - "tail -f server.log" started_at ${foreign.startedAt} (session ${other.id})`,
          )
          expect(text).toContain(
            "These OS processes were spawned by Chimera sessions in this project via the bash tool. Do not kill another session's process; the bash tool blocks cross-session kills unless CHIMERA_KILL_CONFIRM=1 is set.",
          )
          // ANTI-CHURN: no relative times anywhere (would re-inject every turn).
          expect(text).not.toContain("ago")

          // Unchanged registry set → no new runtime-context message on the next turn.
          yield* promptOnce(chat.id, "second")
          const stable = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(stable).toHaveLength(1)

          // Emptying the registry removes the section entirely on the next update.
          yield* markExited(root, own.id)
          yield* markExited(root, foreign.id)
          yield* promptOnce(chat.id, "third")
          const after = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(after).toHaveLength(2)
          expect(after[1]?.metadata?.runtimeContext.sections).not.toHaveProperty("sessionProcesses")
          expect(after[1]?.text).not.toContain("## Session Processes")
          expect(after[1]?.text).toContain("sessionProcesses")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live(
    "caps the list at 10 lines in started_at order and appends a stable overflow line",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          yield* initGraph()
          const root = yield* projectRoot()
          const sessions = yield* Session.Service
          const chat = yield* seedSession()

          const commands = Array.from({ length: 12 }, (_, index) => `cmd-${String(index + 1).padStart(2, "0")}`)
          yield* Effect.forEach(commands, (command) => registerProcess(root, chat.id, command), { discard: true })

          yield* promptOnce(chat.id, "first")
          const parts = runtimeContextParts(yield* sessions.messages({ sessionID: chat.id }))
          expect(parts).toHaveLength(1)
          const text = parts[0]?.text ?? ""
          const lines = text.split("\n").filter((line) => line.startsWith("- pid "))
          expect(lines).toHaveLength(10)
          // The head of the started_at ASC list is kept; the tail is only counted.
          expect(lines[0]).toContain('"cmd-01"')
          expect(text).toContain('"cmd-10"')
          expect(text).not.toContain('"cmd-11"')
          expect(text).not.toContain('"cmd-12"')
          expect(text).toContain("- …and 2 more")
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )
})
