import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/agent/background-job"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Auth } from "@/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { Permission } from "../../src/permission"
import { ProjectID } from "@/project/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskCancelTool } from "../../src/tool/task-cancel"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "../../src/provider/provider"
import DESCRIPTION from "../../src/tool/task_cancel.txt"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  routingState = ConfigSubagentRouting.empty()
  routingActivity = []
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const providerFixture = {
  name: "Test",
  id: "test",
  env: [],
  npm: "@ai-sdk/openai-compatible",
  models: {
    "test-model": {
      id: "test-model",
      name: "Test Model",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      release_date: "2025-01-01",
      limit: { context: 100000, output: 10000 },
      cost: { input: 0, output: 0 },
      options: {},
      variants: { max: {}, xhigh: {}, high: {} },
    },
  },
  options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
}

const baseConfig = {
  provider: { test: providerFixture },
}

let routingState: ConfigSubagentRouting.State = ConfigSubagentRouting.empty()
let routingActivity: ProjectID[] = []
const routingLayer = Layer.succeed(
  ConfigSubagentRouting.Service,
  ConfigSubagentRouting.Service.of({
    get: () => Effect.succeed(routingState),
    prefer: () => Effect.die(new Error("unexpected preference mutation")),
    suppress: () => Effect.die(new Error("unexpected suppression mutation")),
    recordDelegation: (projectID) =>
      Effect.sync(() => {
        routingActivity.push(projectID)
        return routingState
      }),
  }),
)
const authLayer = Layer.mock(Auth.Service)({
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
  set: () => Effect.void,
  remove: () => Effect.void,
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    routingLayer,
    authLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    DelegationLimiter.defaultLayer,
    BackgroundJob.defaultLayer,
    Provider.defaultLayer,
  ),
)
const itReal = testEffect(makePromptHarness())
const itCascade = testEffect(Layer.mergeAll(SessionRunState.defaultLayer, BackgroundJob.defaultLayer))
const itRemove = testEffect(Layer.mergeAll(Session.defaultLayer, BackgroundJob.defaultLayer))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskCancelTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function makeStub(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  onCancel?: (sessionID: SessionID) => void
  onInject?: (input: { sessionID: SessionID; text: string }) => void
  text?: string
  prompt?: (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts>
}): TaskPromptOps {
  return {
    cancel: (sessionID) =>
      Effect.sync(() => {
        opts?.onCancel?.(sessionID)
      }),
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      opts?.prompt?.(input) ??
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    injectSynthetic: (input) =>
      Effect.sync(() => {
        opts?.onInject?.(input)
        return reply(
          { ...input, parts: [{ type: "text" as const, text: input.text }] } as SessionPrompt.PromptInput,
          input.text,
        )
      }),
  }
}

const toolCtx = (opts: { chat: Session.Info; assistant: MessageV2.Assistant; promptOps: TaskPromptOps }) => ({
  sessionID: opts.chat.id,
  messageID: opts.assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps: opts.promptOps, bypassAgentCheck: true },
  messages: [] as MessageV2.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const cancelCtx = (sessionID: SessionID) => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  extra: {},
  messages: [] as MessageV2.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

function shortFailureText(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return ""
  return Cause.prettyErrors(exit.cause).join("\n")
}

describe("tool.task_cancel", () => {
  it.instance(
    "cancels a running background task and its child run, and reports the cancelled state",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const taskTool = yield* TaskTool
        const taskDef = yield* taskTool.init()
        const cancelTool = yield* TaskCancelTool
        const cancelDef = yield* cancelTool.init()
        const gate = defer<void>()
        const cancelled: SessionID[] = []
        const promptOps = makeStub({
          onCancel: (sessionID) => cancelled.push(sessionID),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "never")
            }),
        })

        const started = yield* taskDef.execute(
          { description: "probe", prompt: "work", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const taskId = (started.metadata as { jobId?: string }).jobId as SessionID
        expect((yield* jobs.get(taskId))?.status).toBe("running")

        const result = yield* cancelDef.execute({ task_id: taskId }, cancelCtx(chat.id))
        expect(result.output).toContain("(cancelled)")
        expect(result.metadata).toMatchObject({ taskId, status: "cancelled", cancelled: true })
        expect((yield* jobs.get(taskId))?.status).toBe("cancelled")
        // The engine's onInterrupt fires the child-run cancel hook once.
        expect(cancelled).toContain(taskId)
        expect(new Set(cancelled).size).toBe(1)

        gate.resolve()
      }),
    { config: baseConfig },
  )

  it.instance(
    "rejects cancelling a task started by another session (ownership guard)",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const taskTool = yield* TaskTool
        const taskDef = yield* taskTool.init()
        const cancelTool = yield* TaskCancelTool
        const cancelDef = yield* cancelTool.init()
        const gate = defer<void>()
        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "never")
            }),
        })
        const started = yield* taskDef.execute(
          { description: "probe", prompt: "work", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const taskId = (started.metadata as { jobId?: string }).jobId as SessionID

        const exit = yield* cancelDef
          .execute({ task_id: taskId }, cancelCtx(SessionID.make("ses_attacker")))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const message = shortFailureText(exit)
        expect(message).toContain("started by session")
        expect(message).toContain("only cancel background tasks you started yourself")
        expect(message).toContain("ses_attacker")

        // The job is untouched by the rejected attempt.
        expect((yield* jobs.get(taskId))?.status).toBe("running")
        gate.resolve()
      }),
    { config: baseConfig },
  )

  it.instance(
    "reports a clear error for a nonexistent task_id",
    () =>
      Effect.gen(function* () {
        const cancelTool = yield* TaskCancelTool
        const cancelDef = yield* cancelTool.init()
        const { chat } = yield* seed()
        const exit = yield* cancelDef
          .execute({ task_id: "ses_nope" }, cancelCtx(chat.id))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(shortFailureText(exit)).toContain("No background task found with task_id: ses_nope")
      }),
    { config: baseConfig },
  )

  it.instance(
    "is idempotent for terminal states: completed and cancelled tasks return snapshot text without error",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const taskTool = yield* TaskTool
        const taskDef = yield* taskTool.init()
        const cancelTool = yield* TaskCancelTool
        const cancelDef = yield* cancelTool.init()

        const completed = yield* taskDef.execute(
          { description: "fast", prompt: "work", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: makeStub({ text: "done" }) }),
        )
        const fastId = (completed.metadata as { jobId?: string }).jobId as string
        yield* jobs.wait({ id: fastId })
        const first = yield* cancelDef.execute({ task_id: fastId }, cancelCtx(chat.id))
        expect(first.output).toContain("already completed")
        const again = yield* cancelDef.execute({ task_id: fastId }, cancelCtx(chat.id))
        expect(again.output).toContain("already completed")
        expect((yield* jobs.get(fastId))?.status).toBe("completed")

        const gate = defer<void>()
        const blocking = yield* taskDef.execute(
          { description: "blocking", prompt: "work", subagent_type: "general", background: true },
          toolCtx({
            chat,
            assistant,
            promptOps: makeStub({
              prompt: (input) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() => gate.promise)
                  return reply(input, "never")
                }),
            }),
          }),
        )
        const blockedId = (blocking.metadata as { jobId?: string }).jobId as string
        const cancelled = yield* cancelDef.execute({ task_id: blockedId }, cancelCtx(chat.id))
        expect(cancelled.output).toContain("(cancelled)")
        const cancelledAgain = yield* cancelDef.execute({ task_id: blockedId }, cancelCtx(chat.id))
        expect(cancelledAgain.output).toContain("already cancelled")
        gate.resolve()
      }),
    { config: baseConfig },
  )

  it.instance(
    "rejects cancellation with a clear error when the background kill-switch is off",
    () =>
      Effect.gen(function* () {
        const cancelTool = yield* TaskCancelTool
        const cancelDef = yield* cancelTool.init()
        const { chat } = yield* seed()
        const exit = yield* cancelDef
          .execute({ task_id: "ses_any" }, cancelCtx(chat.id))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(shortFailureText(exit)).toContain("background_subagents is false")
      }),
    { config: { delegation: { background_subagents: false }, provider: { test: providerFixture } } },
  )

  it.instance(
    "registers in the builtin registry and follows the task visibility surface for restricted agents",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("task_cancel")

        const agents = yield* Agent.Service
        const explore = yield* agents.get("explore")
        const general = yield* agents.get("general")
        // task is not on the explore allowlist, so task_cancel follows suit.
        const disabledExplore = Permission.disabled(["task_cancel", "task"], explore.permission)
        expect(disabledExplore.has("task_cancel")).toBe(true)
        expect(disabledExplore.has("task")).toBe(true)
        const disabledGeneral = Permission.disabled(["task_cancel", "task"], general.permission)
        expect(disabledGeneral.size).toBe(0)
      }),
    { config: baseConfig },
  )
})

describe("cascade: session run cancel", () => {
  const blockedRun = (gate: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      yield* Deferred.await(gate)
      return "done"
    })
  // ensureRunning's work must produce MessageV2.WithParts like the real loop.
  const blockedRunnerWork = (gate: Deferred.Deferred<void>, sessionID: SessionID) =>
    Effect.gen(function* () {
      yield* Deferred.await(gate)
      return reply({ sessionID, parts: [] }, "ran")
    })

  itCascade.instance(
    "cancelling a session run cancels its background jobs and propagates across two job levels, interrupting each child run",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const state = yield* SessionRunState.Service
        const parent = SessionID.make("parent")
        const child = SessionID.make("child")
        const grandchild = SessionID.make("grandchild")

        const childGate = yield* Deferred.make<void>()
        const grandGate = yield* Deferred.make<void>()
        let childRunInterrupts = 0
        let grandRunInterrupts = 0

        // Real runners for the child and grandchild sessions with the same
        // onInterrupt shape prompt.ts wires (returns WithParts).
        yield* state
          .ensureRunning(
            child,
            Effect.sync(() => {
              childRunInterrupts += 1
              return reply({ sessionID: child, parts: [] } as never, "child-interrupted")
            }),
            blockedRunnerWork(childGate, child),
          )
          .pipe(Effect.forkScoped)
        yield* state
          .ensureRunning(
            grandchild,
            Effect.sync(() => {
              grandRunInterrupts += 1
              return reply({ sessionID: grandchild, parts: [] }, "grand-interrupted")
            }),
            blockedRunnerWork(grandGate, grandchild),
          )
          .pipe(Effect.forkScoped)

        // Mirrors the task.ts wiring: job cancel fires state.cancel(child).
        yield* jobs.start({
          id: child,
          type: "task",
          metadata: { parentSessionId: parent, sessionId: child },
          onInterrupt: state.cancel(child).pipe(Effect.ignore),
          run: blockedRun(childGate),
        })
        yield* jobs.start({
          id: grandchild,
          type: "task",
          metadata: { parentSessionId: child, sessionId: grandchild },
          onInterrupt: state.cancel(grandchild).pipe(Effect.ignore),
          run: blockedRun(grandGate),
        })
        yield* Effect.sleep(20)

        yield* state.cancel(parent)

        expect((yield* jobs.get(child))?.status).toBe("cancelled")
        expect((yield* jobs.get(grandchild))?.status).toBe("cancelled")
        // Each child run was interrupted exactly once by its runner cancel.
        expect(childRunInterrupts).toBe(1)
        expect(grandRunInterrupts).toBe(1)
        // Neither run completed on its own: the gates are still raw.
        expect(yield* Deferred.isDone(childGate)).toBe(false)
        expect(yield* Deferred.isDone(grandGate)).toBe(false)

        yield* Deferred.succeed(childGate, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(grandGate, undefined).pipe(Effect.ignore)
      }),
  )

  itCascade.instance(
    "cancelling a session that is itself a running job cancels that job and does not recurse forever",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const state = yield* SessionRunState.Service
        const self = SessionID.make("self")
        const gate = yield* Deferred.make<void>()
        let interrupts = 0

        yield* state
          .ensureRunning(
            self,
            Effect.sync(() => {
              interrupts += 1
              return reply({ sessionID: self, parts: [] }, "interrupted")
            }),
            blockedRunnerWork(gate, self),
          )
          .pipe(Effect.forkScoped)
        // Self-referential: the job for "self" has an onInterrupt that
        // re-enters state.cancel("self"). The running-status filter keeps the
        // recursion bounded regardless of the cycle-shaped metadata.
        yield* jobs.start({
          id: self,
          type: "task",
          metadata: { parentSessionId: SessionID.make("root"), sessionId: self },
          onInterrupt: state.cancel(self).pipe(Effect.ignore),
          run: blockedRun(gate),
        })
        yield* Effect.sleep(20)

        yield* state.cancel(self)

        expect((yield* jobs.get(self))?.status).toBe("cancelled")
        expect(interrupts).toBe(1)
        yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
      }),
  )

  itCascade.instance(
    "terminates on cyclic metadata (visited/cancelled guard) and fires each job's onInterrupt exactly once",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const state = yield* SessionRunState.Service
        const aGate = yield* Deferred.make<void>()
        const bGate = yield* Deferred.make<void>()
        let aInterrupts = 0
        let bInterrupts = 0
        // A cycle is impossible to build through real delegation (parents are
        // ancestors), but pathological metadata must not hang the BFS.
        yield* jobs.start({
          id: "a",
          type: "task",
          metadata: { parentSessionId: "b", sessionId: "a" },
          onInterrupt: Effect.sync(() => {
            aInterrupts += 1
          }),
          run: blockedRun(aGate),
        })
        yield* jobs.start({
          id: "b",
          type: "task",
          metadata: { parentSessionId: "a", sessionId: "b" },
          onInterrupt: Effect.sync(() => {
            bInterrupts += 1
          }),
          run: blockedRun(bGate),
        })
        yield* Effect.sleep(20)

        yield* state.cancel(SessionID.make("a"))

        expect((yield* jobs.get("a"))?.status).toBe("cancelled")
        expect((yield* jobs.get("b"))?.status).toBe("cancelled")
        expect(aInterrupts).toBe(1)
        expect(bInterrupts).toBe(1)
        yield* Deferred.succeed(aGate, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(bGate, undefined).pipe(Effect.ignore)
      }),
  )
})

describe("session.remove cleanup", () => {
  const blockedRun = (gate: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      yield* Deferred.await(gate)
      return "done"
    })

  itRemove.instance(
    "removing a session cancels the jobs it owns and the jobs it dispatched, leaving unrelated jobs alone",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ title: "Child", parentID: parent.id })
        const gate = yield* Deferred.make<void>()
        // The parent session itself running as a background job (sessionId match).
        yield* jobs.start({
          id: "job_p",
          type: "task",
          metadata: { sessionId: parent.id, parentSessionId: "ancestor_p" },
          run: blockedRun(gate),
        })
        // A job the parent dispatched (parentSessionId match, cancelled here or
        // through the child recursion).
        yield* jobs.start({
          id: "job_c",
          type: "task",
          metadata: { sessionId: child.id, parentSessionId: parent.id },
          run: blockedRun(gate),
        })
        // Unrelated job from another parent — must survive.
        yield* jobs.start({
          id: "job_other",
          type: "task",
          metadata: { sessionId: "unrelated", parentSessionId: "zygote" },
          run: blockedRun(gate),
        })
        yield* Effect.sleep(20)

        yield* sessions.remove(parent.id)

        expect((yield* jobs.get("job_p"))?.status).toBe("cancelled")
        expect((yield* jobs.get("job_c"))?.status).toBe("cancelled")
        expect((yield* jobs.get("job_other"))?.status).toBe("running")
        yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
      }),
  )
})

describe("cascade: real harness", () => {
  itReal.live(
    "cancelling the parent session's run cancels its background job and interrupts the child run",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const taskTool = yield* TaskTool
          const taskDef = yield* taskTool.init()
          const chat = yield* sessions.create({ title: "Parent" })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const assistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            parentID: user.id,
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: dir, root: dir },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() },
          }
          yield* sessions.updateMessage(assistant)
          const promptOps: TaskPromptOps = {
            cancel: (sessionID) => prompt.cancel(sessionID),
            resolvePromptParts: (template) => prompt.resolvePromptParts(template),
            prompt: (input) => prompt.prompt(input),
            injectSynthetic: (input) => prompt.injectSynthetic(input),
          }
          const gate = defer<void>()
          // Hold the child's first LLM stream open so the child run is
          // provably in-flight when the parent is cancelled.
          yield* llm.hold("child-done", gate.promise)

          const started = yield* taskDef.execute(
            { description: "probe", prompt: "do it", subagent_type: "general", background: true },
            toolCtx({ chat, assistant, promptOps }),
          )
          const taskId = (started.metadata as { jobId?: string }).jobId as SessionID
          yield* llm.wait(1)

          yield* prompt.cancel(chat.id)

          const waitForCancel = Effect.fnUntraced(function* () {
            for (let i = 0; i < 100; i++) {
              const info = yield* jobs.get(taskId)
              if (info?.status !== "running") return info?.status
              yield* Effect.sleep(25)
            }
            return yield* Effect.fail(new Error(`timed out waiting for background job ${taskId} to cancel`))
          })
          const status = yield* waitForCancel()
          expect(status).toBe("cancelled")
          gate.resolve()
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  itReal.live(
    "task_cancel cancels a real in-flight background task from the parent session",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const taskTool = yield* TaskTool
          const taskDef = yield* taskTool.init()
          const cancelTool = yield* TaskCancelTool
          const cancelDef = yield* cancelTool.init()
          const chat = yield* sessions.create({ title: "Parent" })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const assistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            parentID: user.id,
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: dir, root: dir },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() },
          }
          yield* sessions.updateMessage(assistant)
          const promptOps: TaskPromptOps = {
            cancel: (sessionID) => prompt.cancel(sessionID),
            resolvePromptParts: (template) => prompt.resolvePromptParts(template),
            prompt: (input) => prompt.prompt(input),
            injectSynthetic: (input) => prompt.injectSynthetic(input),
          }
          const gate = defer<void>()
          yield* llm.hold("child-done", gate.promise)

          const started = yield* taskDef.execute(
            { description: "probe", prompt: "do it", subagent_type: "general", background: true },
            toolCtx({ chat, assistant, promptOps }),
          )
          const taskId = (started.metadata as { jobId?: string }).jobId as SessionID
          yield* llm.wait(1)

          const result = yield* cancelDef.execute({ task_id: taskId }, cancelCtx(chat.id))
          expect(result.output).toContain("(cancelled)")

          const waitForCancel = Effect.fnUntraced(function* () {
            for (let i = 0; i < 100; i++) {
              const info = yield* jobs.get(taskId)
              if (info?.status !== "running") return info?.status
              yield* Effect.sleep(25)
            }
            return yield* Effect.fail(new Error(`timed out waiting for background job ${taskId} to cancel`))
          })
          const status = yield* waitForCancel()
          expect(status).toBe("cancelled")
          gate.resolve()
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )
})