import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { ProviderTransform } from "@/provider/transform"

// Fixtures use only the neutral `test/` prefix: no internal relay identity,
// endpoint, or route prefix may appear in this file or the configuration docs
// it pins (audit red line).
function openaiModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "test/test-model",
    providerID: "test",
    api: { id: "test-model", url: "http://localhost.invalid/v1", npm: "@ai-sdk/openai" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    ...overrides,
  } as any
}

// Captures the wire body while serving a minimal valid Responses API payload so
// the SDK's request-building (not a network round-trip) is what gets asserted.
function captureFetch(responseBody: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetch = async (url: string, init: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body ?? "{}") })
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetch, calls }
}

const responsesModel = (fetch: typeof globalThis.fetch) =>
  createOpenAI({ apiKey: "test-key", baseURL: "http://localhost.invalid/v1", fetch }).responses("gpt-4o")

const minimalResponse = {
  id: "resp-test",
  created_at: 1,
  model: "test-model",
  output: [],
  usage: { input_tokens: 1, output_tokens: 1 },
}

describe("ProviderTransform.providerOptions - forceReasoning passthrough", () => {
  test("routes options.forceReasoning under the openai providerOptions key", () => {
    expect(ProviderTransform.providerOptions(openaiModel(), { forceReasoning: true, reasoningEffort: "high" })).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "high" },
    })
  })

  test("keeps forceReasoning alongside other OpenAI-specific options", () => {
    expect(
      ProviderTransform.providerOptions(openaiModel(), {
        forceReasoning: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
    ).toEqual({
      openai: { forceReasoning: true, store: false, include: ["reasoning.encrypted_content"] },
    })
  })

  test("does not inject forceReasoning when it is unset", () => {
    const result = ProviderTransform.providerOptions(openaiModel(), { reasoningEffort: "low" })
    expect(result).toEqual({ openai: { reasoningEffort: "low" } })
    expect(result.openai.forceReasoning).toBeUndefined()
  })
})

describe("@ai-sdk/openai forceReasoning - sampling parameter stripping", () => {
  test("keeps temperature and top_p for a non-reasoning model by default", async () => {
    const captured = captureFetch(minimalResponse)
    const result = await responsesModel(captured.fetch as typeof globalThis.fetch).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      temperature: 0.2,
      topP: 0.8,
      providerOptions: {},
    })

    const body = result.request?.body as Record<string, unknown>
    expect(body.temperature).toBe(0.2)
    expect(body.top_p).toBe(0.8)
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ feature: "temperature" }))
  })

  test("strips temperature and top_p once forceReasoning marks the model as reasoning", async () => {
    const captured = captureFetch(minimalResponse)
    const result = await responsesModel(captured.fetch as typeof globalThis.fetch).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      temperature: 0.2,
      topP: 0.8,
      providerOptions: { openai: { forceReasoning: true } },
    })

    const body = result.request?.body as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(result.warnings).toContainEqual({
      type: "unsupported",
      feature: "temperature",
      details: "temperature is not supported for reasoning models",
    })
    expect(result.warnings).toContainEqual({
      type: "unsupported",
      feature: "topP",
      details: "topP is not supported for reasoning models",
    })
  })
})