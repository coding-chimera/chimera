import { describe, expect, test } from "bun:test"
import {
  formatCompletedSubagentDetail,
  formatSubagentRetry,
  formatSubagentTitle,
  formatSubagentToolcalls,
} from "../../../src/cli/cmd/tui/util/subagent-format"

describe("tui subagent format", () => {
  test("keeps background state attached to the subagent identity", () => {
    expect(formatSubagentTitle("Explore", "Inspect renderer", false)).toBe("Explore Task — Inspect renderer")
    expect(formatSubagentTitle("Explore", "Inspect renderer", true)).toBe(
      "Explore Task (background) — Inspect renderer",
    )
  })

  test("pluralizes toolcall counts", () => {
    expect(formatSubagentToolcalls(1)).toBe("1 toolcall")
    expect(formatSubagentToolcalls(3)).toBe("3 toolcalls")
  })

  test("formats retry lines", () => {
    expect(formatSubagentRetry(2, "rate limited")).toBe("Retrying (attempt 2) · rate limited")
  })

  test("completed detail omits zero toolcalls", () => {
    expect(formatCompletedSubagentDetail(0, "5s")).toBe("5s")
    expect(formatCompletedSubagentDetail(4, "5s")).toBe("4 toolcalls · 5s")
  })
})
