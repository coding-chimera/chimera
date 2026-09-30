import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as Stream from "effect/Stream"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import type { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ContextEpoch } from "../../src/session/context-epoch"
import { Permission } from "../../src/permission"
import { PermissionPersist } from "../../src/permission/persist"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideInstance, reloadTestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
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
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

// Stands in for the DWS workflow transport: constructible without network
// access, and doStream terminates immediately so LLM.stream can be drained
// while the attached approvalHandler is exercised directly.
class StubWorkflowModel extends GitLabWorkflowLanguageModel {
  constructor(workingDirectory: string) {
    super(
      "duo-workflow-test",
      {
        instanceUrl: "https://gitlab.invalid",
        getHeaders: () => ({}),
        provider: "gitlab.workflow",
      },
      { workingDirectory },
    )
  }

  override async doStream() {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: undefined, reasoning: undefined },
        },
      },
    ]
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      }),
    }
  }
}

let activeModel: StubWorkflowModel

const workflowProvider = Layer.effect(
  Provider.Service,
  Effect.gen(function* () {
    const real = yield* Provider.Service
    return Provider.Service.of({
      ...real,
      getLanguage: () => Effect.succeed(activeModel),
    })
  }),
).pipe(Layer.provide(Provider.defaultLayer))

const env = Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer, LLM.layer).pipe(
  Layer.provideMerge(workflowProvider),
  Layer.provideMerge(Permission.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(ContextEpoch.defaultLayer),
)

const it = testEffect(env)

afterEach(async () => {
  await disposeAllInstances()
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

const streamInput = (sessionID: SessionID, permission: Permission.Ruleset | undefined, model: Provider.Model) => ({
  user: {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ref.providerID, modelID: ref.modelID },
  } satisfies MessageV2.User,
  sessionID,
  model,
  agent: { name: "build", mode: "primary", options: {}, permission: [] } satisfies Agent.Info,
  permission,
  system: [],
  messages: [{ role: "user" as const, content: "run the workflow" }],
  tools: {},
})

const drainWorkflowStream = (input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    yield* llm.stream(input).pipe(Stream.runDrain)
  })

describe("workflow_tool_approval session permission persistence", () => {
  it.live("always reply persists to session slots and skips the ask after a restart", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: cfg })
      const run = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))

      const sessionID = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const chat = yield* sessions.create({})

        activeModel = new StubWorkflowModel(dir)
        yield* drainWorkflowStream(streamInput(chat.id, undefined, model)).pipe(run)
        const handler = activeModel.approvalHandler
        if (!handler) throw new Error("approvalHandler was not attached to the workflow model")

        // Phase 1: fresh session, no persisted rules -> the handler must ask.
        const asked = yield* Effect.promise(() => handler([{ name: "bash", args: "{}" }])).pipe(Effect.forkScoped)
        const pending = yield* waitForPending(1)
        expect(pending[0].permission).toBe("workflow_tool_approval")
        yield* PermissionPersist.replyAndPersist({ requestID: pending[0].id, reply: "always" })
        expect(yield* Fiber.join(asked)).toEqual({ approved: true })
        expect((yield* sessions.get(chat.id)).permission).toEqual([
          { permission: "workflow_tool_approval", pattern: "bash", action: "allow" },
        ])
        return chat.id
      }).pipe(run)

      // Simulated restart: drop all per-directory instance state so the
      // in-memory approved ruleset is rebuilt (empty) from scratch.
      yield* Effect.promise(() => reloadTestInstance({ directory: dir }))

      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const provider = yield* Provider.Service
        const permission = yield* Permission.Service
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const info = yield* sessions.get(sessionID)

        // A fresh model instance has no in-process approvedToolsForSession
        // shortcut, so only the persisted session rule can skip the ask.
        activeModel = new StubWorkflowModel(dir)
        yield* drainWorkflowStream(streamInput(sessionID, info.permission, model)).pipe(run)
        const handler = activeModel.approvalHandler
        if (!handler) throw new Error("approvalHandler was not attached to the workflow model")

        const approved = yield* Effect.promise(() => handler([{ name: "bash", args: "{}" }]))
        expect(approved).toEqual({ approved: true })
        expect(yield* permission.list()).toHaveLength(0)
      }).pipe(run)
    }),
  )
})
