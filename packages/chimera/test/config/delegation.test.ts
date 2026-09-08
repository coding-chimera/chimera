import { describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { ConfigParse } from "../../src/config/parse"

describe("config.delegation background subagents", () => {
  test("defaults are consumed from the exported constants", () => {
    expect(ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS).toBe(true)
    expect(ConfigDelegation.DEFAULT_BACKGROUND_CONCURRENT).toBe(16)
    // Omitted keys stay undefined in the parsed config; defaults live at the
    // consumption sites (kill-switch gating in phase 2, engine capacity in start).
    const config = ConfigParse.effectSchema(Config.Info, { delegation: {} }, "test")
    expect(config.delegation?.background_subagents).toBeUndefined()
    expect(config.delegation?.background_concurrent).toBeUndefined()
  })

  test("parses a background_subagents override", () => {
    const config = ConfigParse.effectSchema(Config.Info, { delegation: { background_subagents: false } }, "test")
    expect(config.delegation?.background_subagents).toBe(false)
  })

  test("parses a background_concurrent override", () => {
    const config = ConfigParse.effectSchema(Config.Info, { delegation: { background_concurrent: 8 } }, "test")
    expect(config.delegation?.background_concurrent).toBe(8)
  })

  test("rejects a non-boolean background_subagents", () => {
    expect(() =>
      ConfigParse.effectSchema(Config.Info, { delegation: { background_subagents: "yes" } }, "test"),
    ).toThrow()
  })

  test("rejects zero, negative, and non-integer background_concurrent", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => ConfigParse.effectSchema(Config.Info, { delegation: { background_concurrent: bad } }, "test")).toThrow()
    }
  })

  test("Config zod schema exposes background fields", () => {
    const parsed = Config.Info.zod.safeParse({ delegation: { background_subagents: true, background_concurrent: 4 } })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.delegation?.background_subagents).toBe(true)
      expect(parsed.data.delegation?.background_concurrent).toBe(4)
    }
  })
})