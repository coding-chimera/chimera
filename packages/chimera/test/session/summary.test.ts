import { describe, expect, test } from "bun:test"
import { SessionSummary } from "@/session/summary"
import { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"

const diff = (patch: string, file = "file.txt"): Snapshot.FileDiff => ({
  file,
  patch,
  additions: 1,
  deletions: 0,
})

describe("SessionSummary.messageSummaryDiffs", () => {
  test("keeps diffs that fit the stored budget", () => {
    const diffs = [diff("+ small patch\n"), diff("+ other\n", "other.txt")]

    expect(SessionSummary.messageSummaryDiffs(diffs)).toEqual(diffs)
  })

  test("drops diffs over the item cap", () => {
    const diffs = Array.from({ length: 201 }, (_, index) => diff("+x\n", `file-${index}.txt`))

    expect(SessionSummary.messageSummaryDiffs(diffs)).toBeUndefined()
  })

  test("drops diffs whose estimated size exceeds the budget", () => {
    const diffs = [diff("x".repeat(MessageV2.MAX_STORED_MESSAGE_SUMMARY_BYTES))]

    expect(SessionSummary.messageSummaryDiffs(diffs)).toBeUndefined()
  })

  test("drops diffs whose serialized form exceeds the stored budget", () => {
    // Control characters cost one character in the estimate but six bytes once
    // JSON escapes them, so this payload passes the cheap size gate and only
    // the serialized check catches it. Storing it is what used to force the
    // read-path repair in MessageV2.
    const patch = "\u0001".repeat(Math.floor(MessageV2.MAX_STORED_MESSAGE_SUMMARY_BYTES / 4))
    const diffs = [diff(patch)]
    expect(patch.length).toBeLessThan(MessageV2.MAX_STORED_MESSAGE_SUMMARY_BYTES)
    expect(Buffer.byteLength(JSON.stringify(diffs))).toBeGreaterThan(MessageV2.MAX_STORED_MESSAGE_SUMMARY_BYTES)

    expect(SessionSummary.messageSummaryDiffs(diffs)).toBeUndefined()
  })
})
