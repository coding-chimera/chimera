import { describe, expect, test } from "bun:test"
import {
  memoryDedicatedToolsEnabled,
  memoryDedicatedToolsStatus,
  memoryDedicatedToolsToggleTitle,
  memoryEnabled,
  memoryEnabledStatus,
  memoryEnabledToggleTitle,
  nextMemoryDedicatedTools,
  nextMemoryEnabled,
} from "./memory-settings"

describe("memory-settings", () => {
  test("defaults to disabled for both flags", () => {
    expect(memoryEnabled({})).toBe(false)
    expect(memoryDedicatedToolsEnabled({})).toBe(false)
    expect(memoryEnabledStatus({})).toBe("off")
    expect(memoryDedicatedToolsStatus({})).toBe("off")
  })

  test("toggles opt-in flags", () => {
    const enabled = { memories: { enabled: true, dedicated_tools: true } }
    expect(nextMemoryEnabled({})).toBe(true)
    expect(nextMemoryEnabled(enabled)).toBe(false)
    expect(nextMemoryDedicatedTools({})).toBe(true)
    expect(nextMemoryDedicatedTools(enabled)).toBe(false)
  })

  test("titles include current status and next action", () => {
    expect(memoryEnabledToggleTitle({})).toContain("off")
    expect(memoryEnabledToggleTitle({})).toContain("toggle on")
    expect(memoryDedicatedToolsToggleTitle({ memories: { dedicated_tools: true } })).toContain("on")
    expect(memoryDedicatedToolsToggleTitle({ memories: { dedicated_tools: true } })).toContain("toggle off")
  })
})
