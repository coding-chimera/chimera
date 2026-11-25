/**
 * Native-transport https/TLS data plane (stage2) — real addon, real hermetic
 * TLS servers. Skips cleanly when the prebuild is missing or too old.
 *
 * Fixtures: test/provider/fixtures/transport (throwaway CA + server/client
 * certs). Servers bind 127.0.0.1 on ephemeral ports; no external network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportFetch } from "@/provider/sdk/native-transport/fetch"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import {
  DIR,
  SERVER_NAME,
  caProfile,
  caPem,
  clearTransportEnv,
  makeFallback,
  nativeFetch,
  postInit,
  rejection,
  runEnvChild,
  serverNameProfile,
  startH2,
  startHttp1Tls,
  tlsAddonAvailable,
} from "./fixtures/transport/helpers"

const AVAILABLE = tlsAddonAvailable()
const it = AVAILABLE ? test : test.skip
// Extra CA roots are trusted additively on every platform (platform verifier
// primary + webpki extra-roots fallback), so the child-process env tests run
// on darwin as well as Linux. The crate reads env once at init, hence child
// processes.
const itEnvRoots = AVAILABLE ? test : test.skip
let restoreEnv: () => void = () => {}

beforeEach(() => {
  restoreEnv = clearTransportEnv()
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  NativeTransportLoader.resetTransportForTests()
  restoreEnv()
})

it("https with platform trust rejects an untrusted server certificate (fail-closed)", async () => {
  const server = startHttp1Tls(() => new Response("never", { headers: { "content-type": "text/plain" } }))
  try {
    const fallback = makeFallback()
    const fetchFn = nativeFetch(0, undefined, fallback.fn)
    const error = await rejection(fetchFn(server.url("/x"), postInit()))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")
    // The addon handled it (no delegation): an untrusted https peer must fail,
    // not silently fall back to Bun's own TLS stack.
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("configureTls CA trust carries status, headers and an ordered SSE stream to a clean EOF", async () => {
  const encoder = new TextEncoder()
  const server = startHttp1Tls((req) => {
    if (new URL(req.url).pathname === "/sse") {
      let index = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index >= 4) {
              controller.close()
              return
            }
            controller.enqueue(encoder.encode(`data: ${index}\n\n`))
            index += 1
            await Bun.sleep(20)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response("hello", { status: 200, headers: { "content-type": "text/plain", "x-test": "1" } })
  })
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)

    const response = await fetchFn(server.url("/plain"), postInit())
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(response.headers.get("x-test")).toBe("1")
    expect(await response.text()).toBe("hello")

    const sse = await fetchFn(server.url("/sse"), postInit())
    expect(sse.status).toBe(200)
    expect(sse.headers.get("content-type")).toBe("text/event-stream")
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      chunks.push(decoder.decode(part.value))
    }
    expect(chunks.join("")).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\n")
    // Streamed, not one buffered blob: more than one pull was observed.
    expect(chunks.length).toBeGreaterThan(1)
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("ALPN negotiates h2 and the addon carries the h2 response", async () => {
  const server = await startH2()
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const response = await fetchFn(server.url("/h2"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("h2-ok")
    // Server-side proof: the TLS session really negotiated h2.
    expect(server.alpn.length).toBeGreaterThan(0)
    expect(server.alpn.every((protocol) => protocol === "h2")).toBe(true)
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("httpVersion http1 never upgrades to h2 (fails against an h2-only server, works against http1)", async () => {
  const h2 = await startH2()
  const http1 = startHttp1Tls(() => new Response("http1-ok", { headers: { "content-type": "text/plain" } }))
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const pinned = nativeFetch(profileId, "http1", fallback.fn)

    const error = await rejection(pinned(h2.url("/x"), postInit()))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")
    // No h2 session was created: the http1-only ALPN list cannot negotiate
    // with an h2-only server, so it fails instead of silently upgrading.
    expect(h2.alpn.length).toBe(0)

    const response = await pinned(http1.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("http1-ok")
    expect(fallback.calls.length).toBe(0)
  } finally {
    h2.close()
    http1.close()
  }
})

// ---------------------------------------------------------------------------
// Bodyless GET/HEAD ride the addon (fix #4: no null body over the napi ABI)
// ---------------------------------------------------------------------------

it("a bodyless GET rides the addon and never pre-send-delegates", async () => {
  const server = startHttp1Tls(() => new Response("get-ok", { headers: { "content-type": "text/plain" } }))
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = NativeTransportFetch.preSendFallbackCount()

    const response = await fetchFn(server.url("/get"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("get-ok")

    // The addon carried it: the fallback never ran and no pre-send delegation
    // was counted (before the fix every bodyless GET delegated).
    expect(fallback.calls.length).toBe(0)
    expect(NativeTransportFetch.preSendFallbackCount()).toBe(before)
  } finally {
    server.close()
  }
})

it("a bodyless HEAD rides the addon and yields a null body", async () => {
  let received = 0
  const server = startHttp1Tls(() => {
    received += 1
    return new Response(null, { status: 200, headers: { "content-type": "text/plain" } })
  })
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const before = NativeTransportFetch.preSendFallbackCount()

    const response = await fetchFn(server.url("/head"), { method: "HEAD" })
    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(received).toBe(1)
    expect(fallback.calls.length).toBe(0)
    expect(NativeTransportFetch.preSendFallbackCount()).toBe(before)
  } finally {
    server.close()
  }
})

it("a caPem-only profile trusts a CA-signed server (no serverName override needed)", async () => {
  const server = startHttp1Tls(() => new Response("ca-only-ok", { headers: { "content-type": "text/plain" } }))
  try {
    // caProfile() registers `{ caPem }` with no serverName: platform trust is
    // primary and the CA is an extra anchor (works on darwin too).
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const response = await fetchFn(server.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ca-only-ok")
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("the explicit serverName-override profile still trusts the CA-signed server", async () => {
  const server = startHttp1Tls(() => new Response("name-override-ok", { headers: { "content-type": "text/plain" } }))
  try {
    const profileId = serverNameProfile()
    expect(profileId).toBeGreaterThan(0)
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const response = await fetchFn(server.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("name-override-ok")
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("kill switch OPENCODE_RUST_TRANSPORT=0 returns the fallback identity and null management plane", () => {
  process.env.OPENCODE_RUST_TRANSPORT = "0"
  const fallback = makeFallback()
  expect(NativeTransport.resolveFetch({ enabled: true, fallback: fallback.fn })).toBe(fallback.fn)
  expect(NativeTransport.configureTls({ caPem })).toBeNull()
  expect(NativeTransport.capabilities()).toBeNull()
  expect(NativeTransport.stats()).toBeNull()
})

// ---------------------------------------------------------------------------
// Env CA roots — read once at crate init, so they need a fresh process
// ---------------------------------------------------------------------------

const envRootCases: Array<{ name: string; env: () => Record<string, string> }> = [
  { name: "OPENCODE_RUST_TRANSPORT_CA_FILE", env: () => ({ OPENCODE_RUST_TRANSPORT_CA_FILE: path.join(DIR, "ca.pem") }) },
  { name: "NODE_EXTRA_CA_CERTS", env: () => ({ NODE_EXTRA_CA_CERTS: path.join(DIR, "ca.pem") }) },
  { name: "SSL_CERT_FILE", env: () => ({ SSL_CERT_FILE: path.join(DIR, "ca.pem") }) },
  { name: "SSL_CERT_DIR", env: () => ({ SSL_CERT_DIR: path.join(DIR, "ca-dir") }) },
]

for (const item of envRootCases) {
  itEnvRoots(`${item.name} adds a trust root before init (child process)`, async () => {
    const server = startHttp1Tls(() => new Response("env-root-ok", { headers: { "content-type": "text/plain" } }))
    try {
      // profile 0: only the env root can make the CA-signed server trusted.
      const withRoot = await runEnvChild(server.url("/x"), item.env(), "env")
      expect(withRoot.ok).toBe(true)
      expect(withRoot.text).toBe("env-root-ok")
      expect(withRoot.delta).toEqual({ protocol: 0, route: 0, postSend: 0, cancelled: 0 })

      // Control: without the env root the same server must be rejected.
      const withoutRoot = await runEnvChild(server.url("/x"), {}, "env")
      expect(withoutRoot.ok).toBe(false)
    } finally {
      server.close()
    }
  })
}

// Old-addon https delegation (addon without the `tls` capability) is already
// asserted in test/provider/native-transport.test.ts ("https rides the addon
// only when it advertises the tls capability"); not duplicated here.