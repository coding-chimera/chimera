/**
 * Native-transport seam tests — executed entirely against a fake addon
 * (pure JS async simulation of the crate ABI). No native binary is loaded,
 * no server is started, no real network is touched. The 300-concurrent case
 * verifies the JS adapter has no hidden 64/256-style cap; it is NOT a
 * production performance measurement.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportFetch } from "@/provider/sdk/native-transport/fetch"
import { NativeTransportGating } from "@/provider/sdk/native-transport/gating"
import { NativeTransportLoader, acceptsContract } from "@/provider/sdk/native-transport/loader"
import {
  REQUIRED_CAPABILITIES,
  type ContractInfo,
  type HeadersResult,
  type RequestSpec,
  type TransportAddon,
} from "@/provider/sdk/native-transport/layout"

const encoder = new TextEncoder()

/** Intentionally non-RequestInit shapes (Bun extensions, unknown keys) for
 *  the delegation whitelist — the adapter must delegate them untouched. */
const rawInit = (value: unknown) => value as RequestInit

// ---------------------------------------------------------------------------
// Fake addon — mirrors the crate's handle lifecycle in pure JS
// ---------------------------------------------------------------------------

type FakeState = {
  spec: RequestSpec
  head: HeadersResult
  chunks: Uint8Array[]
  cursor: number
  eof: boolean
  cancelled: boolean
  released: boolean
  reading: boolean
  bodyWaiters: Array<{ resolve: (chunk: Uint8Array | null) => void; reject: (error: Error) => void }>
  headWaiters: Array<{ resolve: (head: HeadersResult) => void; reject: (error: Error) => void }>
}

type FakeOptions = {
  contract?: Partial<ContractInfo>
  head?: Partial<HeadersResult>
  /** Pre-scripted body chunks; EOF follows unless openEnded. */
  chunks?: string[]
  /** Leave the stream open after scripted chunks (test pushes/finishes manually). */
  openEnded?: boolean
  /** awaitHeaders stays pending until releaseHeaders/cancel (abort-window tests). */
  holdHeaders?: boolean
  headersError?: Error
  bodyError?: Error
  startError?: Error
}

function makeFakeAddon(opts: FakeOptions = {}) {
  const states = new Map<number, FakeState>()
  const calls = { start: 0, started: [] as number[], cancel: [] as number[], release: [] as number[] }
  let nextHandle = 1
  let live = 0
  let peak = 0
  let idleReclaimed = 0

  const stateOf = (handle: number) => {
    const state = states.get(handle)
    if (!state) throw new Error(`unknown transport handle ${handle}`)
    return state
  }
  const wakeBody = (state: FakeState, error: Error) => {
    for (const waiter of state.bodyWaiters.splice(0)) waiter.reject(error)
  }

  const addon: TransportAddon = {
    contractInfo: () => ({
      abiMajor: 1,
      abiMinor: 0,
      capabilities: [...REQUIRED_CAPABILITIES],
      build: "fake-addon",
      ...opts.contract,
    }),
    startRequest(spec) {
      if (opts.startError) throw opts.startError
      const handle = nextHandle++
      calls.start++
      calls.started.push(handle)
      live++
      peak = Math.max(peak, live)
      states.set(handle, {
        spec,
        head: { status: 200, statusText: "OK", headers: [], url: spec.url, redirected: false, ...opts.head },
        chunks: (opts.chunks ?? []).map((text) => encoder.encode(text)),
        cursor: 0,
        eof: !opts.openEnded,
        cancelled: false,
        released: false,
        reading: false,
        bodyWaiters: [],
        headWaiters: [],
      })
      return { handle }
    },
    async awaitHeaders(handle) {
      const state = stateOf(handle)
      if (opts.headersError) throw opts.headersError
      if (state.released) throw new Error("request has been released")
      if (state.cancelled) throw new Error("request was cancelled")
      if (!opts.holdHeaders) return state.head
      return new Promise<HeadersResult>((resolve, reject) => state.headWaiters.push({ resolve, reject }))
    },
    async readBody(handle) {
      const state = stateOf(handle)
      if (state.released) throw new Error("request has been released")
      // The crate allows one in-flight readBody per handle; a second
      // concurrent read is a defect, not a queue.
      if (state.reading) throw new Error("readBody is already pending for this handle")
      state.reading = true
      try {
        // Buffered bytes win over terminal state, matching the crate.
        if (state.cursor < state.chunks.length) return state.chunks[state.cursor++]
        if (opts.bodyError) throw opts.bodyError
        if (state.cancelled) throw new Error("request was cancelled")
        if (state.eof) return null
        return await new Promise<Uint8Array | null>((resolve, reject) => state.bodyWaiters.push({ resolve, reject }))
      } finally {
        state.reading = false
      }
    },
    cancel(handle) {
      const state = states.get(handle)
      if (!state || state.cancelled || state.released) return
      state.cancelled = true
      state.cursor = state.chunks.length
      calls.cancel.push(handle)
      wakeBody(state, new Error("request was cancelled"))
      for (const waiter of state.headWaiters.splice(0)) waiter.reject(new Error("request was cancelled"))
    },
    release(handle) {
      const state = states.get(handle)
      if (!state || state.released) return
      state.released = true
      live--
      calls.release.push(handle)
      wakeBody(state, new Error("request has been released"))
      for (const waiter of state.headWaiters.splice(0)) waiter.reject(new Error("request has been released"))
    },
    stats: () => ({
      activeHandles: live,
      bufferedBytes: 0,
      cancelledHandles: calls.cancel.length,
      postSendErrors: 0,
      protocolFallbacks: 0,
      routeFallbacks: 0,
      idleReclaimedHandles: idleReclaimed,
      workerThreads: 1,
    }),
  }

  return {
    addon,
    calls,
    peak: () => peak,
    live: () => live,
    specOf: (handle: number) => stateOf(handle).spec,
    push(handle: number, text: string) {
      const state = stateOf(handle)
      const bytes = encoder.encode(text)
      const waiter = state.bodyWaiters.shift()
      if (waiter) waiter.resolve(bytes)
      else state.chunks.push(bytes)
    },
    finish(handle: number) {
      const state = stateOf(handle)
      state.eof = true
      for (const waiter of state.bodyWaiters.splice(0)) waiter.resolve(null)
    },
    releaseHeaders(handle: number) {
      const state = stateOf(handle)
      for (const waiter of state.headWaiters.splice(0)) waiter.resolve(state.head)
    },
    /** Mimics the crate's idle-reader reclaim: registry removal + teardown +
     *  the idleReclaimedHandles counter, without a JS-side cancel call. */
    reclaim(handle: number) {
      const state = stateOf(handle)
      if (state.released) return
      state.released = true
      state.cancelled = true
      state.cursor = state.chunks.length
      live--
      idleReclaimed++
      calls.release.push(handle)
      wakeBody(state, new Error("request has been released"))
      for (const waiter of state.headWaiters.splice(0)) waiter.reject(new Error("request has been released"))
    },
  }
}

function makeFallback() {
  const calls: Array<{ input: unknown; init: unknown }> = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response("fallback")
  }) as typeof fetch
  return { fn, calls }
}

type CreateOpts = { tlsProfile?: number; httpVersion?: "auto" | "http1" }

function setup(opts: FakeOptions = {}, create: CreateOpts = {}) {
  const fake = makeFakeAddon(opts)
  NativeTransportLoader.setTransportForTests(fake.addon)
  const fallback = makeFallback()
  const fetchFn = NativeTransport.resolveFetch({ enabled: true, fallback: fallback.fn, ...create })
  return { fake, fallback, fetchFn }
}

/** Settle a promise and hand back the rejection value (or undefined on success). */
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error) => error)

// ---------------------------------------------------------------------------
// Env hygiene — bun test shares one process across files
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "OPENCODE_RUST_TRANSPORT",
  "OPENCODE_RUST_TRANSPORT_PATH",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  NativeTransportLoader.setTransportForTests(null)
  NativeTransportLoader.resetTransportForTests()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

describe("gating", () => {
  test("every provider is eligible once the flag is explicitly on", () => {
    expect(NativeTransportGating.eligible({ enabled: true })).toBe(true)
  })

  test("flag must be explicitly true", () => {
    expect(NativeTransportGating.eligible({ enabled: false })).toBe(false)
    expect(NativeTransportGating.eligible({ enabled: undefined })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveFetch selection + management plane
// ---------------------------------------------------------------------------

describe("resolveFetch selection", () => {
  test("off returns the fallback identity and never touches the addon", () => {
    const fake = makeFakeAddon()
    NativeTransportLoader.setTransportForTests(fake.addon)
    const fallback = makeFallback()
    expect(NativeTransport.resolveFetch({ enabled: false, fallback: fallback.fn })).toBe(fallback.fn)
    expect(NativeTransport.resolveFetch({ enabled: undefined, fallback: fallback.fn })).toBe(fallback.fn)
    expect(fake.calls.start).toBe(0)
    expect(fallback.calls.length).toBe(0)
  })

  test("kill switch OPENCODE_RUST_TRANSPORT=0 returns the fallback identity", () => {
    process.env.OPENCODE_RUST_TRANSPORT = "0"
    const { fake, fallback, fetchFn } = setup()
    expect(fetchFn).toBe(fallback.fn)
    expect(fake.calls.start).toBe(0)
    expect(NativeTransport.contractInfo()).toBeNull()
    expect(NativeTransport.stats()).toBeNull()
  })

  test("loader failure (cached null) returns the fallback identity", () => {
    NativeTransportLoader.setTransportForTests(null)
    const fallback = makeFallback()
    expect(NativeTransport.resolveFetch({ enabled: true, fallback: fallback.fn })).toBe(fallback.fn)
  })

  test("enabled with a verified addon returns a native-backed wrapper", () => {
    const { fallback, fetchFn } = setup()
    expect(fetchFn).not.toBe(fallback.fn)
  })

  test("management plane reads the addon contract and live stats", () => {
    const { fake } = setup()
    expect(NativeTransport.contractInfo()?.build).toBe("fake-addon")
    expect(NativeTransport.stats()?.activeHandles).toBe(0)
    fake.addon.startRequest({ url: "http://example.test/", method: "GET", headers: [] })
    expect(NativeTransport.stats()?.activeHandles).toBe(1)
  })

  test("management plane exposes negotiated capabilities and the new fallback counters", () => {
    setup()
    expect(NativeTransport.capabilities()).toEqual([...REQUIRED_CAPABILITIES])
    expect(NativeTransport.stats()?.protocolFallbacks).toBe(0)
    expect(NativeTransport.stats()?.routeFallbacks).toBe(0)
    NativeTransportLoader.setTransportForTests(null)
    expect(NativeTransport.capabilities()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ABI negotiation matrix
// ---------------------------------------------------------------------------

describe("ABI negotiation", () => {
  const info = (): ContractInfo => ({
    abiMajor: 1,
    abiMinor: 0,
    capabilities: [...REQUIRED_CAPABILITIES],
    build: "fake",
  })

  test("exact contract and newer minors within the major are accepted", () => {
    expect(acceptsContract(info())).toBe(true)
    expect(acceptsContract({ ...info(), abiMinor: 7 })).toBe(true)
    expect(acceptsContract({ ...info(), capabilities: [...REQUIRED_CAPABILITIES, "future-cap"] })).toBe(true)
  })

  test("a different major is refused in both directions", () => {
    expect(acceptsContract({ ...info(), abiMajor: 0 })).toBe(false)
    expect(acceptsContract({ ...info(), abiMajor: 2 })).toBe(false)
  })

  test("every required capability is mandatory", () => {
    for (const cap of REQUIRED_CAPABILITIES) {
      expect(acceptsContract({ ...info(), capabilities: REQUIRED_CAPABILITIES.filter((c) => c !== cap) })).toBe(false)
    }
    expect(acceptsContract({ ...info(), capabilities: [] })).toBe(false)
  })

  test("v1.2 additive capabilities are tolerated", () => {
    expect(
      acceptsContract({
        ...info(),
        abiMinor: 2,
        capabilities: [
          ...REQUIRED_CAPABILITIES,
          "tls",
          "tls-platform",
          "http2",
          "proxy-system",
          "tls-custom-ca",
          "mtls",
          "fallback-protocol",
          "fallback-route",
        ],
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Native data plane
// ---------------------------------------------------------------------------

describe("native data plane", () => {
  test("string input rides the addon with a GET default", async () => {
    const { fake, fallback, fetchFn } = setup({ chunks: ["hello"] })
    const res = await fetchFn("http://example.test/a")
    expect(await res.text()).toBe("hello")
    expect(fake.calls.start).toBe(1)
    expect(fake.specOf(1).url).toBe("http://example.test/a")
    expect(fake.specOf(1).method).toBe("GET")
    expect(fake.specOf(1).redirect).toBe("follow")
    expect(fallback.calls.length).toBe(0)
  })

  test("URL input is carried as its href", async () => {
    const { fake, fetchFn } = setup({ chunks: ["ok"] })
    await fetchFn(new URL("http://example.test/b?x=1"))
    expect(fake.specOf(1).url).toBe("http://example.test/b?x=1")
  })

  test("POST string body, method and record headers cross intact", async () => {
    const { fake, fetchFn } = setup({ chunks: ["ok"] })
    await fetchFn("http://example.test/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: '{"prompt":"hi"}',
    })
    const spec = fake.specOf(1)
    expect(spec.method).toBe("POST")
    expect(spec.body).toBe('{"prompt":"hi"}')
    expect(spec.headers).toEqual([
      { name: "content-type", value: "application/json" },
      { name: "authorization", value: "Bearer k" },
    ])
  })

  test("Uint8Array body and duplicate header pairs are preserved in order", async () => {
    const { fake, fetchFn } = setup({ chunks: ["ok"] })
    const bytes = encoder.encode("binary")
    await fetchFn("http://example.test/bin", {
      method: "POST",
      headers: [
        ["x-a", "1"],
        ["x-a", "2"],
      ],
      body: bytes,
    })
    const spec = fake.specOf(1)
    expect(spec.body).toBe(bytes)
    expect(spec.headers).toEqual([
      { name: "x-a", value: "1" },
      { name: "x-a", value: "2" },
    ])
  })

  test("timeout: false is native (the addon has no deadline either)", async () => {
    const { fake, fallback, fetchFn } = setup({ chunks: ["ok"] })
    const res = await fetchFn("http://example.test/t", rawInit({ timeout: false }))
    expect(await res.text()).toBe("ok")
    expect(fake.calls.start).toBe(1)
    expect(fallback.calls.length).toBe(0)
  })

  test("spec carries the default profile: auto protocol, profile 0", async () => {
    const { fake, fetchFn } = setup({ chunks: ["ok"] })
    await fetchFn("http://example.test/defaults")
    expect(fake.specOf(1).httpVersion).toBe("auto")
    expect(fake.specOf(1).tlsProfile).toBe(0)
  })

  test("resolveFetch passes tlsProfile and httpVersion into the spec", async () => {
    const { fake, fetchFn } = setup({ chunks: ["ok"] }, { tlsProfile: 7, httpVersion: "http1" })
    await fetchFn("http://example.test/profile")
    expect(fake.specOf(1).tlsProfile).toBe(7)
    expect(fake.specOf(1).httpVersion).toBe("http1")
  })

  test("https rides the addon only when it advertises the tls capability", async () => {
    const plain = setup({ chunks: ["ok"] })
    const delegated = await plain.fetchFn("https://example.test/secure")
    expect(await delegated.text()).toBe("fallback")
    expect(plain.fake.calls.start).toBe(0)

    const tls = setup({ chunks: ["ok"], contract: { capabilities: [...REQUIRED_CAPABILITIES, "tls"] } })
    const native = await tls.fetchFn("https://example.test/secure")
    expect(await native.text()).toBe("ok")
    expect(tls.fake.specOf(1).url).toBe("https://example.test/secure")
  })
})

// ---------------------------------------------------------------------------
// Delegation whitelist — fallback called exactly once, addon never started
// ---------------------------------------------------------------------------

describe("delegation whitelist", () => {
  const cases: Array<{ name: string; input: RequestInfo | URL; init?: RequestInit }> = [
    { name: "Request input", input: new Request("http://example.test/") },
    { name: "https without the tls capability", input: "https://example.test/" },
    { name: "non-http scheme", input: "ftp://example.test/" },
    { name: "invalid URL", input: "not a url" },
    { name: "Bun proxy extension", input: "http://example.test/", init: rawInit({ proxy: "http://proxy.test" }) },
    { name: "Bun tls extension", input: "http://example.test/", init: rawInit({ tls: { rejectUnauthorized: false } }) },
    { name: "Bun unix extension", input: "http://example.test/", init: rawInit({ unix: "/tmp/socket" }) },
    { name: "Bun verbose extension", input: "http://example.test/", init: rawInit({ verbose: true }) },
    { name: "keepAlive extension", input: "http://example.test/", init: rawInit({ keepAlive: false }) },
    { name: "session extension", input: "http://example.test/", init: rawInit({ session: {} }) },
    { name: "arbitrary unknown key", input: "http://example.test/", init: rawInit({ whatever: 1 }) },
    {
      name: "inherited unknown key",
      input: "http://example.test/",
      init: rawInit(Object.create({ proxy: "http://proxy.test" })),
    },
    {
      name: "symbol key",
      input: "http://example.test/",
      init: rawInit({ [Symbol("unknown")]: true }),
    },
    {
      name: "ReadableStream body",
      input: "http://example.test/",
      init: { method: "POST", body: new ReadableStream({ start(c) { c.close() } }) },
    },
    { name: "FormData body", input: "http://example.test/", init: { method: "POST", body: new FormData() } },
    { name: "Blob body", input: "http://example.test/", init: { method: "POST", body: new Blob(["x"]) } },
    { name: "ArrayBuffer body", input: "http://example.test/", init: { method: "POST", body: new ArrayBuffer(4) } },
    {
      name: "URLSearchParams body",
      input: "http://example.test/",
      init: { method: "POST", body: new URLSearchParams({ a: "1" }) },
    },
    { name: "redirect manual", input: "http://example.test/", init: { redirect: "manual" } },
    { name: "redirect error", input: "http://example.test/", init: { redirect: "error" } },
    { name: "numeric timeout", input: "http://example.test/", init: rawInit({ timeout: 1000 }) },
    { name: "timeout true", input: "http://example.test/", init: rawInit({ timeout: true }) },
    {
      name: "non-string header value",
      input: "http://example.test/",
      init: { headers: { "x-a": 1 } as unknown as Record<string, string> },
    },
  ]

  for (const item of cases) {
    test(`${item.name} delegates untouched, exactly once`, async () => {
      const { fake, fallback, fetchFn } = setup()
      const res = await fetchFn(item.input, item.init)
      expect(await res.text()).toBe("fallback")
      expect(fallback.calls.length).toBe(1)
      expect(fallback.calls[0].input).toBe(item.input)
      expect(fallback.calls[0].init).toBe(item.init)
      expect(fake.calls.start).toBe(0)
    })
  }

  test("an environment proxy delegates even a plain http GET", async () => {
    process.env.HTTP_PROXY = "http://proxy.test:8080"
    const { fake, fallback, fetchFn } = setup()
    const res = await fetchFn("http://example.test/")
    expect(await res.text()).toBe("fallback")
    expect(fallback.calls.length).toBe(1)
    expect(fake.calls.start).toBe(0)
  })

  test("proxy-system lifts env-proxy delegation: the addon handles the env proxy", async () => {
    process.env.HTTP_PROXY = "http://proxy.test:8080"
    const { fake, fetchFn } = setup({ chunks: ["ok"], contract: { capabilities: [...REQUIRED_CAPABILITIES, "proxy-system"] } })
    const res = await fetchFn("http://example.test/")
    expect(await res.text()).toBe("ok")
    expect(fake.calls.start).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Response metadata, duplicates, clone chain, null bodies
// ---------------------------------------------------------------------------

describe("Response surface", () => {
  const head: Partial<HeadersResult> = {
    status: 201,
    statusText: "Created",
    url: "http://example.test/final",
    redirected: true,
    headers: [
      { name: "set-cookie", value: "a=1" },
      { name: "set-cookie", value: "b=2" },
      { name: "content-type", value: "text/plain" },
    ],
  }

  test("status/statusText/url/redirected/type and appended duplicate headers", async () => {
    const { fetchFn } = setup({ head, chunks: ["ok"] })
    const res = await fetchFn("http://example.test/start")
    expect(res.status).toBe(201)
    expect(res.statusText).toBe("Created")
    expect(res.url).toBe("http://example.test/final")
    expect(res.redirected).toBe(true)
    expect(res.type).toBe("basic")
    // get() joins duplicates with ", " — proves append, not set (last-wins).
    expect(res.headers.get("set-cookie")).toBe("a=1, b=2")
    expect(res.headers.get("content-type")).toBe("text/plain")
    expect(await res.text()).toBe("ok")
  })

  test("clone and grandclone keep metadata; native tee/bodyUsed semantics survive", async () => {
    const { fetchFn } = setup({ head, chunks: ["ok"] })
    const res = await fetchFn("http://example.test/start")
    const clone = res.clone()
    const grandclone = clone.clone()
    for (const copy of [clone, grandclone]) {
      expect(copy.url).toBe("http://example.test/final")
      expect(copy.redirected).toBe(true)
      expect(copy.type).toBe("basic")
      expect(copy.status).toBe(201)
    }
    expect(res.bodyUsed).toBe(false)
    expect(await grandclone.text()).toBe("ok")
    expect(grandclone.bodyUsed).toBe(true)
    expect(clone.bodyUsed).toBe(false)
    expect(await res.text()).toBe("ok")
    expect(res.bodyUsed).toBe(true)
  })

  test("204/205/304 and HEAD give a null body and release the handle", async () => {
    for (const status of [204, 205, 304]) {
      const { fake, fetchFn } = setup({ head: { status } })
      const res = await fetchFn("http://example.test/nb")
      expect(res.body).toBeNull()
      expect(res.status).toBe(status)
      expect(fake.calls.release).toEqual([1])
    }
    const { fake, fetchFn } = setup()
    const res = await fetchFn("http://example.test/head", { method: "HEAD" })
    expect(res.body).toBeNull()
    expect(fake.calls.release).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// Streaming (SSE-shaped chunks)
// ---------------------------------------------------------------------------

describe("streaming", () => {
  test("chunks arrive in order with their boundaries, EOF closes and releases", async () => {
    const { fake, fetchFn } = setup({
      head: { headers: [{ name: "content-type", value: "text/event-stream" }] },
      openEnded: true,
    })
    const res = await fetchFn("http://example.test/sse")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    fake.push(1, "data: one\n\n")
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(decoder.decode(first.value)).toBe("data: one\n\n")

    fake.push(1, "data: two\n\n")
    const second = await reader.read()
    expect(decoder.decode(second.value)).toBe("data: two\n\n")

    fake.finish(1)
    expect((await reader.read()).done).toBe(true)
    expect(fake.calls.release).toEqual([1])
  })

  test("pre-scripted chunks concatenate through text()", async () => {
    const { fake, fetchFn } = setup({ chunks: ["Hel", "lo, ", "world"] })
    const res = await fetchFn("http://example.test/text")
    expect(await res.text()).toBe("Hello, world")
    expect(fake.calls.release).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// Abort semantics
// ---------------------------------------------------------------------------

describe("abort", () => {
  test("pre-aborted signal rejects with the original reason identity, before start", async () => {
    const { fake, fallback, fetchFn } = setup()
    const controller = new AbortController()
    const reason = new Error("caller cancelled")
    controller.abort(reason)
    const error = await rejection(fetchFn("http://example.test/", { signal: controller.signal }))
    expect(error).toBe(reason)
    expect(fake.calls.start).toBe(0)
    expect(fallback.calls.length).toBe(0)
  })

  test("abort while headers are pending cancels the handle and rejects with the reason", async () => {
    const { fake, fallback, fetchFn } = setup({ holdHeaders: true })
    const controller = new AbortController()
    const reason = { code: "mid-headers" }
    const pending = fetchFn("http://example.test/", { signal: controller.signal })
    await Bun.sleep(1)
    controller.abort(reason)
    const error = await rejection(pending)
    expect(error).toBe(reason)
    expect(fake.calls.cancel).toEqual([1])
    expect(fake.calls.release).toEqual([1])
    expect(fallback.calls.length).toBe(0)
  })

  test("mid-stream abort rejects the next read with the reason identity and tears down", async () => {
    const { fake, fallback, fetchFn } = setup({ openEnded: true })
    const controller = new AbortController()
    const reason = new Error("mid-stream")
    const res = await fetchFn("http://example.test/sse", { signal: controller.signal })
    const reader = res.body!.getReader()

    fake.push(1, "data: partial\n\n")
    expect((await reader.read()).done).toBe(false)

    controller.abort(reason)
    const error = await rejection(reader.read())
    expect(error).toBe(reason)
    expect(fake.calls.cancel).toEqual([1])
    expect(fake.calls.release).toEqual([1])
    expect(fallback.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Error channel discipline
// ---------------------------------------------------------------------------

describe("error channels", () => {
  test("synchronous startRequest defect counts a pre-send fallback and delegates once", async () => {
    const before = NativeTransportFetch.preSendFallbackCount()
    const { fake, fallback, fetchFn } = setup({ startError: new Error("invalid url") })
    const res = await fetchFn("http://example.test/")
    expect(await res.text()).toBe("fallback")
    expect(fallback.calls.length).toBe(1)
    expect(fake.calls.start).toBe(0)
    expect(NativeTransportFetch.preSendFallbackCount()).toBe(before + 1)
  })

  test("headers-phase failure is TypeError('fetch failed', {cause}) and never falls back", async () => {
    const cause = new Error("connection reset by peer")
    const { fake, fallback, fetchFn } = setup({ headersError: cause })
    const error = await rejection(fetchFn("http://example.test/"))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")
    expect((error as Error).cause).toBe(cause)
    expect(fallback.calls.length).toBe(0)
    expect(fake.calls.release).toEqual([1])
  })

  test("body-phase failure surfaces raw on the stream and never falls back", async () => {
    const cause = new Error("response body failed")
    const { fake, fallback, fetchFn } = setup({ chunks: ["partial"], bodyError: cause })
    const res = await fetchFn("http://example.test/")
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("partial")
    const error = await rejection(reader.read())
    expect(error).toBe(cause)
    expect(fallback.calls.length).toBe(0)
    expect(fake.calls.release).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// Concurrency — pure JS simulation, no hidden adapter cap
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  test("300 concurrent fake requests all start, complete and release (no 64/256-style JS cap)", async () => {
    const { fake, fallback, fetchFn } = setup({ chunks: ["x"] })
    const texts = await Promise.all(
      Array.from({ length: 300 }, (_, i) => fetchFn(`http://example.test/${i}`).then((res) => res.text())),
    )
    expect(texts.length).toBe(300)
    expect(texts.every((text) => text === "x")).toBe(true)
    expect(fake.calls.start).toBe(300)
    // Every request was in flight before any completed: the adapter itself
    // imposes no concurrency ceiling. This is a fake-addon simulation, not a
    // production performance claim.
    expect(fake.peak()).toBe(300)
    expect(fake.live()).toBe(0)
    expect(fake.calls.release.length).toBe(300)
    expect(new Set(fake.calls.release).size).toBe(300)
    expect(fallback.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Review fixes: abort(null) identity, preconnect, single-reader rule, reclaim
// ---------------------------------------------------------------------------

describe("review fixes", () => {
  test("abort(null) rejects with null itself, not a substituted DOMException", async () => {
    const { fake, fetchFn } = setup()
    const controller = new AbortController()
    controller.abort(null)
    const error = await rejection(fetchFn("http://example.test/", { signal: controller.signal }))
    expect(error).toBeNull()
    expect(fake.calls.start).toBe(0)
  })

  test("the wrapper keeps the fallback's bound preconnect", () => {
    const fake = makeFakeAddon()
    NativeTransportLoader.setTransportForTests(fake.addon)
    const seen: Array<{ self: unknown; url: string }> = []
    const base = (async () => new Response("fallback")) as unknown as typeof fetch
    Object.assign(base, {
      preconnect(this: unknown, url: string) {
        seen.push({ self: this, url })
      },
    })
    const fn = NativeTransport.resolveFetch({ enabled: true, fallback: base })
    const preconnect = (fn as unknown as { preconnect?: (url: string) => void }).preconnect
    expect(typeof preconnect).toBe("function")
    preconnect!("http://example.test/")
    expect(seen.length).toBe(1)
    expect(seen[0].self).toBe(base)
    expect(seen[0].url).toBe("http://example.test/")
  })

  test("a second concurrent readBody is refused (crate single-reader rule)", async () => {
    const { fake, fetchFn } = setup({ openEnded: true })
    const res = await fetchFn("http://example.test/sse")
    // The adapter's first pull is already pending inside readBody.
    await expect(fake.addon.readBody(1)).rejects.toThrow("already pending")
    fake.push(1, "data: x\n\n")
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: x\n\n")
  })

  test("idle reclaim of an open stream errors the abandoned body, never falls back, stats observe it", async () => {
    const { fake, fallback, fetchFn } = setup({ openEnded: true })
    const res = await fetchFn("http://example.test/abandoned")
    fake.reclaim(1)
    const reader = res.body!.getReader()
    const error = await rejection(reader.read())
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("released")
    expect(fallback.calls.length).toBe(0)
    expect(fake.addon.stats().idleReclaimedHandles).toBe(1)
    expect(NativeTransport.stats()?.idleReclaimedHandles).toBe(1)
  })

  test("idle reclaim after a small buffered body: first chunk survives, rest errors", async () => {
    const { fake, fallback, fetchFn } = setup({ chunks: ["x"] })
    const res = await fetchFn("http://example.test/small")
    fake.reclaim(1)
    const reader = res.body!.getReader()
    expect((await reader.read()).value).toEqual(encoder.encode("x"))
    const error = await rejection(reader.read())
    expect((error as Error).message).toContain("released")
    expect(fallback.calls.length).toBe(0)
    expect(fake.addon.stats().idleReclaimedHandles).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// configureTls — immutable profile registrar passthrough
// ---------------------------------------------------------------------------

describe("configureTls", () => {
  test("passes the profile through and returns the addon's profile id", () => {
    const seen: unknown[] = []
    const fake = makeFakeAddon()
    NativeTransportLoader.setTransportForTests(
      Object.assign(fake.addon, {
        configureTls(profile: unknown) {
          seen.push(profile)
          return { profileId: 5 }
        },
      }),
    )
    const profile = { caPem: "-----BEGIN CERTIFICATE-----", rejectUnauthorized: false, proxy: "http://proxy.test" }
    expect(NativeTransport.configureTls(profile)).toEqual({ profileId: 5 })
    expect(seen).toEqual([profile])
  })

  test("null-safe when the addon is absent or too old to export configureTls", () => {
    NativeTransportLoader.setTransportForTests(null)
    expect(NativeTransport.configureTls({ caPem: null })).toBeNull()
    NativeTransportLoader.setTransportForTests(makeFakeAddon().addon)
    expect(NativeTransport.configureTls({ caPem: null })).toBeNull()
  })

  test("kill switch returns null without touching the addon", () => {
    process.env.OPENCODE_RUST_TRANSPORT = "0"
    const fake = makeFakeAddon()
    NativeTransportLoader.setTransportForTests(Object.assign(fake.addon, { configureTls: () => ({ profileId: 1 }) }))
    expect(NativeTransport.configureTls({})).toBeNull()
  })
})