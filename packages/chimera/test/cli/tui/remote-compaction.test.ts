import { describe, expect, test } from "bun:test"

const {
  nextOpenAIRemoteCompactionMode,
  openAIRemoteCompactionDescription,
  openAIRemoteCompactionEnabled,
  openAIRemoteCompactionStatus,
  openAIRemoteCompactionStatusTitle,
  openAIRemoteCompactionToggleDescription,
  openAIRemoteCompactionToggleTitle,
} = await import("../../../src/cli/cmd/tui/util/remote-compaction")

describe("TUI remote compaction helpers", () => {
  test("treats missing config as enabled auto mode", () => {
    expect(openAIRemoteCompactionEnabled({})).toBe(true)
    expect(openAIRemoteCompactionStatus({})).toBe("on")
    expect(openAIRemoteCompactionStatusTitle({})).toBe("OpenAI remote compaction: on")
    expect(nextOpenAIRemoteCompactionMode({})).toBe("off")
    expect(openAIRemoteCompactionToggleTitle({})).toBe("OpenAI remote compaction: on (toggle off)")
    expect(openAIRemoteCompactionDescription({})).toContain("Codex remote compaction")
    expect(openAIRemoteCompactionToggleDescription({})).toContain("Turn off")
  })

  test("maps off config to disabled status and auto toggle", () => {
    const config = { compaction: { remote: "off" as const } }
    expect(openAIRemoteCompactionEnabled(config)).toBe(false)
    expect(openAIRemoteCompactionStatus(config)).toBe("off")
    expect(openAIRemoteCompactionStatusTitle(config)).toBe("OpenAI remote compaction: off")
    expect(nextOpenAIRemoteCompactionMode(config)).toBe("auto")
    expect(openAIRemoteCompactionToggleTitle(config)).toBe("OpenAI remote compaction: off (toggle on)")
    expect(openAIRemoteCompactionDescription(config)).toContain("local compaction")
    expect(openAIRemoteCompactionToggleDescription(config)).toContain("Turn on")
  })
})
