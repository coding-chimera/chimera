import { describe, expect, test } from "bun:test"

const {
  nextOpenAIRemoteCompactionMode,
  nextOpenAIRemoteCompactionProtocolStatus,
  openAIRemoteCompactionApplies,
  openAIRemoteCompactionDescription,
  openAIRemoteCompactionEnabled,
  openAIRemoteCompactionProtocolConfig,
  openAIRemoteCompactionProtocolDescription,
  openAIRemoteCompactionProtocolStatus,
  openAIRemoteCompactionProtocolStatusTitle,
  openAIRemoteCompactionProtocolToggleDescription,
  openAIRemoteCompactionProtocolToggleTitle,
  openAIRemoteCompactionStatus,
  openAIRemoteCompactionStatusTitle,
  openAIRemoteCompactionToggleDescription,
  openAIRemoteCompactionToggleTitle,
  remoteCompactionLockFromParts,
  remoteCompactionModelLockMessage,
  remoteCompactionModelLocked,
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

  test("maps protocol status to v2 by default while remote is enabled", () => {
    expect(openAIRemoteCompactionProtocolStatus({}, openai)).toBe("v2")
    expect(openAIRemoteCompactionProtocolStatusTitle({}, openai)).toBe("OpenAI remote compaction protocol: v2")
    expect(openAIRemoteCompactionProtocolDescription({}, openai)).toContain("Prefers v2")
    expect(openAIRemoteCompactionProtocolToggleTitle({}, openai)).toBe(
      "OpenAI remote compaction protocol: v2 (switch to legacy)",
    )
    expect(openAIRemoteCompactionProtocolToggleDescription({}, openai)).toContain("legacy")
  })

  test("cycles remote compaction protocol through v2 legacy and off", () => {
    const v2 = { compaction: { remote: "auto" as const, remote_protocol: "v2" as const } }
    const legacy = { compaction: { remote: "auto" as const, remote_protocol: "legacy" as const } }
    const off = { compaction: { remote: "off" as const, remote_protocol: "legacy" as const } }

    expect(nextOpenAIRemoteCompactionProtocolStatus(v2, openai)).toBe("legacy")
    expect(nextOpenAIRemoteCompactionProtocolStatus(legacy, openai)).toBe("off")
    expect(nextOpenAIRemoteCompactionProtocolStatus(off, openai)).toBe("v2")
  })

  test("builds protocol config patch with model-aware remote enablement", () => {
    expect(openAIRemoteCompactionProtocolConfig("v2", openai)).toEqual({ remote: "auto", remote_protocol: "v2" })
    expect(openAIRemoteCompactionProtocolConfig("legacy", mirror)).toEqual({ remote: "on", remote_protocol: "legacy" })
    expect(openAIRemoteCompactionProtocolConfig("off", openai)).toEqual({ remote: "off", remote_protocol: "v2" })
  })

  test("detects and describes remote compaction model locks", () => {
    const lock = remoteCompactionLockFromParts([
      { id: "part-1", messageID: "msg-1", type: "text" },
      {
        id: "part-2",
        messageID: "msg-2",
        type: "compaction",
        remote: { providerID: "openai", modelID: "gpt-5" },
      },
    ])

    expect(lock).toEqual({ providerID: "openai", modelID: "gpt-5", messageID: "msg-2", partID: "part-2" })
    expect(remoteCompactionModelLocked(lock, { providerID: "openai", modelID: "gpt-5" })).toBe(false)
    expect(remoteCompactionModelLocked(lock, { providerID: "test", modelID: "test-model" })).toBe(true)
    expect(remoteCompactionModelLockMessage(lock!, { providerID: "test", modelID: "test-model" })).toContain(
      "locked to openai/gpt-5",
    )
  })
})
