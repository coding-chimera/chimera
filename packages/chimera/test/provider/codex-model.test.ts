import { describe, expect, test } from "bun:test"
import { CodexModel } from "@/provider/codex-model"

describe("codex-model.isOAuthModel", () => {
  // Version-fallback matrix ported from upstream codex.test.ts
  // (02a167e048 + 500c46ec79): compare GPT versions by major and minor so
  // gpt-5.10 no longer collapses to 5.1 via parseFloat, and integer versions
  // like gpt-6 match at all. Unanchored regex: suffixed variants of allowed
  // generations pass, matching upstream.
  test.each([
    ["gpt-6", true],
    ["gpt-6-astra", true],
    ["gpt-6.0-astra", true],
    ["gpt-7", true],
    ["gpt-10", true],
    ["gpt-5.5-astra", true],
    ["gpt-5.9", true],
    ["gpt-5.10", true],
    ["gpt-5.10-astra", true],
    ["gpt-5.40", true],
    ["gpt-6garbage", true],
    ["gpt-6.", true],
    ["gpt-6.1.2", true],
    ["gpt-5", false],
    ["gpt-5.4-astra", false],
    ["gpt-5.04-astra", false],
    ["gpt-4.1", false],
    ["gpt-4.99", false],
    ["gpt-5.5-pro", false],
    ["not-a-gpt-model", false],
  ])("filters unknown id %s by GPT major and minor versions", (id, allowed) => {
    expect(CodexModel.isOAuthModel(id)).toBe(allowed)
  })

  // Fork-specific shape: the capability registry short-circuits the version
  // fallback, and modelID() normalization strips provider prefixes / case.
  test.each([
    ["gpt-5.2", true],
    ["gpt-5.4", true],
    ["gpt-5.5", true],
    ["gpt-5.6", true],
    ["gpt-5.6-sol", true],
    ["gpt-5.6-fast", true],
    ["openai/gpt-6", true],
    ["OpenAI/GPT-6", true],
    ["openai.gpt-6", true],
    ["openai/gpt-5.10", true],
    ["openai/gpt-5", false],
  ])("registry and normalization resolve %s before the version fallback", (id, allowed) => {
    expect(CodexModel.isOAuthModel(id)).toBe(allowed)
  })
})
