import { describe, expect, test } from "bun:test"
import { shouldSnapshot, snapshotLimitBytes } from "../../src/cli/heap"

const MB = 1024 * 1024

describe("Heap auto snapshot", () => {
  test("uses 2GB RSS limit by default", () => {
    expect(snapshotLimitBytes({})).toBe(2 * 1024 * MB)
  })

  test("allows lowering the RSS snapshot threshold", () => {
    expect(snapshotLimitBytes({ OPENCODE_AUTO_HEAP_SNAPSHOT_MB: "256" })).toBe(256 * MB)
    expect(shouldSnapshot({ rss: 257 * MB }, 256 * MB)).toBe(true)
    expect(shouldSnapshot({ rss: 256 * MB }, 256 * MB)).toBe(false)
  })

  test("ignores invalid RSS threshold overrides", () => {
    expect(snapshotLimitBytes({ OPENCODE_AUTO_HEAP_SNAPSHOT_MB: "0" })).toBe(2 * 1024 * MB)
    expect(snapshotLimitBytes({ OPENCODE_AUTO_HEAP_SNAPSHOT_MB: "nope" })).toBe(2 * 1024 * MB)
  })
})
