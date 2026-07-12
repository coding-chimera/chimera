import { describe, expect, test } from "bun:test"
import { lineHash, normalizeInsertLines, normalizeReplaceLines, normalizeReplacement } from "../../src/tool/hashline"

describe("tool.hashline", () => {
  test("hashes significant lines with whitespace-sensitive omo-cid2 semantics", () => {
    expect(lineHash(1, "function hello() {")).not.toBe(lineHash(1, "  function hello() {"))
    expect(lineHash(1, "if (a && b) {")).not.toBe(lineHash(1, "if(a&&b){"))
    expect(lineHash(1, "value")).toBe(lineHash(1, "value  "))
    expect(lineHash(1, "value")).toBe(lineHash(1, "value\r"))
  })

  test("treats unicode letters and numbers as significant content", () => {
    expect(lineHash(1, "你好")).toBe(lineHash(2, "你好"))
    expect(lineHash(1, "こんにちは")).toBe(lineHash(3, "こんにちは"))
  })

  test("mixes line number for non-significant lines", () => {
    expect(lineHash(1, "}")).not.toBe(lineHash(2, "}"))
    expect(new Set(Array.from({ length: 12 }, (_, index) => lineHash(index + 1, ""))).size).toBeGreaterThan(1)
  })

  test("normalizes replacement indentation and boundary echoes", () => {
    expect(normalizeReplaceLines(["function test() {", "  return old", "}"], 2, 2, ["function test() {", "return next", "}"])).toEqual([
      "  return next",
    ])
    expect(normalizeReplaceLines(["  const value = old"], 1, 1, ["const value = next"])).toEqual(["  const value = next"])
  })

  test("normalizes replacement trailing blanks by input type", () => {
    expect(normalizeReplacement("line\n")).toEqual(["line"])
    expect(normalizeReplacement("line\n\n")).toEqual(["line", ""])
    expect(normalizeReplacement(["line", ""])).toEqual(["line", ""])
    expect(normalizeReplacement([""])).toEqual([""])
  })

  test("normalizes merged replacement lines and insert anchor echoes", () => {
    expect(normalizeReplaceLines(["const a = 1;", "const b = 2;"], 1, 2, ["const a = 1; const b = 3;"])).toEqual([
      "const a = 1;",
      "const b = 3;",
    ])
    expect(normalizeInsertLines(["one"], 1, "append", ["one", "two"])).toEqual(["two"])
    expect(normalizeInsertLines(["three"], 1, "prepend", ["two", "three"])).toEqual(["two"])
  })

  test("preserves explicit multiline-to-single-line replacements", () => {
    expect(normalizeReplaceLines(["const a = 1;", "const b = 2;"], 1, 2, ["const a = 1; const b = 2;"])).toEqual([
      "const a = 1; const b = 2;",
    ])
    expect(normalizeReplaceLines(["  const a = 1;", "  const b = 2;"], 1, 2, ["  const a = 1; const b = 2;"])).toEqual([
      "  const a = 1; const b = 2;",
    ])
  })
})
