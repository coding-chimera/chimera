import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Chimera } from "@/chimera"
import { ChimeraPromptContext } from "@/chimera/prompt-context"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { recordPredesignRun } from "@/chimera/store"
import { getGraphDataRootInfo } from "@/graph"
import { InstanceState } from "@/effect/instance-state"
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

function toolPart(sessionID: SessionID, messageID: MessageID, tool: string, callID: string, output = ""): MessageV2.ToolPart {
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
      output,
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

// A realistic mutation-tool output carrying a propagation scope check: the
// drift scanner parses the named files out of this exact line shape.
const SCOPE_OUTPUT = [
  "Edit applied successfully.",
  "",
  "Propagation check: 1 dependent file(s) may be affected: relay.ts.",
  "Scope check: propagation reaches deep.ts (via surface.ts, 3 hops), surface.ts (via relay.ts, 2 hops), relay.ts, outside the scope declared in predesign_drift (declared: main.ts). Entries marked (via ..., N hops) are deep consumers up to 3 hops away that grep on the changed symbol cannot reach; they often hardcode the old contract.",
].join("\n")

function driftCtx(sessionID: SessionID, callID: string) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    callID,
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function sessionWithScopeFlag(sessions: Session.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const parent = yield* sessions.updateMessage(userMessage(sessionID))
    const assistant = yield* sessions.updateMessage(assistantMessage(sessionID, parent.id))
    yield* sessions.updatePart(toolPart(sessionID, assistant.id, "edit", "call_scope_flag", SCOPE_OUTPUT))
  })
}

describe("chimera prompt-context unreconciled scope drift", () => {
  it.live("resurfaces scope-flagged files that were never edited or declared", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Drift open" })
        yield* sessionWithScopeFlag(sessions, session.id)

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        // Deep entries only: relay.ts is 1-hop and must not dilute the list.
        expect(context).toContain("Unreconciled scope drift: deep.ts, surface.ts")
        expect(context).not.toContain("surface.ts, relay.ts")
        expect(context).toContain("Reconcile each one before closeout")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("clears the drift signal once a predesign declares the flagged files", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const instance = yield* InstanceState.context
        const dir = instance.worktree === "/" ? instance.directory : instance.worktree
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Drift declared" })
        yield* sessionWithScopeFlag(sessions, session.id)
        const artifact = path.join(getGraphDataRootInfo(dir).dataRoot, "chimera", "predesign-runs.jsonl")
        yield* Effect.promise(() =>
          recordPredesignRun(dir, artifact, {
            sessionID: session.id,
            messageID: MessageID.ascending(),
            agent: "build",
            intent: "reconcile the flagged propagation surfaces",
            files: ["surface.ts", "deep.ts"],
            seedNodes: [],
            impactedNodes: [],
            fileDependents: [],
            evidence: [],
            snapshotRevision: "test-revision",
            payload: {},
          }),
        )

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain("Unreconciled scope drift")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("clears the drift signal once the flagged files are edited", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const instance = yield* InstanceState.context
        const dir = instance.worktree === "/" ? instance.directory : instance.worktree
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Drift edited" })
        yield* sessionWithScopeFlag(sessions, session.id)
        for (const file of ["surface.ts", "deep.ts"]) {
          yield* Chimera.trackToolMutation(
            {
              toolID: "edit",
              ctx: driftCtx(session.id, `call_drift_edit_${file}`),
              files: [path.join(dir, file)],
            },
            Effect.promise(() => fs.writeFile(path.join(dir, file), "export const patched = 1\n")),
          )
        }

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context ?? "").not.toContain("Unreconciled scope drift")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )

  it.live("keeps a deeper file flagged when only one flagged file is edited", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const instance = yield* InstanceState.context
        const dir = instance.worktree === "/" ? instance.directory : instance.worktree
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Drift partial" })
        yield* sessionWithScopeFlag(sessions, session.id)
        yield* Chimera.trackToolMutation(
          {
            toolID: "edit",
            ctx: driftCtx(session.id, "call_drift_partial"),
            files: [path.join(dir, "surface.ts")],
          },
          Effect.promise(() => fs.writeFile(path.join(dir, "surface.ts"), "export const patched = 1\n")),
        )

        const context = yield* (yield* ChimeraPromptContext.Service).render(session.id, sessions)

        expect(context).toContain("Unreconciled scope drift: deep.ts")
        expect(context).not.toContain("deep.ts, surface.ts")
      }),
      { git: true, config: (url) => testProviderConfig(url) },
    ),
  )
})