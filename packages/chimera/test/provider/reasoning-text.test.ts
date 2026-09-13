import { describe, expect, test } from "bun:test"
import { ReasoningText } from "@/provider/reasoning-text"

const target = (overrides: Partial<Parameters<typeof ReasoningText.needed>[0]> = {}) => ({
  api: { id: "deepseek-v4.1-flash-expires-on-0910", npm: "@ai-sdk/openai" },
  wire_api: "responses",
  capabilities: { reasoning: true },
  ...overrides,
})

describe("provider.reasoningText.needed", () => {
  test("requires the openai responses wire, reasoning capability and a deepseek model", () => {
    expect(ReasoningText.needed(target())).toBe(true)
    expect(ReasoningText.needed(target({ wire_api: "chat" }))).toBe(false)
    expect(
      ReasoningText.needed(target({ api: { id: "deepseek-v4.1-flash-expires-on-0910", npm: "@ai-sdk/openai-compatible" } })),
    ).toBe(false)
    expect(ReasoningText.needed(target({ api: { id: "gpt-5.2", npm: "@ai-sdk/openai" } }))).toBe(false)
    expect(ReasoningText.needed(target({ capabilities: { reasoning: false } }))).toBe(false)
  })
})

describe("provider.reasoningText.deltaFromRaw", () => {
  test("maps response.reasoning_text.delta onto the reasoning part id", () => {
    expect(
      ReasoningText.deltaFromRaw({
        type: "response.reasoning_text.delta",
        item_id: "rs_1",
        content_index: 0,
        delta: "Step 1",
      }),
    ).toEqual({ id: "rs_1:0", text: "Step 1" })
  })

  test("defaults the content index and rejects unrelated or malformed events", () => {
    expect(ReasoningText.deltaFromRaw({ type: "response.reasoning_text.delta", item_id: "rs_2", delta: "x" })).toEqual({
      id: "rs_2:0",
      text: "x",
    })
    expect(
      ReasoningText.deltaFromRaw({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "x" }),
    ).toBeUndefined()
    expect(ReasoningText.deltaFromRaw({ type: "response.reasoning_text.delta", item_id: "rs_1", delta: "" })).toBeUndefined()
    expect(ReasoningText.deltaFromRaw({ type: "response.reasoning_text.delta", delta: "x" })).toBeUndefined()
    expect(ReasoningText.deltaFromRaw("nope")).toBeUndefined()
    expect(ReasoningText.deltaFromRaw(undefined)).toBeUndefined()
  })
})

describe("provider.reasoningText.mirrorIntoContent", () => {
  test("mirrors summary text into DeepSeek reasoning content", () => {
    const body: { input: Array<Record<string, unknown>> } = {
      input: [
        {
          type: "reasoning",
          encrypted_content: "enc-1",
          summary: [
            { type: "summary_text", text: "hello " },
            { type: "summary_text", text: "world" },
          ],
        },
      ],
    }
    expect(ReasoningText.mirrorIntoContent(body)).toBe(1)
    expect(body.input[0].content).toEqual([{ type: "reasoning_text", text: "hello world" }])
  })

  test("patches empty content arrays and leaves existing content untouched", () => {
    const body: { input: Array<Record<string, unknown>> } = {
      input: [
        { type: "reasoning", content: [], summary: [{ type: "summary_text", text: "a" }] },
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "keep" }],
          summary: [{ type: "summary_text", text: "b" }],
        },
      ],
    }
    expect(ReasoningText.mirrorIntoContent(body)).toBe(1)
    expect(body.input[0].content).toEqual([{ type: "reasoning_text", text: "a" }])
    expect(body.input[1].content).toEqual([{ type: "reasoning_text", text: "keep" }])
  })

  test("ignores non-reasoning items, empty summaries and malformed bodies", () => {
    expect(
      ReasoningText.mirrorIntoContent({ input: [{ type: "message", summary: [{ text: "x" }] }, { type: "reasoning", summary: [] }] }),
    ).toBe(0)
    expect(ReasoningText.mirrorIntoContent({ input: "nope" })).toBe(0)
    expect(ReasoningText.mirrorIntoContent(null)).toBe(0)
  })
})