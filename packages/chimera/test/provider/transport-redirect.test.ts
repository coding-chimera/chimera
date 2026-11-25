/**
 * Redirect regression (fix #1): the crate follows redirects MANUALLY, so the
 * pre-send fallback is only eligible on hop 0. A connect failure on a redirect
 * hop must propagate — never replay the original POST, never bump a fallback
 * counter. Also covers the redirect semantics the manual loop implements:
 * 303 POST->GET, 307 method/body preservation, and cross-origin credential
 * stripping.
 *
 * Everything is a hermetic 127.0.0.1 TLS server; no external network.
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
  rejection,
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

it("a redirect-hop connect failure rejects with no fallback and exactly one accepted POST", async () => {
  const dead = await closedPort()
  let received = 0
  const source = startHttp1Tls(() => {
    received += 1
    return new Response(null, { status: 307, headers: { location: `https://localhost:${dead}/next` } })
  })
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = statsNow()

    // The POST body makes a replay observable: a duplicated request would hit
    // the source a second time.
    const error = await rejection(fetchFn(source.url("/start"), postInit("model-call")))

    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")
    // Hop 0 was already accepted: the fallback must not run, and no counter moves.
    expect(fallback.calls.length).toBe(0)
    expect(received).toBe(1)
    const delta = statsDelta(before, statsNow())
    expect(delta.protocol).toBe(0)
    expect(delta.route).toBe(0)
    expect(delta.postSend).toBe(0)

    // Give a stray retry a chance to show up before the final assertions.
    await Bun.sleep(150)
    expect(received).toBe(1)
    expect(fallback.calls.length).toBe(0)
    expect(statsDelta(before, statsNow()).protocol).toBe(0)
    expect(statsDelta(before, statsNow()).route).toBe(0)
  } finally {
    source.close()
  }
})

it("a followed redirect returns the final body and marks the response redirected", async () => {
  const target = startHttp1Tls(() => new Response("from-b", { headers: { "content-type": "text/plain" } }))
  const source = startHttp1Tls(() => new Response(null, { status: 307, headers: { location: target.url("/final") } }))
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)

    const response = await fetchFn(source.url("/start"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("from-b")
    expect(response.redirected).toBe(true)
    expect(response.url).toBe(target.url("/final"))
    expect(fallback.calls.length).toBe(0)
  } finally {
    source.close()
    target.close()
  }
})

it("303 turns a POST into a bodyless GET at the redirect target", async () => {
  let seen: { method: string; body: string } | undefined
  const target = startHttp1Tls(async (req) => {
    seen = { method: req.method, body: await req.text() }
    return new Response("after-303", { headers: { "content-type": "text/plain" } })
  })
  const source = startHttp1Tls(() => new Response(null, { status: 303, headers: { location: target.url("/after") } }))
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)

    const response = await fetchFn(source.url("/start"), postInit("payload"))
    expect(await response.text()).toBe("after-303")
    expect(seen).toBeDefined()
    expect(seen!.method).toBe("GET")
    expect(seen!.body).toBe("")
    expect(fallback.calls.length).toBe(0)
  } finally {
    source.close()
    target.close()
  }
})

it("307 preserves method and body across a same-origin redirect and keeps credentials", async () => {
  let seen: { method: string; body: string; authorization: string | null } | undefined
  const server = startHttp1Tls(async (req) => {
    if (new URL(req.url).pathname === "/final") {
      seen = {
        method: req.method,
        body: await req.text(),
        authorization: req.headers.get("authorization"),
      }
      return new Response("same-origin-final", { headers: { "content-type": "text/plain" } })
    }
    return new Response(null, { status: 307, headers: { location: "/final" } })
  })
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)

    const response = await fetchFn(server.url("/start"), {
      method: "POST",
      body: "preserved-body",
      headers: { "content-type": "text/plain", authorization: "Bearer same-origin" },
    })
    expect(await response.text()).toBe("same-origin-final")
    expect(seen).toBeDefined()
    expect(seen!.method).toBe("POST")
    expect(seen!.body).toBe("preserved-body")
    expect(seen!.authorization).toBe("Bearer same-origin")
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("a cross-origin redirect strips Authorization", async () => {
  let authorization: string | null = "unset"
  const target = startHttp1Tls((req) => {
    authorization = req.headers.get("authorization")
    return new Response("cross-origin-final", { headers: { "content-type": "text/plain" } })
  })
  const source = startHttp1Tls(() => new Response(null, { status: 307, headers: { location: target.url("/final") } }))
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)

    const response = await fetchFn(source.url("/start"), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", authorization: "Bearer cross-origin" },
    })
    expect(await response.text()).toBe("cross-origin-final")
    expect(authorization).toBeNull()
    expect(fallback.calls.length).toBe(0)
  } finally {
    source.close()
    target.close()
  }
})