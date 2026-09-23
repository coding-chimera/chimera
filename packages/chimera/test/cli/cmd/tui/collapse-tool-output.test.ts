import { describe, expect, test } from "bun:test"
import { collapseToolOutput } from "@/cli/cmd/tui/util/collapse-tool-output"

describe("collapseToolOutput", () => {
  test("keeps short output untouched", () => {
    const result = collapseToolOutput("a\nb\nc", 10, 100)
    expect(result).toEqual({ output: "a\nb\nc", overflow: false })
  })

  test("collapses by line count with an ellipsis line", () => {
    const output = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const result = collapseToolOutput(output, 10, 10_000)
    expect(result.overflow).toBe(true)
    expect(result.output.split("\n")).toEqual([...Array.from({ length: 10 }, (_, i) => `line${i + 1}`), "…"])
  })

  test("collapses a single huge line by character budget", () => {
    const output = "x".repeat(500)
    const result = collapseToolOutput(output, 10, 100)
    expect(result.overflow).toBe(true)
    expect(Array.from(result.output)).toHaveLength(100)
    expect(result.output.endsWith("…")).toBe(true)
  })

  test("counts wide characters as single units", () => {
    const output = "😀".repeat(10)
    const result = collapseToolOutput(output, 10, 6)
    expect(result.overflow).toBe(true)
    expect(Array.from(result.output)).toEqual([...Array(5).fill("😀"), "…"])
  })

  test("char budget applies to the line preview, not the whole output", () => {
    const output = ["a".repeat(30), "b".repeat(30), "c"].join("\n")
    const result = collapseToolOutput(output, 2, 50)
    expect(result.overflow).toBe(true)
    expect(Array.from(result.output)).toHaveLength(50)
  })
})
