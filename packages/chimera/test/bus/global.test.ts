import { describe, expect, test } from "bun:test"
import { GlobalBus } from "@/bus/global"

describe("GlobalBus max listeners (R1)", () => {
  test("raises the warning threshold above the EventEmitter default of 10", () => {
    // One listener per SSE connection plus fixed process consumers; the default
    // threshold warns spuriously with a few open WebUI tabs.
    expect(GlobalBus.getMaxListeners()).toBeGreaterThanOrEqual(1_000)
  })

  test("many concurrent listeners do not emit a warning", () => {
    const warnings: unknown[] = []
    const onWarning = (warning: unknown) => warnings.push(warning)
    process.on("warning", onWarning)
    const handlers = Array.from({ length: 50 }, () => () => {})
    try {
      for (const handler of handlers) GlobalBus.on("event", handler)
      expect(GlobalBus.listenerCount("event")).toBeGreaterThanOrEqual(50)
      expect(warnings.length).toBe(0)
    } finally {
      for (const handler of handlers) GlobalBus.off("event", handler)
      process.off("warning", onWarning)
    }
  })
})
