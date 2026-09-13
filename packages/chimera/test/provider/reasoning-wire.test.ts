import { describe, expect, test } from "bun:test"
import { ReasoningWire } from "@/provider/reasoning-wire"

describe("provider.reasoningWire.fromOptions", () => {
  test("forwards the resolved effort and summary for explicit requests", () => {
    expect(
      ReasoningWire.fromOptions({ openai: { reasoningEffort: "max", reasoningSummary: "auto" } }, true),
    ).toEqual({ effort: "max", summary: "auto" })
  })

  test("keeps a lone effort or summary", () => {
    expect(ReasoningWire.fromOptions({ openai: { reasoningEffort: "none" } }, true)).toEqual({ effort: "none" })
    expect(ReasoningWire.fromOptions({ openai: { reasoningSummary: "auto" } }, true)).toEqual({ summary: "auto" })
  })

  test("ignores implicit requests and unusable values", () => {
    const explicit = { openai: { reasoningEffort: "max", reasoningSummary: "auto" } }
    expect(ReasoningWire.fromOptions(explicit, false)).toBeUndefined()
    expect(ReasoningWire.fromOptions({ openai: { reasoningEffort: "", reasoningSummary: "" } }, true)).toBeUndefined()
    expect(ReasoningWire.fromOptions({ openai: { reasoningEffort: 3 } }, true)).toBeUndefined()
    expect(ReasoningWire.fromOptions({ anthropic: { reasoningEffort: "max" } }, true)).toBeUndefined()
    expect(ReasoningWire.fromOptions({ openai: "max" }, true)).toBeUndefined()
    expect(ReasoningWire.fromOptions({}, true)).toBeUndefined()
  })
})

describe("provider.reasoningWire.encode", () => {
  test("round-trips the payload", () => {
    expect(ReasoningWire.decode(ReasoningWire.encode({ effort: "xhigh", summary: "auto" }))).toEqual({
      effort: "xhigh",
      summary: "auto",
    })
    expect(ReasoningWire.decode(ReasoningWire.encode({ effort: "none" }))).toEqual({ effort: "none" })
  })

  test("rejects malformed or empty payloads", () => {
    expect(ReasoningWire.decode("not json")).toBeUndefined()
    expect(ReasoningWire.decode("{}")).toBeUndefined()
    expect(ReasoningWire.decode('{"effort":3}')).toBeUndefined()
    expect(ReasoningWire.decode('{"effort":""}')).toBeUndefined()
    expect(ReasoningWire.decode('"text"')).toBeUndefined()
    expect(ReasoningWire.decode("")).toBeUndefined()
    expect(ReasoningWire.decode(null)).toBeUndefined()
    expect(ReasoningWire.decode(undefined)).toBeUndefined()
  })
})

describe("provider.reasoningWire.inject", () => {
  test("mirrors the payload when the body has no reasoning object", () => {
    const body: Record<string, unknown> = { model: "deepseek", input: [] }
    expect(ReasoningWire.inject(body, { effort: "max", summary: "auto" })).toBe(true)
    expect(body["reasoning"]).toEqual({ effort: "max", summary: "auto" })
  })

  test("keeps an existing reasoning object and ignores empty payloads", () => {
    const body = { reasoning: { effort: "low" } }
    expect(ReasoningWire.inject(body, { effort: "max" })).toBe(false)
    expect(body.reasoning).toEqual({ effort: "low" })
    expect(ReasoningWire.inject({}, undefined)).toBe(false)
    expect(ReasoningWire.inject("nope", { effort: "max" })).toBe(false)
  })
})

describe("provider.reasoningWire.take", () => {
  test("decodes and removes the internal header while keeping the rest", () => {
    const taken = ReasoningWire.take({
      "content-type": "application/json",
      [ReasoningWire.HEADER]: '{"effort":"max","summary":"auto"}',
    })
    expect(taken?.value).toEqual({ effort: "max", summary: "auto" })
    expect(taken?.headers.get(ReasoningWire.HEADER)).toBeNull()
    expect(taken?.headers.get("content-type")).toBe("application/json")
  })

  test("accepts Headers instances and reports absent or malformed markers", () => {
    const headers = new Headers({ [ReasoningWire.HEADER]: "broken" })
    const taken = ReasoningWire.take(headers)
    expect(taken?.value).toBeUndefined()
    expect(taken?.headers.get(ReasoningWire.HEADER)).toBeNull()
    expect(ReasoningWire.take({ "content-type": "application/json" })).toBeUndefined()
    expect(ReasoningWire.take(undefined)).toBeUndefined()
  })
})
