import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { CodexResponses, type CodexResponsesInput } from "@/session/codex-responses"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ToolRevealTable } from "@/session/session.sql"
import { ToolSearch } from "@/session/tool-search"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(ToolSearch.defaultLayer)
const loopIt = testEffect(makePromptHarness())

const candidates = ToolSearch.DEFERRED_TOOLS.map((entry) => ({ id: entry.id, description: entry.summary }))

// tool_reveal rows FK-reference session rows (which FK-reference project
// rows); seed the parent chain for the synthetic unit sessions, mirroring
// test/session/goal.test.ts. The module-level reveal cache is also reset so
// every test reloads from the database deterministically.
beforeEach(() => {
  ToolSearch.resetRevealCache()
  Database.Client().$client.exec(`
    DELETE FROM tool_reveal;
    DELETE FROM session WHERE id LIKE 'ses_tool_search_unit%';
    DELETE FROM project WHERE id = 'prj_tool_search_test';
    INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('prj_tool_search_test', '/tmp/tool-search-test', '[]', 0, 0);
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('ses_tool_search_unit_a', 'prj_tool_search_test', 'tool-search-a', '/tmp/tool-search-test', 'Tool Search A', 'test', 0, 0),
           ('ses_tool_search_unit_b', 'prj_tool_search_test', 'tool-search-b', '/tmp/tool-search-test', 'Tool Search B', 'test', 0, 0);
  `)
})

// The chat-completions wire serializes the tool record as [{type:"function",
// function:{name,...}}]; extract the ordered names from a captured request body.
const wireToolNames = (body: Record<string, unknown>) =>
  ((body.tools ?? []) as Array<{ function?: { name?: string } }>).map((entry) => entry.function?.name ?? "")

describe("session.tool-search", () => {
  it.live("search scores and ranks matches; browser_* top for 'browser'", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      const matches = toolSearch.search({ query: "browser", limit: 11, candidates })
      expect(matches.length).toBe(6)
      expect(matches.map((match) => match.id).toSorted()).toEqual([
        "browser_click",
        "browser_close",
        "browser_open",
        "browser_screenshot",
        "browser_snapshot",
        "browser_type",
      ])
      // id hit (3) + description hit (1) + id-prefix bonus (1) for every browser_* tool
      expect(matches.every((match) => match.score === 5)).toBe(true)
    }),
  )

  it.live("search ranks subagent_model_routes top for 'route'", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      const matches = toolSearch.search({ query: "route", limit: 11, candidates })
      expect(matches[0]?.id).toBe("subagent_model_routes")
      expect(matches.map((match) => match.id)).not.toContain("browser_open")
    }),
  )

  it.live("search caps results at limit and the hard reveal cap", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      expect(toolSearch.search({ query: "browser", limit: 2, candidates }).length).toBe(2)
      const many = Array.from({ length: 30 }, (_, index) => ({
        id: `fake_tool_${index}`,
        description: "shared keyword",
      }))
      expect(toolSearch.search({ query: "keyword", limit: 100, candidates: many }).length).toBe(
        ToolSearch.MAX_REVEAL_LIMIT,
      )
    }),
  )

  it.live("search drops non-matching queries and empty term queries", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      expect(toolSearch.search({ query: "zzz-not-a-tool", limit: 8, candidates })).toEqual([])
      expect(toolSearch.search({ query: "   ", limit: 8, candidates })).toEqual([])
    }),
  )

  it.live("isDeferred only admits the static catalog", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      expect(toolSearch.isDeferred("lsp")).toBe(true)
      expect(toolSearch.isDeferred("browser_open")).toBe(true)
      expect(toolSearch.isDeferred("read")).toBe(false)
      expect(toolSearch.isDeferred("tool_search")).toBe(false)
      expect(ToolSearch.DEFERRED_TOOL_IDS.size).toBe(11)
    }),
  )

  it.live("reveal is idempotent, ignores unknown ids, and records per session", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      const sessionID = SessionID.make("ses_tool_search_unit_a")
      const other = SessionID.make("ses_tool_search_unit_b")
      expect((yield* toolSearch.revealed(sessionID)).size).toBe(0)
      yield* toolSearch.reveal(sessionID, ["lsp", "lsp", "read", "bogus"])
      expect(new Set(yield* toolSearch.revealed(sessionID))).toEqual(new Set(["lsp"]))
      yield* toolSearch.reveal(sessionID, ["lsp", "browser_open"])
      expect(new Set(yield* toolSearch.revealed(sessionID))).toEqual(new Set(["lsp", "browser_open"]))
      expect((yield* toolSearch.revealed(other)).size).toBe(0)
    }),
  )

  it.live("reveals reload from the database after the in-memory cache resets", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      const sessionID = SessionID.make("ses_tool_search_unit_a")
      yield* toolSearch.reveal(sessionID, ["lsp", "browser_click"])
      ToolSearch.resetRevealCache()
      expect(new Set(yield* toolSearch.revealed(sessionID))).toEqual(new Set(["lsp", "browser_click"]))
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(ToolRevealTable).where(eq(ToolRevealTable.session_id, sessionID)).limit(1).get(),
        ),
      )
      expect(new Set(row?.data.revealed)).toEqual(new Set(["lsp", "browser_click"]))
    }),
  )

  it.live("stale ids from older catalog versions are dropped on load", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      const sessionID = SessionID.make("ses_tool_search_unit_a")
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(ToolRevealTable)
            .values({ session_id: sessionID, data: { revealed: ["lsp", "retired_tool"] } })
            .run(),
        ),
      )
      ToolSearch.resetRevealCache()
      expect(new Set(yield* toolSearch.revealed(sessionID))).toEqual(new Set(["lsp"]))
    }),
  )
})

test("the deferred catalog ids map to real tool modules and txt descriptions", () => {
  for (const entry of ToolSearch.DEFERRED_TOOLS) {
    expect(existsSync(path.join(import.meta.dir, "../../src/tool", `${entry.id}.ts`))).toBe(true)
    expect(existsSync(path.join(import.meta.dir, "../../src/tool", `${entry.id}.txt`))).toBe(true)
  }
})

test("the unknown-tool hint mentions tool_search", () => {
  expect(ToolSearch.DEFERRED_TOOL_HINT).toContain("tool_search")
  expect(ToolSearch.DEFERRED_TOOL_HINT.startsWith(" ")).toBe(true)
})

describe("session.tool-search prompt loop", () => {
  loopIt.live("default request omits the deferred ids but includes tool_search", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Defer default",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one")
        yield* prompt.loop({ sessionID: session.id })

        const inputs = yield* llm.inputs
        const names = wireToolNames(inputs[0])
        for (const id of ToolSearch.DEFERRED_TOOL_IDS) expect(names).not.toContain(id)
        expect(names).toContain("tool_search")
        // the always-visible core tools keep their presence
        expect(names).toContain("read")
        expect(names).toContain("edit")
        expect(names).toContain("bash")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("revealing via tool_search adds the tool to the next call and keeps positions", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Reveal lsp",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.tool("tool_search", { query: "language server" })
        yield* llm.text("revealed")
        yield* prompt.loop({ sessionID: session.id })

        const inputs = yield* llm.inputs
        expect(inputs.length).toBe(2)
        const before = wireToolNames(inputs[0])
        const after = wireToolNames(inputs[1])
        expect(before).not.toContain("lsp")
        expect(after).toContain("lsp")
        // positions of previously-visible tools stay byte-stable: revealed
        // tools are appended at the end of the record
        for (const name of ["read", "edit", "bash"]) expect(after.indexOf(name)).toBe(before.indexOf(name))
        expect(after.slice(0, before.length)).toEqual(before)
        expect(after[after.length - 1]).toBe("lsp")

        const output = (yield* sessions.messages({ sessionID: session.id }))
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "tool_search")
        if (output?.type !== "tool" || output.state.status !== "completed") throw new Error("missing tool_search part")
        expect(output.state.output).toContain("Revealed tools:")
        expect(output.state.output).toContain("`lsp`")
        expect(output.state.output).toContain(
          "These tools are now in your tool list and callable from your next model call.",
        )
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("already-revealed matches are noted instead of re-listed, and no-match gives guidance", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Reveal twice",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.tool("tool_search", { query: "browser" })
        yield* llm.tool("tool_search", { query: "browser" })
        yield* llm.tool("tool_search", { query: "zzz-not-a-tool" })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const outputs = (yield* sessions.messages({ sessionID: session.id }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.tool === "tool_search")
          .map((part) => (part.type === "tool" && part.state.status === "completed" ? part.state.output : ""))
        expect(outputs.length).toBe(3)
        expect(outputs[0]).toContain("Revealed tools:")
        expect(outputs[0]).toContain("browser_open")
        expect(outputs[1]).toContain("Already revealed in this session")
        expect(outputs[1]).not.toContain("Revealed tools:")
        expect(outputs[2]).toContain('No deferred tools matched "zzz-not-a-tool"')
        expect(outputs[2]).toContain("Deferred categories: browser_*")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("permission-denied deferred tools are never revealed", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Deny browser",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "browser_open", pattern: "*", action: "deny" },
          ],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.tool("tool_search", { query: "browser" })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const inputs = yield* llm.inputs
        const names = wireToolNames(inputs[1])
        expect(names).toContain("browser_snapshot")
        expect(names).not.toContain("browser_open")
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})

// The pre-reveal "Unknown tool" degradation: the main AI SDK path repairs
// unknown calls to the invalid tool, while the GitLab-workflow executor and
// the Codex Responses executor emit the enriched "Unknown tool ... deferred"
// message. The harness cannot force the workflow-model branch, so the Codex
// Responses path is driven directly here (same pattern as
// test/session/codex-responses.test.ts).
describe("session.tool-search unknown tool", () => {
  function codexModel() {
    return {
      id: "gpt-5.5",
      name: "GPT 5.5",
      providerID: "openai",
      api: { id: "gpt-5.5", npm: "@ai-sdk/openai", url: "" },
      status: "active",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 400_000, input: 272_000, output: 128_000 },
      options: {},
      headers: {},
      family: "gpt-5",
      release_date: "2026-01-01",
      variants: {},
    } as unknown as CodexResponsesInput["model"]
  }

  function responseStream(chunks: unknown[]) {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\ndata: [DONE]\n\n"),
        )
        controller.close()
      },
    })
  }

  test("calling a deferred tool before reveal yields the enriched tool_search error", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          responseStream([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { id: "fc-lsp", type: "function_call", call_id: "call-lsp", name: "lsp" },
            },
            { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { id: "fc-lsp", type: "function_call", call_id: "call-lsp", name: "lsp", arguments: "{}" },
            },
            { type: "response.completed", response: { id: "resp-lsp", usage: { input_tokens: 1, output_tokens: 1 } } },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })

    const events: any[] = []
    for await (const event of CodexResponses.stream({
      sessionID: "session-tool-search-defer",
      model: codexModel(),
      system: ["You are concise."],
      messages: [{ role: "user", content: "Hello" }],
      tools: {},
      params: {
        temperature: 0.2,
        topP: 0.8,
        topK: undefined,
        maxOutputTokens: undefined,
        options: { reasoningEffort: "high", reasoningSummary: "auto" },
      },
      headers: {},
      auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000, accountId: "acc-123" },
      abort: new AbortController().signal,
      endpoint: `${server.url.origin}/backend-api/codex/responses`,
    }))
      events.push(event)

    const failure = events.find((event) => event.type === "tool-error")
    expect(failure?.error.message).toBe(
      "Unknown tool: lsp It is registered but deferred — call `tool_search` with a keyword to reveal it.",
    )
  })
})
