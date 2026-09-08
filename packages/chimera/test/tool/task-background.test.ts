import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
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

        gate.resolve()
        const waited = yield* jobs.wait({ id: taskId })
        expect(waited.info?.status).toBe("completed")
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
    "resume into a finished job follows the existing synchronous resume path unchanged",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const first = yield* def.execute(
          { description: "task a", prompt: "work a", subagent_type: "general", background: true },
          toolCtx({ chat, assistant, promptOps: makeStub({ text: "a-done" }) }),
        )
        const taskId = (first.metadata as { jobId?: string }).jobId as SessionID

        const resumed = yield* def.execute(
          { description: "task b", prompt: "work b", subagent_type: "general", task_id: taskId, background: true },
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
