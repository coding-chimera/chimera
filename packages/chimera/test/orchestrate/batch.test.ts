import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
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
import { getCodeGraphDir } from "@/graph/directory"
import { writePersistentObligationStore } from "@/chimera/store"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

/**
 * Host-binding coverage for `orche.batch`. The prompt layer is a controllable
 * mock (no real child process or LLM); Agent/Config/Session/DelegationLimiter/
 * BackgroundJob are the real layers so dispatch behavior is exercised for real.
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
  extra?: { structured?: unknown; error: MessageV2.Assistant["error"] },
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

const seed = Effect.fn("OrchestrateBatchTest.seed")(function* (title = "Orchestrate parent") {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title })
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

const bind = Effect.fn("OrchestrateBatchTest.bind")(function* (
  parent: { chat: Session.Info; assistant: MessageV2.Assistant },
  limits: OrchestrationLimits,
) {
  return yield* makeOrchestrationBindings(
    {
      parentSessionID: parent.chat.id,
      parentMessageID: parent.assistant.id,
      signal: new AbortController().signal,
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

function promptText(input: SessionPrompt.PromptInput) {
  const part = input.parts[0]
  return part?.type === "text" ? part.text : ""
}

function callBatch(binding: (args: JsonValue) => JsonValue | Promise<JsonValue>, args: JsonValue) {
  return Effect.promise(() => Promise.resolve(binding(args)))
}

describe("orchestrate orche.batch", () => {
  it.instance("fans out explicit items and returns aligned results", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const prompts: string[] = []
      promptFn = (input) => {
        prompts.push(promptText(input))
        return Effect.succeed(reply(input, "Status: actionable\nChanged files: src/a.ts"))
      }
      const orche = yield* bind(parent, { maxTotalAgents: 8, maxConcurrent: 4 })

      const result = yield* callBatch(orche.bindings.orche.batch, { items: ["alpha", "beta"] })
      const entries = result as Array<{ item: unknown; index: number; status: string; summary: Record<string, string> }>

      expect(entries).toHaveLength(2)
      expect(entries[0]).toMatchObject({ item: "alpha", index: 1, status: "completed" })
      expect(entries[1]).toMatchObject({ item: "beta", index: 2, status: "completed" })
      expect(entries[0].summary.status).toBe("actionable")
      expect(entries[0].summary.changedFiles).toBe("src/a.ts")
      // Child prompts run concurrently, so locate each prompt by content instead of order.
      const alphaPrompt = prompts.find((prompt) => prompt.includes("alpha"))
      const betaPrompt = prompts.find((prompt) => prompt.includes("beta"))
      expect(alphaPrompt).toContain("Item 1/2:")
      expect(betaPrompt).toContain("Item 2/2:")
      expect(asks.map((ask) => ask.patterns[0])).toEqual(["general", "general"])
      expect(events.filter((event) => event.type === "finish")).toHaveLength(2)
      yield* orche.disposeAll()
    }),
  )

  it.instance("materializes a from source into batch items", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const parent = yield* seed()
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
      promptFn = (input) => {
        prompts.push(promptText(input))
        return Effect.succeed(reply(input, "Status: covered"))
      }
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

      const result = yield* callBatch(orche.bindings.orche.batch, { from: "pending_obligations" })
      const entries = result as Array<{ item: { id?: string; ref?: string }; index: number; status: string }>

      expect(entries).toHaveLength(1)
      expect(entries[0].item.id).toBe("obl_pending")
      expect(entries[0].item.ref).toBe("obligation:obl_pending")
      expect(entries[0].index).toBe(1)
      expect(prompts[0]).toContain("audit-followup subagent")
      expect(prompts[0]).toContain("obl_pending")
      expect(prompts[0]).not.toContain("obl_resolved")
      yield* orche.disposeAll()
    }),
  )

  it.instance("renders preset templates and keeps scope warnings advisory", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const prompts: string[] = []
      promptFn = (input) => {
        prompts.push(promptText(input))
        return Effect.succeed(reply(input, "done"))
      }
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

      yield* callBatch(orche.bindings.orche.batch, {
        preset: "file-review",
        items: [{ file: "src/a.ts" }, { scope: { files: ["src/a.ts"] } }],
      })

      const filePrompt = prompts.find((prompt) => prompt.includes('"file": "src/a.ts"'))
      const scopePrompt = prompts.find((prompt) => prompt.includes('"scope": {'))
      expect(filePrompt).toContain("file-review subagent")
      expect(filePrompt).toContain("Item 1/2:")
      expect(filePrompt).toContain("Parent follow-up:")
      expect(filePrompt).toContain("Scope warning:")
      expect(scopePrompt).toContain("Scope warning:")
      expect(scopePrompt).toContain("Item 2/2:")
      expect(asks.map((ask) => ask.patterns[0])).toEqual(["explore", "explore"])
      yield* orche.disposeAll()
    }),
  )

  it.instance("rejects an empty batch request with a clear binding error", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })
      const batch = orche.bindings.orche.batch

      const missing = yield* callBatch(batch, {}).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
      if (Exit.isFailure(missing)) expect(Cause.pretty(missing.cause)).toContain("requires items or from")

      const both = yield* callBatch(batch, { items: ["a"], from: "pending_obligations" }).pipe(Effect.exit)
      expect(Exit.isFailure(both)).toBe(true)
      if (Exit.isFailure(both)) {
        expect(Cause.pretty(both.cause)).toContain("either explicit items or from, not both")
      }

      const empty = yield* callBatch(batch, { items: [] }).pipe(Effect.exit)
      expect(Exit.isFailure(empty)).toBe(true)
      if (Exit.isFailure(empty)) expect(Cause.pretty(empty.cause)).toContain("non-empty items array")

      expect(promptInputs).toHaveLength(0)
      yield* orche.disposeAll()
    }),
  )

  it.instance("returns null for a failed item and keeps sibling results", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      promptFn = (input) =>
        promptText(input).includes("beta")
          ? Effect.succeed(
              reply(input, "partial", { error: { name: "UnknownError", data: { message: "model exploded" } } }),
            )
          : Effect.succeed(reply(input, "Status: actionable"))
      const orche = yield* bind(parent, { maxTotalAgents: 4, maxConcurrent: 2 })

      const result = yield* callBatch(orche.bindings.orche.batch, { items: ["alpha", "beta"], concurrency: 2 })
      const entries = result as Array<unknown>

      expect(entries).toHaveLength(2)
      expect(entries[0]).toMatchObject({ item: "alpha", index: 1, status: "completed" })
      expect(entries[1]).toBeNull()
      expect(events.filter((event) => event.status === "failed")).toHaveLength(1)
      yield* orche.disposeAll()
    }),
  )
})