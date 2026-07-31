import { describe, expect, test } from "bun:test"
import { shouldConfirmUltraSwitch, ultraSwitchCopy } from "../../../src/cli/cmd/tui/util/variant"

describe("ultra variant switch confirmation", () => {
  test("confirms entering ultra from another variant", () => {
    expect(shouldConfirmUltraSwitch("max", "ultra")).toBe(true)
  })

  test("confirms entering ultra from an explicit default", () => {
    expect(shouldConfirmUltraSwitch(undefined, "ultra")).toBe(true)
  })

  test("matches ultra case-insensitively", () => {
    expect(shouldConfirmUltraSwitch("max", "Ultra")).toBe(true)
    expect(shouldConfirmUltraSwitch("Ultra", "max")).toBe(true)
  })

  test("confirms leaving ultra", () => {
    expect(shouldConfirmUltraSwitch("ultra", "max")).toBe(true)
    expect(shouldConfirmUltraSwitch("ultra", undefined)).toBe(true)
  })

  test("does not confirm switches within the same side", () => {
    expect(shouldConfirmUltraSwitch("max", "high")).toBe(false)
    expect(shouldConfirmUltraSwitch(undefined, "max")).toBe(false)
    expect(shouldConfirmUltraSwitch("ultra", "ultra")).toBe(false)
    expect(shouldConfirmUltraSwitch(undefined, undefined)).toBe(false)
  })

  test("uses enter copy when moving to ultra and leave copy when leaving", () => {
    expect(ultraSwitchCopy("max", "ultra").title).toBe("Switch to ultra?")
    expect(ultraSwitchCopy("ultra", "max").title).toBe("Switch away from ultra?")
    expect(ultraSwitchCopy("max", "ultra").message).toContain("prompt cache hits will drop temporarily")
  })
})
