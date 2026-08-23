import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Auth } from "@/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Permission } from "../../src/permission"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ChimeraSwarmTool } from "../../src/tool/swarm"
import { SubagentDispatch } from "../../src/agent/subagent-dispatch"
import * as ModelTelemetry from "../../src/agent/model-telemetry"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { getCodeGraphDir } from "@/graph/directory"
import { recordOracleResult, writePersistentObligationStore } from "@/chimera/store"
import { ProjectID } from "@/project/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import path from "path"

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
    testProvider.layer,
  ),
)
const modelIt = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    routingLayer,
    authLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    testProvider.layer,
  ),
)
let modelIdentityListCalls = 0
const identityProvider = ProviderTest.fake({
  model: testProvider.model,
  info: testProvider.info,
  list: Effect.fn("IdentityProvider.list")(() => {
    modelIdentityListCalls += 1
    return Effect.succeed({ [testProvider.info.id]: testProvider.info })
  }),
})
const identityIt = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    routingLayer,
    authLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    identityProvider.layer,
  ),
)

afterEach(async () => {
  routingState = ConfigSubagentRouting.empty()
  routingActivity = []
  await disposeAllInstances()
})

const seed = Effect.fn("SwarmToolTest.seed")(function* (title = "Swarm parent", parentID?: SessionID) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title, ...(parentID ? { parentID } : {}) })
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

function ctx(input: { chat: { id: SessionID }; assistant: { id: MessageID } }, promptOps: TaskPromptOps) {
  return {
    sessionID: input.chat.id,
    messageID: input.assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps, bypassAgentCheck: true },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.chimera_swarm", () => {
  it.instance("expands prompt_template over explicit items and creates child tasks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const prompts: string[] = []
      const result = yield* def.execute(
        {
          prompt_template: "Review {{index}}/{{total}}: {{item}}",
          items: ["alpha", { target: "beta" }],
          subagent_type: "general",
          description: "review shard",
          concurrency: 2,
        },
        ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input.parts[0]?.type === "text" ? input.parts[0].text : "") })),
      )

      expect(result.metadata.successCount).toBe(2)
      expect(result.metadata.failureCount).toBe(0)
      expect(prompts).toEqual(["Review 1/2: alpha", 'Review 2/2: {\n  "target": "beta"\n}'])
      expect(yield* sessions.children(parent.chat.id)).toHaveLength(2)
      expect(routingActivity).toEqual([parent.chat.projectID])

      const output = JSON.parse(result.output)
      expect(output.success).toBe(2)
      expect(output.failure).toBe(0)
      expect(output.results).toHaveLength(2)
      expect(output.parentCloseout.length).toBeGreaterThan(0)
      expect(output.results.every((r: { outputFile?: string }) => typeof r.outputFile === "string")).toBe(true)
    }),
  )

  it.instance("defaults concurrent child prompts to sixteen", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let active = 0
      let maxActive = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            active++
            maxActive = Math.max(maxActive, active)
            if (active === 16) yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            active--
            return reply(input, "done")
          }),
      }

      const fiber = yield* def
        .execute(
          {
            prompt_template: "Review {{item}}",
            items: Array.from({ length: 17 }, (_, index) => `item-${index + 1}`),
            subagent_type: "general",
          },
          ctx(parent, promptOps),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      expect(maxActive).toBe(16)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.metadata.concurrency).toBe(16)
      expect(JSON.parse(result.output).concurrency).toBe(16)
    }),
  )

  it.instance("keeps child task metadata from overwriting swarm metadata", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const metadata: Array<{ title?: string; metadata?: Record<string, unknown> }> = []

      yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha", "beta"],
          subagent_type: "general",
          description: "review shard",
          concurrency: 2,
        },
        {
          ...ctx(parent, stubOps()),
          metadata: (input) =>
            Effect.sync(() => {
              metadata.push(input)
            }),
        },
      )

      expect(metadata.length).toBeGreaterThan(1)
      const first = metadata[0]?.metadata
      const firstRuns = first?.childRuns as Array<{ status: string }> | undefined
      expect(firstRuns?.map((item) => item.status)).toEqual(["queued", "queued"])
      expect(first?.childSessions).toHaveLength(0)
      expect(
        metadata.some((item) =>
          (item.metadata?.childRuns as Array<{ status: string }> | undefined)?.some((run) => run.status === "running"),
        ),
      ).toBe(true)
      expect(metadata.every((item) => item.title === "review shard")).toBe(true)
      const last = metadata.at(-1)?.metadata
      expect(last?.itemCount).toBe(2)
      expect(last?.concurrency).toBe(2)
      expect(last?.sessionId).toBeUndefined()
      expect(last?.childSessions).toHaveLength(2)
      const lastRuns = last?.childRuns as Array<{ status: string; sessionId?: string }> | undefined
      expect(lastRuns?.map((item) => item.status)).toEqual(["completed", "completed"])
      expect(lastRuns?.every((item) => typeof item.sessionId === "string")).toBe(true)
    }),
  )

  it.instance("isolates failed children and publishes final child run states", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const text = input.parts.find((part) => part.type === "text")?.text ?? ""
            if (text.includes("beta")) return yield* Effect.die(new Error("beta failed"))
            return reply(input, "done")
          }),
      }

      const result = yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha", "beta"],
          subagent_type: "general",
          concurrency: 2,
        },
        ctx(parent, promptOps),
      )

      const runs = result.metadata.childRuns as Array<{ status: string; sessionId?: string; error?: string }>
      expect(runs.map((run) => run.status)).toEqual(["completed", "error"])
      expect(runs.every((run) => typeof run.sessionId === "string")).toBe(true)
      expect(runs[1].error).toContain("beta failed")
      expect(result.metadata.childSessions).toHaveLength(2)
      expect(result.metadata.successCount).toBe(1)
      expect(result.metadata.failureCount).toBe(1)
      expect(routingActivity).toHaveLength(1)
      expect(JSON.parse(result.output).results.map((item: { status: string }) => item.status)).toEqual(["success", "failure"])
    }),
  )

  it.instance("keeps mixed interrupt and failure child outcomes classified as errors", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          const text = input.parts.find((part) => part.type === "text")?.text ?? ""
          if (!text.includes("beta")) return Effect.succeed(reply(input, "done"))
          return Effect.failCause(Cause.combine(Cause.interrupt(undefined), Cause.die(new Error("beta mixed failure"))))
        },
      }
      const result = yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha", "beta"],
          subagent_type: "general",
          concurrency: 2,
        },
        ctx(parent, promptOps),
      )
      const runs = result.metadata.childRuns as Array<{ status: string; error?: string }>
      expect(runs.map((run) => run.status)).toEqual(["completed", "error"])
      expect(runs[1]?.error).toContain("beta mixed failure")
      expect(result.metadata.successCount).toBe(1)
      expect(result.metadata.failureCount).toBe(1)
    }),
  )

  it.instance("prioritizes parent abort over a mixed child cause", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          const mixed = Cause.combine(Cause.interrupt(undefined), Cause.die(new Error("aborted mixed failure")))
          return Effect.failCause(mixed).pipe(Effect.ensuring(Effect.sync(() => abort.abort())))
        },
      }
      const result = yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha"],
          subagent_type: "general",
          concurrency: 1,
        },
        { ...ctx(parent, promptOps), abort: abort.signal },
      )
      const runs = result.metadata.childRuns as Array<{ status: string; error?: string }>
      expect(runs.map((run) => run.status)).toEqual(["cancelled"])
      expect(runs[0]?.error).toContain("aborted mixed failure")
      expect(result.metadata.successCount).toBe(0)
      expect(result.metadata.failureCount).toBe(1)
    }),
  )
  it.instance("disables nested fan-out for swarm workers", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const prompts: SessionPrompt.PromptInput[] = []

      yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha"],
          subagent_type: "general",
          concurrency: 1,
        },
        ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
      )

      expect(prompts[0].tools).toMatchObject({ task: false, chimera_swarm: false })
      const children = yield* sessions.children(parent.chat.id)
      expect(children).toHaveLength(1)
      const rules = children[0].permission ?? []
      expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "task" })
      expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "chimera_swarm" })
      expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "subagent_model_prefer" })
      expect(rules).toContainEqual({ pattern: "*", action: "deny", permission: "subagent_model_suppress" })
      expect(Permission.evaluate("task", "*", rules).action).toBe("deny")
      expect(Permission.evaluate("chimera_swarm", "*", rules).action).toBe("deny")
    }),
  )

  it.instance("resuming a swarm child through dispatch keeps nested denies and adds no allows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha"],
          subagent_type: "general",
          concurrency: 1,
        },
        ctx(parent, stubOps()),
      )

      const childSessions = result.metadata.childSessions as Array<{ sessionId?: string }> | undefined
      const childID = childSessions?.[0]?.sessionId
      expect(childID).toBeDefined()
      const before = (yield* sessions.get(SessionID.make(childID!))).permission ?? []

      const dispatch = yield* SubagentDispatch
      yield* dispatch.run({
        parentSessionID: parent.chat.id,
        parentMessageID: parent.assistant.id,
        description: "resume shard",
        prompt: "continue the review",
        subagentType: "general",
        taskID: childID,
        promptOps: stubOps(),
        abort: new AbortController().signal,
        nestedDelegation: "deny",
      })

      const after = (yield* sessions.get(SessionID.make(childID!))).permission ?? []
      expect(after).toContainEqual({ pattern: "*", action: "deny", permission: "task" })
      expect(after).toContainEqual({ pattern: "*", action: "deny", permission: "chimera_swarm" })
      expect(after).toContainEqual({ pattern: "*", action: "deny", permission: "subagent_model_prefer" })
      expect(after).toContainEqual({ pattern: "*", action: "deny", permission: "subagent_model_suppress" })
      expect(after.filter((rule) => rule.action === "allow")).toEqual(before.filter((rule) => rule.action === "allow"))
      expect(after.filter((rule) => rule.permission === "task" && rule.action === "deny")).toHaveLength(1)
      expect(after.filter((rule) => rule.permission === "chimera_swarm" && rule.action === "deny")).toHaveLength(1)
    }),
  )

  it.instance("resumed swarm child evaluates task and chimera_swarm as deny through real permissions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha"],
          subagent_type: "general",
          concurrency: 1,
        },
        ctx(parent, stubOps()),
      )

      const childSessions = result.metadata.childSessions as Array<{ sessionId?: string }> | undefined
      const childID = childSessions?.[0]?.sessionId
      expect(childID).toBeDefined()
      const before = (yield* sessions.get(SessionID.make(childID!))).permission ?? []

      const dispatch = yield* SubagentDispatch
      yield* dispatch.run({
        parentSessionID: parent.chat.id,
        parentMessageID: parent.assistant.id,
        description: "resume shard",
        prompt: "continue the review",
        subagentType: "general",
        taskID: childID,
        promptOps: stubOps(),
        abort: new AbortController().signal,
        nestedDelegation: "deny",
      })

      const after = (yield* sessions.get(SessionID.make(childID!))).permission ?? []
      expect(Permission.evaluate("task", "*", after).action).toBe("deny")
      expect(Permission.evaluate("chimera_swarm", "*", after).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", after).action).toBe("ask")
      expect(after.filter((rule) => rule.action === "allow")).toEqual(before.filter((rule) => rule.action === "allow"))
    }),
  )

  it.instance("adds soft scope warnings for explicit item file conflicts", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const prompts: string[] = []
      const result = yield* def.execute(
        {
          prompt_template: "Handle {{item}}",
          items: [
            { files: ["src/shared.ts"], task: "first" },
            { files: ["src/shared.ts"], task: "second" },
          ],
          subagent_type: "general",
          concurrency: 2,
        },
        ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input.parts[0]?.type === "text" ? input.parts[0].text : "") })),
      )

      expect(result.metadata.scopeWarningCount).toBe(1)

      const output = JSON.parse(result.output)
      expect(output.scopeWarnings).toHaveLength(1)
      expect(output.scopeWarnings[0].message).toContain("src/shared.ts appears in items 1, 2")
      expect(prompts[0]).toContain("Scope warning")
      expect(prompts[1]).toContain("Scope warning")
      expect(result.metadata.successCount).toBe(2)
    }),
  )

  it.instance("caps explicitly oversized concurrency at sixteen", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let active = 0
      let maxActive = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            active++
            maxActive = Math.max(maxActive, active)
            if (active === 16) yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            active--
            return reply(input, "done")
          }),
      }

      const fiber = yield* def
        .execute(
          {
            prompt_template: "Handle {{item}}",
            items: Array.from({ length: 17 }, (_, index) => `item-${index + 1}`),
            concurrency: 100,
          },
          ctx(parent, promptOps),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      expect(maxActive).toBe(16)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.metadata.concurrency).toBe(16)
    }),
  )

  it.instance("cancels sixteen created child sessions when interrupted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<void>()
      const cancelled: string[] = []
      const metadata: Array<Record<string, unknown>> = []
      let active = 0
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.push(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: () =>
          Effect.gen(function* () {
            active++
            if (active === 16) yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
      }

      const fiber = yield* def
        .execute(
          {
            prompt_template: "Handle {{item}}",
            items: Array.from({ length: 16 }, (_, index) => `item-${index + 1}`),
            subagent_type: "general",
            concurrency: 16,
          },
          {
            ...ctx(parent, promptOps),
            metadata: (input) =>
              Effect.sync(() => {
                metadata.push(input.metadata ?? {})
              }),
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(routingActivity).toHaveLength(1)

      const childIDs = (yield* sessions.children(parent.chat.id)).map((item) => item.id).sort()
      expect(childIDs).toHaveLength(16)
      expect(cancelled.sort()).toEqual(childIDs)
      const runs = metadata.at(-1)?.childRuns as Array<{ status: string }> | undefined
      expect(runs?.map((run) => run.status)).toEqual(Array.from({ length: 16 }, () => "cancelled"))
    }),
  )

  it.instance("materializes pending obligations as audit-followup items", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const prompts: string[] = []
      yield* Effect.promise(() =>
        writePersistentObligationStore(
          test.directory,
          path.join(getCodeGraphDir(test.directory), "chimera", "obligations.json"),
          {
            schemaVersion: 1,
            obligations: [
              {
                id: "obl_pending",
                fingerprint: "fp_pending",
                status: "pending",
                target: "src/a.ts:1",
                risk: "call_flow",
                classification: "source",
                reason: "review target",
                evidence: "audit:evidence",
                createdAt: "2026-07-02T00:00:00.000Z",
                updatedAt: "2026-07-02T00:00:00.000Z",
              },
              {
                id: "obl_resolved",
                fingerprint: "fp_resolved",
                status: "resolved",
                target: "src/b.ts:1",
                risk: "test",
                reason: "already done",
                evidence: "audit:resolved",
                createdAt: "2026-07-02T00:00:00.000Z",
                updatedAt: "2026-07-02T00:00:00.000Z",
              },
            ],
          },
        ),
      )

      const result = yield* def.execute(
        {
          from: "pending_obligations",
          subagent_type: "general",
        },
        ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input.parts[0]?.type === "text" ? input.parts[0].text : "") })),
      )

      expect(result.metadata.itemCount).toBe(1)
      expect(prompts[0]).toContain("obl_pending")
      expect(prompts[0]).not.toContain("obl_resolved")
      expect(prompts[0]).toContain("audit-followup")
      expect(prompts[0]).toContain("scoped edits")
      expect(prompts[0]).toContain("changed files")
    }),
  )

  it.instance("materializes failing and unknown oracles as follow-up items", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const prompts: string[] = []
      yield* Effect.promise(() =>
        recordOracleResult(test.directory, path.join(getCodeGraphDir(test.directory), "chimera", "oracle-results.jsonl"), {
          kind: "shell",
          status: "fail",
          tool: {
            id: "bash",
            messageID: parent.assistant.id,
            sessionID: parent.chat.id,
            agent: "build",
          },
          project: {
            root: test.directory,
            worktree: test.directory,
            directory: test.directory,
          },
          finishedAt: "2026-07-02T00:00:00.000Z",
          linkWindow: {
            source: "same_session_preceding_mutations",
            sessionID: parent.chat.id,
            projectRoot: test.directory,
            finishedBefore: "2026-07-02T00:00:00.000Z",
            maxChanges: 20,
          },
          linkedChanges: [],
          verificationKind: "test",
          payload: { shell: { command: "bun test", output: "failed" } },
        }),
      )

      const result = yield* def.execute(
        {
          from: "failing_or_unknown_oracles",
          subagent_type: "general",
        },
        ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input.parts[0]?.type === "text" ? input.parts[0].text : "") })),
      )

      expect(result.metadata.itemCount).toBe(1)
      expect(prompts[0]).toContain("oracle-followup")
      expect(prompts[0]).toContain("failed")
      expect(prompts[0]).toContain("test")
    }),
  )

  it.instance("is exposed by the registry with audit-evidence guidance", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const build = yield* agent.get("build")
      const tool = (yield* registry.tools({ ...ref, agent: build })).find((item) => item.id === "chimera_swarm")

      expect(tool?.description).toContain("audit evidence")
      expect(tool?.description).toContain("worker prompt shape")
      expect(tool?.description).toContain("audit-followup")
      expect(tool?.description).toContain("prompt_template")
      expect(tool?.description).toContain("scope warnings")
      expect(tool?.description).toContain("Status, Changed files, Verification")
      expect(tool?.description).toContain("parent agent owns conflict handling")
      expect(tool?.description).toContain("defaults to 16")
      expect(tool?.description).toContain("capped at 16")
      expect(tool?.description).toContain("capacity ceiling")
      expect(tool?.description).toContain("cannot call `task` or `chimera_swarm`")
    }),
  )

  it.instance("extracts structured summaries from child results", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          prompt_template: "Handle {{item}}",
          items: ["first", "second"],
          subagent_type: "general",
          concurrency: 2,
        },
        ctx(
          parent,
          stubOps({
            text: [
              "Status: actionable",
              "Changed files: src/first.ts",
              "Verification: bun test passed",
              "Remaining risk: low",
              "Parent follow-up: closeout",
            ].join("\n"),
          }),
        ),
      )

      const output = JSON.parse(result.output)
      expect(output.results).toHaveLength(2)
      expect(output.results[0].summary.status).toBe("actionable")
      expect(output.results[0].summary.changedFiles).toBe("src/first.ts")
      expect(output.results[0].summary.verification).toBe("bun test passed")
      expect(output.results[0].summary.remainingRisk).toBe("low")
      expect(output.results[0].summary.parentFollowUp).toBe("closeout")
      expect(typeof output.results[0].outputFile).toBe("string")
    }),
  )

  it.instance("defaults file-review preset to explore subagent", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const prompts: { subagent_type: string; prompt: string }[] = []
      const result = yield* def.execute(
        {
          preset: "file-review",
          items: ["src/a.ts"],
          concurrency: 1,
        },
        ctx(
          parent,
          stubOps({
            onPrompt: (input) =>
              prompts.push({
                subagent_type: input.agent ?? "general",
                prompt: input.parts[0]?.type === "text" ? input.parts[0].text : "",
              }),
          }),
        ),
      )

      expect(result.metadata.successCount).toBe(1)
      expect(prompts).toHaveLength(1)
      expect(prompts[0].subagent_type).toBe("explore")
      expect(prompts[0].prompt).toContain("file-review subagent")
    }),
  )

  it.instance("fails with a constructed example when explicit items is empty", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute({ prompt_template: "Handle {{item}}", items: [] }, ctx(parent, stubOps())),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("Provide at least one swarm item.")
        expect(message).toContain("Example:")
        expect(message).toContain("{{item}}")
      }
      expect(routingActivity).toHaveLength(0)
    }),
  )

  it.instance("fails when both items and from are provided", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute({ items: ["a.ts"], from: "pending_obligations" }, ctx(parent, stubOps())),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("Provide either explicit items or from, not both.")
      }
    }),
  )

  it.instance("fails when prompt_template omits {{item}} and shows a template example", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute({ prompt_template: "Review all files", items: ["a.ts"] }, ctx(parent, stubOps())),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("prompt_template must include the {{item}} placeholder.")
        expect(message).toContain("Example:")
        expect(message).toContain("{{index}}/{{total}}")
      }
    }),
  )

  it.instance("fails when neither prompt_template nor preset is given and shows an example", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute({ items: ["a.ts"] }, ctx(parent, stubOps())),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("Provide prompt_template or choose a preset.")
        expect(message).toContain("Example:")
      }
    }),
  )

  it.instance("fails with unknown agent type and enumerates valid types", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute(
          { prompt_template: "Handle {{item}}", items: ["a.ts"], subagent_type: "nope" },
          ctx(parent, stubOps()),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("Unknown agent type: nope")
        expect(message).toContain("Valid types:")
      }
    }),
  )

  it.instance("fails when a from source yields no items with a follow-up hint", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute({ from: "pending_obligations" }, ctx(parent, stubOps())),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("No swarm items found from source: pending_obligations")
        expect(message).toContain("chimera_obligations_list")
      }
    }),
  )

  it.instance("formats schema validation errors with expected shape and example", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute(
          { concurrency: "8" } as unknown as Parameters<typeof def.execute>[0],
          ctx(parent, stubOps()),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("invalid arguments")
        expect(message).toContain("Expected shape:")
        expect(message).toContain("model?: string")
        expect(message).toContain("variant?: string")
        expect(message).toContain("Example:")
      }
    }),
  )

  it.instance("asks for task_profile permission when model_profile is set", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const asks: Array<{ permission?: string; patterns?: readonly string[]; always?: readonly string[]; metadata?: Record<string, unknown> }> = []
      const promptOps = stubOps()
      yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha"],
          subagent_type: "general",
          model_profile: "flash",
          concurrency: 1,
        },
        {
          ...ctx(parent, promptOps),
          extra: { promptOps, bypassAgentCheck: false },
          ask: (input) =>
            Effect.sync(() => {
              asks.push(input)
            }),
        },
      )
      expect(asks.map((item) => item.permission)).toEqual(["task", "task_profile"])
      expect(asks[1].patterns).toEqual(["flash"])
      expect(asks[1].always).toEqual(["flash"])
      expect(asks[1].metadata).toMatchObject({ model_profile: "flash" })
    }),
    {
      config: {
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
      },
    },
  )

  modelIt.instance(
    "asks once for a route profile when agent selection is bypassed",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[]; always?: readonly string[] }> = []
        const promptOps = stubOps()
        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            concurrency: 2,
          },
          {
            ...ctx(parent, promptOps),
            extra: { promptOps, bypassAgentCheck: true },
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(result.metadata.successCount).toBe(2)
        expect(asks.map((item) => item.permission)).toEqual(["task_profile"])
        expect(asks[0]?.patterns).toEqual(["flash"])
        expect(asks[0]?.always).toEqual(["flash"])
      }),
    {
      config: {
        delegation: {
          model_profiles: { flash: { model: "test/test-model" } },
          routes: { general: "flash" },
        },
      },
    },
  )

  it.instance(
    "fails before creating children when task_profile permission is denied",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            {
              prompt_template: "Review {{item}}",
              items: ["alpha"],
              subagent_type: "general",
              model_profile: "flash",
              concurrency: 1,
            },
            {
              ...ctx(parent, stubOps()),
              extra: { promptOps: stubOps(), bypassAgentCheck: false },
              ask: (input: { permission?: string }) =>
                input.permission === "task_profile" ? Effect.die(new Error("task_profile denied")) : Effect.void,
            },
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("task_profile denied")
        }
        expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
      }),
    {
      config: {
        permission: {
          task_profile: {
            "*": "allow",
            flash: "deny",
          },
        },
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
      },
    },
  )

  modelIt.instance(
    "applies model_profile to every worker prompt input model and variant",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const prompts: SessionPrompt.PromptInput[] = []
        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            model_profile: "flash",
            concurrency: 2,
          },
          ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
        )
        expect(result.metadata.successCount).toBe(2)
        expect(prompts).toHaveLength(2)
        for (const input of prompts) {
          expect(input.model).toMatchObject({ providerID: ref.providerID, modelID: ref.modelID })
          expect(input.variant).toBe("max")
        }
      }),
    {
      config: {
        delegation: {
          model_profiles: {
            flash: { model: "test/test-model", variant: "max" },
          },
        },
      },
    },
  )

  modelIt.instance(
    "records model_profile and execution in child run and session metadata",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha"],
            subagent_type: "general",
            model_profile: "flash",
            concurrency: 1,
          },
          ctx(parent, stubOps()),
        )
        const runs = result.metadata.childRuns as Array<{
          model_profile?: string
          execution?: { modelProfile?: string; source?: string }
        }>
        expect(runs).toHaveLength(1)
        expect(runs[0].model_profile).toBe("flash")
        expect(runs[0].execution?.modelProfile).toBe("flash")
        expect(runs[0].execution?.source).toBe("request-profile")
        const sessions = result.metadata.childSessions as Array<{ model_profile?: string }>
        expect(sessions).toHaveLength(1)
        expect(sessions[0].model_profile).toBe("flash")
      }),
    {
      config: {
        delegation: {
          model_profiles: {
            flash: { model: "test/test-model", variant: "max" },
          },
        },
      },
    },
  )

  modelIt.instance(
    "keeps queued/running/completed status metadata with execution fields present",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const metadata: Array<{ title?: string; metadata?: Record<string, unknown> }> = []
        yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            model_profile: "flash",
            concurrency: 1,
          },
          {
            ...ctx(parent, stubOps()),
            metadata: (input) =>
              Effect.sync(() => {
                metadata.push(input)
              }),
          },
        )
        const firstRuns = metadata[0]?.metadata?.childRuns as Array<{ status: string }> | undefined
        expect(firstRuns?.map((run) => run.status)).toEqual(["queued", "queued"])
        expect(
          metadata.some((item) =>
            (item.metadata?.childRuns as Array<{ status: string }> | undefined)?.some((run) => run.status === "running"),
          ),
        ).toBe(true)
        const last = metadata.at(-1)?.metadata
        const lastRuns = last?.childRuns as
          | Array<{ status: string; model_profile?: string; execution?: { modelProfile?: string } }>
          | undefined
        expect(lastRuns?.map((run) => run.status)).toEqual(["completed", "completed"])
        expect(lastRuns?.every((run) => run.model_profile === "flash")).toBe(true)
        expect(lastRuns?.every((run) => run.execution !== undefined)).toBe(true)
        const lastSessions = last?.childSessions as Array<{ model_profile?: string }> | undefined
        expect(lastSessions?.every((session) => session.model_profile === "flash")).toBe(true)
      }),
    {
      config: {
        delegation: {
          model_profiles: {
            flash: { model: "test/test-model", variant: "max" },
          },
        },
      },
    },
  )
  modelIt.instance(
    "asks once for task_model and applies the direct model to every worker prompt",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: Array<{
          permission?: string
          patterns?: readonly string[]
          always?: readonly string[]
          metadata?: Record<string, unknown>
        }> = []
        const prompts: SessionPrompt.PromptInput[] = []
        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            model: "test/test-model",
            variant: "max",
            concurrency: 2,
          },
          {
            ...ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )
        expect(result.metadata.successCount).toBe(2)
        expect(asks).toHaveLength(1)
        expect(asks[0].permission).toBe("task_model")
        expect(asks[0].patterns).toEqual(["test/test-model"])
        expect(asks[0].always).toEqual(["test/test-model"])
        expect(asks[0].metadata).toMatchObject({ model: "test/test-model" })
        expect(prompts).toHaveLength(2)
        for (const input of prompts) {
          expect(input.model).toMatchObject({ providerID: ref.providerID, modelID: ref.modelID })
          expect(input.variant).toBe("max")
        }
      }),
  )

  it.instance(
    "fails before creating children when task_model permission is denied",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            {
              prompt_template: "Review {{item}}",
              items: ["alpha"],
              subagent_type: "general",
              model: "test/test-model",
              concurrency: 1,
            },
            {
              ...ctx(parent, stubOps()),
              ask: (input: { permission?: string }) =>
                input.permission === "task_model" ? Effect.die(new Error("task_model denied")) : Effect.void,
            },
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("task_model denied")
        }
        expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
        expect(routingActivity).toHaveLength(0)
      }),
  )

  it.instance(
    "fails before creating children when model and model_profile are both set",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            {
              prompt_template: "Review {{item}}",
              items: ["alpha"],
              subagent_type: "general",
              model: "test/test-model",
              model_profile: "flash",
              concurrency: 1,
            },
            ctx(parent, stubOps()),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("mutually exclusive")
        }
        expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
      }),
  )

  modelIt.instance(
    "records the resolved direct model and request-model execution in child metadata",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha"],
            subagent_type: "general",
            model: "test/test-model",
            variant: "max",
            concurrency: 1,
          },
          ctx(parent, stubOps()),
        )
        const runs = result.metadata.childRuns as Array<{
          model?: { providerID?: string; modelID?: string; variant?: string }
          execution?: { source?: string }
        }>
        expect(runs).toHaveLength(1)
        expect(runs[0].model).toMatchObject({ providerID: "test", modelID: "test-model", variant: "max" })
        expect(runs[0].execution?.source).toBe("request-model")
        const sessions = result.metadata.childSessions as Array<{ model?: { providerID?: string; modelID?: string; variant?: string } }>
        expect(sessions).toHaveLength(1)
        expect(sessions[0].model).toMatchObject({ providerID: "test", modelID: "test-model", variant: "max" })
      }),
  )

  it.instance(
    "newly created swarm children keep task and chimera_swarm denies when a direct model variant is used",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha"],
            subagent_type: "general",
            model: "test/test-model",
            variant: "max",
            concurrency: 1,
          },
          ctx(parent, stubOps()),
        )

        const childSessions = result.metadata.childSessions as Array<{ sessionId?: string }> | undefined
        const childID = childSessions?.[0]?.sessionId
        expect(childID).toBeDefined()

        const permission = (yield* sessions.get(SessionID.make(childID!))).permission ?? []
        expect(Permission.evaluate("task", "*", permission).action).toBe("deny")
        expect(Permission.evaluate("chimera_swarm", "*", permission).action).toBe("deny")
        expect(permission.some((rule) => rule.permission === "task" && rule.action === "deny")).toBe(true)
        expect(permission.some((rule) => rule.permission === "chimera_swarm" && rule.action === "deny")).toBe(true)
      }),
  )

  it.instance(
    "nested delegation denies still evaluate as deny when a direct model is used",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha"],
            subagent_type: "general",
            model: "test/test-model",
            concurrency: 1,
          },
          ctx(parent, stubOps()),
        )

        const childSessions = result.metadata.childSessions as Array<{ sessionId?: string }> | undefined
        const childID = childSessions?.[0]?.sessionId
        expect(childID).toBeDefined()

        const dispatch = yield* SubagentDispatch
        yield* dispatch.run({
          parentSessionID: parent.chat.id,
          parentMessageID: parent.assistant.id,
          description: "resume shard",
          prompt: "continue the review",
          subagentType: "general",
          taskID: childID,
          model: "test/test-model",
          promptOps: stubOps(),
          abort: new AbortController().signal,
          nestedDelegation: "deny",
        })

        const after = (yield* sessions.get(SessionID.make(childID!))).permission ?? []
        expect(Permission.evaluate("task", "*", after).action).toBe("deny")
        expect(Permission.evaluate("chimera_swarm", "*", after).action).toBe("deny")
      }),
  )
  identityIt.instance(
    "resolves model_identity once, authorizes once, and reuses the concrete route for every worker",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
        modelIdentityListCalls = 0
        const prompts: SessionPrompt.PromptInput[] = []
        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            model_identity: "test-model",
            provider: "test",
            variant: "max",
            concurrency: 2,
          },
          {
            ...ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )
        expect(modelIdentityListCalls).toBe(1)
        expect(result.metadata.successCount).toBe(2)
        expect(asks).toHaveLength(1)
        expect(asks[0].permission).toBe("task_model")
        expect(asks[0].patterns).toEqual(["test/test-model"])
        expect(prompts).toHaveLength(2)
        expect(
          prompts.every(
            (input) =>
              input.model?.providerID === ProviderID.make("test") &&
              input.model.modelID === ModelID.make("test-model") &&
              input.variant === "max",
          ),
        ).toBe(true)
        const runs = result.metadata.childRuns as Array<{ execution?: { source?: string } }>
        expect(runs.every((run) => run.execution?.source === "request-model-identity")).toBe(true)
      }),
  )

  identityIt.instance(
    "persists one shared swarm decision and linked child lifecycle without exposing telemetry IDs",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
        modelIdentityListCalls = 0
        yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
        const priorEvents = ModelTelemetry.read({ projectID: parent.chat.projectID, limit: 1000 })
        const priorEventIDs = new Set(priorEvents.map((event) => event.eventID))

        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            model_identity: "test-model",
            provider: "test",
            variant: "max",
            concurrency: 2,
          },
          {
            ...ctx(parent, stubOps()),
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(modelIdentityListCalls).toBe(1)
        expect(asks.map((item) => item.permission)).toEqual(["task_model"])
        expect(asks[0]?.patterns).toEqual(["test/test-model"])
        expect(result.metadata.successCount).toBe(2)
        expect(result.metadata.failureCount).toBe(0)

        const metadata = result.metadata as { childRuns: unknown[]; childSessions: unknown[] }
        const output = JSON.parse(result.output) as {
          childRuns: unknown[]
          childSessions: unknown[]
          success: number
          failure: number
        }
        expect(metadata.childRuns).toHaveLength(2)
        expect(metadata.childSessions).toHaveLength(2)
        expect(output.childRuns).toHaveLength(2)
        expect(output.childSessions).toHaveLength(2)
        expect(output.success).toBe(2)
        expect(output.failure).toBe(0)

        const publicPayload = JSON.stringify({ metadata, output })
        for (const key of ["episodeID", "decisionID", "delegationID", "fanoutID"]) {
          expect(publicPayload).not.toContain(`"${key}"`)
        }

        yield* Effect.promise(() => ModelTelemetry.drainBestEffort())
        const events = ModelTelemetry.read({ projectID: parent.chat.projectID, limit: 1000 }).filter(
          (event) => !priorEventIDs.has(event.eventID),
        )
        expect(events).toHaveLength(7)

        const decisions = events.filter((event) => event.eventType === "decision.recorded")
        expect(decisions).toHaveLength(1)
        const decision = decisions[0]
        if (!decision || decision.decisionID === undefined || decision.fanout === undefined) {
          throw new Error("expected one persisted swarm decision with decision and fanout IDs")
        }

        expect(decision).toMatchObject({
          eventType: "decision.recorded",
          action: {
            route: "test/test-model",
            identity: "test-model",
            variant: "max",
            selectionSource: "explicit",
            resolutionSource: "request-model-identity",
          },
          fanout: {
            size: 2,
            concurrency: 2,
            templateKind: "swarm",
          },
        })
        expect(decision.fanout.fanoutID).toMatch(/^fanout-/)

        const lifecycle = events.filter((event) => event.eventType !== "decision.recorded")
        expect(lifecycle).toHaveLength(6)
        expect(lifecycle.every((event) => event.delegationID !== undefined)).toBe(true)
        expect(lifecycle.every((event) => event.decisionID === decision.decisionID)).toBe(true)
        expect(lifecycle.every((event) => event.episodeID === decision.episodeID)).toBe(true)
        expect(lifecycle.every((event) => event.fanout?.fanoutID === decision.fanout?.fanoutID)).toBe(true)
        expect(lifecycle.map((event) => event.fanout?.itemIndex).sort()).toEqual([0, 0, 0, 1, 1, 1])

        const delegationIDs = [
          ...new Set(
            lifecycle
              .map((event) => event.delegationID)
              .filter((id): id is string => id !== undefined),
          ),
        ]
        expect(delegationIDs).toHaveLength(2)
        expect(
          delegationIDs
            .map((delegationID) => lifecycle.find((event) => event.delegationID === delegationID)?.fanout?.itemIndex)
            .sort(),
        ).toEqual([0, 1])

        for (const delegationID of delegationIDs) {
          const childEvents = lifecycle.filter((event) => event.delegationID === delegationID)
          expect(childEvents).toHaveLength(3)
          expect(childEvents.every((event) => event.attemptIndex === 0)).toBe(true)
          expect(childEvents.map((event) => event.eventType).sort()).toEqual([
            "delegation.finished",
            "delegation.prepared",
            "delegation.started",
          ])
        }
      }),
  )

  modelIt.instance(
    "rejects identity task_model permission before creating any swarm child",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        let prompted = false
        const exit = yield* Effect.exit(
          def.execute(
            {
              prompt_template: "Review {{item}}",
              items: ["alpha", "beta"],
              subagent_type: "general",
              model_identity: "test-model",
              concurrency: 2,
            },
            {
              ...ctx(parent, stubOps({ onPrompt: () => (prompted = true) })),
              ask: (input: { permission?: string }) =>
                input.permission === "task_model" ? Effect.die(new Error("task_model denied")) : Effect.void,
            },
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("task_model denied")
        expect(prompted).toBe(false)
        expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
      }),
  )

  it.instance(
    "rejects conflicting swarm identity selectors before asking or creating children",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: unknown[] = []
        const exit = yield* Effect.exit(
          def.execute(
            {
              prompt_template: "Review {{item}}",
              items: ["alpha"],
              subagent_type: "general",
              model: "test/test-model",
              model_identity: "test-model",
            },
            {
              ...ctx(parent, stubOps()),
              ask: (input) =>
                Effect.sync(() => {
                  asks.push(input)
                }),
            },
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("mutually exclusive")
        expect(asks).toHaveLength(0)
        expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
      }),
  )

  it.instance("records no activity when the swarm parent is itself a child session", () =>
    Effect.gen(function* () {
      const root = yield* seed()
      const parent = yield* seed("Nested swarm parent", root.chat.id)
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          prompt_template: "Review {{item}}",
          items: ["alpha"],
          subagent_type: "general",
          concurrency: 1,
        },
        ctx(parent, stubOps()),
      )
      expect(result.metadata.successCount).toBe(1)
      expect(routingActivity).toHaveLength(0)
    }),
  )
  identityIt.instance(
    "selects and authorizes a workload route once for the whole fan-out",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
        const prompts: SessionPrompt.PromptInput[] = []
        modelIdentityListCalls = 0

        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            workload: "scout",
            concurrency: 2,
          },
          {
            ...ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(modelIdentityListCalls).toBe(1)
        expect(asks).toHaveLength(1)
        expect(asks[0]?.permission).toBe("task_model")
        expect(asks[0]?.patterns).toEqual(["test/test-model"])
        expect(result.metadata).toMatchObject({ workload: "scout", model: "test/test-model", successCount: 2 })
        expect(prompts).toHaveLength(2)
        expect(prompts.every((input) => input.model?.providerID === ref.providerID && input.model.modelID === ref.modelID)).toBe(true)
        const runs = result.metadata.childRuns as Array<{ execution?: { workload?: string; source?: string } }>
        expect(runs.every((run) => run.execution?.workload === "scout")).toBe(true)
        expect(runs.every((run) => run.execution?.source === "request-model")).toBe(true)
      }),
  )

  modelIt.instance(
    "keeps an explicit swarm model authoritative while recording workload",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const prompts: SessionPrompt.PromptInput[] = []

        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            workload: "scout",
            model: "test/test-model",
            variant: "max",
            concurrency: 2,
          },
          ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
        )

        expect(result.metadata).toMatchObject({ workload: "scout", model: "test/test-model", successCount: 2 })
        expect(prompts.every((input) => input.model?.providerID === ref.providerID && input.model.modelID === ref.modelID && input.variant === "max")).toBe(true)
        const runs = result.metadata.childRuns as Array<{ execution?: { workload?: string; source?: string } }>
        expect(runs.every((run) => run.execution?.workload === "scout")).toBe(true)
        expect(runs.every((run) => run.execution?.source === "request-model")).toBe(true)
      }),
  )

  modelIt.instance(
    "rejects workload-only swarm dispatch when scheduling is disabled",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: unknown[] = []

        const exit = yield* def
          .execute(
            {
              prompt_template: "Review {{item}}",
              items: ["alpha"],
              subagent_type: "general",
              workload: "scout",
            },
            {
              ...ctx(parent, stubOps()),
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
        expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
      }),
    { config: { delegation: { scheduling: { enabled: false } } } },
  )

  identityIt.instance(
    "keeps an explicit swarm model authoritative when scheduling is disabled and authorizes once",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed()
        const tool = yield* ChimeraSwarmTool
        const def = yield* tool.init()
        const asks: Array<{ permission?: string; patterns?: readonly string[] }> = []
        const prompts: SessionPrompt.PromptInput[] = []
        modelIdentityListCalls = 0

        const result = yield* def.execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha", "beta"],
            subagent_type: "general",
            workload: "scout",
            model: "test/test-model",
            variant: "max",
            concurrency: 2,
          },
          {
            ...ctx(parent, stubOps({ onPrompt: (input) => prompts.push(input) })),
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          },
        )

        expect(modelIdentityListCalls).toBe(1)
        expect(asks.map((item) => item.permission)).toEqual(["task_model"])
        expect(asks[0]?.patterns).toEqual(["test/test-model"])
        expect(result.metadata).toMatchObject({ workload: "scout", model: "test/test-model", successCount: 2 })
        expect(prompts).toHaveLength(2)
        expect(
          prompts.every(
            (input) =>
              input.model?.providerID === ref.providerID &&
              input.model.modelID === ref.modelID &&
              input.variant === "max",
          ),
        ).toBe(true)
        const runs = result.metadata.childRuns as Array<{ execution?: { workload?: string; source?: string } }>
        expect(runs.every((run) => run.execution?.workload === "scout")).toBe(true)
        expect(runs.every((run) => run.execution?.source === "request-model")).toBe(true)
      }),
    { config: { delegation: { scheduling: { enabled: false } } } },
  )

  modelIt.instance("rejects an unknown workload before authorization or child creation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      const asks: unknown[] = []

      const exit = yield* def
        .execute(
          {
            prompt_template: "Review {{item}}",
            items: ["alpha"],
            subagent_type: "general",
            workload: "unknown",
          },
          {
            ...ctx(parent, stubOps()),
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
      expect(yield* sessions.children(parent.chat.id)).toHaveLength(0)
    }),
  )
})
