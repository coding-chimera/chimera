import { describe, expect, test } from "bun:test"
import { check } from "./control-check"

describe("WP-10 control-plane fixtures", () => {
  test("inventories, owners, references, and all behavior judges pass", async () => {
    const result = await check()
    expect(result.errors).toEqual([])
    expect(result.summary).toContain("PASS semantic points: 223 enumerated + 12 buckets = 343")
    expect(result.summary.some((line) => line.startsWith("PASS judges: 29/29"))).toBe(true)
    expect(result.summary.some((line) => line.startsWith("PASS domains: 12 manifests"))).toBe(true)
  })
})