/**
 * Pre-send vs post-send fallback discipline for the native transport.
 *
 * THE invariant: the crate may only retry a request after a provably pre-send
 * `is_connect()` failure. Once the request may be on the wire, an error is
 * propagated unchanged — a POST/model call is never duplicated and the TS
 * fallback is never invoked again.
 *
 * Empirical classification (probed on darwin-arm64, recorded here as tests):
 *   - ALPN completed then the h2 session is destroyed -> POST-SEND class:
 *     no protocol fallback, error propagates, postSendErrors unchanged.
 *   - TCP-level RST while the TLS ClientHello offers h2 -> `is_connect()`:
 *     one protocol fallback, the http1 retry succeeds against a real server.
 *   - connection refused -> `is_connect()`: one protocol fallback.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import {
  caProfile,
  clearTransportEnv,
  closedPort,
  makeFallback,
  nativeFetch,
  postInit,
  runEnvChild,
  startAlpnRstProxy,
  startBrokenMidStream,
  startH2,
  startHttp1Tls,
  statsDelta,
  statsNow,
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
  restoreEnv()
})

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(10)
  }
}

// ---------------------------------------------------------------------------
// THE CROWN: a post-send failure is never retried and never duplicated
// ---------------------------------------------------------------------------

it("CROWN: a mid-stream break propagates with zero retries, zero fallback calls and exactly one POST", async () => {
  const server = await startBrokenMidStream()
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = statsNow()

    // The POST body makes duplication observable: a retried request would
    // reach the server a second time.
    let error: unknown
    try {
      const response = await fetchFn(server.url("/chat"), postInit("model-call"))
      const reader = response.body!.getReader()
      for (;;) {
        const part = await reader.read()
        if (part.done) break
      }
    } catch (failure) {
      error = failure
    }

    expect(error).toBeDefined()
    expect(String(error)).toContain("response body failed")
    // The TS fallback was never invoked for this request.
    expect(fallback.calls.length).toBe(0)
    // The POST reached the server exactly once — never duplicated.
    expect(server.received()).toBe(1)

    await waitFor(() => statsDelta(before, statsNow()).postSend === 1)
    const delta = statsDelta(before, statsNow())
    expect(delta.protocol).toBe(0)
    expect(delta.route).toBe(0)
    expect(delta.postSend).toBe(1)
    // Give a stray retry a chance to show up before the final assertion.
    await Bun.sleep(150)
    expect(server.received()).toBe(1)
    expect(statsDelta(before, statsNow()).postSend).toBe(1)
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------------------
// Pre-send protocol fallback: h2 connect failure -> http1 retry succeeds
// ---------------------------------------------------------------------------

it("pre-send h2 failure fires exactly one protocol fallback and the http1 retry succeeds", async () => {
  const real = startHttp1Tls(() => new Response("http1-behind-rst", { headers: { "content-type": "text/plain" } }))
  const front = await startAlpnRstProxy(real.port)
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = statsNow()

    const response = await fetchFn(front.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("http1-behind-rst")

    const delta = statsDelta(before, statsNow())
    expect(delta.protocol).toBe(1)
    expect(delta.route).toBe(0)
    expect(delta.postSend).toBe(0)
    // One h2 ClientHello was reset; the http1 retry was tunneled through.
    expect(front.rsts()).toBe(1)
    expect(fallback.calls.length).toBe(0)
  } finally {
    front.close()
    real.close()
  }
})

it("a connection-refused https request counts one protocol fallback and propagates the failure", async () => {
  const port = await closedPort()
  const profileId = caProfile()
  const fallback = makeFallback()
  const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
  const before = statsNow()

  const error = await fetchFn(`https://localhost:${port}/x`, postInit()).then(
    () => undefined,
    (failure) => failure,
  )
  expect(error).toBeInstanceOf(TypeError)
  expect((error as Error).message).toBe("fetch failed")

  await waitFor(() => statsDelta(before, statsNow()).protocol === 1)
  const delta = statsDelta(before, statsNow())
  expect(delta.protocol).toBe(1)
  expect(delta.route).toBe(0)
  expect(delta.postSend).toBe(0)
  expect(fallback.calls.length).toBe(0)
})

// ---------------------------------------------------------------------------
// Empirical boundary: ALPN completed is already post-send
// ---------------------------------------------------------------------------

it("ALPN-then-destroy is classified post-send: no fallback, error propagates", async () => {
  const server = await startH2({
    onSession: (session) => {
      session.destroy()
    },
  })
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = statsNow()

    const error = await fetchFn(server.url("/x"), postInit()).then(
      () => undefined,
      (failure) => failure,
    )
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")

    // TLS + ALPN completed before the destroy, so this is NOT is_connect():
    // the crate must not retry.
    expect(server.alpn.length).toBeGreaterThan(0)
    expect(server.alpn.every((protocol) => protocol === "h2")).toBe(true)
    const delta = statsDelta(before, statsNow())
    expect(delta.protocol).toBe(0)
    expect(delta.route).toBe(0)
    expect(delta.postSend).toBe(0)
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------------------
// Pre-send route fallback: system proxy -> direct
// ---------------------------------------------------------------------------

it("a dead system proxy fires exactly one route fallback and the direct retry succeeds (child process)", async () => {
  const server = startHttp1Tls(() => new Response("proxy-route-ok", { headers: { "content-type": "text/plain" } }))
  const dead = await closedPort()
  try {
    const result = await runEnvChild(server.url("/x"), { HTTPS_PROXY: `http://127.0.0.1:${dead}` })
    expect(result.ok).toBe(true)
    expect(result.text).toBe("proxy-route-ok")
    expect(result.delta).toEqual({ protocol: 0, route: 1, postSend: 0, cancelled: 0 })
  } finally {
    server.close()
  }
})

it("a pinned profile proxy is never bypassed by the route fallback", async () => {
  const dead = await closedPort()
  let hits = 0
  const server = startHttp1Tls(() => {
    hits += 1
    return new Response("never", { headers: { "content-type": "text/plain" } })
  })
  try {
    const profileId = caProfile({ proxy: `http://127.0.0.1:${dead}` })
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = statsNow()

    const error = await fetchFn(server.url("/x"), postInit()).then(
      () => undefined,
      (failure) => failure,
    )
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")

    const delta = statsDelta(before, statsNow())
    expect(delta.route).toBe(0)
    expect(delta.postSend).toBe(0)
    // The pinned route is the only route: the server never sees the request.
    expect(hits).toBe(0)
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("bounds retries to one per request: a dead proxy plus a dead target counts route only (child process)", async () => {
  const deadProxy = await closedPort()
  const deadTarget = await closedPort()
  const result = await runEnvChild(`https://localhost:${deadTarget}/x`, { HTTPS_PROXY: `http://127.0.0.1:${deadProxy}` })
  expect(result.ok).toBe(false)
  // Route fallback is preferred when a proxy env is configured; the direct
  // retry is the single allowed retry, so no protocol retry follows it.
  expect(result.delta).toEqual({ protocol: 0, route: 1, postSend: 0, cancelled: 0 })
})

it("no proxy configured: a dead https target counts protocol, never route", async () => {
  const deadTarget = await closedPort()
  const profileId = caProfile()
  const fallback = makeFallback()
  const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
  const before = statsNow()
  await fetchFn(`https://localhost:${deadTarget}/x`, postInit()).catch(() => undefined)
  await waitFor(() => statsDelta(before, statsNow()).protocol === 1)
  const delta = statsDelta(before, statsNow())
  expect(delta.route).toBe(0)
  })
