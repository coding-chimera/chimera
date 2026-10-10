import { describe, expect, test } from "bun:test"
import { gcCooldownMs, shouldCollect, softCapBytes } from "../../src/cli/heap"

const MB = 1024 * 1024
const MINUTE = 60_000

describe("Heap soft cap (opt-in)", () => {
  test("is disabled by default when the env var is unset", () => {
    expect(softCapBytes({})).toBeUndefined()
    expect(softCapBytes({ CHIMERA_HEAP_SOFT_CAP_MB: "" })).toBeUndefined()
  })

  test("enables collection when explicitly set to a positive value", () => {
    expect(softCapBytes({ CHIMERA_HEAP_SOFT_CAP_MB: "256" })).toBe(256 * MB)
    expect(softCapBytes({ CHIMERA_HEAP_SOFT_CAP_MB: "2048" })).toBe(2048 * MB)
  })

  test("stays disabled when explicitly set to zero", () => {
    expect(softCapBytes({ CHIMERA_HEAP_SOFT_CAP_MB: "0" })).toBeUndefined()
  })

  test("stays disabled on invalid or negative values", () => {
    expect(softCapBytes({ CHIMERA_HEAP_SOFT_CAP_MB: "nope" })).toBeUndefined()
    expect(softCapBytes({ CHIMERA_HEAP_SOFT_CAP_MB: "-1" })).toBeUndefined()
  })
})

describe("Heap GC cooldown", () => {
  test("defaults to five minutes", () => {
    expect(gcCooldownMs({})).toBe(5 * MINUTE)
  })

  test("honors a valid override", () => {
    expect(gcCooldownMs({ CHIMERA_HEAP_GC_COOLDOWN_MS: "10000" })).toBe(10000)
  })

  test("falls back to the default on invalid values", () => {
    expect(gcCooldownMs({ CHIMERA_HEAP_GC_COOLDOWN_MS: "0" })).toBe(5 * MINUTE)
    expect(gcCooldownMs({ CHIMERA_HEAP_GC_COOLDOWN_MS: "nope" })).toBe(5 * MINUTE)
  })
})

describe("shouldCollect", () => {
  const base = { cap: 1024 * MB, cooldownMs: 5 * MINUTE, lastCollectedAt: 0 }

  test("does not collect when disabled", () => {
    expect(shouldCollect({ ...base, cap: undefined, heapUsed: 4 * 1024 * MB, now: 10 * MINUTE })).toBe(false)
  })

  test("does not collect below the soft cap", () => {
    expect(shouldCollect({ ...base, heapUsed: 512 * MB, now: 10 * MINUTE })).toBe(false)
    expect(shouldCollect({ ...base, heapUsed: 1024 * MB, now: 10 * MINUTE })).toBe(false)
  })

  test("collects above the cap once the cooldown has elapsed", () => {
    expect(shouldCollect({ ...base, heapUsed: 1025 * MB, now: 6 * MINUTE })).toBe(true)
  })

  test("throttles within the cooldown window", () => {
    expect(shouldCollect({ ...base, heapUsed: 2 * 1024 * MB, now: 3 * MINUTE })).toBe(false)
    expect(shouldCollect({ ...base, heapUsed: 2 * 1024 * MB, lastCollectedAt: 4 * MINUTE, now: 5 * MINUTE })).toBe(false)
    expect(shouldCollect({ ...base, heapUsed: 2 * 1024 * MB, lastCollectedAt: 4 * MINUTE, now: 9 * MINUTE })).toBe(true)
  })
})