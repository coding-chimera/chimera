import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/agent/background-job"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Auth } from "@/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/contracts/session-ids"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SubagentDispatch, type SubagentPromptOps } from "../../src/agent/subagent-dispatch"
import { Provider } from "../../src/provider/provider"
import { Truncate } from "@/tool/truncate"
import { OrchestrateTool } from "@/tool/orchestrate"
import { TaskCancelTool } from "@/tool/task-cancel"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * Background-mode coverage for `orchestrate`:
 * - the program-level job returns a start receipt immediately and keeps running,
 * - every settled subagent injects a `<orchestrate_worker_result>` notification,
 * - the program result is injected once, with delivery marked only afterwards,
 * - task_cancel / instance dispose cascade to the program and its subagents.
 */

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
    ConfigSubagentRouting.defaultLayer,
    authLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    DelegationLimiter.defaultLayer,
    BackgroundJob.defaultLayer,
    Provider.defaultLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const seed = Effect.fn("OrchestrateBackgroundTest.seed")(function* () {
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
  prompt?: (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts>
  cancel?: (sessionID: SessionID) => Effect.Effect<void>
  inject?: (input: { sessionID: SessionID; text: string }) => void
}): SubagentPromptOps {
  return {
    cancel: (sessionID) => opts?.cancel?.(sessionID) ?? Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => opts?.prompt?.(input) ?? Effect.succeed(reply(input, "done")),
    injectSynthetic: (input) =>
      Effect.sync(() => {
        opts?.inject?.(input)
        return reply(
          { ...input, parts: [{ type: "text" as const, text: input.text }] } as SessionPrompt.PromptInput,
          input.text,
        )
      }),
  }
}

const toolCtx = (opts: { chat: Session.Info; assistant: MessageV2.Assistant; promptOps: SubagentPromptOps }) => ({
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

const waitUntil = (predicate: () => boolean, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return
      yield* Effect.sleep(25)
    }
    return yield* Effect.fail(new Error(message))
  })

const awaitWithTimeout = <A, E>(deferred: Deferred.Deferred<A, E>, message: string) =>
  Deferred.await(deferred).pipe(
    Effect.timeoutOption("20000 millis"),
    Effect.flatMap((option) =>
      option._tag === "Some" ? Effect.succeed(option.value) : Effect.fail(new Error(message)),
    ),
  )

const CODE = [
  'orche.log("phase one");',
  'const result = await orche.agent({ prompt: "alpha work", label: "alpha" });',
  "return { ok: true, result };",
].join("\n")

describe("tool.orchestrate background", () => {
  it.instance(
    "returns a start receipt immediately and injects per-worker plus final notifications",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* OrchestrateTool
        const def = yield* tool.init()
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const injected: string[] = []

        const promptOps = makeStub({
          inject: (input) => injected.push(input.text),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined).pipe(Effect.ignore)
              yield* Deferred.await(gate)
              return reply(input, "alpha-done")
            }),
        })

        const result = yield* def.execute(
          { code: CODE, description: "background fan-out", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )

        expect(result.metadata).toMatchObject({ background: true })
        const jobId = (result.metadata as { jobId?: string }).jobId
        expect(typeof jobId).toBe("string")
        if (!jobId) throw new Error("background receipt did not carry a job id")
        expect(result.output).toContain('"job_id"')
        expect(result.output).toContain(jobId)
        expect(result.output).toContain("<orchestrate_worker_result>")

        const running = yield* jobs.get(jobId)
        expect(running?.status).toBe("running")
        expect(running?.type).toBe("orchestrate")
        expect(running?.ownerSessionId).toBe(chat.id)
        expect(running?.metadata?.background).toBe(true)
        expect(running?.delivery).toBe("pending")

        yield* awaitWithTimeout(started, "background orchestrate never dispatched its first subagent")
        yield* Deferred.succeed(gate, undefined)

        const waited = yield* jobs.wait({ id: jobId })
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toContain('"ok": true')
        expect(waited.info?.output).toContain("phase one")

        yield* waitUntil(
          () => injected.some((text) => text.includes("<orchestrate_worker_result>")),
          "worker completion notification was never injected",
        )
        yield* waitUntil(
          () => injected.some((text) => text.includes("<orchestrate_result>")),
          "program completion notification was never injected",
        )

        const worker = injected.find((text) => text.includes("<orchestrate_worker_result>"))
        expect(worker).toContain("(orchestrate worker completed)")
        expect(worker).toContain("index: 1")
        expect(worker).toContain("label: alpha")
        expect(worker).toContain("status: completed")
        expect(worker).toContain("summary: alpha-done")

        const final = injected.find((text) => text.includes("<orchestrate_result>"))
        expect(final).toContain(`task_id: ${jobId}`)
        expect(final).toContain("(orchestrate program completed)")
        expect(final).toContain('"ok": true')
        expect(final).toContain("phase one")
        // Per-worker notifications arrive as each worker settles, before the
        // program-level summary.
        expect(injected.indexOf(worker!)).toBeLessThan(injected.indexOf(final!))

        let delivered = false
        for (let attempt = 0; attempt < 400; attempt++) {
          if ((yield* jobs.get(jobId))?.delivery === "delivered") {
            delivered = true
            break
          }
          yield* Effect.sleep(25)
        }
        expect(delivered).toBe(true)
        const quiet = yield* jobs.waitOwnerQuiescent(chat.id).pipe(Effect.as("quiet"), Effect.timeoutOption("500 millis"))
        expect(quiet._tag).toBe("Some")

        expect(yield* sessions.children(chat.id)).toHaveLength(1)
      }),
    { config: baseConfig },
  )

  it.instance(
    "task_cancel cancels the program job and cascades to its running subagents",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* OrchestrateTool
        const def = yield* tool.init()
        const cancelTool = yield* TaskCancelTool
        const cancelDef = yield* cancelTool.init()
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const cancelled: SessionID[] = []

        const promptOps = makeStub({
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined).pipe(Effect.ignore)
              yield* Deferred.await(gate)
              return reply(input, "late")
            }),
          cancel: (sessionID) =>
            Effect.sync(() => {
              cancelled.push(sessionID)
            }).pipe(Effect.andThen(Deferred.succeed(gate, undefined)), Effect.asVoid),
        })

        const startedResult = yield* def.execute(
          { code: CODE, description: "cancellable program", background: true },
          toolCtx({ chat, assistant, promptOps }),
        )
        const jobId = (startedResult.metadata as { jobId?: string }).jobId
        if (!jobId) throw new Error("background receipt did not carry a job id")
        yield* awaitWithTimeout(started, "background orchestrate never dispatched its first subagent")

        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(1)
        const childID = children[0]!.id

        const result = yield* cancelDef.execute({ task_id: jobId }, cancelCtx(chat.id))
        expect(result.output).toContain("(cancelled)")
        expect(result.output).toContain("orchestration program")
        expect((yield* jobs.get(jobId))?.status).toBe("cancelled")
        expect(cancelled).toContain(childID)
      }),
    { config: baseConfig },
  )

  it.instance(
    "the background kill-switch rejects background=true with a clear error and starts nothing",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* OrchestrateTool
        const def = yield* tool.init()

        const exit = yield* def
          .execute(
            { code: "return 1", description: "blocked background program", background: true },
            toolCtx({ chat, assistant, promptOps: makeStub() }),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.prettyErrors(exit.cause).join("\n")
          expect(message).toContain("kill-switch")
          expect(message).toContain("background_subagents is false")
        }
        expect((yield* jobs.list()).filter((job) => job.status === "running")).toHaveLength(0)
      }),
    { config: { ...baseConfig, delegation: { background_subagents: false } } },
  )
})

describe("tool.orchestrate background dispose", () => {
  it.live("instance dispose interrupts the program and cancels its running subagents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ config: baseConfig })
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const cancelledSignal = yield* Deferred.make<void>()
      const cancelled: SessionID[] = []
      let childID: SessionID | undefined

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* OrchestrateTool
          const def = yield* tool.init()
          const promptOps = makeStub({
            prompt: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined).pipe(Effect.ignore)
                yield* Deferred.await(gate)
                return reply(input, "late")
              }),
            cancel: (sessionID) =>
              Effect.sync(() => {
                cancelled.push(sessionID)
              }).pipe(
                Effect.andThen(Deferred.succeed(cancelledSignal, undefined)),
                Effect.asVoid,
              ),
          })

          const result = yield* def.execute(
            { code: CODE, description: "dispose program", background: true },
            toolCtx({ chat, assistant, promptOps }),
          )
          const jobId = (result.metadata as { jobId?: string }).jobId
          if (!jobId) throw new Error("background receipt did not carry a job id")
          yield* awaitWithTimeout(started, "background orchestrate never dispatched its first subagent")
          childID = (yield* sessions.children(chat.id))[0]?.id
          expect((yield* jobs.get(jobId))?.status).toBe("running")
        }),
      )

      yield* Effect.promise(() => disposeAllInstances())
      yield* Deferred.await(cancelledSignal).pipe(
        Effect.timeoutOption("5000 millis"),
        Effect.flatMap((option) =>
          option._tag === "Some" ? Effect.void : Effect.fail(new Error("dispose never cancelled the program's subagent")),
        ),
      )
      expect(childID).toBeDefined()
      expect(cancelled).toContain(childID!)
      expect(new Set(cancelled).size).toBe(1)
      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )
})

describe("orchestrate permission parity", () => {
  test("denies orchestrate whenever the subagent cannot task", () => {
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: { permission: [] } as unknown as Agent.Info,
    })
    expect(rules).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "chimera_swarm", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "orchestrate", pattern: "*", action: "deny" })
  })

  test("keeps orchestrate available when the subagent can task", () => {
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: { permission: [{ permission: "task", pattern: "*", action: "allow" }] } as unknown as Agent.Info,
    })
    expect(rules.some((rule) => rule.permission === "orchestrate")).toBe(false)
  })
})