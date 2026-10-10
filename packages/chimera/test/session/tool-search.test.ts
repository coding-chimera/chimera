import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { tool, jsonSchema } from "ai"
import { Database } from "@/storage/db"
import { CodexResponses, type CodexResponsesInput } from "@/session/codex-responses"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Permission } from "@/permission"
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

// Requests captured by the test LLM server that actually carried a non-empty
// tool array (title/summary small calls do not; they would otherwise shift a
// naive index).
const wireLists = (inputs: Record<string, unknown>[]) =>
  inputs
    .filter((body) => Array.isArray(body.tools) && (body.tools as unknown[]).length > 0)
    .map((body) => wireToolNames(body))

const runtimeContextTexts = (messages: MessageV2.WithParts[]) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && Boolean(part.metadata?.runtimeContext))
    .map((part) => part.text)

const toolPart = (messages: MessageV2.WithParts[], name: string) =>
  messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === name)

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

  it.live("phase-2 catalog: obligation/oracle recall tools match their keywords", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      expect(toolSearch.search({ query: "obligation", limit: 8, candidates }).map((match) => match.id)).toContain(
        "chimera_obligations_sync",
      )
      // equal scores tie-break on id ascending
      expect(toolSearch.search({ query: "oracle", limit: 8, candidates }).map((match) => match.id)).toEqual([
        "chimera_oracle_get",
        "chimera_oracle_recent",
      ])
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
      expect(toolSearch.isDeferred("chimera_oracle_get")).toBe(true)
      expect(toolSearch.isDeferred("chimera_obligation_claim")).toBe(true)
      expect(toolSearch.isDeferred("read")).toBe(false)
      expect(toolSearch.isDeferred("tool_search")).toBe(false)
      // flow-entry tools stay always-exposed (85-call entry, closeout evidence)
      expect(toolSearch.isDeferred("chimera_obligations_list")).toBe(false)
      expect(toolSearch.isDeferred("chimera_audit_recent")).toBe(false)
      expect(ToolSearch.DEFERRED_TOOL_IDS.size).toBe(17)
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

  it.live("reveal records per-tool timestamps in the payload; reload keeps them", () =>
    Effect.gen(function* () {
      const toolSearch = yield* ToolSearch.Service
      const sessionID = SessionID.make("ses_tool_search_unit_a")
      const before = Date.now()
      yield* toolSearch.reveal(sessionID, ["lsp", "browser_click"])
      const times = yield* toolSearch.revealTimes(sessionID)
      expect(typeof times.get("lsp")).toBe("number")
      expect((times.get("lsp") ?? 0) >= before).toBe(true)
      ToolSearch.resetRevealCache()
      const reloaded = yield* toolSearch.revealTimes(sessionID)
      expect(reloaded.get("lsp")).toBe(times.get("lsp"))
      expect(reloaded.get("browser_click")).toBe(times.get("browser_click"))
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(ToolRevealTable).where(eq(ToolRevealTable.session_id, sessionID)).limit(1).get(),
        ),
      )
      expect(Object.keys(row?.data.revealedAt ?? {}).toSorted()).toEqual(["browser_click", "lsp"])
    }),
  )

  it.live("legacy rows without timestamps fall back to the row's upper-bound time", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_tool_search_unit_a")
      yield* Effect.sync(() =>
        Database.Client().$client.exec(`
          INSERT INTO tool_reveal (session_id, data, time_created, time_updated)
          VALUES ('${sessionID}', '{"revealed":["lsp"]}', 1000, 2000);
        `),
      )
      ToolSearch.resetRevealCache()
      const toolSearch = yield* ToolSearch.Service
      const times = yield* toolSearch.revealTimes(sessionID)
      // time_updated (2000) is an upper bound on the true reveal time: the
      // promotion check `time <= compactionTime` can therefore never fire early.
      expect(times.get("lsp")).toBe(2000)
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

  test("compactSignature renders a compact formal-parameter list", () => {
    expect(
      ToolSearch.compactSignature({
        type: "object",
        properties: { url: { type: "string" }, timeout: { type: "number" } },
        required: ["url"],
      }),
    ).toBe("(url: string, timeout?: number)")
    expect(ToolSearch.compactSignature({ type: "object", properties: {} })).toBe("")
    expect(ToolSearch.compactSignature(undefined)).toBe("")
    // anyOf folds to the first non-null branch; enums collapse to "enum"
    expect(
      ToolSearch.compactSignature({
        type: "object",
        properties: { a: { anyOf: [{ type: "null" }, { type: "integer" }] }, b: { enum: ["x", "y"] } },
        required: ["a", "b"],
      }),
    ).toBe("(a: integer, b: enum)")
  })
})

test("the deferred catalog ids map to real tool implementations and txt descriptions", () => {
  for (const entry of ToolSearch.DEFERRED_TOOLS) {
    expect(existsSync(path.join(import.meta.dir, "../../src/tool", `${entry.id}.txt`))).toBe(true)
    // the chimera_* follow-up/recall tools share the chimera.ts implementation module
    const module = entry.id.startsWith("chimera_") ? "chimera" : entry.id
    expect(existsSync(path.join(import.meta.dir, "../../src/tool", `${module}.ts`))).toBe(true)
  }
})

test("the unknown-tool hint mentions tool_search", () => {
  expect(ToolSearch.DEFERRED_TOOL_HINT).toContain("tool_search")
  expect(ToolSearch.DEFERRED_TOOL_HINT).toContain("call it directly by name")
  expect(ToolSearch.DEFERRED_TOOL_HINT.startsWith(" ")).toBe(true)
})

describe("session.tool-search prompt loop (phase 2)", () => {
  const startSession = Effect.fnUntraced(function* (title: string, permission?: Permission.Ruleset) {
    const sessions = yield* Session.Service
    return yield* sessions.create({
      title,
      permission: permission ?? [{ permission: "*", pattern: "*", action: "allow" }],
    })
  })

  const promptStart = Effect.fnUntraced(function* (sessionID: SessionID, text: string) {
    const prompt = yield* SessionPrompt.Service
    yield* prompt.prompt({
      sessionID,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text }],
    })
  })

  loopIt.live("default request omits the deferred ids but includes tool_search", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const session = yield* startSession("Defer default")
        yield* promptStart(session.id, "start")
        yield* llm.text("one")
        yield* prompt.loop({ sessionID: session.id })

        const lists = wireLists(yield* llm.inputs)
        for (const names of lists) for (const id of ToolSearch.DEFERRED_TOOL_IDS) expect(names).not.toContain(id)
        const names = lists[0]
        expect(names).toContain("tool_search")
        // the always-visible core tools keep their presence
        expect(names).toContain("read")
        expect(names).toContain("edit")
        expect(names).toContain("bash")
        // phase 2 keeps the flow-entry and closeout tools always exposed
        expect(names).toContain("chimera_obligations_list")
        expect(names).toContain("chimera_audit_recent")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("revealing never touches the tools array; the tail section carries id + signature + summary", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession("Reveal lsp tail")
        yield* promptStart(session.id, "start")
        yield* llm.tool("tool_search", { query: "language server" })
        yield* llm.text("revealed")
        yield* prompt.loop({ sessionID: session.id })

        // the revealed tool never appears in any captured request's tool array
        for (const names of wireLists(yield* llm.inputs)) expect(names).not.toContain("lsp")

        const outputs = (yield* sessions.messages({ sessionID: session.id })).flatMap((m) => m.parts)
        const search = outputs.find((part) => part.type === "tool" && part.tool === "tool_search")
        if (search?.type !== "tool" || search.state.status !== "completed") throw new Error("missing tool_search part")
        expect(search.state.output).toContain("callable by name immediately")
        // the full .txt description ships inside the tool_search result
        expect(search.state.output).toContain("Interact with Language Server Protocol")

        const contexts = runtimeContextTexts(yield* sessions.messages({ sessionID: session.id }))
        const section = contexts.find((text) => text.includes("## Revealed Deferred Tools"))
        expect(section).toBeDefined()
        // compact signature is present: lsp requires operation, filePath, line, character
        expect(section).toContain("- `lsp(operation: string, filePath: string, line: integer, character: integer")
        expect(section).toContain("Language-server code intelligence")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("repair path executes a revealed tool called by name through the normal path", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession("Repair execute")
        yield* promptStart(session.id, "start")
        yield* llm.tool("tool_search", { query: "model schedule" })
        yield* llm.text("revealed")
        yield* prompt.loop({ sessionID: session.id })

        yield* promptStart(session.id, "now call the revealed scheduler tool")
        yield* llm.tool("subagent_model_schedule", { limit: 3 })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const messages = yield* sessions.messages({ sessionID: session.id })
        const part = toolPart(messages, "subagent_model_schedule")
        if (part?.type !== "tool") throw new Error("revealed tool part was never executed")
        if (part.state.status !== "completed") throw new Error(`revealed tool errored: ${JSON.stringify(part.state)}`)
        expect(part.state.output).toContain("scout")
        // and it still never entered the tool array
        for (const names of wireLists(yield* llm.inputs)) expect(names).not.toContain("subagent_model_schedule")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("repair refuses a revealed-but-permission-denied tool with guidance, not execution", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const toolSearch = yield* ToolSearch.Service
        const session = yield* startSession("Revealed denied", [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "subagent_model_routes", pattern: "*", action: "deny" },
        ])
        // service-level reveal bypasses the tool_search permission filter — the
        // state a resumed older session can carry; the llm gate must still deny.
        yield* toolSearch.reveal(session.id, ["subagent_model_routes"])

        yield* promptStart(session.id, "start")
        yield* llm.tool("subagent_model_routes", { model_identity: "deepseek-v4.1-flash" })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const messages = yield* sessions.messages({ sessionID: session.id })
        const invalid = toolPart(messages, "invalid")
        if (invalid?.type !== "tool" || invalid.state.status !== "completed")
          throw new Error("invalid tool part missing")
        expect(invalid.state.output).toContain("not permitted")
        expect(toolPart(messages, "subagent_model_routes")).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("calling a deferred tool without reveal lands on invalid with the tool_search guidance", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession("Unrevealed deferred")
        yield* promptStart(session.id, "start")
        yield* llm.tool("chimera_oracle_get", { ref: "oracle:zz" })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const messages = yield* sessions.messages({ sessionID: session.id })
        const invalid = toolPart(messages, "invalid")
        if (invalid?.type !== "tool" || invalid.state.status !== "completed")
          throw new Error("invalid tool part missing")
        expect(invalid.state.output).toContain("reveal it with `tool_search`")
        expect(toolPart(messages, "chimera_oracle_get")).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("a compaction summary promotes earlier reveals into the array and drops the tail section", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession("Promote on compaction")
        yield* promptStart(session.id, "start")
        yield* llm.tool("tool_search", { query: "language server" })
        yield* llm.text("revealed")
        yield* prompt.loop({ sessionID: session.id })

        // Seed a completed compaction-summary assistant message: exactly the
        // fact resolveTools/runtime-context derive the promotion boundary from.
        const firstUser = (yield* sessions.messages({ sessionID: session.id })).find((m) => m.info.role === "user")!
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: firstUser.info.id,
          sessionID: session.id,
          mode: "compaction",
          agent: "compaction",
          summary: true,
          finish: "stop",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
        })

        yield* promptStart(session.id, "after compaction")
        yield* llm.text("ok")
        yield* prompt.loop({ sessionID: session.id })

        // promoted: lsp now rides the request tool array
        const lists = wireLists(yield* llm.inputs)
        expect(lists[lists.length - 1]).toContain("lsp")
        // and the tail section is gone: the compaction boundary resets the
        // runtime-context snapshot, and the fresh snapshot omits the section
        // because every reveal was promoted.
        const messages = yield* sessions.messages({ sessionID: session.id })
        const contexts = runtimeContextTexts(messages)
        expect(contexts.some((text) => text.includes("## Revealed Deferred Tools"))).toBe(true)
        expect(contexts[contexts.length - 1]).not.toContain("## Revealed Deferred Tools")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("already-revealed matches are noted, no-match lists the new categories", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession("Reveal twice")
        yield* promptStart(session.id, "start")
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
        expect(outputs[0]).toContain("callable by name immediately")
        expect(outputs[0]).toContain("browser_open")
        expect(outputs[1]).toContain("Already revealed in this session (still callable by name)")
        expect(outputs[1]).not.toContain("Revealed tools (")
        expect(outputs[2]).toContain('No deferred tools matched "zzz-not-a-tool"')
        expect(outputs[2]).toContain("Deferred categories: browser_*")
        expect(outputs[2]).toContain("chimera_oracle_*")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("permission-denied deferred tools are never revealed and stay off the tail section", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession("Deny browser", [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "browser_open", pattern: "*", action: "deny" },
        ])
        yield* promptStart(session.id, "start")
        yield* llm.tool("tool_search", { query: "browser" })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        // nothing browser-related enters the wire array anymore (phase 2)
        for (const names of wireLists(yield* llm.inputs)) expect(names).not.toContain("browser_snapshot")
        const contexts = runtimeContextTexts(yield* sessions.messages({ sessionID: session.id }))
        const section = contexts.find((text) => text.includes("## Revealed Deferred Tools"))
        expect(section).toBeDefined()
        expect(section).toContain("browser_snapshot")
        expect(section).not.toContain("browser_open")
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})

// The pre-reveal "Unknown tool" degradation on the non-AI-SDK executors: the
// GitLab-workflow executor and the Codex Responses executor emit the enriched
// "Unknown tool ... deferred" message, while a revealed tool called by name
// executes through the revealedCallable view. The harness cannot force the
// workflow-model branch, so the Codex Responses path is driven directly here
// (same pattern as test/session/codex-responses.test.ts).
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

  function toolCallChunks(name: string) {
    return [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: `fc-${name}`, type: "function_call", call_id: `call-${name}`, name },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: `fc-${name}`, type: "function_call", call_id: `call-${name}`, name, arguments: "{}" },
      },
      { type: "response.completed", response: { id: `resp-${name}`, usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
  }

  async function drive(input: Partial<CodexResponsesInput>) {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(responseStream(toolCallChunks("lsp")), { headers: { "Content-Type": "text/event-stream" } })
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
      ...input,
    } as CodexResponsesInput))
      events.push(event)
    return events
  }

  test("calling a deferred tool before reveal yields the enriched tool_search error", async () => {
    const events = await drive({})
    const failure = events.find((event) => event.type === "tool-error")
    expect(failure?.error.message).toBe(
      "Unknown tool: lsp It is registered but deferred — reveal it with `tool_search`, then call it directly by name.",
    )
  })

  test("a revealed tool called by name executes through the revealedCallable view", async () => {
    const events = await drive({
      revealedCallable: {
        lsp: tool({
          inputSchema: jsonSchema<{ operation?: string }>({
            type: "object",
            properties: { operation: { type: "string" } },
          }),
          execute: async () => ({ output: "revealed-ok", title: "lsp", metadata: {} }),
        }),
      },
    })
    const result = events.find((event) => event.type === "tool-result")
    expect(result?.output).toEqual({ output: "revealed-ok", title: "lsp", metadata: {} })
    expect(events.find((event) => event.type === "tool-error")).toBeUndefined()
  })
})
