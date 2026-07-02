import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
      expect(result.output).toContain("success: 2")
    }),
  )

  it.instance("bounds concurrent child prompts", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const tool = yield* ChimeraSwarmTool
      const def = yield* tool.init()
      let active = 0
      let maxActive = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(async () => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise((resolve) => setTimeout(resolve, 20))
            active--
            return reply(input, "done")
          }),
      }

      yield* def.execute(
        {
          prompt_template: "Handle {{item}}",
          items: ["a", "b", "c", "d", "e"],
          concurrency: 2,
        },
        ctx(parent, promptOps),
      )

      expect(maxActive).toBeGreaterThan(1)
      expect(maxActive).toBeLessThanOrEqual(2)
    }),
  )

  it.instance("materializes pending obligations as audit-review items", () =>
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
      expect(prompts[0]).toContain("audit-review")
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
      expect(tool?.description).toContain("prompt_template")
    }),
  )
})
