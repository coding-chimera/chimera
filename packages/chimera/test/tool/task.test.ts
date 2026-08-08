import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
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
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "../../src/provider/provider"
import { WorkspaceID } from "../../src/control-plane/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
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

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
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
    CrossSpawnSpawner.defaultLayer,
    failingSessionLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
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

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned", agentName?: string) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title, ...(agentName ? { agent: agentName } : {}) })
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

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

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
        expect(seen?.variant).toBeUndefined()
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
        always: ["*"],
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

  it.instance("execute appends nested delegation denies when resuming a swarm worker child", () =>
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
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }), swarmWorker: true },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.execution.resumed).toBe(true)
      const resumed = yield* sessions.get(child.id)
      expect(resumed.permission?.slice(-2)).toEqual([
        { pattern: "*", action: "deny", permission: "task" },
        { pattern: "*", action: "deny", permission: "chimera_swarm" },
      ])
      expect(seen?.tools).toMatchObject({ task: false, chimera_swarm: false })
    }),
  )

  it.instance("execute does not duplicate nested delegation denies on repeated resumes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const params = {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      }
      const toolCtx = (swarmWorker: boolean) => ({
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps(), swarmWorker },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const first = yield* def.execute(params, toolCtx(true))
      const second = yield* def.execute({ ...params, task_id: first.metadata.sessionId }, toolCtx(true))

      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
      const child = yield* sessions.get(first.metadata.sessionId)
      const taskDenies = child.permission?.filter((rule) => rule.permission === "task" && rule.action === "deny") ?? []
      const swarmDenies =
        child.permission?.filter((rule) => rule.permission === "chimera_swarm" && rule.action === "deny") ?? []
      expect(taskDenies).toHaveLength(1)
      expect(swarmDenies).toHaveLength(1)
    }),
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
      expect(description).toContain("- flash: Flash profile")
      expect(description).toContain("- luna: Luna profile")
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
      expect(description).not.toContain("- flash:")
      expect(description).toContain("- luna: Luna profile")
    }),
    {
      config: {
        ...delegationConfig,
        permission: { task_profile: { flash: "deny" } },
      },
    },

  )

  it.instance("execute resume applies nested delegation denies via the atomic slot primitive", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
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
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps(), swarmWorker: true },
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
})
