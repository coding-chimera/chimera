import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PROVIDER_PROFILES } from "./format"
import { runSuite, validateFixture } from "./validate"

const FIXTURES = join(import.meta.dir, "fixtures")

type MutableFixture = {
  profile?: string
  description?: string
  capabilities?: Record<string, unknown>
  turns: Array<{
    request: {
      endpoint?: string
      headers?: Record<string, string>
      body?: {
        messages?: Array<Record<string, unknown>>
        input?: Array<Record<string, unknown>>
      }
    }
    expected: {
      events: Array<Record<string, unknown>>
    }
  }>
}

async function load(file: string): Promise<MutableFixture> {
  return JSON.parse(await readFile(join(FIXTURES, file), "utf8")) as MutableFixture
}

function codes(result: ReturnType<typeof validateFixture>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code)
}

describe("provider fixture coverage", () => {
  test("all six profiles have at least one valid fixture", async () => {
    const suite = await runSuite()
    expect(suite.ok).toBe(true)
    for (const profile of PROVIDER_PROFILES) {
      expect(suite.coverage[profile]).toBeGreaterThanOrEqual(1)
    }
    expect(suite.fixtures.length).toBeGreaterThanOrEqual(6)
  })

  test("fixture digests are stable across two runs", async () => {
    const first = await runSuite()
    const second = await runSuite()
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.fixtures.map((fixture) => fixture.digest)).toEqual(second.fixtures.map((fixture) => fixture.digest))
  })

  test("no fixture contains a real URL, home path, or credential", async () => {
    const suite = await runSuite()
    expect(suite.ok).toBe(true)
    expect(suite.issues).toEqual([])
  })
})

describe("validator rejects deliberately broken fixtures", () => {
  test("real endpoint is rejected", async () => {
    const fixture = await load("chat-api-key.text-and-tool-call.json")
    fixture.turns[0].request.endpoint = "not-synthetic://provider/chat/completions"
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_ENDPOINT")
  })

  test("leaked API key is rejected", async () => {
    const fixture = await load("chat-api-key.text-and-tool-call.json")
    fixture.turns[0].request.headers = {
      ...fixture.turns[0].request.headers,
      authorization: "Bearer " + "unredacted-placeholder",
    }
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_SECRET")
  })

  test("home absolute path is rejected", async () => {
    const fixture = await load("chat-api-key.text-and-tool-call.json")
    fixture.description = ["", "Users", "fixture", "secret"].join("/")
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_SECRET")
  })

  test("unknown profile is rejected", async () => {
    const fixture = await load("chat-api-key.text-and-tool-call.json")
    fixture.profile = "unknown-profile"
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_PROFILE")
  })

  test("capability verdict drift is rejected", async () => {
    const fixture = await load("chat-api-key.text-and-tool-call.json")
    fixture.capabilities = { ...fixture.capabilities, genai_verdict: "uncovered" }
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_CAPABILITY")
  })

  test("tool result before tool call is rejected", async () => {
    const fixture = await load("native-tool-search.client-execution.json")
    const events = fixture.turns[0].expected.events
    const callIndex = events.findIndex((event) => event.type === "tool-call")
    const resultIndex = events.findIndex((event) => event.type === "tool-result")
    expect(callIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(callIndex)
    const [result] = events.splice(resultIndex, 1)
    events.splice(callIndex, 0, result)
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_EVENT_ORDER")
  })

  test("host tool call without a following result is rejected", async () => {
    const fixture = await load("chat-api-key.text-and-tool-call.json")
    const body = fixture.turns[1].request.body
    expect(body?.messages).toBeDefined()
    body!.messages = body!.messages!.filter((message) => message.role !== "tool")
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_TOOL_CLOSURE")
  })

  test("missing assistant call replay is rejected", async () => {
    const fixture = await load("native-tool-search.client-execution.json")
    const input = fixture.turns[1].request.body?.input
    expect(input).toBeDefined()
    const callIndex = input!.findIndex((item) => item.type === "tool_search_call")
    expect(callIndex).toBeGreaterThanOrEqual(0)
    input!.splice(callIndex, 1)
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_TOOL_CLOSURE")
  })

  test("duplicate tool output id in one request is rejected", async () => {
    const fixture = await load("responses-api-key.text-and-tool-call.json")
    const input = fixture.turns[1].request.body?.input
    expect(input).toBeDefined()
    const output = input!.find((item) => item.type === "function_call_output")
    expect(output).toBeDefined()
    input!.push({ ...output! })
    expect(codes(validateFixture(fixture))).toContain("PROVIDER_TOOL_CLOSURE")
  })
})