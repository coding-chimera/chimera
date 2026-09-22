import { describe, expect, test } from "bun:test"
import { displayCharAt, displaySlice, mentionTriggerIndex, promptOffsetWidth } from "../../../src/cli/cmd/prompt-display"
import { expandTrackedPastedText } from "../../../src/cli/cmd/tui/component/prompt/part"
import { isDuplicateEntry, type PromptInfo } from "../../../src/cli/cmd/tui/component/prompt/history"

describe("prompt display width helpers (upstream bba76009a8)", () => {
  test("counts wide characters as two columns and newlines as one", () => {
    expect(promptOffsetWidth("abc")).toBe(3)
    expect(promptOffsetWidth("中文")).toBe(4)
    expect(promptOffsetWidth("a\nb")).toBe(3)
    expect(promptOffsetWidth("🚀")).toBe(2)
  })

  test("displaySlice cuts on display columns, not string indices", () => {
    expect(displaySlice("中文abc", 0, 4)).toBe("中文")
    expect(displaySlice("中文abc", 4)).toBe("abc")
  })

  test("displayCharAt resolves the grapheme at a display offset", () => {
    expect(displayCharAt("a中b", 1)).toBe("中")
    expect(displayCharAt("a中b", 3)).toBe("b")
  })

  test("mentionTriggerIndex reports the @ trigger offset", () => {
    expect(mentionTriggerIndex("hello @fo", 9)).toBe(6)
    expect(mentionTriggerIndex("hello foo", 9)).toBeUndefined()
  })

  test("expands tracked pasted text next to wide characters without corruption", () => {
    // Display: "中文[Pasted Text #1]" — the placeholder occupies columns 4..20.
    const input = "中文[Pasted Text #1]"
    const expanded = expandTrackedPastedText(input, [
      { start: 4, end: 20, text: "粘贴的内容" },
    ])
    expect(expanded).toBe("中文粘贴的内容")
    // A plain string.slice at the display offsets would corrupt the prefix.
    expect(input.slice(0, 4) + "粘贴的内容").not.toBe(expanded)
  })

  test("expands multiple ranges back to front", () => {
    const input = "[Pasted Text #1] and [Pasted Text #2]"
    const expanded = expandTrackedPastedText(input, [
      { start: 0, end: 16, text: "A" },
      { start: 21, end: 37, text: "B" },
    ])
    expect(expanded).toBe("A and B")
  })
})

describe("prompt history dedupe (upstream f3b0d3d7ac)", () => {
  const entry = (input: string, parts: PromptInfo["parts"] = []): PromptInfo => ({ input, parts })

  test("flags consecutive duplicates and nothing else", () => {
    expect(isDuplicateEntry(entry("a"), entry("a"))).toBe(true)
    expect(isDuplicateEntry(entry("a"), entry("b"))).toBe(false)
    expect(isDuplicateEntry(undefined, entry("a"))).toBe(false)
  })
})
