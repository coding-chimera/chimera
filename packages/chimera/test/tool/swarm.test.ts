import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ChimeraSwarmTool } from "../../src/tool/swarm"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { getCodeGraphDir } from "@/graph/directory"
import { recordOracleResult, writePersistentObligationStore } from "@/chimera/store"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const seed = Effect.fn("SwarmToolTest.seed")(function* (title = "Swarm parent") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
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
      expect(JSON.parse(result.output).results.map((item: { status: string }) => item.status)).toEqual(["success", "failure"])
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
      expect(children[0].permission?.slice(-2)).toEqual([
        { pattern: "*", action: "deny", permission: "task" },
        { pattern: "*", action: "deny", permission: "chimera_swarm" },
      ])
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
})
