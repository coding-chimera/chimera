import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Chimera } from "@/chimera"
import { ProcessRegistry } from "@/chimera/process-registry"
import { ProcessWatch } from "@/chimera/process-watch"
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
  ProcessWatch.reset()
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

const initGraph = Effect.fnUntraced(function* () {
  return yield* Chimera.initProjectGraph({ watch: false })
})

const projectRoot = Effect.fnUntraced(function* () {
  const instance = yield* InstanceState.context
  return instance.worktree === "/" ? instance.directory : instance.worktree
})

/** Poll the target session until an injected notice AND the woken turn's reply are persisted. */
const pollWake = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: SessionID, tag: string, reply: string) {
  for (let i = 0; i < 200; i++) {
    const msgs = yield* sessions.messages({ sessionID, limit: 20 })
    const wake = syntheticTextParts(msgs)
      .map((part) => part.text)
      .find((text) => text.includes(tag))
    const assistant = plainTexts(msgs)
    if (wake && assistant.includes(reply)) return { wake, assistant }
    yield* Effect.sleep(50)
    yield* Effect.sleep(50)
  }
  return yield* Effect.fail(new Error(`injected ${tag} notice or reply (${reply}) never arrived for ${sessionID}`))
})

/**
 * Seed a parked session and arm the instance watchers: the noReply prompt runs
 * prompt()'s arming path without consuming a queued LLM response or starting a
 * loop, exactly like the edit-intent wake tests.
 */
const seedWaiter = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  title: string,
  reply: string,
  llm: { text: (value: string) => Effect.Effect<void> },
) {
  const session = yield* sessions.create({ title })
  const first = yield* sessions.updateMessage(userMessage(session.id))
  yield* sessions.updateMessage(assistantMessage(session.id, first.id))
  yield* llm.text(reply)
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID: session.id, agent: "build", noReply: true, parts: [{ type: "text", text: "seed" }] })
  return session
})

describe("proc_notify exit watch (registry → watcher → inject)", () => {
  it.live(
    "a subscribed session is notified with <process_exited> when the watched process exits, exactly once",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          yield* initGraph()
          const root = yield* projectRoot()
          const sessions = yield* Session.Service

          const holder = yield* sessions.create({ title: "Holder" })
          const waiter = yield* seedWaiter(sessions, "Waiter", "exit-echo", llm)

          const registered = yield* Effect.promise(() =>
            ProcessRegistry.register({ projectRoot: root, sessionID: holder.id, pid: process.pid, command: "sleep 60" }),
          )
          expect(registered).toBeDefined()
          if (!registered) return

          ProcessWatch.subscribe({
            projectRoot: root,
            sessionID: waiter.id,
            pid: registered.pid,
            command: registered.command,
            ownerSession: holder.id,
            startedAt: registered.startedAt,
          })

          // Owner reports the exit: the in-process bus event drives the fast channel.
          yield* Effect.promise(() => ProcessRegistry.markExited(root, registered.id, 0))

          const { wake } = yield* pollWake(sessions, waiter.id, "<process_exited", "exit-echo")
          expect(wake).toContain(`pid="${registered.pid}"`)
          expect(wake).toContain('status="exited"')
          expect(wake).toContain('exit_code="0"')
          expect(wake).toContain('detected="owner-report"')
          expect(wake).toContain(`owner_session="${holder.id}"`)

          // One-shot: the subscription is consumed and never fires again.
          expect(ProcessWatch.listForProject(root)).toHaveLength(0)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
    30_000,
  )

  it.live(
    "a watch timeout injects <process_watch_timeout> and removes the subscription while the process keeps running",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          yield* initGraph()
          const root = yield* projectRoot()
          const sessions = yield* Session.Service

          const holder = yield* sessions.create({ title: "Holder" })
          const waiter = yield* seedWaiter(sessions, "Waiter", "timeout-echo", llm)

          const registered = yield* Effect.promise(() =>
            ProcessRegistry.register({ projectRoot: root, sessionID: holder.id, pid: process.pid, command: "sleep 60" }),
          )
          expect(registered).toBeDefined()
          if (!registered) return

          ProcessWatch.subscribe({
            projectRoot: root,
            sessionID: waiter.id,
            pid: registered.pid,
            command: registered.command,
            ownerSession: holder.id,
            startedAt: registered.startedAt,
            timeoutMs: 1_000,
          })

          // The process stays running (pid = this test process); only the timeout fires.
          const { wake } = yield* pollWake(sessions, waiter.id, "<process_watch_timeout", "timeout-echo")
          expect(wake).toContain(`pid="${registered.pid}"`)
          expect(wake).toContain('command="sleep 60"')
          expect(ProcessWatch.listForProject(root)).toHaveLength(0)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
    30_000,
  )
})