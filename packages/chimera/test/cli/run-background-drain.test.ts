import { describe, expect, test } from "bun:test"
import { drainBackgroundJobs } from "../../src/cli/cmd/run"

const quiescent = { quiescent: true, running: 0, pendingDeliveries: 0 }
const busy = (running: number, pendingDeliveries: number) => ({
  quiescent: false,
  running,
  pendingDeliveries,
})

describe("drainBackgroundJobs", () => {
  test("returns immediately when the first poll is quiescent", async () => {
    const polls: number[] = []
    const result = await drainBackgroundJobs({
      sessionID: "ses-test",
      poll: async (timeoutMs) => {
        polls.push(timeoutMs)
        return quiescent
      },
    })
    expect(result).toEqual(quiescent)
    expect(polls).toEqual([30000])
  })

  test("keeps polling while not quiescent and prints one progress line per round", async () => {
    const responses = [busy(1, 0), busy(0, 1), quiescent]
    const progress: Array<{ running: number; pendingDeliveries: number; waitedSeconds: number }> = []
    const result = await drainBackgroundJobs({
      sessionID: "ses-test",
      poll: async (timeoutMs) => responses.shift() ?? quiescent,
      pollTimeoutMs: 1000,
      onWaiting: (state) => progress.push(state),
    })
    expect(result).toEqual(quiescent)
    expect(progress).toEqual([
      { running: 1, pendingDeliveries: 0, waitedSeconds: 0 },
      { running: 0, pendingDeliveries: 1, waitedSeconds: 0 },
    ])
  })

  test("passes the configured poll timeout to every poll", async () => {
    const polls: number[] = []
    const responses = [busy(2, 0), quiescent]
    await drainBackgroundJobs({
      sessionID: "ses-test",
      poll: async (timeoutMs) => {
        polls.push(timeoutMs)
        return responses.shift() ?? quiescent
      },
      pollTimeoutMs: 4242,
    })
    expect(polls).toEqual([4242, 4242])
  })

  test("stops early when the signal aborts even if not quiescent", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await drainBackgroundJobs({
      sessionID: "ses-test",
      poll: async () => busy(3, 0),
      signal: controller.signal,
    })
    expect(result).toEqual(busy(3, 0))
  })
})