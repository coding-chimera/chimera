import { describe, expect, test } from "bun:test"

const {
  nextOpenAIRemoteCompactionMode,
  openAIRemoteCompactionApplies,
  openAIRemoteCompactionDescription,
  openAIRemoteCompactionEnabled,
  openAIRemoteCompactionStatus,
  openAIRemoteCompactionStatusTitle,
  openAIRemoteCompactionToggleDescription,
  openAIRemoteCompactionToggleTitle,
} = await import("../../../src/cli/cmd/tui/util/remote-compaction")

describe("TUI remote compaction helpers", () => {
  const openai = { providerID: "openai" }
  const mirror = { providerID: "openai-compatible", api: { id: "gpt-5" } }
  const kimi = { providerID: "kimi-for-coding", api: { id: "kimi-for-coding" } }

  test("only applies to OpenAI models", () => {
    expect(openAIRemoteCompactionApplies(openai)).toBe(true)
    expect(openAIRemoteCompactionApplies(mirror)).toBe(false)
    expect(openAIRemoteCompactionApplies(undefined)).toBe(false)
  })

  test("auto mode enables only OpenAI models by default", () => {
    expect(openAIRemoteCompactionEnabled({}, openai)).toBe(true)
    expect(openAIRemoteCompactionStatus({}, openai)).toBe("on")
    expect(openAIRemoteCompactionStatusTitle({}, openai)).toBe("OpenAI remote compaction: on")
    expect(nextOpenAIRemoteCompactionMode({}, openai)).toBe("off")
    expect(openAIRemoteCompactionToggleTitle({}, openai)).toBe("OpenAI remote compaction: on (toggle off)")
    expect(openAIRemoteCompactionDescription({}, openai)).toContain("Auto-enabled")
    expect(openAIRemoteCompactionToggleDescription({}, openai)).toContain("Turn off")
    expect(openAIRemoteCompactionEnabled({}, mirror)).toBe(false)
    expect(openAIRemoteCompactionStatus({}, mirror)).toBe("off")
    expect(nextOpenAIRemoteCompactionMode({}, mirror)).toBe("on")
    expect(openAIRemoteCompactionDescription({}, mirror)).toContain("Auto mode is off")
  })

  test("keeps Kimi off even when remote compaction is forced on", () => {
    const config = { compaction: { remote: "on" as const } }
    expect(openAIRemoteCompactionEnabled(config, kimi)).toBe(false)
    expect(openAIRemoteCompactionStatus(config, kimi)).toBe("off")
    expect(openAIRemoteCompactionStatusTitle(config, kimi)).toBe("OpenAI remote compaction: off")
    expect(openAIRemoteCompactionDescription(config, kimi)).toContain("off for this provider")
  })

  test("maps off config to disabled status and model-aware toggle", () => {
    const config = { compaction: { remote: "off" as const } }
    expect(openAIRemoteCompactionEnabled(config, openai)).toBe(false)
    expect(openAIRemoteCompactionStatus(config, openai)).toBe("off")
    expect(openAIRemoteCompactionStatusTitle(config, openai)).toBe("OpenAI remote compaction: off")
    expect(nextOpenAIRemoteCompactionMode(config, openai)).toBe("auto")
    expect(nextOpenAIRemoteCompactionMode(config, mirror)).toBe("on")
    expect(openAIRemoteCompactionToggleTitle(config, mirror)).toBe("OpenAI remote compaction: off (toggle on)")
    expect(openAIRemoteCompactionDescription(config, mirror)).toContain("local compaction")
    expect(openAIRemoteCompactionToggleDescription(config, mirror)).toContain("Turn on")
  })

  test("maps forced on config to enabled status for mirror providers", () => {
    const config = { compaction: { remote: "on" as const } }
    expect(openAIRemoteCompactionEnabled(config, mirror)).toBe(true)
    expect(openAIRemoteCompactionStatus(config, mirror)).toBe("on")
    expect(nextOpenAIRemoteCompactionMode(config, mirror)).toBe("off")
    expect(openAIRemoteCompactionDescription(config, mirror)).toContain("Forced on")
  })
})
