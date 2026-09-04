import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as ModelTelemetry from "../../src/agent/model-telemetry"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Auth } from "@/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { Permission } from "../../src/permission"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ModelNotFoundError, Provider } from "../../src/provider/provider"
import { WorkspaceID } from "../../src/control-plane/schema"
import { disposeAllInstances } from "../fixture/fixture"
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

const delegationConfig = {
  delegation: {
    model_profiles: {
      flash: { model: "test/test-model", variant: "max", description: "Flash profile" },
      luna: { model: "test/test-model", description: "Luna profile" },
    },
    routes: { general: "luna" },
  },
  provider: { test: providerFixture },

}
const disabledSchedulingConfig = {
  ...delegationConfig,
  delegation: {
    ...delegationConfig.delegation,
    scheduling: { enabled: false },
  },
}

const twoProviderConfig = {
  ...delegationConfig,
  provider: {
    test: {
      ...providerFixture,
      models: {
        "test-model": {
          ...providerFixture.models["test-model"],
          capability_model_id: "shared-test-model",
        },
      },
    },
    second: {
      ...providerFixture,
      id: "second",
      name: "Second",
      models: {
        "second-model": {
          ...providerFixture.models["test-model"],
          id: "second-model",
          name: "Second Model",
          capability_model_id: "shared-test-model",
        },
      },
    },
  },
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
    Provider.defaultLayer,
  ),
)

const failingSessionLayer = Layer.effect(
  Session.Service,
  Effect.gen(function* () {
    const inner = yield* Session.Service
    return Session.Service.of({
      ...inner,
      get: (id: SessionID) =>
        id === SessionID.make("ses_boom") ? Effect.die(new Error("database exploded")) : inner.get(id),
    })
  }),
).pipe(Layer.provide(Session.defaultLayer))

const failIt = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    routingLayer,
    authLayer,
    CrossSpawnSpawner.defaultLayer,
    failingSessionLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    DelegationLimiter.defaultLayer,
    Provider.defaultLayer,
  ),
)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned", agentName?: string, parentID?: SessionID) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title, ...(agentName ? { agent: agentName } : {}), ...(parentID ? { parentID } : {}) })
  const messageAgent = agentName ?? "build"
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: messageAgent,
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: messageAgent,
    agent: messageAgent,
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

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string; tokens?: MessageV2.TokenUsage }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.tokens)
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string, tokens?: MessageV2.TokenUsage): MessageV2.WithParts {
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
      tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)
        expect(first).toContain("Concrete file paths do not disqualify delegation.")
        expect(first).toContain("single, straightforward read or search")
        expect(first).toContain("Do not fan out by item count alone.")
        expect(first).not.toContain("If you want to read a specific file path")

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      expect(seen?.sessionID).toBe(child.id)
      expect(routingActivity).toHaveLength(0)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session and remains interrupted when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(routingActivity).toHaveLength(1)
    }),
  )

  it.instance("execute cancels without starting the child prompt when already aborted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      let prompted = false
      abort.abort()

      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompted = true
            return reply(input, "unexpected")
          }),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const exit = yield* Fiber.await(fiber)
      const kids = yield* sessions.children(chat.id)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(kids).toHaveLength(1)
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(kids[0]?.id)
      expect(routingActivity).toHaveLength(1)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
      expect(routingActivity).toEqual([chat.projectID])
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "subagent_model_prefer",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "subagent_model_suppress",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "allow",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ])
        expect(seen?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("execute inherits parent agent deny rules", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Plan parent", "plan")
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "plan",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId)
      expect(child.permission).toContainEqual({
        permission: "edit",
        pattern: "*",
        action: "deny",
      })
    }),
  )
  it.instance(
    "execute prefers an explicit model_profile over the delegation route",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model_profile: "flash",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({ providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") })
        expect(seen?.variant).toBe("max")
        expect(result.metadata.model).toEqual({
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test-model"),
          variant: "max",
        })
        expect(result.metadata.execution.modelProfile).toBe("flash")
        expect(result.metadata.execution.source).toBe("request-profile")
        expect(result.metadata.execution.resumed).toBe(false)
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.agent).toBe("general")
        expect(child.model).toEqual({
          id: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          variant: "max",
        })
      }),
    { config: delegationConfig },

  )

  it.instance(
    "execute applies the delegation route profile without an explicit model_profile",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(seen?.model).toEqual({ providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") })
        expect(seen?.variant).toBe("max")
        expect(result.metadata.execution.modelProfile).toBe("flash")
        expect(result.metadata.execution.source).toBe("role-route")
        expect(asks.map((item) => item.permission)).toEqual(["task", "task_profile"])
        expect(asks[1]?.patterns).toEqual(["flash"])
      }),
    {
      config: {
        delegation: {
          model_profiles: { flash: { model: "test/test-model" } },
          routes: { general: "flash" },
        },
        provider: { test: providerFixture },
      },
    },
  )

  it.instance("execute falls back to the parent model without delegation config", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.model.providerID).toBe(ref.providerID)
      expect(result.metadata.model.modelID).toBe(ref.modelID)
      expect(result.metadata.model.variant).toBeUndefined()
      expect(result.metadata.execution.modelProfile).toBeUndefined()
      expect(result.metadata.execution.source).toBe("parent")
      expect(result.metadata.execution.resumed).toBe(false)
    }),
  )

  it.instance("execute asks for task and task_profile when model_profile is set", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model_profile: "flash",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
      expect(calls[1]).toEqual({
        permission: "task_profile",
        patterns: ["flash"],
        always: ["flash"],
        metadata: {
          description: "inspect bug",
          model_profile: "flash",
        },
      })
    }),
    {
      config: {
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        provider: { test: providerFixture },
      },
    },
  )

  it.instance(
    "execute still asks for task_profile when agent selection is bypassed",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
        const promptOps = stubOps()

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model_profile: "flash",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(asks.map((item) => item.permission)).toEqual(["task_profile"])
        expect(asks[0]?.patterns).toEqual(["flash"])
      }),
    {
      config: {
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        provider: { test: providerFixture },
      },
    },
  )

  it.instance(
    "execute fails before creating a child when the profile variant is not advertised",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let prompted = false
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              prompted = true
              return reply(input, "unexpected")
            }),
        }

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              model_profile: "flash",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(0)
        expect(prompted).toBe(false)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("does not advertise variant")
        }
      }),
    {
      config: {
        delegation: {
          model_profiles: { flash: { model: "test/test-model", variant: "bogus" } },
        },
        provider: { test: providerFixture },

      },
    },
  )

  it.instance("execute fails with a clear error for an unknown model profile", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model_profile: "nope",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("Unknown model profile: nope")
      }
    }),
    {
      config: {
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
      },
    },
  )

  it.instance("execute fails before creating a child when the profile model is not registered", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model_profile: "flash",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(0)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
    {
      config: {
        delegation: { model_profiles: { flash: { model: "ghost/ghost-model", variant: "max" } } },
      },
    },
  )

  it.instance("execute resumes a locked child and reports the resume source", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { id: ref.modelID, providerID: ref.providerID },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.execution.resumed).toBe(true)
      expect(result.metadata.execution.source).toBe("resume")
      expect(result.metadata.model.providerID).toBe(ref.providerID)
      expect(result.metadata.model.modelID).toBe(ref.modelID)
      expect(result.metadata.execution.modelProfile).toBeUndefined()
    }),
  )

  it.instance("execute fails to resume a child created for a different agent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "explore",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).join("\n")).toContain(
          "Cannot resume session: it was created for agent general, not explore",
        )
      }
    }),
  )

  it.instance("execute fails to resume a child locked to a different model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test") },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
            model_profile: "luna",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("Cannot resume session: it is locked to model")
      }
    }),
    {
      config: {
        delegation: { model_profiles: { luna: { model: "test/other-model" } } },
        provider: {
          test: {
            ...providerFixture,
            models: {
              ...providerFixture.models,
              "other-model": { ...providerFixture.models["test-model"], id: "other-model", name: "Other Model" },
            },
          },
        },
      },
    },
  )

  it.instance("execute keeps child permissions identical when an explicit model_profile is used", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Plan parent", "plan")
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const plain = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "plan",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const profiled = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model_profile: "flash",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "plan",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const plainChild = yield* sessions.get(plain.metadata.sessionId)
      const profiledChild = yield* sessions.get(profiled.metadata.sessionId)
      expect(profiledChild.permission).toEqual(plainChild.permission)
      expect(profiledChild.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    }),
    { config: delegationConfig },

  )

  it.instance("execute fails to resume a child owned by a different parent session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const foreignParent = yield* sessions.create({ title: "Foreign parent" })
      const foreignChild = yield* sessions.create({
        parentID: foreignParent.id,
        title: "Foreign child",
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: foreignChild.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.prettyErrors(exit.cause).join("\n")
        expect(message).toContain("Cannot resume session")
        expect(message).toContain("different parent session")
      }
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      const untouched = yield* sessions.get(foreignChild.id)
      expect(untouched.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
    }),
  )

  it.instance("execute fails to resume a child bound to a different workspace", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Child in other workspace",
        workspaceID: WorkspaceID.ascending()
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.prettyErrors(exit.cause).join("\n")
        expect(message).toContain("Cannot resume session")
        expect(message).toContain("different workspace")
      }
    }),
  )

  it.instance("execute keeps delegation allowed when resuming a child below the depth cap", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.execution.resumed).toBe(true)
      const resumed = yield* sessions.get(child.id)
      expect(resumed.permission).not.toContainEqual({ pattern: "*", action: "deny", permission: "task" })
      expect(resumed.permission).not.toContainEqual({ pattern: "*", action: "deny", permission: "chimera_swarm" })
      expect(resumed.permission).toContainEqual({ pattern: "*", action: "deny", permission: "subagent_model_prefer" })
      expect(resumed.permission).toContainEqual({ pattern: "*", action: "deny", permission: "subagent_model_suppress" })
      expect(seen?.tools?.task).toBeUndefined()
      expect(seen?.tools?.chimera_swarm).toBeUndefined()
    }),
  )

  it.instance("execute does not duplicate depth-cap delegation denies on repeated resumes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const intermediate = yield* seed("Intermediate child", "general", chat.id)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const params = {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      }
      const toolCtx = () => ({
        sessionID: intermediate.chat.id,
        messageID: intermediate.assistant.id,
        agent: "general",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps() },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const first = yield* def.execute(params, toolCtx())
      const second = yield* def.execute({ ...params, task_id: first.metadata.sessionId }, toolCtx())

      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
      const child = yield* sessions.get(first.metadata.sessionId)
      const taskDenies = child.permission?.filter((rule) => rule.permission === "task" && rule.action === "deny") ?? []
      const swarmDenies =
        child.permission?.filter((rule) => rule.permission === "chimera_swarm" && rule.action === "deny") ?? []
      expect(taskDenies).toHaveLength(1)
      expect(swarmDenies).toHaveLength(1)
    }),
  )

  it.instance(
    "serializes concurrent dispatches when the delegation concurrency budget is exhausted",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const started: string[] = []
        let release!: () => void
        const gate = new Promise<void>((done) => {
          release = done
        })
        const blockingOps = (tag: string): TaskPromptOps => ({
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              started.push(tag)
              yield* Effect.promise(() => gate)
              return reply(input, "done")
            }),
        })
        const toolCtx = (ops: TaskPromptOps) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })

        const first = yield* def
          .execute({ description: "task a", prompt: "work a", subagent_type: "general" }, toolCtx(blockingOps("a")))
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        expect(started).toEqual(["a"])

        const second = yield* def
          .execute({ description: "task b", prompt: "work b", subagent_type: "general" }, toolCtx(blockingOps("b")))
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        expect(started).toEqual(["a"])

        release()
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(started).toEqual(["a", "b"])
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )

  it.instance("execute resume only appends deny rules and never adds allows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const original = [
        { permission: "bash", pattern: "*", action: "allow" as const },
        { permission: "task", pattern: "*", action: "deny" as const },
      ]
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", permission: original })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const resumed = yield* sessions.get(child.id)
      const allows = resumed.permission?.filter((rule) => rule.action === "allow") ?? []
      expect(allows).toHaveLength(1)
      expect(allows[0]).toEqual({ permission: "bash", pattern: "*", action: "allow" })
      const taskDenies = resumed.permission?.filter((rule) => rule.permission === "task" && rule.action === "deny") ?? []
      expect(taskDenies).toHaveLength(1)
    }),
  )

  it.instance("description lists non-denied delegation model profiles", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const registry = yield* ToolRegistry.Service
      const description =
        (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

      expect(description).toContain("Available model profiles:")
      expect(description).toContain("- flash -> test/test-model (variant: max): Flash profile")
      expect(description).toContain("- luna -> test/test-model: Luna profile")
      expect(description).toContain("Direct model selection:")
      expect(description).toContain("- Pass model as an exact provider/model route.")
      expect(description).toContain("- Use subagent_model_routes to inspect concrete current routes for a model identity.")
    }),
    { config: delegationConfig },

  )

  it.instance("description hides denied model profiles from the caller", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const registry = yield* ToolRegistry.Service
      const description =
        (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

      expect(description).toContain("Available model profiles:")
      expect(description).not.toContain("- flash")
      expect(description).toContain("- luna -> test/test-model: Luna profile")
    }),
    {
      config: {
        ...delegationConfig,
        permission: { task_profile: { flash: "deny" } },
      },
    },

  )

  it.instance("execute resume applies depth-cap delegation denies via the atomic slot primitive", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const intermediate = yield* seed("Intermediate child", "general", chat.id)
      const child = yield* sessions.create({
        parentID: intermediate.chat.id,
        title: "Existing grandchild",
        agent: "general",
        permission: [
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "allow" },
        ],
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: intermediate.chat.id,
          messageID: intermediate.assistant.id,
          agent: "general",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const resumed = yield* sessions.get(child.id)
      const rules = resumed.permission ?? []
      expect(Permission.evaluate("task", "*", rules).action).toBe("deny")
      expect(Permission.evaluate("chimera_swarm", "*", rules).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", rules).action).toBe("allow")
      expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "allow" })
    }),
  )

  it.instance("execute fails to resume a child bound to a different project", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const foreignProject = ProjectID.make("foreign-project")
      const foreignChild = SessionID.make("ses_foreign_project")
      Database.use((db) =>
        db
          .insert(ProjectTable)
          .values({
            id: foreignProject,
            worktree: `/${foreignProject}`,
            sandboxes: [],
            time_created: 1_000_000,
            time_updated: 1_000_000,
          })
          .run(),
      )
      Database.use((db) =>
        db
          .insert(SessionTable)
          .values({
            id: foreignChild,
            project_id: foreignProject,
            parent_id: chat.id,
            slug: foreignChild,
            directory: `/${foreignProject}`,
            title: "Foreign project child",
            version: "test",
            permission: [{ permission: "bash", pattern: "*", action: "allow" }],
            time_created: 1_000_000,
            time_updated: 1_000_000,
          })
          .run(),
      )
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: foreignChild,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.prettyErrors(exit.cause).join("\n")
        expect(message).toContain("Cannot resume session")
        expect(message).toContain("different project")
      }
      expect(prompted).toBe(false)
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(foreignChild)
      const untouched = yield* sessions.get(foreignChild)
      expect(untouched.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
    }),
  )

  failIt.instance("execute propagates unexpected task_id lookup failures without side effects", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompted = true
            return reply(input, "unexpected")
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: "ses_boom",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("database exploded")
      }
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )
  it.instance("execute resolves a direct model with an advertised variant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/test-model",
          variant: "max",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({ providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") })
      expect(seen?.variant).toBe("max")
      expect(result.metadata.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "max",
      })
      expect(result.metadata.execution.modelProfile).toBeUndefined()
      expect(result.metadata.execution.source).toBe("request-model")
      expect(result.metadata.execution.resumed).toBe(false)
      const child = yield* sessions.get(result.metadata.sessionId)
      expect(child.model).toEqual({
        id: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        variant: "max",
      })
    }),
    { config: delegationConfig },
  )

  it.instance("execute asks for task_model with the canonical provider/model", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
      expect(calls[1]).toEqual({
        permission: "task_model",
        patterns: ["test/test-model"],
        always: ["test/test-model"],
        metadata: {
          description: "inspect bug",
          model: "test/test-model",
        },
      })
    }),
    { config: delegationConfig },
  )

  it.instance("execute still asks for task_model when agent selection is bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps(), bypassAgentCheck: true },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              asks.push(input)
            }),
        },
      )

      expect(asks.map((item) => item.permission)).toEqual(["task_model"])
      expect(asks[0]?.patterns).toEqual(["test/test-model"])
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails before creating a child when task_model permission is denied", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: (input: { permission?: string }) =>
              input.permission === "task_model" ? Effect.die(new Error("task_model denied")) : Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("task_model denied")
      }
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails without asking or creating a child when model and model_profile are both set", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const asks: unknown[] = []

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
            model_profile: "flash",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("mutually exclusive")
      }
      expect(asks).toHaveLength(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails without creating a child when variant is set without model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            variant: "max",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("variant requires model")
      }
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails without creating a child for an invalid model format", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "nope",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain('expected "provider/model"')
      }
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails before creating a child when the direct model is not registered", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "nope/nope",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(Cause.pretty(exit.cause)).toContain("ProviderModelNotFoundError")
        expect(ModelNotFoundError.isInstance(error)).toBe(true)
      }
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails before creating a child when the direct model variant is not advertised", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
            variant: "bogus",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Available variants: ultra, max, xhigh, high")
      }
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute resumes a direct model child when the model matches", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "max" },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.execution.resumed).toBe(true)
      expect(result.metadata.execution.source).toBe("resume")
      expect(result.metadata.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "max",
      })
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails to resume a direct model child locked to a different model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test") },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
            model: "test/other-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("it is locked to model test/test-model, not test/other-model")
      }
    }),
    {
      config: {
        delegation: { model_profiles: { luna: { model: "test/other-model" } } },
        provider: {
          test: {
            ...providerFixture,
            models: {
              ...providerFixture.models,
              "other-model": { ...providerFixture.models["test-model"], id: "other-model", name: "Other Model" },
            },
          },
        },
      },
    },
  )

  it.instance("execute fails to resume a direct model child locked to a different variant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "max" },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
            model: "test/test-model",
            variant: "high",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain('is locked to variant "max", not variant "high"')
      }
    }),
    { config: delegationConfig },
  )

  it.instance("execute keeps the persisted variant when resuming a direct model child without a variant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "max" },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.execution.resumed).toBe(true)
      expect(result.metadata.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "max",
      })
    }),
    { config: delegationConfig },
  )
  it.instance("execute resolves model_identity and authorizes the canonical route before creating the child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
      let seen: SessionPrompt.PromptInput | undefined
      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model_identity: "shared-test-model",
          provider: "test",
          variant: "max",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              asks.push(input)
            }),
        },
      )
      expect(asks.map((item) => item.permission)).toEqual(["task", "task_model"])
      expect(asks[1]?.patterns).toEqual(["test/test-model"])
      expect(seen?.model).toEqual({ providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") })
      expect(seen?.variant).toBe("max")
      expect(result.metadata.execution.source).toBe("request-model-identity")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
    {
      config: {
        ...delegationConfig,
        provider: {
          test: {
            ...providerFixture,
            models: {
              "test-model": {
                ...providerFixture.models["test-model"],
                capability_model_id: "shared-test-model",
              },
            },
          },
        },
      },
    },
  )

  it.instance("execute rejects identity task_model permission with zero children", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false
      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model_identity: "shared-test-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: (input: { permission?: string }) =>
              input.permission === "task_model" ? Effect.die(new Error("task_model denied")) : Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("task_model denied")
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    {
      config: {
        ...delegationConfig,
        provider: {
          test: {
            ...providerFixture,
            models: {
              "test-model": {
                ...providerFixture.models["test-model"],
                capability_model_id: "shared-test-model",
              },
            },
          },
        },
      },
    },
  )

  it.instance("execute rejects conflicting identity selectors before asking or creating a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const asks: unknown[] = []
      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
            model_identity: "shared-test-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("mutually exclusive")
      expect(asks).toHaveLength(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: delegationConfig },
  )

  it.instance("execute fails without activity when promptOps are missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("promptOps")
      expect(routingActivity).toHaveLength(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("execute records no activity when the parent session is itself a child", () =>
    Effect.gen(function* () {
      const root = yield* seed()
      const { chat, assistant } = yield* seed("Nested parent", undefined, root.chat.id)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.metadata.execution.resumed).toBe(false)
      expect(routingActivity).toHaveLength(0)
    }),
  )

  it.instance("execute resolves an ambiguous identity with the unique active preference", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      routingState = {
        ...ConfigSubagentRouting.empty(),
        revision: 1,
        global: {
          providers: {},
          routes: {
            "shared-test-model": {
              "second/second-model": { preference: { weight: 1, activity: 0, revision: 1 } },
            },
          },
        },
      }
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
      let seen: SessionPrompt.PromptInput | undefined
      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model_identity: "shared-test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              asks.push(input)
            }),
        },
      )
      expect(asks.map((item) => item.permission)).toEqual(["task", "task_model"])
      expect(asks[1]?.patterns).toEqual(["second/second-model"])
      expect(seen?.model).toEqual({ providerID: ProviderID.make("second"), modelID: ModelID.make("second-model") })
      expect(result.metadata.execution.source).toBe("request-model-identity")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
    { config: twoProviderConfig },
  )

  it.instance("execute fails with ambiguity when identity routes tie without a preference", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const asks: Array<{ permission?: string }> = []
      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model_identity: "shared-test-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ambiguous")
      expect(asks.map((item) => item.permission)).toEqual(["task"])
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
    { config: twoProviderConfig },
  )
  it.instance(
    "execute selects a concrete route for workload-only dispatch and authorizes it",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[]; metadata?: Record<string, unknown> }> = []
        let seen: SessionPrompt.PromptInput | undefined

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            workload: "scout",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(asks.map((item) => item.permission)).toEqual(["task", "task_model"])
        expect(asks[0]?.metadata).toMatchObject({ workload: "scout" })
        expect(asks[1]?.patterns).toEqual([
          `${result.metadata.model.providerID}/${result.metadata.model.modelID}`,
        ])
        expect(seen?.model).toEqual({
          providerID: result.metadata.model.providerID,
          modelID: result.metadata.model.modelID,
        })
        expect(seen?.variant).toBe(result.metadata.model.variant)
        expect(result.metadata.execution).toMatchObject({ workload: "scout", source: "request-model", resumed: false })
        expect((yield* sessions.get(result.metadata.sessionId)).model).toMatchObject({
          providerID: result.metadata.model.providerID,
          id: result.metadata.model.modelID,
          variant: result.metadata.model.variant,
        })
      }),
    { config: delegationConfig },
  )

  it.instance(
    "execute keeps an explicit model and variant authoritative when workload is also set",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            workload: "scout",
            model: "test/test-model",
            variant: "max",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual(ref)
        expect(seen?.variant).toBe("max")
        expect(result.metadata.model.variant).toBe("max")
        expect(result.metadata.execution).toMatchObject({ workload: "scout", source: "request-model" })
      }),
    { config: delegationConfig },
  )

  it.instance(
    "execute rejects workload-only dispatch when scheduling is disabled",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const asks: unknown[] = []

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              workload: "scout",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  asks.push(input)
                }),
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Subagent workload scheduling is disabled")
        expect(asks).toHaveLength(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { config: disabledSchedulingConfig },
  )

  it.instance(
    "execute validates and dispatches an explicit model workload when scheduling is disabled",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []

        const invalid = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              workload: "unknown",
              model: "test/test-model",
              variant: "max",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  asks.push(input)
                }),
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(invalid)).toBe(true)
        if (Exit.isFailure(invalid)) expect(Cause.pretty(invalid.cause)).toContain("Valid workloads: scout, builder, reviewer")
        expect(asks).toHaveLength(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)

        let seen: SessionPrompt.PromptInput | undefined
        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            workload: "scout",
            model: "test/test-model",
            variant: "max",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(asks.map((item) => item.permission)).toEqual(["task", "task_model"])
        expect(asks[1]?.patterns).toEqual(["test/test-model"])
        expect(seen?.model).toEqual(ref)
        expect(seen?.variant).toBe("max")
        expect(result.metadata.execution).toMatchObject({ workload: "scout", source: "request-model" })
        expect(yield* sessions.children(chat.id)).toHaveLength(1)
      }),
    { config: disabledSchedulingConfig },
  )

  it.instance(
    "execute validates workload names before asking or creating a child",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const asks: unknown[] = []

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              workload: "unknown",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  asks.push(input)
                }),
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Valid workloads: scout, builder, reviewer")
        expect(asks).toHaveLength(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { config: delegationConfig },
  )

  it.instance(
    "execute records workload on resume without changing the persisted model lock",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Existing child",
          agent: "general",
          model: { id: ref.modelID, providerID: ref.providerID, variant: "max" },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string }> = []

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "continue the cache key path",
            subagent_type: "general",
            workload: "builder",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(asks.map((item) => item.permission)).toEqual(["task"])
        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.metadata.model).toMatchObject({ providerID: ref.providerID, modelID: ref.modelID, variant: "max" })
        expect(result.metadata.execution).toMatchObject({ workload: "builder", source: "resume", resumed: true })
      }),
    { config: delegationConfig },
  )

  it.instance("execute records linked telemetry and does not expose internal telemetry IDs", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const existingTelemetryIDs = new Set(
        ModelTelemetry.read({ projectID: chat.projectID }).map((event) => event.eventID),
      )
      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } } }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const events = ModelTelemetry.read({ projectID: chat.projectID }).filter(
        (event) => !existingTelemetryIDs.has(event.eventID),
      )
      const decisions = events.filter((event) => event.eventType === "decision.recorded")
      const lifecycle = events.filter((event) => event.eventType.startsWith("delegation."))
      expect(decisions).toHaveLength(1)
      expect(lifecycle.map((event) => event.eventType).sort()).toEqual([
        "delegation.finished",
        "delegation.prepared",
        "delegation.started",
      ])
      const decision = decisions[0]
      if (!decision) throw new Error("expected a recorded delegation decision")
      expect(lifecycle.every((event) => event.episodeID === decision.episodeID && event.decisionID === decision.decisionID)).toBe(true)
      expect(lifecycle.every((event) => event.delegationID !== undefined)).toBe(true)
      expect(new Set(lifecycle.map((event) => event.delegationID)).size).toBe(1)
      expect(lifecycle.find((event) => event.eventType === "delegation.finished")?.execution).toMatchObject({
        status: "completed",
      })
      expect(lifecycle.find((event) => event.eventType === "delegation.finished")?.usage).toEqual({
        input: 10,
        output: 20,
        reasoning: 3,
        cacheRead: 4,
        cacheWrite: 5,
      })
      const visible = `${JSON.stringify(result.metadata)}\n${result.output}`
      const telemetryIDs = new Set(
        events.flatMap((event) => [event.eventID, event.episodeID, event.decisionID, event.delegationID].filter(Boolean)),
      )
      telemetryIDs.forEach((id) => expect(visible).not.toContain(id))
    }),
  )
  it.instance("execute persists explicit model_identity as the telemetry action identity", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const existingTelemetryIDs = new Set(
        ModelTelemetry.read({ projectID: chat.projectID }).map((event) => event.eventID),
      )
      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model_identity: "shared-test-model",
          provider: "test",
          variant: "max",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const decisions = ModelTelemetry.read({ projectID: chat.projectID })
        .filter((event) => !existingTelemetryIDs.has(event.eventID))
        .filter((event) => event.eventType === "decision.recorded")
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.action).toMatchObject({
        route: "test/test-model",
        identity: "shared-test-model",
        variant: "max",
      })
      expect(decisions[0]?.action?.identity).not.toBe("route:test/test-model")
    }),
    { config: twoProviderConfig },
  )
  it.instance("execute records prepared and cancelled telemetry without started when already aborted", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const existingTelemetryIDs = new Set(
        ModelTelemetry.read({ projectID: chat.projectID }).map((event) => event.eventID),
      )
      const abort = new AbortController()
      abort.abort()
      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const events = ModelTelemetry.read({ projectID: chat.projectID }).filter(
        (event) => !existingTelemetryIDs.has(event.eventID),
      )
      const decisions = events.filter((event) => event.eventType === "decision.recorded")
      const lifecycle = events.filter((event) => event.eventType.startsWith("delegation."))
      expect(decisions).toHaveLength(1)
      expect(lifecycle.map((event) => event.eventType).sort()).toEqual([
        "delegation.cancelled",
        "delegation.prepared",
      ])
      const decision = decisions[0]
      const prepared = lifecycle.find((event) => event.eventType === "delegation.prepared")
      const cancelled = lifecycle.find((event) => event.eventType === "delegation.cancelled")
      if (!decision || !prepared || !cancelled) throw new Error("expected aborted delegation telemetry")
      expect(prepared.decisionID).toBe(decision.decisionID)
      expect(cancelled.decisionID).toBe(decision.decisionID)
      expect(prepared.episodeID).toBe(decision.episodeID)
      expect(cancelled.episodeID).toBe(decision.episodeID)
      expect(prepared.delegationID).toBe(cancelled.delegationID)
      expect(cancelled.execution).toMatchObject({
        status: "cancelled",
        finishReason: "cancelled",
        errorClass: "cancelled",
      })
    }),
  )
  it.instance("resuming a task creates fresh telemetry IDs with inherited lineage and incremented attempt", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const execute = (task_id?: string) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            ...(task_id ? { task_id } : {}),
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
      const before = new Set(ModelTelemetry.read({ projectID: chat.projectID }).map((event) => event.eventID))
      const first = yield* execute()
      const second = yield* execute(first.metadata.sessionId)
      yield* Effect.promise(() => ModelTelemetry.drainBestEffort())

      const events = ModelTelemetry.read({ projectID: chat.projectID }).filter((event) => !before.has(event.eventID))
      const decisions = events.filter((event) => event.eventType === "decision.recorded")
      const prepared = events.filter((event) => event.eventType === "delegation.prepared")
      expect(decisions).toHaveLength(2)
      expect(prepared).toHaveLength(2)
      expect(decisions[0]?.decisionID).not.toBe(decisions[1]?.decisionID)
      expect(decisions[0]?.episodeID).toBe(decisions[1]?.episodeID)
      const firstPrepared = prepared.find((event) => event.attemptIndex === 0)
      const resumedPrepared = prepared.find((event) => event.attemptIndex === 1)
      expect(firstPrepared?.delegationID).not.toBe(resumedPrepared?.delegationID)
      expect(resumedPrepared?.parentDelegationID).toBe(firstPrepared?.delegationID)
      expect(firstPrepared?.attemptIndex).toBe(0)
      expect(resumedPrepared?.attemptIndex).toBe(1)
      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
    }),
  )
})
