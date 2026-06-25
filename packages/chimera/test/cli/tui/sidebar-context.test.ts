import { describe, expect, test } from "bun:test"
import type { SessionUsage } from "@opencode-ai/sdk/v2"
import { resolveUsage } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/context"

describe("sidebar context usage", () => {
  test("prefers session usage snapshot over message-window fallback", () => {
    let fallbackCalls = 0
    const usage = {
      total: { total: 30, input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 5 } },
      last: { total: 20, input: 6, output: 4, reasoning: 2, cache: { read: 3, write: 5 } },
      modelContextWindow: 100,
      cost: { total: 0.03, last: 0.02 },
    } satisfies SessionUsage

    const result = resolveUsage(usage, () => {
      fallbackCalls++
      return {
        total: {
          input: 1,
          output: 1,
          reasoning: 1,
          outputEstimated: true,
          contextEstimated: true,
          cacheRead: 1,
          cacheReadEstimated: true,
          context: 1,
        },
        current: {
          input: 1,
          output: 1,
          reasoning: 1,
          outputEstimated: true,
          contextEstimated: true,
          cacheRead: 1,
          cacheReadEstimated: true,
          context: 1,
        },
      }
    })

    expect(fallbackCalls).toBe(0)
    expect(result.total).toEqual({
      input: 22,
      output: 5,
      reasoning: 3,
      outputEstimated: false,
      contextEstimated: false,
      cacheRead: 7,
      cacheReadEstimated: false,
      context: 30,
    })
    expect(result.current).toEqual({
      input: 14,
      output: 4,
      reasoning: 2,
      outputEstimated: false,
      contextEstimated: false,
      cacheRead: 3,
      cacheReadEstimated: false,
      context: 20,
    })
  })
})
