/**
 * Native-transport proxy semantics (stage2): system/env proxy discovery,
 * explicit pinned proxies, direct connections, and the old-addon delegation
 * path when `proxy-system` is absent.
 *
 * Env proxy state is read once by the crate at module init, so the system-proxy
 * test runs in a child process; the pinned/direct cases are in-process because
 * they travel in the TLS profile, not the environment.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import { REQUIRED_CAPABILITIES, type TransportAddon } from "@/provider/sdk/native-transport/layout"
import {
  caProfile,
  clearTransportEnv,
  makeFallback,
  nativeFetch,
  postInit,
  runEnvChild,
  startConnectProxy,
  startHttp1Tls,
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

it("HTTPS_PROXY routes the addon through the configured CONNECT proxy (child process)", async () => {
  const server = startHttp1Tls(() => new Response("via-proxy", { headers: { "content-type": "text/plain" } }))
  const proxy = await startConnectProxy()
  try {
    const result = await runEnvChild(server.url("/x"), { HTTPS_PROXY: proxy.url })
    expect(result.ok).toBe(true)
    expect(result.text).toBe("via-proxy")
    expect(proxy.connects()).toBe(1)
    expect(result.delta).toEqual({ protocol: 0, route: 0, postSend: 0, cancelled: 0 })
  } finally {
    proxy.close()
    server.close()
  }
})

it("a pinned profile proxy routes the request through that proxy", async () => {
  const server = startHttp1Tls(() => new Response("pinned-ok", { headers: { "content-type": "text/plain" } }))
  const proxy = await startConnectProxy()
  try {
    const profileId = caProfile({ proxy: proxy.url })
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = statsNow()

    const response = await fetchFn(server.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("pinned-ok")
    expect(proxy.connects()).toBe(1)
    expect(fallback.calls.length).toBe(0)

    const after = statsNow()
    expect((after.protocolFallbacks ?? 0) - (before.protocolFallbacks ?? 0)).toBe(0)
    expect((after.routeFallbacks ?? 0) - (before.routeFallbacks ?? 0)).toBe(0)
  } finally {
    proxy.close()
    server.close()
  }
})

it("no proxy configuration connects directly and never touches the proxy", async () => {
  const server = startHttp1Tls(() => new Response("direct-ok", { headers: { "content-type": "text/plain" } }))
  const proxy = await startConnectProxy()
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const response = await fetchFn(server.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("direct-ok")
    expect(proxy.connects()).toBe(0)
    expect(fallback.calls.length).toBe(0)
  } finally {
    proxy.close()
    server.close()
  }
})

it("an addon without proxy-system delegates an env-proxied request to the fallback", async () => {
  const calls = { start: 0 }
  const addon: TransportAddon = {
    contractInfo: () => ({
      abiMajor: 1,
      abiMinor: 0,
      capabilities: [...REQUIRED_CAPABILITIES],
      build: "fake-no-proxy-system",
    }),
    startRequest: () => {
      calls.start += 1
      return { handle: 1 }
    },
    awaitHeaders: async () => ({ status: 200, statusText: "OK", headers: [], url: "", redirected: false }),
    readBody: async () => null,
    cancel: () => {},
    release: () => {},
    stats: () => ({ activeHandles: 0, bufferedBytes: 0, cancelledHandles: 0, postSendErrors: 0, workerThreads: 1 }),
  }
  try {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9"
    NativeTransportLoader.setTransportForTests(addon)
    const fallback = makeFallback()
    const fetchFn = NativeTransport.resolveFetch({ enabled: true, fallback: fallback.fn })
    expect(fetchFn).not.toBe(fallback.fn)

    const response = await fetchFn("http://example.test/v1/chat", postInit())
    expect(await response.text()).toBe("FALLBACK")
    // nativeSpec returned null before startRequest: the proxy is never bypassed.
    expect(calls.start).toBe(0)
    expect(fallback.calls.length).toBe(1)
  } finally {
    NativeTransportLoader.resetTransportForTests()
  }
})

// Pinned-proxy-never-bypassed on failure is covered in tls-fallback.test.ts
// ("a pinned profile proxy is never bypassed by the route fallback").