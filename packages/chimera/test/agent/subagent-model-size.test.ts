import { describe, expect, test } from "bun:test"
import { resolveSizeClass, staticSpeedNorm } from "../../src/agent/subagent-model-size"
import type { SizeClass } from "../../src/agent/subagent-model-size"

describe("subagent model size", () => {
  test("covers every seeded identity in the built-in size table", () => {
    const expected: Array<[string, SizeClass]> = [
      ["kimi-k3", "XL"],
      ["qwen3.8-max", "XL"],
      ["gpt-5.6-sol", "XL"],
      ["claude-fable-5", "XL"],
      ["deepseek-v4-pro", "L"],
      ["deepseek-v4-flash", "L"],
      ["qwen3.8-flash", "L"],
      ["claude-opus-5", "L"],
      ["claude-opus-4.8", "L"],
      ["glm-5.2", "M"],
      ["gpt-5.6-terra", "M"],
      ["claude-sonnet-5", "M"],
      ["claude-sonnet-4.6", "M"],
      ["gpt-5.6-luna", "S"],
      ["claude-haiku", "S"],
    ]
    for (const [identity, sizeClass] of expected) {
      expect(resolveSizeClass({ identity })).toBe(sizeClass)
    }
  })

  test("normalizes whitespace and case before table lookup", () => {
    expect(resolveSizeClass({ identity: "  DeepSeek-V4-Flash " })).toBe("L")
  })

  test("lets a valid configured override win over the built-in table", () => {
    expect(resolveSizeClass({ identity: "kimi-k3", configured: "M" })).toBe("M")
  })

  test("ignores an invalid configured literal", () => {
    expect(resolveSizeClass({ identity: "kimi-k3", configured: "XS" })).toBe("XL")
  })

  test("matches dash-aligned prefixes with the longest entry winning", () => {
    expect(resolveSizeClass({ identity: "deepseek-v4-flash-0731" })).toBe("L")
    expect(resolveSizeClass({ identity: "glm-5.2-fast-preview" })).toBe("M")
    expect(resolveSizeClass({ identity: "qwen3.8-max-0902" })).toBe("XL")
  })

  test("rejects prefix candidates without a dash boundary", () => {
    expect(resolveSizeClass({ identity: "qwen3.8-maximum" })).toBeUndefined()
  })

  test("returns undefined for unknown identities", () => {
    expect(resolveSizeClass({ identity: "unknown-model" })).toBeUndefined()
    expect(resolveSizeClass({ identity: "" })).toBeUndefined()
  })

  test("applies the base speed norm for each size class", () => {
    expect(staticSpeedNorm({ sizeClass: "XL", identity: "kimi-k3" })).toBe(0.15)
    expect(staticSpeedNorm({ sizeClass: "L", identity: "deepseek-v4-pro" })).toBe(0.35)
    expect(staticSpeedNorm({ sizeClass: "M", identity: "glm-5.2" })).toBe(0.6)
    expect(staticSpeedNorm({ sizeClass: "S", identity: "claude-haiku" })).toBe(0.85)
  })

  test("demotes one class for fast or flash identities", () => {
    expect(staticSpeedNorm({ sizeClass: "XL", identity: "kimi-k3-fast" })).toBe(0.35)
    expect(staticSpeedNorm({ sizeClass: "L", identity: "qwen3.8-flash" })).toBe(0.6)
    expect(staticSpeedNorm({ sizeClass: "M", identity: "glm-5.2-fast-preview" })).toBe(0.85)
    expect(staticSpeedNorm({ sizeClass: "S", identity: "gpt-5.6-luna-flash" })).toBe(0.85)
  })

  test("falls back to the legacy speed norm without a size class", () => {
    expect(staticSpeedNorm({ identity: "kimi-k2.7-code" })).toBe(1)
    expect(staticSpeedNorm({ identity: "gpt-5.6-sol-flash" })).toBe(1)
    expect(staticSpeedNorm({ identity: "deepseek-v4-pro" })).toBe(0.3)
    expect(staticSpeedNorm({ identity: "glm-5.2" })).toBe(0.6)
    expect(staticSpeedNorm({ identity: "unknown-xyz-42" })).toBe(0.6)
  })
})