import { afterEach, describe, expect } from "bun:test"
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
import { SubagentDispatch } from "../../src/agent/subagent-dispatch"
import { Truncate } from "../../src/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

/**
 * Dispatch-level coverage for structured-output correction retries. The prompt
 * layer is a controllable mock: no child process or LLM is involved, while
 * Agent/Config/Session/DelegationLimiter/BackgroundJob are real layers so the
 * child session lifecycle is exercised for real.
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

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
}

const format: MessageV2.OutputFormat = { type: "json_schema", schema, retryCount: 2 }

type PromptFn = (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts>
type CancelFn = (sessionID: SessionID) => Effect.Effect<void>

let promptFn: PromptFn = (input) => Effect.succeed(reply(input, "done"))
let cancelFn: CancelFn = () => Effect.void
let promptInputs: SessionPrompt.PromptInput[] = []

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

const promptOps = {
  cancel: (sessionID: SessionID) => Effect.suspend(() => cancelFn(sessionID)),
  resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input: SessionPrompt.PromptInput) =>
    Effect.suspend(() => {
      promptInputs.push(input)
      return promptFn(input)
    }),
}

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
    Truncate.defaultLayer,
    testProvider.layer,
  ),
)

afterEach(async () => {
  promptFn = (input) => Effect.succeed(reply(input, "done"))
  cancelFn = () => Effect.void
  promptInputs = []
  await disposeAllInstances()
})

const seed = Effect.fn("SubagentDispatchTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Dispatch parent" })
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

const runDispatch = Effect.fn("SubagentDispatchTest.run")(function* (input: {
  parent: { chat: Session.Info; assistant: MessageV2.Assistant }
  subagentType?: string
  format?: MessageV2.OutputFormat
}) {
  const dispatch = yield* SubagentDispatch
  const prepared = yield* dispatch.prepare({
    parentSessionID: input.parent.chat.id,
    parentMessageID: input.parent.assistant.id,
    subagentType: input.subagentType ?? "general",
  })
  const materialized = yield* dispatch.materialize(prepared, "retry-test")
  return yield* dispatch.runPrepared({
    prepared,
    materialized,
    description: "retry-test",
    prompt: "produce the final answer",
    promptOps,
    abort: new AbortController().signal,
    ...(input.format ? { format: input.format } : {}),
  })
})

describe("subagent structured-output correction retries", () => {
  it.instance("re-prompts the same child session and returns structured output", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const structured = { answer: "42" }
      let calls = 0
      promptFn = (input) => {
        calls += 1
        return Effect.succeed(calls === 1 ? reply(input, "plain text, no tool call") : reply(input, "", { structured }))
      }

      const result = yield* runDispatch({ parent, format })

      expect(result.message.info.role).toBe("assistant")
      if (result.message.info.role === "assistant") expect(result.message.info.structured).toEqual(structured)
      expect(promptInputs).toHaveLength(2)
      expect(promptInputs[1].sessionID).toBe(promptInputs[0].sessionID)
      expect(promptInputs[1].format).toEqual(format)
      const correction = promptInputs[1].parts.find((part) => part.type === "text")?.text ?? ""
      expect(correction).toContain("StructuredOutput")
      expect(correction).toContain('"answer"')
      expect(correction).toContain("was not called")
      const sessions = yield* Session.Service
      expect(yield* sessions.children(parent.chat.id)).toHaveLength(1)
    }),
  )

  it.instance("falls back to text with an event annotation after retries are exhausted", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const sessions = yield* Session.Service
      promptFn = (input) =>
        Effect.gen(function* () {
          const message = reply(input, "still plain text", {
            error: {
              name: "StructuredOutputError",
              data: { message: "expected object, received string at answer", retries: 0 },
            },
          })
          yield* sessions.updateMessage(message.info)
          for (const part of message.parts) yield* sessions.updatePart(part)
          return message
        })

      const result = yield* runDispatch({ parent, format })

      expect(result.message.info.role).toBe("assistant")
      if (result.message.info.role === "assistant") expect(result.message.info.structured).toBeUndefined()
      const text = result.message.parts.findLast((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("schema retries exhausted, fell back to text")
      expect(text).toContain("still plain text")
      expect(result.output).toContain("still plain text")
      expect(promptInputs).toHaveLength(3)
      const messages = yield* sessions.messages({ sessionID: promptInputs[0].sessionID })
      const annotation = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "text" && part.metadata?.schema_fallback === true)
      expect(annotation?.type).toBe("text")
      if (annotation?.type === "text") expect(annotation.text).toContain("schema retries exhausted, fell back to text")
    }),
  )

  it.instance("still fails when retries are exhausted without usable text", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      promptFn = (input) =>
        Effect.succeed(
          reply(input, "", {
            error: {
              name: "StructuredOutputError",
              data: { message: "expected object, received string at answer", retries: 0 },
            },
          }),
        )

      const exit = yield* runDispatch({ parent, format }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("expected object, received string at answer")
        expect(message).toContain("structured-output retries exhausted")
      }
      expect(promptInputs).toHaveLength(3)
    }),
  )

  it.instance("carries the last StructuredOutput validation error into the corrective turn", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const sessions = yield* Session.Service
      const structured = { answer: "42" }
      let calls = 0
      promptFn = (input) =>
        Effect.gen(function* () {
          calls += 1
          if (calls > 1) return reply(input, "", { structured })
          const failed = reply(input, "")
          yield* sessions.updateMessage(failed.info)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: failed.info.id,
            sessionID: input.sessionID,
            type: "tool",
            callID: "call_structured_1",
            tool: "StructuredOutput",
            state: {
              status: "error",
              input: {},
              error: "Invalid input: expected object at answer",
              time: { start: Date.now(), end: Date.now() },
            },
          })
          return reply(input, "plain text")
        })

      const result = yield* runDispatch({ parent, format })

      expect(result.message.info.role).toBe("assistant")
      if (result.message.info.role === "assistant") expect(result.message.info.structured).toEqual(structured)
      expect(promptInputs).toHaveLength(2)
      const correction = promptInputs[1].parts.find((part) => part.type === "text")?.text ?? ""
      expect(correction).toContain("Invalid input: expected object at answer")
    }),
  )

  it.instance("does not retry when retryCount is 0", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      promptFn = (input) => Effect.succeed(reply(input, "plain text"))

      const result = yield* runDispatch({ parent, format: { ...format, retryCount: 0 } })

      expect(result.message.parts.findLast((part) => part.type === "text")?.text).toContain("plain text")
      expect(promptInputs).toHaveLength(1)
    }),
  )

  it.instance("defaults to two retries when retryCount is omitted", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      promptFn = (input) => Effect.succeed(reply(input, "plain text"))

      const result = yield* runDispatch({ parent, format: { type: "json_schema", schema } })

      expect(result.message.parts.findLast((part) => part.type === "text")?.text).toContain("plain text")
      expect(promptInputs).toHaveLength(3)
    }),
  )

  it.instance("caps an oversized fallback inline and saves the full text to an output file", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const long = "0123456789".repeat(1_500)
      promptFn = (input) => Effect.succeed(reply(input, long))

      const result = yield* runDispatch({ parent, format: { ...format, retryCount: 0 } })

      const text = result.message.parts.findLast((part) => part.type === "text")?.text ?? ""
      expect(long).not.toContain("\n")
      expect(text).toContain("schema retries exhausted, fell back to text")
      // The inline body keeps the head of the single long line instead of
      // collapsing to the truncation hint only.
      expect(text).toContain(long.slice(0, 100))
      expect(text).toContain("Full output saved to:")
      expect(text.length).toBeLessThan(long.length)
      const outputPath = result.metadata.outputPath
      expect(typeof outputPath).toBe("string")
      if (typeof outputPath !== "string") return
      const saved = yield* Effect.promise(() => Bun.file(outputPath).text())
      expect(saved).toContain(long)
    }),
  )

  it.instance("falls back to the nearest earlier retry round that produced text", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      let calls = 0
      promptFn = (input) =>
        Effect.gen(function* () {
          calls += 1
          if (calls === 1) return reply(input, "first usable answer")
          return reply(input, "", {
            error: {
              name: "StructuredOutputError",
              data: { message: "expected object, received string at answer", retries: 0 },
            },
          })
        })

      const result = yield* runDispatch({ parent, format })

      const text = result.message.parts.findLast((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("first usable answer")
      expect(text).toContain("schema retries exhausted, fell back to text")
      expect(promptInputs).toHaveLength(3)
    }),
  )

  it.instance("returns pre-compaction text when a compaction completes inside the retry window", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const sessions = yield* Session.Service
      let calls = 0
      promptFn = (input) =>
        Effect.gen(function* () {
          calls += 1
          if (calls === 1) return reply(input, "pre-compaction answer")
          const compaction = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: compaction.id,
            sessionID: input.sessionID,
            type: "compaction",
            auto: true,
          })
          const summary = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: compaction.id,
            sessionID: input.sessionID,
            mode: "compaction",
            agent: "compaction",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            summary: true,
            finish: "stop",
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: summary.id,
            sessionID: input.sessionID,
            type: "text",
            text: "summary",
          })
          return reply(input, "post-compaction answer")
        })

      const result = yield* runDispatch({ parent, format })

      expect(promptInputs).toHaveLength(2)
      const text = result.message.parts.findLast((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("pre-compaction answer")
      expect(text).not.toContain("post-compaction answer")
      expect(text).toContain("interrupted by compaction")
    }),
  )

  it.instance("returns pre-compaction text when a compaction is pending inside the retry window", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const sessions = yield* Session.Service
      let calls = 0
      promptFn = (input) =>
        Effect.gen(function* () {
          calls += 1
          if (calls === 1) return reply(input, "pre-compaction answer")
          const compaction = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: compaction.id,
            sessionID: input.sessionID,
            type: "compaction",
            auto: true,
          })
          return reply(input, "post-compaction answer")
        })

      const result = yield* runDispatch({ parent, format })

      expect(promptInputs).toHaveLength(2)
      const text = result.message.parts.findLast((part) => part.type === "text")?.text ?? ""
      expect(text).toContain("pre-compaction answer")
      expect(text).not.toContain("post-compaction answer")
      expect(text).toContain("interrupted by compaction")
    }),
  )

  it.instance("runs the correction path for the restricted explore subagent", () =>
    Effect.gen(function* () {
      const parent = yield* seed()
      const structured = { answer: "ok" }
      let calls = 0
      promptFn = (input) => {
        calls += 1
        return Effect.succeed(calls === 1 ? reply(input, "plain text") : reply(input, "", { structured }))
      }

      const result = yield* runDispatch({ parent, subagentType: "explore", format })

      expect(result.message.info.role).toBe("assistant")
      if (result.message.info.role === "assistant") expect(result.message.info.structured).toEqual(structured)
      expect(promptInputs).toHaveLength(2)
      expect(promptInputs.every((input) => input.agent === "explore")).toBe(true)
      expect(promptInputs.every((input) => input.format?.type === "json_schema")).toBe(true)
      // Dispatch disables delegation tools for explore; StructuredOutput is
      // injected by the prompt layer outside the permission domain, so the
      // correction path must still work for this restricted agent.
      expect(promptInputs[0].tools).toMatchObject({ task: false, chimera_swarm: false })
      const sessions = yield* Session.Service
      expect(yield* sessions.children(parent.chat.id)).toHaveLength(1)
    }),
  )
})