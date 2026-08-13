import { describe, expect, test } from "bun:test"
import { ProviderUltra } from "../../src/provider/ultra"

describe("ProviderUltra", () => {
  test("default membership covers the built-in ultra models", () => {
    expect(ProviderUltra.isUltraModel({ id: "gpt-5.6-sol", api: { id: "gpt-5.6-sol" } })).toBe(true)
    expect(ProviderUltra.isUltraModel({ id: "gpt-5.6-terra", api: { id: "gpt-5.6-terra" } })).toBe(true)
    expect(ProviderUltra.isUltraModel({ id: "k3", api: { id: "k3" } })).toBe(true)
    expect(ProviderUltra.isUltraModel({ id: "kimi-k3", api: { id: "kimi-k3" } })).toBe(true)
    expect(ProviderUltra.isUltraModel({ id: "deepseek-v4-flash", api: { id: "deepseek-v4-flash" } })).toBe(true)
    expect(ProviderUltra.isUltraModel({ id: "openai/gpt-5.6-sol", api: { id: "openai/gpt-5.6-sol" } })).toBe(true)
  })

  test("non-members are excluded", () => {
    expect(ProviderUltra.isUltraModel({ id: "deepseek-v4-pro", api: { id: "deepseek-v4-pro" } })).toBe(false)
    expect(ProviderUltra.isUltraModel({ id: "gpt-5.6", api: { id: "gpt-5.6" } })).toBe(false)
    expect(ProviderUltra.isUltraModel({ id: "gpt-5.6-luna", api: { id: "gpt-5.6-luna" } })).toBe(false)
  })

  test("configured entries extend the defaults as case-insensitive substrings", () => {
    expect(ProviderUltra.isUltraModel({ id: "deepseek-v4-pro", api: { id: "deepseek-v4-pro" } }, ["DeepSeek-V4-Pro"])).toBe(true)
    expect(ProviderUltra.isUltraModel({ id: "my-custom-model", api: { id: "my-custom-model" } }, ["custom"])).toBe(true)
  })

  test("ultraModels normalizes and drops empty entries", () => {
    const entries = ProviderUltra.ultraModels(["  ", "K3"])
    expect(entries).toContain("k3")
    expect(entries).not.toContain("")
  })
})
