import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { BackgroundJob } from "@/agent/background-job"
import { Bus } from "@/bus"
import { Chimera } from "@/chimera"
import { EditIntentClaims } from "@/chimera/edit-intent"
import { readActiveEditIntentClaims, readEditIntentWaiters, registerEditIntentWaiter, releaseEditIntentClaims } from "@/chimera/store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/contracts/session-ids"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { InstanceState } from "@/effect/instance-state"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
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

  it.live("a release from another process wakes the parked session through the watcher's poll fiber without stealing foreign-hosted waiters", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        void dir
        yield* initGraph()
        const root = yield* projectRoot()
        const sessions = yield* Session.Service

        // The blocker "lives" in another process: it exists only as claim rows.
        const waiter = yield* seedWaiter(sessions, "Waiter", "polled-echo", llm)
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: "ses_remote_holder",
          agent: "build",
          predesignID: "predesign_remote",
          intent: "remote holder refactor",
          files: ["shared.ts"],
        })
        // The local session queues behind the remote holder through the gate
        // (host-stamped with this process, pending-poll hint set).
        const conflicts = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: waiter.id,
          toolID: "edit",
          files: [{ absolutePath: `${root}/shared.ts`, graphPath: "shared.ts" }],
        })
        expect(conflicts).toHaveLength(1)
        // A live foreign host's waiter on the same file (pid 1 = launchd/init):
        // the poll must wake only the locally hosted row.
        yield* Effect.promise(() =>
          registerEditIntentWaiter(root, {
            sessionID: "ses_foreign_parked",
            filePath: "shared.ts",
            blockerSessionID: "ses_remote_holder",
            host: { pid: 1, bootID: "boot_1_1" },
          }),
        )

        // The remote process releases (raw store write: no local bus event,
        // no local take — exactly what a release in another process looks
        // like from here).
        yield* Effect.promise(() => releaseEditIntentClaims(root, "ses_remote_holder", "session_idle"))

        // The watcher's poll fiber (armed by seedWaiter's prompt() run) picks
        // the freed waiter up within its interval and injects the wake.
        const { wake } = yield* pollWake(sessions, waiter.id, "polled-echo")
        expect(wake).toContain("<edit_intent_release>")
        expect(wake).toContain("shared.ts")
        // The poll path has no release reason attached.
        expect(wake).toContain("the holder finished")

        // The foreign-hosted row was NOT stolen: it stays waiting for its
        // own process's poll.
        const foreign = yield* Effect.promise(() => readEditIntentWaiters(root, { sessionID: "ses_foreign_parked", status: "waiting" }))
        expect(foreign).toHaveLength(1)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )
})

describe("edit-intent claims: session-family exemption (parent claims never gate subagents)", () => {
  it.live("a claim never blocks the holder's own subagent family, but still blocks foreign sessions", () =>
    provideTmpdirInstance(
      Effect.fnUntraced(function* (dir) {
        yield* initGraph()
        const root = yield* projectRoot()
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ title: "Child", parentID: parent.id })
        const grandchild = yield* sessions.create({ title: "Grandchild", parentID: child.id })
        const stranger = yield* sessions.create({ title: "Stranger" })
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: parent.id,
          agent: "build",
          predesignID: "predesign_family_parent",
          intent: "parent refactor",
          files: ["shared.ts"],
        })

        const childCheck = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: child.id,
          toolID: "edit",
          files: [{ absolutePath: `${dir}/shared.ts`, graphPath: "shared.ts" }],
        })
        expect(childCheck).toHaveLength(0)
        const grandchildCheck = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: grandchild.id,
          toolID: "edit",
          files: [{ absolutePath: `${dir}/shared.ts`, graphPath: "shared.ts" }],
        })
        expect(grandchildCheck).toHaveLength(0)

        // Predesign side: a child declaring the same file reports no conflict
        // and registers its claim freely.
        const childPredesign = yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: child.id,
          agent: "build",
          predesignID: "predesign_family_child",
          intent: "child work",
          files: ["shared.ts"],
        })
        expect(childPredesign.conflicts).toHaveLength(0)
        expect(childPredesign.registered.map((claim) => claim.filePath)).toEqual(["shared.ts"])

        // Foreign sessions keep blocking, oldest holder first.
        const strangerCheck = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: stranger.id,
          toolID: "edit",
          files: [{ absolutePath: `${dir}/shared.ts`, graphPath: "shared.ts" }],
        })
        expect(strangerCheck).toHaveLength(1)
        expect(strangerCheck[0]!.holder.sessionID).toBe(parent.id)

        // Conservative fallback: a holder whose session row cannot be
        // resolved (deleted or synthetic id) stays foreign even against a
        // resolvable checker inside another family.
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: "ses_family_ghost",
          agent: "build",
          predesignID: "predesign_family_ghost",
          intent: "ghost claim",
          files: ["ghost.ts"],
        })
        const ghostCheck = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: child.id,
          toolID: "edit",
          files: [{ absolutePath: `${dir}/ghost.ts`, graphPath: "ghost.ts" }],
        })
        expect(ghostCheck).toHaveLength(1)

        // The child's own claim does not gate the parent in return.
        const parentCheck = yield* EditIntentClaims.checkMutation({
          projectRoot: root,
          sessionID: parent.id,
          toolID: "edit",
          files: [{ absolutePath: `${dir}/shared.ts`, graphPath: "shared.ts" }],
        })
        expect(parentCheck).toHaveLength(0)
      }),
      { git: true },
    ),
  )
})

describe("edit-intent claims: idle-release gate and explicit closeout release", () => {
  it.live(
    "idle with a running job owned by the session keeps claims; the job's terminal transition releases them and wakes the waiter",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          void dir
          yield* initGraph()
          const root = yield* projectRoot()
          const sessions = yield* Session.Service
          const status = yield* SessionStatus.Service
          const background = yield* BackgroundJob.Service

          const holder = yield* sessions.create({ title: "Holder" })
          const waiter = yield* seedWaiter(sessions, "Waiter", "settled-echo", llm)
          yield* EditIntentClaims.registerFromPredesign({
            projectRoot: root,
            sessionID: holder.id,
            agent: "build",
            predesignID: "predesign_bg_holder",
            intent: "holder refactor",
            files: ["shared.ts"],
          })
          yield* EditIntentClaims.registerFromPredesign({
            projectRoot: root,
            sessionID: waiter.id,
            agent: "build",
            predesignID: "predesign_bg_waiter",
            intent: "waiter refactor",
            files: ["shared.ts"],
          })

          // A background dispatch is still running when the holder turns idle.
          const gate = yield* Deferred.make<string>()
          yield* background.start({ id: "job_bg_gate_owner", ownerSessionId: holder.id, run: Deferred.await(gate) })
          yield* status.set(holder.id, { type: "idle" })
          yield* Effect.sleep("300 millis")

          // The gate holds: claims stay active and the waiter is not woken.
          const heldActive = yield* Effect.promise(() => readActiveEditIntentClaims(root, { sessionID: holder.id }))
          expect(heldActive).toHaveLength(1)
          const stillWaiting = yield* Effect.promise(() => readEditIntentWaiters(root, { sessionID: waiter.id, status: "waiting" }))
          expect(stillWaiting).toHaveLength(1)

          // The job settles: the re-check fiber releases and wakes through the
          // normal idle-reason chain.
          yield* Deferred.succeed(gate, "child done")
          const { wake } = yield* pollWake(sessions, waiter.id, "settled-echo")
          expect(wake).toContain("the holder's run completed")
          const released = yield* Effect.promise(() => readActiveEditIntentClaims(root, { sessionID: holder.id }))
          expect(released).toHaveLength(0)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live("idle with a running job owned by a descendant session also keeps the claims until it settles", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        void dir
        yield* initGraph()
        const root = yield* projectRoot()
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const background = yield* BackgroundJob.Service

        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ title: "Child", parentID: parent.id })
        const waiter = yield* seedWaiter(sessions, "Waiter", "nested-echo", llm)
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: parent.id,
          agent: "build",
          predesignID: "predesign_nested_holder",
          intent: "parent refactor",
          files: ["shared.ts"],
        })
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: waiter.id,
          agent: "build",
          predesignID: "predesign_nested_waiter",
          intent: "waiter refactor",
          files: ["shared.ts"],
        })

        // The nested dispatch is owned by the CHILD session; the parent's
        // idle transition must still hold its claims.
        const gate = yield* Deferred.make<string>()
        yield* background.start({ id: "job_bg_gate_descendant", ownerSessionId: child.id, run: Deferred.await(gate) })
        yield* status.set(parent.id, { type: "idle" })
        yield* Effect.sleep("300 millis")
        const heldActive = yield* Effect.promise(() => readActiveEditIntentClaims(root, { sessionID: parent.id }))
        expect(heldActive).toHaveLength(1)

        yield* Deferred.succeed(gate, "nested done")
        const { wake } = yield* pollWake(sessions, waiter.id, "nested-echo")
        expect(wake).toContain("the holder's run completed")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("an explicit closeout release wakes the queued session without waiting for idle", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        void dir
        yield* initGraph()
        const root = yield* projectRoot()
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const holder = yield* sessions.create({ title: "Holder" })
        const waiter = yield* seedWaiter(sessions, "Waiter", "explicit-echo", llm)
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: holder.id,
          agent: "build",
          predesignID: "predesign_explicit_holder",
          intent: "holder refactor",
          files: ["shared.ts"],
        })
        const queued = yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: waiter.id,
          agent: "build",
          predesignID: "predesign_explicit_waiter",
          intent: "waiter refactor",
          files: ["shared.ts"],
        })
        expect(queued.conflicts).toHaveLength(1)

        const outcome = yield* EditIntentClaims.releaseExplicitly({ bus, projectRoot: root, sessionID: holder.id })
        expect(outcome.released.map((claim) => claim.filePath)).toEqual(["shared.ts"])
        expect(outcome.targets.map((target) => target.sessionID)).toEqual([waiter.id])

        // The holder never goes idle: the Released bus event drives the wake.
        const { wake } = yield* pollWake(sessions, waiter.id, "explicit-echo")
        expect(wake).toContain("the holder released it explicitly")
        const holderActive = yield* Effect.promise(() => readActiveEditIntentClaims(root, { sessionID: holder.id }))
        expect(holderActive).toHaveLength(0)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )
})
