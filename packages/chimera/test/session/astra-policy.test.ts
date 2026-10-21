import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testEffect } from "../lib/effect"

const it = testEffect(makePromptHarness())

function textOf(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function toolPart(message: MessageV2.WithParts) {
  return message.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

describe("Astra tool policy hard stop", () => {
  it.live(
    "stops the run, skips continuation, and leaves the session promptable",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped()
        const policyURL = pathToFileURL(path.resolve(import.meta.dir, "../../src/session/policy.ts")).href
        const pluginFile = path.join(dir, "policy-plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            pluginFile,
            [
              `import { AstraToolPolicyViolation } from ${JSON.stringify(policyURL)}`,
              "",
              "export default async () => ({",
              '  "tool.execute.before": (input) => {',
              '    if (input.tool !== "bash") return',
              "    throw new AstraToolPolicyViolation({",
              '      message: "shell policy violation",',
              "      tool: input.tool,",
              "    })",
              "  },",
              "})",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "chimera.json"),
            JSON.stringify({
              ...testProviderConfig(llm.url),
              plugin: [pathToFileURL(pluginFile).href],
            }),
          ),
        )

        return yield* provideInstance(dir)(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const status = yield* SessionStatus.Service
            const session = yield* sessions.create({
              title: "Astra policy",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })

            yield* llm.tool("bash", { command: "echo policy-probe", description: "policy probe" })
            const first = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "run the policy probe" }],
            })

            expect(first.info.role).toBe("assistant")
            if (first.info.role !== "assistant") return
            expect(first.info.error).toBeDefined()
            const violated = toolPart(first)
            expect(violated?.state.status).toBe("error")
            if (violated?.state.status === "error") expect(violated.state.error).toContain("shell policy violation")

            // The policy stop is terminal for the run: no goal/turn continuation
            // produced a second assistant message.
            const messages = yield* MessageV2.filterCompactedEffect(session.id)
            expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
            expect((yield* status.get(session.id)).type).toBe("idle")

            // Returning idle releases the run state, so a later user prompt runs
            // normally instead of inheriting the terminated turn.
            yield* llm.text("after-policy")
            const second = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "continue after the stop" }],
            })
            expect(second.info.role).toBe("assistant")
            if (second.info.role === "assistant") expect(second.info.error).toBeUndefined()
            expect(textOf(second)).toContain("after-policy")
          }),
        )
      }),
    30_000,
  )
})