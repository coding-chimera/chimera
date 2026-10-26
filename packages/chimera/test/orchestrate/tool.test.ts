import { afterEach, describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * End-to-end orchestrate tool coverage: the root model calls `orchestrate`, the
 * program fans out two real subagent dispatches in a worker process, and only
 * the program's curated return plus logs re-enter the parent context.
 */

const it = testEffect(makePromptHarness())

afterEach(async () => {
  await disposeAllInstances()
})

const CODE = [
  "const results = await orche.parallel([",
  '  () => orche.agent({ prompt: "alpha task", label: "alpha" }),',
  '  () => orche.agent({ prompt: "beta task", label: "beta" }),',
  "]);",
  'orche.log("fanout complete", results.filter(Boolean).length);',
  "return { total: results.length, ok: results.filter(Boolean).length };",
].join("\n")

function textOf(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function toolPart(messages: MessageV2.WithParts[], tool: string) {
  return messages
    .flatMap((message) => message.parts)
    .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === tool)
}

function autoReply(permission: Permission.Interface, asked: string[], reply: (name: string) => "once" | "reject") {
  const bus = Effect.gen(function* () {
    return yield* Bus.Service
  })
  return Effect.gen(function* () {
    const service = yield* bus
    yield* Effect.forkScoped(
      Stream.runForEach(service.subscribe(Permission.Event.Asked), (event) =>
        permission
          .reply({ requestID: event.properties.id, reply: reply(event.properties.permission) })
          .pipe(Effect.tap(() => Effect.sync(() => asked.push(event.properties.permission))), Effect.ignore),
      ),
    )
  })
}

describe("orchestrate tool", () => {
  it.live(
    "fans out subagents and returns only the curated program result",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const permission = yield* Permission.Service
          const asked: string[] = []
          yield* autoReply(permission, asked, () => "once")

          const chat = yield* sessions.create({
            title: "Orchestrate parent",
            permission: [{ permission: "task", pattern: "*", action: "ask" }],
          })

          yield* llm.tool("orchestrate", { code: CODE, description: "fan out two" })
          yield* llm.text("child-alpha-raw")
          yield* llm.text("child-beta-raw")
          yield* llm.text("root summary")

          const result = yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "delegate this fan-out" }],
          })
          expect(result.info.role).toBe("assistant")

          const messages = yield* MessageV2.filterCompactedEffect(chat.id)
          const tool = toolPart(messages, "orchestrate")
          expect(tool).toBeDefined()
          if (!tool || tool.state.status !== "completed") throw new Error("orchestrate tool did not complete")

          // Curated return + logs are the only program output that reaches the parent.
          expect(tool.state.output).toContain("fanout complete 2")
          expect(tool.state.output).toContain('"total": 2')
          expect(tool.state.output).toContain('"ok": 2')

          // Child intermediate responses never enter the parent context.
          const parentText = messages.map(textOf).join("\n")
          expect(parentText).not.toContain("child-alpha-raw")
          expect(parentText).not.toContain("child-beta-raw")
          expect(tool.state.output).not.toContain("child-alpha-raw")
          expect(tool.state.output).not.toContain("child-beta-raw")
          expect(parentText).toContain("root summary")

          // Progress metadata records both children with their terminal status.
          const agents = (tool.state.metadata as { agents?: { label: string; status: string }[] } | undefined)?.agents ?? []
          expect(agents.map((agent) => agent.label).sort()).toEqual(["alpha", "beta"])
          expect(agents.every((agent) => agent.status === "completed")).toBe(true)

          // One orchestrate approval plus one task approval per child.
          expect(asked.filter((name) => name === "orchestrate")).toHaveLength(1)
          expect(asked.filter((name) => name === "task")).toHaveLength(2)

          // Both children are real, persisted child sessions.
          expect(yield* sessions.children(chat.id)).toHaveLength(2)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
    30_000,
  )

  it.live(
    "rejects the call without spawning children when the orchestrate approval is denied",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const permission = yield* Permission.Service
          const asked: string[] = []
          yield* autoReply(permission, asked, (name) => (name === "orchestrate" ? "reject" : "once"))

          const chat = yield* sessions.create({ title: "Orchestrate denied" })

          yield* llm.tool("orchestrate", { code: CODE, description: "denied fan-out" })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "try to delegate" }],
          })

          const messages = yield* MessageV2.filterCompactedEffect(chat.id)
          const tool = toolPart(messages, "orchestrate")
          expect(tool?.state.status).toBe("error")
          if (tool?.state.status === "error") expect(tool.state.error).toContain("rejected")
          expect(asked).toEqual(["orchestrate"])
          expect(yield* sessions.children(chat.id)).toHaveLength(0)
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
    30_000,
  )
})