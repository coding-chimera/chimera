import { describe, expect, test } from "bun:test"

import {
  discoverOpenAICompatibleModels,
  normalizeOpenAICompatibleBaseURL,
  openAICompatibleModelBaseURLCandidates,
  parseOpenAICompatibleModels,
  suggestOpenAICompatibleProviderID,
} from "../../../../src/cli/cmd/tui/util/custom-provider"

describe("custom OpenAI-compatible provider helpers", () => {
  test("normalizes endpoint URLs and candidates", () => {
    expect(normalizeOpenAICompatibleBaseURL(" https://api.example.com/v1/ ")).toBe("https://api.example.com/v1")
    expect(normalizeOpenAICompatibleBaseURL("ftp://api.example.com/v1")).toBeUndefined()
    expect(openAICompatibleModelBaseURLCandidates("https://api.example.com")).toEqual([
      "https://api.example.com",
      "https://api.example.com/v1",
    ])
    expect(openAICompatibleModelBaseURLCandidates("https://api.example.com/v1")).toEqual([
      "https://api.example.com/v1",
    ])
  })

  test("parses common model list shapes", () => {
    expect(
      parseOpenAICompatibleModels({
        data: [{ id: "gpt-5.5" }, { model: "llama" }, { name: "custom" }, { id: "gpt-5.5" }, { id: "" }],
      }),
    ).toEqual(["gpt-5.5", "llama", "custom"])
    expect(parseOpenAICompatibleModels([" a ", { id: "b" }, null, 1])).toEqual(["a", "b"])
    expect(parseOpenAICompatibleModels({ models: [{ id: "c" }] })).toEqual(["c"])
  })

  test("discovers models from fallback /v1 candidates", async () => {
    const calls: string[] = []
    const auth: (string | null)[] = []
    const userAgent: (string | null)[] = []
    const fn = async (input: string, init: RequestInit) => {
      calls.push(String(input))
      auth.push(new Headers(init?.headers).get("authorization"))
      userAgent.push(new Headers(init?.headers).get("User-Agent"))
      if (calls.length === 1) return new Response("{}", { status: 404 })
      return Response.json({ data: [{ id: "gpt-5.5" }] })
    }

    await expect(
      discoverOpenAICompatibleModels({
        baseURL: "https://api.example.com",
        token: "secret",
        userAgent: "custom-client/1.0",
        fetch: fn,
        timeout: 1000,
      }),
    ).resolves.toEqual({ baseURL: "https://api.example.com/v1", models: ["gpt-5.5"] })
    expect(calls).toEqual(["https://api.example.com/models", "https://api.example.com/v1/models"])
    expect(auth).toEqual(["Bearer secret", "Bearer secret"])
    expect(userAgent).toEqual(["custom-client/1.0", "custom-client/1.0"])
  })

  test("suggests stable provider ids", () => {
    expect(suggestOpenAICompatibleProviderID("https://api.example.com/v1")).toBe("example")
    expect(suggestOpenAICompatibleProviderID("http://localhost:11434/v1")).toBe("local-llm")
    expect(suggestOpenAICompatibleProviderID("invalid")).toBe("custom-openai")
  })
})
