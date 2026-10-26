import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/contracts/session-ids"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { BackgroundJob } from "../../src/agent/background-job"
import {
  makeOrchestrationBindings,
  type OrchestrationAgentEvent,
  type OrchestrationAskInput,
  type OrchestrationLimits,
} from "@/orchestrate/host-bindings"
import type { JsonValue } from "@/orchestrate/protocol"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

/**
 * Host-binding coverage for `orche.agent`. The prompt layer is a controllable
 * mock: no real child process or LLM is involved, while Agent/Config/Session/
 * DelegationLimiter/BackgroundJob are the real layers so dispatch behavior
 * (session creation, depth cap, approval plumbing) is exercised for real.
 */

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const testProvider = ProviderTest.fake({
  model: ProviderTest.model({
    providerID: ProviderID.make("test"),
    id: ModelID.make("test-model"),
    variants: { max: {} },
  }),
})

type PromptFn = (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts>
type CancelFn = (sessionID: SessionID) => Effect.Effect<void>

let promptFn: PromptFn = (input) => Effect.succeed(reply(input, "done"))
let cancelFn: CancelFn = () => Effect.void
let promptInputs: SessionPrompt.PromptInput[] = []
let asks: OrchestrationAskInput[] = []
let events: OrchestrationAgentEvent[] = []

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  extra?: { structured?: unknown; error?: MessageV2.Assistant["error"] },
): MessageV2.WithParts {
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
      ...(extra?.structured === undefined ? {} : { structured: extra.structured }),
      ...(extra?.error === undefined ? {} : { error: extra.error }),
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

const authLayer = Layer.mock(Auth.Service)({
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
  set: () => Effect.void,
  remove: () => Effect.void,
})

const promptLayer = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: (sessionID) => Effect.suspend(() => cancelFn(sessionID)),
    prompt: (input) =>
      Effect.suspend(() => {
        promptInputs.push(input)
        return promptFn(input)
      }),
    loop: () => Effect.die(new Error("unused")),
    shell: () => Effect.die(new Error("unused")),
    command: () => Effect.die(new Error("unused")),
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    injectSynthetic: () => Effect.die(new Error("unused")),
    kickGoalContinuation: () => Effect.succeed(false),
    resumeGoalOnOpen: () => Effect.succeed(false),
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    ConfigSubagentRouting.defaultLayer,
    authLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    DelegationLimiter.defaultLayer,
    BackgroundJob.defaultLayer,
    testProvider.layer,
    promptLayer,
  ),
)

afterEach(async () => {
  promptFn = (input) => Effect.succeed(reply(input, "done"))
  cancelFn = () => Effect.void
  promptInputs = []
  asks = []
  events = []
  await disposeAllInstances()
})

const seed = Effect.fn("OrchestrateAgentsTest.seed")(function* (title = "Orchestrate parent", parentID?: SessionID) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title, ...(parentID ? { parentID } : {}) })
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
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

const bind = Effect.fn("OrchestrateAgentsTest.bind")(function* (
  parent: { chat: Session.Info; assistant: MessageV2.Assistant },
  limits: OrchestrationLimits,
  signal?: AbortSignal,
) {
  return yield* makeOrchestrationBindings(
    {
      parentSessionID: parent.chat.id,
      parentMessageID: parent.assistant.id,
      signal: signal ?? new AbortController().signal,
      ask: (input) =>
        Effect.sync(() => {
          asks.push(input)
        }),
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event)
        }),
    },
    limits,
  )
})

function callAgent(binding: (args: JsonValue) => JsonValue | Promise<JsonValue>, args: JsonValue) {
  return Effect.promise(() => Promise.resolve(binding(args)))
}

describe("orchestrate host bindings", () => {
  it.instance("enforces maxConcurrent with FIFO slots", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let active = 0
      let maxActive = 0

      promptFn = (input) =>
        Effect.gen(function* () {
          active += 1
          maxActive = Math.max(maxActive, active)
          if (active === 2) yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          active -= 1
          return reply(input, "done")
        })

      const orche = yield* bind(parent, { maxTotalAgents: 10, maxConcurrent: 2 })
      const fiber = yield* Effect.promise(() =>
        Promise.all(
          [1, 2, 3, 4].map((n) => Promise.resolve(orche.bindings.orche.agent({ prompt: `task-${n}` }))),
        ),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      expect(maxActive).toBe(2)
      yield* Deferred.succeed(release, undefined)
      const results = yield* Fiber.join(fiber)
      expect(results).toEqual([{ text: "done" }, { text: "done" }, { text: "done" }, { text: "done" }])
      expect(maxActive).toBe(2)
      expect(asks).toHaveLength(4)
      yield* orche.disposeAll()
    }),
  )

  it.instance("rejects calls beyond maxTotalAgents", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const orche = yield* bind(parent, { maxTotalAgents: 1, maxConcurrent: 4 })
      const agent = orche.bindings.orche.agent

      expect(yield* callAgent(agent, { prompt: "first" })).toEqual({ text: "done" })
      const rejection = yield* Effect.promise(() =>
        Promise.resolve(agent({ prompt: "second" })).then(
          () => "resolved",
          (error: Error) => error.message,
        ),
      )
      expect(rejection).toContain("maxTotalAgents")
      yield* orche.disposeAll()
    }),
  )

  it.instance("returns null when the subagent fails", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      promptFn = (input) =>
        Effect.succeed(
          reply(input, "partial", { error: { name: "UnknownError", data: { message: "model exploded" } } }),
        )
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

      expect(yield* callAgent(orche.bindings.orche.agent, { prompt: "fails" })).toBeNull()
      expect(events.at(-1)?.status).toBe("failed")
      yield* orche.disposeAll()
    }),
  )

  it.instance("rejects the binding on host-side preparation errors", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

      const exit = yield* callAgent(orche.bindings.orche.agent, {
        prompt: "unknown agent",
        agent: "no-such-agent",
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = exit.cause.reasons.map((reason) => String(reason)).join(" ")
        expect(message).toContain("Unknown agent type")
      }
      yield* orche.disposeAll()
    }),
  )

  it.instance("disposeAll aborts and settles in-flight subagents", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const cancelled: SessionID[] = []

      promptFn = (input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(gate)
          return reply(input, "late")
        })
      cancelFn = (sessionID) =>
        Effect.sync(() => {
          cancelled.push(sessionID)
        }).pipe(Effect.andThen(Deferred.succeed(gate, undefined)), Effect.asVoid)

      const controller = new AbortController()
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 }, controller.signal)
      const fiber = yield* callAgent(orche.bindings.orche.agent, { prompt: "slow" }).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* orche.disposeAll()
      expect(cancelled.length).toBeGreaterThan(0)
      expect(events.at(-1)?.status).toBe("aborted")
      expect(yield* Fiber.join(fiber)).toBeNull()
    }),
  )

  it.instance("passes schema through to the child prompt and returns structured output", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      }
      const structured = { answer: "42" }
      promptFn = (input) => Effect.succeed(reply(input, "", { structured }))
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

      const result = yield* callAgent(orche.bindings.orche.agent, {
        prompt: "structured task",
        schema,
        label: "structured",
      })

      expect(result).toEqual({ structured })
      expect(promptInputs).toHaveLength(1)
      expect(promptInputs[0].format).toEqual({ type: "json_schema", schema, retryCount: 2 })
      expect(events.map((event) => event.type)).toEqual(["start", "finish"])
      expect(events[0].label).toBe("structured")
      yield* orche.disposeAll()
    }),
  )

  it.instance(
    "denies orchestrate on children created at the depth cap",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

        yield* callAgent(orche.bindings.orche.agent, { prompt: "capped child" })

        const children = yield* sessions.children(parent.chat.id)
        expect(children).toHaveLength(1)
        const rules = children[0].permission ?? []
        expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "task" })
        expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "chimera_swarm" })
        expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "orchestrate" })
        expect(promptInputs[0].tools).toMatchObject({
          task: false,
          chimera_swarm: false,
          orchestrate: false,
        })
        yield* orche.disposeAll()
      }),
    { config: { delegation: { max_depth: 2 } } },
  )

  it.instance("uses the temp instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      expect(test.directory).toContain("opencode-test-")
    }),
  )
})