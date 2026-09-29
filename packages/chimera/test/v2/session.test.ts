import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { Shell } from "../../src/shell/shell"
import { Modelv2 } from "../../src/v2/model"
import { FileAttachment, Prompt } from "../../src/v2/session-prompt"
import { SessionV2 } from "../../src/v2/session"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

// The v2 service layer carries the real v1 engine stack (SessionV2.defaultLayer
// provides Session/SessionPrompt/SessionCompaction/... internally), so tests
// exercise the honest aliasing end to end: v2 methods in, real v1 engine work,
// v1 tables out. Session.defaultLayer and SessionStatus.defaultLayer are merged
// in again for direct assertions — the same layer objects dedupe through
// Effect's layer memoization, so both views share one instance.
const stack = Layer.mergeAll(SessionV2.defaultLayer, Session.defaultLayer, SessionStatus.defaultLayer)

const it = testEffect(
  Layer.mergeAll(TestLLMServer.layer, stack, NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer, FetchHttpClient.layer),
)
const unix = process.platform !== "win32" ? it.live : it.live.skip

const model = {
  id: Modelv2.ID.make("test-model"),
  providerID: Modelv2.ProviderID.make("test"),
  variant: Modelv2.VariantID.make("default"),
}

// Registers a custom "test" provider pointing at the in-process LLM stub so
// provider model lookup succeeds inside the loop (same approach as
// test/session/prompt.test.ts).
function providerCfg(url: string) {
  return {
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
          baseURL: url,
        },
      },
    },
  }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

it.live(
  "create delegates to the v1 engine and reads back through get",
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const v2 = yield* SessionV2.Service
        const v1 = yield* Session.Service

        const created = yield* v2.create({ agent: "build", model })
        const fetched = yield* v2.get(created.id)
        expect(fetched.id).toBe(created.id)
        expect(fetched.agent).toBe("build")
        expect(fetched.model?.id).toBe(Modelv2.ID.make("test-model"))
        expect(fetched.model?.providerID).toBe(Modelv2.ProviderID.make("test"))
        expect(fetched.parentID).toBeUndefined()

        // The v1 engine really owns the row: same session through v1 get.
        const original = yield* v1.get(created.id).pipe(Effect.orDie)
        expect(original.id).toBe(created.id)
        expect(original.agent).toBe("build")

        const child = yield* v2.create({ parentID: created.id })
        expect(child.parentID).toBe(created.id)
        const children = yield* v1.children(created.id)
        expect(children.map((info) => info.id)).toContain(child.id)
      }),
    { git: true },
  ),
)

it.live("prompt translates the v2 prompt into the v1 engine and returns the user message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const v2 = yield* SessionV2.Service
      const v1 = yield* Session.Service
      const session = yield* v2.create({ agent: "build", model })

      yield* llm.text("hello back")
      const user = yield* v2.prompt({
        sessionID: session.id,
        prompt: new Prompt({
          text: "hello v2",
          files: [
            FileAttachment.create({
              uri: "data:text/plain;base64,bm90ZSBjb250ZW50",
              mime: "text/plain",
              name: "note.txt",
            }),
          ],
        }),
        delivery: "immediate",
      })
      expect(user.type).toBe("user")
      expect(user.text).toBe("hello v2")
      expect(user.files?.map((file) => file.name)).toContain("note.txt")
      expect(typeof user.id).toBe("string")

      // Immediate delivery ran the real engine turn before returning.
      const msgs = yield* v1.messages({ sessionID: session.id })
      expect(msgs.some((msg) => msg.info.role === "user")).toBe(true)
      expect(
        msgs.some(
          (msg) => msg.info.role === "assistant" && msg.parts.some((part) => part.type === "text" && part.text === "hello back"),
        ),
      ).toBe(true)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("prompt with deferred delivery returns the user message and completes in background", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const v2 = yield* SessionV2.Service
      const v1 = yield* Session.Service
      const session = yield* v2.create({ agent: "build", model })

      yield* llm.text("deferred answer")
      const user = yield* v2.prompt({
        sessionID: session.id,
        prompt: new Prompt({ text: "run in background" }),
        delivery: "deferred",
      })
      expect(user.text).toBe("run in background")

      // The detached turn hits the LLM, then the session settles idle.
      yield* llm.wait(1)
      yield* v2.wait(session.id)
      const msgs = yield* v1.messages({ sessionID: session.id })
      expect(
        msgs.some(
          (msg) =>
            msg.info.role === "assistant" && msg.parts.some((part) => part.type === "text" && part.text === "deferred answer"),
        ),
      ).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("wait resolves immediately for an idle session", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const v2 = yield* SessionV2.Service
        const session = yield* v2.create({})
        yield* v2.wait(session.id).pipe(Effect.timeout("10 seconds"), Effect.orDie)
      }),
    { git: true },
  ),
)

it.live("wait stays pending while busy and resolves on the idle transition", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const v2 = yield* SessionV2.Service
        const status = yield* SessionStatus.Service
        const session = yield* v2.create({})

        yield* status.set(session.id, { type: "busy" })
        let resolved = false
        const fiber = yield* v2
          .wait(session.id)
          .pipe(Effect.tap(() => Effect.sync(() => (resolved = true))), Effect.forkChild)

        yield* Effect.sleep("200 millis")
        expect(resolved).toBe(false)

        yield* status.set(session.id, { type: "idle" })
        yield* Fiber.join(fiber)
        expect(resolved).toBe(true)
      }),
    { git: true },
  ),
)

it.live("compact stages a manual compaction and drives the summarization turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const v2 = yield* SessionV2.Service
      const v1 = yield* Session.Service
      const session = yield* v2.create({ agent: "build", model })

      yield* llm.text("first answer")
      yield* v2.prompt({
        sessionID: session.id,
        prompt: new Prompt({ text: "a question worth summarizing" }),
        delivery: "immediate",
      })

      yield* llm.text("compacted summary")
      yield* v2.compact(session.id)

      const msgs = yield* v1.messages({ sessionID: session.id })
      const compaction = msgs.find((msg) => msg.info.role === "assistant" && msg.info.mode === "compaction")
      expect(compaction).toBeDefined()
      expect(compaction?.info.summary).toBeDefined()
    }),
    { git: true, config: providerCfg },
  ),
)

unix(
  "shell delegates to the v1 shell engine",
  () =>
    withSh(() =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const v2 = yield* SessionV2.Service
          const v1 = yield* Session.Service
          const session = yield* v2.create({ agent: "build", model })

          yield* llm.text("seed turn")
          yield* v2.prompt({
            sessionID: session.id,
            prompt: new Prompt({ text: "seed" }),
            delivery: "immediate",
          })

          yield* llm.text("shell turn done")
          yield* v2.shell({ sessionID: session.id, command: "echo chimera-v2-shell" })

          const msgs = yield* v1.messages({ sessionID: session.id })
          const shellPart = msgs
            .flatMap((msg) => msg.parts)
            .find(
              (part) =>
                part.type === "tool" &&
                part.state.status === "completed" &&
                JSON.stringify(part.state.input).includes("chimera-v2-shell"),
            )
          expect(shellPart).toBeDefined()
          expect(JSON.stringify(shellPart)).toContain("chimera-v2-shell")
        }),
        { git: true, config: providerCfg },
      ),
    ),
)

it.live("subagent runs the child turn and delivers the answer into the parent session", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const v2 = yield* SessionV2.Service
      const v1 = yield* Session.Service
      const parent = yield* v2.create({ agent: "build", model })

      yield* llm.text("child answer")
      yield* llm.text("parent ack")
      yield* v2.subagent({ parentID: parent.id, agent: "build", model, prompt: new Prompt({ text: "child task" }) })

      // Hit 1: the child turn. Hit 2: the parent turn woken by the synthetic
      // delivery message. Then the parent session settles idle again.
      yield* llm.wait(2)
      yield* v2.wait(parent.id)

      const children = yield* v1.children(parent.id)
      expect(children).toHaveLength(1)

      const childMsgs = yield* v1.messages({ sessionID: children[0].id })
      expect(
        childMsgs.some(
          (msg) =>
            msg.info.role === "assistant" && msg.parts.some((part) => part.type === "text" && part.text === "child answer"),
        ),
      ).toBe(true)

      const parentMsgs = yield* v1.messages({ sessionID: parent.id })
      expect(
        parentMsgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("child answer")),
        ),
      ).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("skill is an honest no-op until a v2 skill surface exists", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const v2 = yield* SessionV2.Service
        const v1 = yield* Session.Service
        const session = yield* v2.create({})

        yield* v2.skill({ sessionID: session.id, skill: "repo-cognition" })

        const msgs = yield* v1.messages({ sessionID: session.id })
        expect(msgs).toHaveLength(0)
      }),
    { git: true },
  ),
)
