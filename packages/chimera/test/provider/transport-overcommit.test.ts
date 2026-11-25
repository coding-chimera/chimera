/**
 * Native-transport + HttpLimit overcommit (stage2 integration).
 *
 * The default per-origin cap is delegation.max_concurrent (128). Overcommit is
 * the contract: requests beyond the cap are QUEUED, never rejected. Queue
 * ceilings are opt-in and only reject when explicitly configured.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { ConfigDelegation } from "@/config/delegation"
import {
  DEFAULT_MAX_CONNECTIONS,
  dispose as disposeGates,
  resolveMaxConnections,
  stats as gateStats,
  wrapFetch,
} from "@/provider/http-limit"
import { QueueOverflowError } from "@/provider/http-queue"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import {
  caProfile,
  clearTransportEnv,
  makeFallback,
  nativeFetch,
  postInit,
  startHttp1Tls,
  tlsAddonAvailable,
} from "./fixtures/transport/helpers"

const AVAILABLE = tlsAddonAvailable()
const it = AVAILABLE ? test : test.skip

let restoreEnv: () => void = () => {}

beforeEach(() => {
  restoreEnv = clearTransportEnv()
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  NativeTransportLoader.resetTransportForTests()
  disposeGates()
  restoreEnv()
})

test("the default per-origin cap aligns with delegation.max_concurrent (128)", () => {
  delete process.env.OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS
  expect(DEFAULT_MAX_CONNECTIONS).toBe(128)
  expect(ConfigDelegation.DEFAULT_MAX_CONCURRENT).toBe(128)
  expect(DEFAULT_MAX_CONNECTIONS).toBe(ConfigDelegation.DEFAULT_MAX_CONCURRENT)
  // The provider resolves its default from delegation.max_concurrent.
  expect(resolveMaxConnections(undefined, ConfigDelegation.DEFAULT_MAX_CONCURRENT)).toBe(128)
  // Explicit config and env still win.
  expect(resolveMaxConnections(64, ConfigDelegation.DEFAULT_MAX_CONCURRENT)).toBe(64)
  process.env.OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS = "12"
  expect(resolveMaxConnections(undefined, ConfigDelegation.DEFAULT_MAX_CONCURRENT)).toBe(12)
})

it("overcommits beyond 128 without rejecting or dropping any request", async () => {
  let active = 0
  let peak = 0
  const server = startHttp1Tls(async () => {
    active += 1
    peak = Math.max(peak, active)
    await Bun.sleep(150)
    active -= 1
    return new Response("ok", { headers: { "content-type": "text/plain" } })
  })
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const base = nativeFetch(profileId, undefined, fallback.fn)
    const limited = wrapFetch(base, 128, { mode: "cfs" })

    const outcomes = await Promise.allSettled(
      Array.from({ length: 160 }, (_, index) => limited(server.url(`/${index}`), postInit()).then((response) => response.text())),
    )
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected")
    expect(rejected).toEqual([])
    const texts = outcomes.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : null))
    expect(texts.every((text) => text === "ok")).toBe(true)
    // Exactly the cap is in flight; the remaining 32 waited in the queue.
    expect(peak).toBe(128)
    expect(fallback.calls.length).toBe(0)

    const gate = gateStats().find((entry) => entry.origin === `https://localhost:${server.port}`)
    expect(gate).toBeDefined()
    expect(gate!.limit).toBe(128)
    expect(gate!.active).toBe(0)
    expect(gate!.queued).toBe(0)
  } finally {
    server.close()
  }
})

it("an opt-in queue ceiling rejects the excess while the admitted requests still complete", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = startHttp1Tls(async () => {
    await gate
    return new Response("ok", { headers: { "content-type": "text/plain" } })
  })
  try {
    const profileId = caProfile()
    const base = nativeFetch(profileId, undefined, makeFallback().fn)
    // limit 2 + maxQueueLength 5: the burst is admitted until the queue ceiling
    // is reached, so 5 requests get in and 5 overflow.
    const limited = wrapFetch(base, 2, { mode: "cfs", maxQueueLength: 5 })
    const pending = Array.from({ length: 10 }, (_, index) =>
      limited(server.url(`/${index}`), postInit()).then(
        (response) => response.text(),
        (error) => error,
      ),
    )
    await Bun.sleep(50)
    release()
    const outcomes = await Promise.all(pending)
    const successes = outcomes.filter((outcome) => outcome === "ok")
    const overflows = outcomes.filter((outcome) => outcome instanceof QueueOverflowError)
    expect(successes.length).toBe(5)
    expect(overflows.length).toBe(5)
    expect(overflows.every((error) => (error as QueueOverflowError).kind === "count")).toBe(true)
  } finally {
    server.close()
  }
})