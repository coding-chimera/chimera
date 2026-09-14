import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/agent/background-job"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Auth } from "@/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Permission } from "../../src/permission"
import { ProjectID } from "@/project/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { SubagentDispatch } from "../../src/agent/subagent-dispatch"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "../../src/provider/provider"
import { toJsonSchema } from "../../src/util/effect-zod"
import DESCRIPTION from "../../src/tool/task.txt"
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

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskBackgroundTest.seed")(function* () {
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

describe("tool.task background", () => {
  it.instance(
    "background dispatch returns immediately with a running marker and the child session id, and the job keeps running",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const gate = defer<void>()
        const started: string[] = []
        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              started.push(input.sessionID)
              yield* Effect.promise(() => gate.promise)
              return reply(input, "probe-done")
            }),
        })

        const result = yield* def.execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )

        expect(result.output).toContain("(background, running)")
        expect(result.output).toContain("task_id: ")
        const taskId = (result.metadata as { jobId?: string }).jobId as SessionID
        expect(typeof taskId).toBe("string")
        expect((yield* jobs.get(taskId))?.status).toBe("running")
        expect(started).toHaveLength(1)
        // Typed ownership is recorded and the engine-derived metadata projection matches.
        const job = yield* jobs.get(taskId)
        expect(job?.ownerSessionId).toBe(chat.id)
        expect(job?.metadata?.parentSessionId).toBe(chat.id)
        expect(job?.metadata?.sessionId).toBe(taskId)
        expect(job?.delivery).toBe("pending")

        gate.resolve()
        const waited = yield* jobs.wait({ id: taskId })
        expect(waited.info?.status).toBe("completed")
      }),
    { config: baseConfig },
  )

  it.instance(
    "notify delivery: job reaches delivered after the notify fiber completes injection and quiescence is reachable",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const gate = defer<void>()
        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "delivery-done")
            }),
        })
        const result = yield* def.execute(
          { description: "delivery probe", prompt: "work", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const taskId = (result.metadata as { jobId?: string }).jobId as SessionID
        gate.resolve()
        const waited = yield* jobs.wait({ id: taskId })
        expect(waited.info?.status).toBe("completed")
        const waitDelivered = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if ((yield* jobs.get(taskId))?.delivery === "delivered") return
            yield* Effect.sleep(25)
          }
          return yield* Effect.fail(new Error("delivery never reached delivered"))
        })
        yield* waitDelivered()
        const quiet = yield* jobs.waitOwnerQuiescent(chat.id).pipe(Effect.as("quiet"), Effect.timeoutOption("200 millis"))
        expect(quiet._tag).toBe("Some")
      }),
    { config: baseConfig },
  )

  it.instance(
    "resume into a still-running job appends the new prompt as a serial segment and reports the appended state",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const gate = defer<void>()
        const log: string[] = []
        const firstOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              log.push("a-start")
              yield* Effect.promise(() => gate.promise)
              log.push("a-end")
              return reply(input, "a-done")
            }),
        }
        const secondOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              log.push("b-start")
              log.push("b-end")
              return reply(input, "b-done")
            }),
        }

        const first = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: firstOps }),
        )
        const taskId = (first.metadata as { jobId?: string }).jobId as SessionID
        yield* Effect.sleep(50)

        const second = yield* def.execute(
          { description: "task b", prompt: "work b", subagent_type: "general", task_id: taskId, background: true },
          toolCtx({ chat, assistant, promptOps: secondOps }),
        )
        expect(second.output).toContain("background, running")
        expect((second.metadata as { jobId?: string }).jobId).toBe(taskId)
        yield* Effect.sleep(30)
        expect(log).toEqual(["a-start"])

        gate.resolve()
        const waited = yield* jobs.wait({ id: taskId })
        expect(waited.info?.status).toBe("completed")
        expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"])
      }),
    { config: baseConfig },
  )

  it.instance(
    "resume into a finished job restarts in the background and returns immediately",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const first = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: makeStub({ text: "a-done" }) }),
        )
        const taskId = (first.metadata as { jobId?: string }).jobId as SessionID
        expect((yield* jobs.wait({ id: taskId })).info?.status).toBe("completed")

        const gate = defer<void>()
        const log: string[] = []
        const injected: string[] = []
        const resumed = yield* def.execute(
          { description: "task b", prompt: "work b", subagent_type: "general", task_id: taskId, background: true },
          toolCtx({
            chat,
            assistant,
            promptOps: makeStub({
              onInject: (input) => injected.push(input.text),
              prompt: (input) =>
                Effect.gen(function* () {
                  log.push("b-start")
                  yield* Effect.promise(() => gate.promise)
                  log.push("b-end")
                  return reply(input, "b-done")
                }),
            }),
          }),
        )
        // Hard non-blocking evidence: execute returned while the gate is still closed,
        // so the restarted run cannot have completed (the removed synchronous-resume
        // degradation would have parked the parent turn here forever).
        expect(log).not.toContain("b-end")
        expect(resumed.output).toContain("(background, running)")
        expect(resumed.output).toContain(`task_id: ${taskId}`)
        expect((resumed.metadata as { jobId?: string }).jobId).toBe(taskId)
        expect((resumed.metadata as { background?: boolean }).background).toBe(true)
        const restarted = yield* jobs.get(taskId)
        expect(restarted?.status).toBe("running")
        expect(restarted?.delivery).toBe("pending")

        const waitForBStart = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if (log.includes("b-start")) return
            yield* Effect.sleep(10)
          }
          return yield* Effect.fail(new Error("restarted background run never reached the prompt stub"))
        })
        yield* waitForBStart()
        expect(log).not.toContain("b-end")

        gate.resolve()
        const waited = yield* jobs.wait({ id: taskId })
        expect(waited.info?.status).toBe("completed")
        const waitForInjection = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if (injected.some((text) => text.includes("b-done"))) return
            yield* Effect.sleep(25)
          }
          return yield* Effect.fail(new Error("background result never injected into the parent session"))
        })
        yield* waitForInjection()
        expect(
          injected.some((text) => text.includes("<task_result>") && text.includes(`task_id: ${taskId}`)),
        ).toBe(true)
      }),
    { config: baseConfig },
  )

  it.instance(
    "settled-resume restart while the old notify is still injecting: the stale delivery mark cannot orphan the new run's result",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const injectAGate = defer<void>()
        const injectedA: string[] = []
        const firstOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => Effect.sync(() => reply(input, "a-done")),
          injectSynthetic: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => injectAGate.promise)
              injectedA.push(input.text)
              return reply(
                { ...input, parts: [{ type: "text" as const, text: input.text }] } as SessionPrompt.PromptInput,
                input.text,
              )
            }),
        }
        const first = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: firstOps }),
        )
        const taskId = (first.metadata as { jobId?: string }).jobId as SessionID
        expect((yield* jobs.wait({ id: taskId })).info?.status).toBe("completed")
        expect((yield* jobs.get(taskId))?.generation).toBe(1)

        // Restart the same task_id in the background while the old notify fiber is
        // parked inside its (long) injection — the problem-A race window.
        const runBGate = defer<void>()
        const injectBGate = defer<void>()
        const injectedB: string[] = []
        const secondOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => runBGate.promise)
              return reply(input, "b-done")
            }),
          injectSynthetic: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => injectBGate.promise)
              injectedB.push(input.text)
              return reply(
                { ...input, parts: [{ type: "text" as const, text: input.text }] } as SessionPrompt.PromptInput,
                input.text,
              )
            }),
        }
        const resumed = yield* def.execute(
          { description: "task b", prompt: "work b", subagent_type: "general", task_id: taskId, background: true },
          toolCtx({ chat, assistant, promptOps: secondOps }),
        )
        expect(resumed.output).toContain("(background, running)")
        expect((resumed.metadata as { jobId?: string }).jobId).toBe(taskId)
        const restarted = yield* jobs.get(taskId)
        expect(restarted?.status).toBe("running")
        expect(restarted?.delivery).toBe("pending")
        expect(restarted?.generation).toBe(2)

        // The old injection finishes; its stale by-id mark must not deliver generation 2.
        injectAGate.resolve()
        const waitForAInjection = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if (injectedA.some((text) => text.includes("a-done"))) return
            yield* Effect.sleep(10)
          }
          return yield* Effect.fail(new Error("old notify injection never completed"))
        })
        yield* waitForAInjection()
        yield* Effect.sleep(50) // give the stale markDelivered time to land
        expect((yield* jobs.get(taskId))?.delivery).toBe("pending")

        // The new run settles; quiescence must stay blocked until its own delivery.
        runBGate.resolve()
        expect((yield* jobs.wait({ id: taskId })).info?.status).toBe("completed")
        const early = yield* jobs.waitOwnerQuiescent(chat.id).pipe(Effect.as("quiet"), Effect.timeoutOption("150 millis"))
        expect(early._tag).toBe("None")

        injectBGate.resolve()
        const waitForBInjection = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if (injectedB.some((text) => text.includes("b-done"))) return
            yield* Effect.sleep(10)
          }
          return yield* Effect.fail(new Error("restarted run's result was never injected (orphaned delivery)"))
        })
        yield* waitForBInjection()
        expect(
          injectedB.some((text) => text.includes("<task_result>") && text.includes(`task_id: ${taskId}`)),
        ).toBe(true)
        const quiet = yield* jobs.waitOwnerQuiescent(chat.id).pipe(Effect.as("quiet"), Effect.timeoutOption("500 millis"))
        expect(quiet._tag).toBe("Some")
      }),
    { config: baseConfig },
  )

  it.instance(
    "resume into a finished job without background stays synchronous",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const first = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: makeStub({ text: "a-done" }) }),
        )
        const taskId = (first.metadata as { jobId?: string }).jobId as SessionID
        expect((yield* jobs.wait({ id: taskId })).info?.status).toBe("completed")

        const resumed = yield* def.execute(
          { description: "task b", prompt: "work b", subagent_type: "general", task_id: taskId },
          toolCtx({ chat, assistant, promptOps: makeStub({ text: "b-done" }) }),
        )
        expect(resumed.metadata.sessionId).toBe(taskId)
        expect(resumed.metadata.execution?.resumed).toBe(true)
        expect(resumed.output).toContain("<task_result>")
        expect(resumed.output).toContain("b-done")
        expect(resumed.output).not.toContain("(background, running)")
      }),
    { config: baseConfig },
  )

  it.instance(
    "settled-resume restart over the background cap fails without replacing the settled job",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const settledFirst = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: makeStub({ text: "a-done" }) }),
        )
        const settledId = (settledFirst.metadata as { jobId?: string }).jobId as SessionID
        expect((yield* jobs.wait({ id: settledId })).info?.status).toBe("completed")

        const gate = defer<void>()
        const blocking = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "blocked")
            }),
        })
        yield* def.execute(
          { description: "task b", prompt: "work b", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: blocking }),
        )

        const exit = yield* def
          .execute(
            { description: "task c", prompt: "work c", subagent_type: "general", task_id: settledId, background: true },
            toolCtx({ chat, assistant, promptOps: makeStub({ text: "c-done" }) }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.prettyErrors(exit.cause).join("\n")
          expect(message).toContain("concurrency limit reached")
          expect(message).toContain("background_concurrent")
        }
        // No new run started: the settled entry was not replaced by a running job.
        expect((yield* jobs.get(settledId))?.status).toBe("completed")
        gate.resolve()
      }),
    { config: { delegation: { background_concurrent: 1 }, provider: { test: providerFixture } } },
  )

  it.instance(
    "background dispatches over the background_concurrent cap fail with a clear error",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const gate = defer<void>()
        const blocking = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "blocked")
            }),
        })
        yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: blocking }),
        )
        const exit = yield* def
          .execute(
            { description: "task b", prompt: "work b", subagent_type: "general", background: true },
            toolCtx({ chat, assistant, promptOps: makeStub() }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.prettyErrors(exit.cause).join("\n")
          expect(message).toContain("concurrency limit reached")
          expect(message).toContain("background_concurrent")
        }
        gate.resolve()
      }),
    { config: { delegation: { background_concurrent: 1 }, provider: { test: providerFixture } } },
  )

  it.instance(
    "cancelling a running background job fires the child session cancel hook once",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
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
        const result = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const taskId = (result.metadata as { jobId?: string }).jobId as SessionID
        yield* Effect.sleep(20)

        const cancelledJob = yield* jobs.cancel(taskId)
        expect(cancelledJob?.status).toBe("cancelled")
        // The child-run cancel entry point is invoked once via the job's
        // onInterrupt and once via runWork's own interrupt release; both are
        // idempotent at the prompt-layer cancel, so assert the child session
        // was targeted without a distinct second id.
        expect(cancelled.some((id) => id === taskId)).toBe(true)
        expect(new Set(cancelled).size).toBe(1)
        gate.resolve()
      }),
    { config: baseConfig },
  )

  it.instance(
    "kill-switch off narrows parameters (no background field), keeps description byte-identical, and rejects background=true",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        expect(def.description).toBe(DESCRIPTION)
        const narrow = toJsonSchema(def.parameters as never)
        expect(narrow.properties).not.toHaveProperty("background")

        const dialog = yield* def
          .execute(
            { description: "task a", prompt: "work a", subagent_type: "general", background: true },
            toolCtx({ chat, assistant, promptOps: makeStub({ text: "sync-done" }) }),
          )
        // The narrow schema strips `background` before execution, so a request
        // that smuggles it in falls back to the byte-stable synchronous path
        // and never starts a background job.
        expect(dialog.output).not.toContain("(background, running)")
        expect(dialog.output).toContain("sync-done")
        const jobs = yield* BackgroundJob.Service
        expect((yield* jobs.list()).every((job) => job.status !== "running")).toBe(true)
      }),
    { config: { delegation: { background_subagents: false }, provider: { test: providerFixture } } },
  )

  it.instance(
    "kill-switch on advertises background in parameters and description",
    () =>
      Effect.gen(function* () {
        const tool = yield* TaskTool
        const def = yield* tool.init()
        expect(def.description).toContain("Background mode")
        const wide = toJsonSchema(def.parameters as never)
        expect(wide.properties).toHaveProperty("background")
      }),
    { config: { delegation: { background_subagents: true }, provider: { test: providerFixture } } },
  )

  it.instance(
    "fresh dispatch over the background cap fails without creating a child session",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const gate = defer<void>()
        const blocking = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "blocked")
            }),
        })
        yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: blocking }),
        )
        expect((yield* sessions.children(chat.id)).length).toBe(1)

        const exit = yield* def
          .execute(
            { description: "task b", prompt: "work b", subagent_type: "general", background: true },
            toolCtx({ chat, assistant, promptOps: makeStub({ text: "b" }) }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.prettyErrors(exit.cause).join("\n")
          expect(message).toContain("concurrency limit reached")
          expect(message).toContain("background_concurrent")
        }
        // The over-cap reject ran before materialize: no orphan child session.
        expect((yield* sessions.children(chat.id)).length).toBe(1)
        gate.resolve()
      }),
    { config: { delegation: { background_concurrent: 1 }, provider: { test: providerFixture } } },
  )

  it.instance(
    "background dispatch explicitly requesting ultra is rejected and starts nothing",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const exit = yield* def
          .execute(
            { description: "task", prompt: "work", subagent_type: "general", variant: "ultra", background: true },
            toolCtx({ chat, assistant, promptOps: makeStub({ text: "sync-done" }) }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.prettyErrors(exit.cause).join("\n")
          expect(message.toLowerCase()).toContain("ultra")
        }
        const jobs = yield* BackgroundJob.Service
        expect((yield* jobs.list()).filter((job) => job.status === "running")).toHaveLength(0)
      }),
    { config: baseConfig },
  )

  it.instance(
    "a background child session never inherits an ultra variant from an ultra parent",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Ultra parent" })
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
          variant: "ultra",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const gate = defer<void>()
        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => gate.promise)
              return reply(input, "child-done")
            }),
        })
        const result = yield* def.execute(
          { description: "child work", prompt: "work", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const taskId = (result.metadata as { jobId?: string }).jobId as SessionID
        const child = yield* sessions.get(taskId)
        expect(child.model?.variant).not.toBe("ultra")
        const job = yield* jobs.get(taskId)
        const model = job?.metadata?.model as { variant?: string } | undefined
        expect(model?.variant).not.toBe("ultra")
        gate.resolve()
        const waited = yield* jobs.wait({ id: taskId })
        expect(waited.info?.status).toBe("completed")
      }),
    { config: baseConfig },
  )

  itReal.live(
    "completed background task injects a synthetic task_result message into the parent session and the parent loop digests it",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const tool = yield* TaskTool
          const def = yield* tool.init()
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
            prompt: (input) => prompt.prompt(input).pipe(Effect.catch(Effect.die)),
            injectSynthetic: (input) => prompt.injectSynthetic(input),
          }
          yield* llm.text("child-result")
          yield* llm.text("parent-digested")

          const result = yield* def.execute(
            { description: "probe", prompt: "do it", subagent_type: "general", background: true },
            toolCtx({ chat, assistant, promptOps }),
          )
          const taskId = (result.metadata as { jobId?: string }).jobId as SessionID
          expect(result.output).toContain("(background, running)")

          const waitForInjection = Effect.fnUntraced(function* () {
            for (let i = 0; i < 100; i++) {
              const msgs = yield* sessions.messages({ sessionID: chat.id, limit: 20 })
              const injected = msgs.some((msg) =>
                msg.parts.some(
                  (part) => part.type === "text" && part.synthetic === true && part.text.includes("child-result"),
                ),
              )
              if (injected) return msgs
              yield* Effect.sleep(50)
            }
            return yield* Effect.fail(new Error(`timed out waiting for background notification for ${taskId}`))
          })
          yield* waitForInjection()
          expect(
            (yield* sessions.messages({ sessionID: chat.id, limit: 20 })).some((msg) =>
              msg.parts.some(
                (part) => part.type === "text" && part.synthetic === true && part.text.includes("<task_result>"),
              ),
            ),
          ).toBe(true)

          const waitForParentDigest = Effect.fnUntraced(function* () {
            for (let i = 0; i < 100; i++) {
              const msgs = yield* sessions.messages({ sessionID: chat.id, limit: 20 })
              const digested = msgs.some((msg) =>
                msg.parts.some(
                  (part) => part.type === "text" && !part.synthetic && part.text === "parent-digested",
                ),
              )
              if (digested) return
              yield* Effect.sleep(50)
            }
            return yield* Effect.fail(new Error("timed out waiting for parent loop to digest the background notification"))
          })
          yield* waitForParentDigest()
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )
})

describe("tool.task dispatch park (phase 2)", () => {
  // The stub prompt cannot run effectful fibers (its Effect must be pure of reqs),
  // so the notify contract (wait for settle, persist the wake-up turn's final
  // message, then markDelivered) is forked from the test scope once the stub
  // reports it registered the owned job.
  const waitForPromptRan = (done: Deferred.Deferred<void>) =>
    Effect.fnUntraced(function* () {
      for (let i = 0; i < 500; i++) {
        if (yield* Deferred.isDone(done)) return
        yield* Effect.sleep(10)
      }
      return yield* Effect.fail(new Error("prompt stub never ran in time"))
    })

  it.instance(
    "foreground dispatch parks until the child's owned background job is delivered, and returns the woken turn's output",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const leafGate = yield* Deferred.make<void>()
        const promptRan = yield* Deferred.make<void>()
        const progress: Array<Record<string, unknown>> = []
        let midSession: SessionID | undefined
        let leafID = ""

        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              // Turn 1: the child dispatches a background job and ends its turn with
              // a "waiting" text. The leaf stays gated so the park is observable.
              midSession = input.sessionID
              leafID = `park-leaf-${input.sessionID}`
              yield* jobs
                .start({
                  id: leafID,
                  ownerSessionId: input.sessionID,
                  type: "task",
                  run: Deferred.await(leafGate).pipe(Effect.as("leaf-work")),
                })
                .pipe(Effect.ignore)
              yield* Deferred.succeed(promptRan, undefined)
              return reply(input, "waiting-for-leaf")
            }),
        })

        const fiber = yield* Effect.forkScoped(
          def.execute(
            { description: "park probe", prompt: "work", subagent_type: "general" },
            {
              ...toolCtx({ chat, assistant, promptOps }),
              metadata: (input) =>
                Effect.sync(() => {
                  if (input.metadata) progress.push(input.metadata)
                }),
            },
          ),
        )
        yield* waitForPromptRan(promptRan)()
        // Delivery contract: on settle, run the wake-up turn (persist its final
        // assistant message like the loop does: message info plus text part), then
        // mark the delivery complete.
        yield* jobs
          .wait({ id: leafID })
          .pipe(
            Effect.andThen(() =>
              Effect.gen(function* () {
                const woken = reply({ sessionID: midSession! } as SessionPrompt.PromptInput, "final-aggregated")
                yield* sessions.updateMessage(woken.info)
                yield* Effect.forEach(woken.parts, (part) => sessions.updatePart(part), { discard: true })
              }),
            ),
            Effect.andThen(() => jobs.markDelivered(leafID)),
            Effect.forkScoped,
          )
        // While the leaf is running, the dispatch must be parked, not returned.
        const during = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("200 millis"))
        expect(during._tag).toBe("None")

        yield* Deferred.succeed(leafGate, undefined)
        const settled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("5000 millis"))
        expect(settled._tag).toBe("Some")
        if (settled._tag === "Some") {
          const exit = settled.value
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            expect(exit.value.output).toContain("final-aggregated")
            expect(exit.value.output).not.toContain("waiting-for-leaf")
          }
        }
        // The parked-progress metadata carries the three promised signals.
        const parked = progress.filter((item) => item.parked === true)
        expect(parked.length).toBeGreaterThan(0)
        expect(parked[0].parkElapsedMs).toBe(0)
        expect(parked[0].waitingBackgroundTasks).toBe(1)
        expect(typeof parked[0].sessionId).toBe("string")
      }),
    { config: baseConfig },
  )

  it.instance(
    "a background mid job stays running until its own leaf is delivered, then its final output aggregates the woken turn",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const leafGate = yield* Deferred.make<void>()
        const promptRan = yield* Deferred.make<void>()
        let midSession: SessionID | undefined
        let leafID = ""

        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              midSession = input.sessionID
              leafID = `nested-leaf-${input.sessionID}`
              yield* jobs
                .start({
                  id: leafID,
                  ownerSessionId: input.sessionID,
                  type: "task",
                  run: Deferred.await(leafGate).pipe(Effect.as("leaf-output")),
                })
                .pipe(Effect.ignore)
              yield* Deferred.succeed(promptRan, undefined)
              return reply(input, "mid-waiting")
            }),
        })

        const result = yield* def.execute(
          { description: "nested probe", prompt: "work", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const midJobId = (result.metadata as { jobId?: string }).jobId as string
        // The mid job stays alive while its own leaf is unsettled.
        expect((yield* jobs.get(midJobId))?.status).toBe("running")
        yield* waitForPromptRan(promptRan)()
        yield* jobs
          .wait({ id: leafID })
          .pipe(
            Effect.andThen(() =>
              Effect.gen(function* () {
                const woken = reply({ sessionID: midSession! } as SessionPrompt.PromptInput, "mid-aggregated")
                yield* sessions.updateMessage(woken.info)
                yield* Effect.forEach(woken.parts, (part) => sessions.updatePart(part), { discard: true })
              }),
            ),
            Effect.andThen(() => jobs.markDelivered(leafID)),
            Effect.forkScoped,
          )

        yield* Deferred.succeed(leafGate, undefined)
        const waited = yield* jobs.wait({ id: midJobId }).pipe(Effect.timeoutOption("5000 millis"))
        expect(waited._tag).toBe("Some")
        if (waited._tag === "Some") {
          expect(waited.value.info?.status).toBe("completed")
          expect(waited.value.info?.output).toContain("mid-aggregated")
          expect(waited.value.info?.output).not.toContain("mid-waiting")
        }
      }),
    { config: baseConfig },
  )

  it.instance(
    "aborting while parked cascades to the owned background job and the dispatch exits interrupted",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const leafGate = yield* Deferred.make<void>()
        const promptRan = yield* Deferred.make<void>()
        const abort = new AbortController()
        const cancelledSessions: SessionID[] = []
        let midSession: SessionID | undefined
        let leafID = ""

        const promptOps: TaskPromptOps = {
          // Background task contract: mid's session cancel cascades to its children,
          // which in the harness is simulated by cancelling the leaf job directly.
          cancel: (sessionID) =>
            Effect.gen(function* () {
              cancelledSessions.push(sessionID)
              if (leafID) yield* jobs.cancel(leafID)
            }),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              midSession = input.sessionID
              leafID = `abort-leaf-${input.sessionID}`
              yield* jobs
                .start({
                  id: leafID,
                  ownerSessionId: input.sessionID,
                  type: "task",
                  run: Deferred.await(leafGate).pipe(Effect.as("never")),
                })
                .pipe(Effect.ignore)
              yield* Deferred.succeed(promptRan, undefined)
              return reply(input, "waiting-for-leaf")
            }),
        }

        const fiber = yield* Effect.forkScoped(
          def.execute(
            { description: "abort probe", prompt: "work", subagent_type: "general" },
            { ...toolCtx({ chat, assistant, promptOps }), abort: abort.signal },
          ),
        )
        yield* waitForPromptRan(promptRan)()
        // Delivery contract: notify marks delivered no matter how the job settled.
        yield* jobs
          .wait({ id: leafID })
          .pipe(Effect.andThen(() => jobs.markDelivered(leafID)), Effect.forkScoped)
        const during = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("200 millis"))
        expect(during._tag).toBe("None")

        abort.abort()
        const waitForCancel = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if (midSession && cancelledSessions.includes(midSession)) return
            yield* Effect.sleep(10)
          }
          return yield* Effect.fail(new Error("abort-triggered cancel never fired"))
        })
        yield* waitForCancel()
        const waitForLeafCancelled = Effect.fnUntraced(function* () {
          for (let i = 0; i < 100; i++) {
            if ((yield* jobs.get(leafID))?.status === "cancelled") return
            yield* Effect.sleep(10)
          }
          return yield* Effect.fail(new Error("leaf job never cancelled"))
        })
        yield* waitForLeafCancelled()

        const settled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("5000 millis"))
        expect(settled._tag).toBe("Some")
        if (settled._tag === "Some") {
          const exit = settled.value
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        yield* Deferred.succeed(leafGate, undefined)
      }),
    { config: baseConfig },
  )

  it.instance(
    "onParkProgress fires immediately at park entry with the right waiting count, then periodically while parked",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const dispatch = yield* SubagentDispatch
        const leafGate = yield* Deferred.make<void>()
        const promptRan = yield* Deferred.make<void>()
        const progress: Array<{ waiting: number; elapsedMs: number }> = []

        const prepared = yield* dispatch.prepare({
          parentSessionID: chat.id,
          parentMessageID: assistant.id,
          subagentType: "general",
        })
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* jobs
                .start({
                  id: "progress-leaf",
                  ownerSessionId: input.sessionID,
                  type: "task",
                  run: Deferred.await(leafGate).pipe(Effect.as("leaf")),
                })
                .pipe(Effect.ignore)
              yield* Deferred.succeed(promptRan, undefined)
              return reply(input, "waiting-for-leaf")
            }),
        }

        const running = yield* Effect.forkScoped(
          dispatch.runPrepared({
            prepared,
            description: "progress probe",
            prompt: "work",
            promptOps,
            abort: new AbortController().signal,
            onParkProgress: (info) =>
              Effect.sync(() => {
                progress.push(info)
              }),
            parkProgressIntervalMs: 25,
          }),
        )
        yield* waitForPromptRan(promptRan)()
        yield* jobs
          .wait({ id: "progress-leaf" })
          .pipe(
            Effect.andThen(() => jobs.markDelivered("progress-leaf")),
            Effect.forkScoped,
          )
        // Hold the park open across several ticks, then settle.
        yield* Effect.sleep(250)
        expect(progress[0]).toEqual({ waiting: 1, elapsedMs: 0 })
        expect(progress.length).toBeGreaterThanOrEqual(3)
        yield* Deferred.succeed(leafGate, undefined)
        const settled = yield* Fiber.await(running).pipe(Effect.timeoutOption("5000 millis"))
        expect(settled._tag).toBe("Some")
      }),
    { config: baseConfig },
  )

  it.instance(
    "dispatch with no owned background jobs skips the park and returns the first-turn output unchanged",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const dispatch = yield* SubagentDispatch
        const progress: Array<{ waiting: number; elapsedMs: number }> = []
        const prepared = yield* dispatch.prepare({
          parentSessionID: chat.id,
          parentMessageID: assistant.id,
          subagentType: "general",
        })
        const result = yield* dispatch.runPrepared({
          prepared,
          description: "plain probe",
          prompt: "work",
          promptOps: makeStub({ text: "plain-done" }),
          abort: new AbortController().signal,
          onParkProgress: (info) =>
            Effect.sync(() => {
              progress.push(info)
            }),
          parkProgressIntervalMs: 25,
        })
        expect(result.output).toContain("plain-done")
        expect(progress).toEqual([])
      }),
    { config: baseConfig },
  )
})
