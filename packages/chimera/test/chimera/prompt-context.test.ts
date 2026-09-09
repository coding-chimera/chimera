import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Chimera } from "@/chimera"
import { ChimeraPromptContext } from "@/chimera/prompt-context"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(makePromptHarness())

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const HINT_HEADER = "## Graph discovery hint"
// The text-exploration tools whose presence (≥4 calls) makes the nudge relevant.
const TEXT_TOOLS = ["bash", "read", "grep", "glob"]

const GRAPH_PUSH_HEADER = "## Graph context (auto)"
const GRAPH_PUSH_ENV = "CHIMERA_GRAPH_PUSH_CONTEXT"

function userMessage(sessionID: SessionID): MessageV2.User {
  return {
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: "build",
    model: ref,
  } satisfies MessageV2.User
}

function assistantMessage(sessionID: SessionID, parentID: MessageID): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  } satisfies MessageV2.Assistant
}

function toolPart(sessionID: SessionID, messageID: MessageID, tool: string, callID: string): MessageV2.ToolPart {
  return {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    tool,
    callID,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  } satisfies MessageV2.ToolPart
}

function textPart(sessionID: SessionID, messageID: MessageID, text: string): MessageV2.TextPart {
  return {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text",
    text,
    synthetic: true,
  } satisfies MessageV2.TextPart
}

// A fully initialized graph (init + sync) makes the prompt-context readiness
// probe pass exactly like a production project; the prompt-context render path
// itself never opens the graph database.
const initGraph = Effect.fnUntraced(function* () {
  return yield* Chimera.initProjectGraph({ watch: false })
})

function sessionWithToolParts(
  sessions: Session.Interface,
  sessionID: SessionID,
  textTools: string[],
  graphTools: string[] = [],
) {
  return Effect.gen(function* () {
    const parent = yield* sessions.updateMessage(userMessage(sessionID))
    const assistant = yield* sessions.updateMessage(assistantMessage(sessionID, parent.id))
    let index = 0
    for (const tool of textTools) {
      yield* sessions.updatePart(toolPart(sessionID, assistant.id, tool, `call_${index}`))
      index += 1
    }
    for (const tool of graphTools) {
      yield* sessions.updatePart(toolPart(sessionID, assistant.id, tool, `call_graph_${index}`))
      index += 1
    }
  })
}

function persistedHintBlock(sessions: Session.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const message = yield* sessions.updateMessage(userMessage(sessionID))
    yield* sessions.updatePart(
      textPart(
        sessionID,
        message.id,
        `## Chimera Execution Context\n\n...\n${HINT_HEADER}\nThis project is indexed. One chimera_search or chimera_impact call can replace several grep/read steps.`,
      ),
    )
  })
}

// -- Push-style graph context helpers --

// Real user input arrives as non-synthetic text parts; synthetic parts (runtime
// context snapshots, injected reminders) are production text and must never seed
// token extraction.
function userTextPart(sessionID: SessionID, messageID: MessageID, text: string): MessageV2.TextPart {
  return {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text",
    text,
  } satisfies MessageV2.TextPart
}

function sessionWithUserText(sessions: Session.Interface, sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const message = yield* sessions.updateMessage(userMessage(sessionID))
    yield* sessions.updatePart(userTextPart(sessionID, message.id, text))
  })
}

// Sets CHIMERA_GRAPH_PUSH_CONTEXT for the duration of the test scope and restores
// the prior value afterwards (process.env writes leak across files otherwise).
function withGraphPushFlag(value: string | undefined) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const original = process.env[GRAPH_PUSH_ENV]
      if (value === undefined) delete process.env[GRAPH_PUSH_ENV]
      else process.env[GRAPH_PUSH_ENV] = value
      return original
    }),
    (original) =>
      Effect.sync(() => {
        if (original === undefined) delete process.env[GRAPH_PUSH_ENV]
        else process.env[GRAPH_PUSH_ENV] = original
      }),
  )
}
describe("chimera prompt-context graph discovery hint", () => {
  it.live(
    "injects the hint when the graph is ready, the session has >=4 text-exploration calls, and zero graph-query calls",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* () {
          yield* initGraph()
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "Hint" })
        yield* sessionWithToolParts(sessions, session.id, TEXT_TOOLS)

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

          expect(context).toBeDefined()
          expect(context).toContain(HINT_HEADER)
          expect(context).toContain("This project is indexed.")
          expect(context).toContain('chimera_file_symbols answers "what is in this file"')
          // The new section lands inside the existing runtime context block after Closeout Signals.
          expect(context!.indexOf(HINT_HEADER)).toBeGreaterThan(context!.indexOf("Closeout Signals"))
        }),
        { git: true, config: (url) => testProviderConfig(url) },
      ),
  )

  it.live("does not inject when the session already used a graph-query tool", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Hint used graph" })
        yield* sessionWithToolParts(sessions, session.id, TEXT_TOOLS, ["chimera_search"])

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain(HINT_HEADER)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("does not inject when the session has fewer than 4 text-exploration calls", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Hint too early" })
        yield* sessionWithToolParts(sessions, session.id, TEXT_TOOLS.slice(0, 3))

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain(HINT_HEADER)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("does not inject a second time once a previous prompt injection is persisted in the session", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Hint already shown" })
        yield* sessionWithToolParts(sessions, session.id, TEXT_TOOLS)
        // The first build's block was persisted as a synthetic runtime-context
        // message; its marker line is what makes the once-per-session guarantee.
        yield* persistedHintBlock(sessions, session.id)

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain(HINT_HEADER)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )
})

describe("chimera prompt-context push graph context", () => {
  it.live("skips the section when the env flag is off", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* withGraphPushFlag(undefined)
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Push flag off" })
        yield* sessionWithUserText(sessions, session.id, "Update `trackedPushSymbol` to accept an options object.")

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain(GRAPH_PUSH_HEADER)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("injects the section with hit lines when the flag is on, the graph is initialized, and the message is code-like", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        yield* withGraphPushFlag("1")
        // Fixture symbol the graph index can actually resolve.
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "search.ts"), "export function trackedPushSymbol() { return 1 }\n"))
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Push flag on" })
        yield* sessionWithUserText(
          sessions,
          session.id,
          "Update `trackedPushSymbol` to accept an options object and adjust src/tool/search.ts accordingly.",
        )

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context).toBeDefined()
        expect(context).toBeDefined()
        expect(context).toContain(GRAPH_PUSH_HEADER)
        expect(context).toContain("trackedPushSymbol (function)")
        expect(context).toContain("(auto-generated from your message keywords; query tools available for deeper exploration)")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("skips the section for a plain natural-language message even with the flag on", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* withGraphPushFlag("1")
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Push natural language" })
        yield* sessionWithUserText(sessions, session.id, "Please help me understand the project structure and how everything fits together.")

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain(GRAPH_PUSH_HEADER)
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("injects with debug logging on and falls back to the default timeout for invalid overrides", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        yield* withGraphPushFlag("1")
        const originalDebug = process.env["CHIMERA_GRAPH_PUSH_DEBUG"]
        const originalTimeout = process.env["CHIMERA_GRAPH_PUSH_TIMEOUT_MS"]
        process.env["CHIMERA_GRAPH_PUSH_DEBUG"] = "1"
        process.env["CHIMERA_GRAPH_PUSH_TIMEOUT_MS"] = "not-a-number"
        try {
          yield* Effect.promise(() => fs.writeFile(path.join(dir, "debug.ts"), "export function trackedPushDebug() { return 1 }\n"))
          yield* initGraph()
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "Push debug env" })
          yield* sessionWithUserText(sessions, session.id, "Update `trackedPushDebug` to accept an options object.")

          const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

          expect(context ?? "").toContain(GRAPH_PUSH_HEADER)
          expect(context ?? "").toContain("trackedPushDebug (function)")
        } finally {
          if (originalDebug === undefined) delete process.env["CHIMERA_GRAPH_PUSH_DEBUG"]
          else process.env["CHIMERA_GRAPH_PUSH_DEBUG"] = originalDebug
          if (originalTimeout === undefined) delete process.env["CHIMERA_GRAPH_PUSH_TIMEOUT_MS"]
          else process.env["CHIMERA_GRAPH_PUSH_TIMEOUT_MS"] = originalTimeout
        }
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )
})