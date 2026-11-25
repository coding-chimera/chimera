/**
 * Real-addon 300-concurrent acceptance fixture for the native transport
 * (8575C acceptance evidence). Runs ONLY on Linux with an explicit opt-in
 * (OPENCODE_RUST_TRANSPORT_LINUX300=1) and a loadable chimera-transport
 * prebuild; everywhere else every test is skipped.
 *
 * The fixture is a local Bun.serve on 127.0.0.1 (test runtime only — no
 * production gateway, no process pool, no new framework). It verifies:
 *   - peak server-side in-flight = 300 (no hidden 64/256-style cap anywhere
 *     in the JS adapter or the addon),
 *   - all 300 SSE-style streamed responses arrive complete and in order,
 *   - a 300-stream cancel storm drains addon handles back to zero,
 *   - buffered bytes stay bounded by 300 x the crate's 256 KiB per-stream
 *     ceiling while nobody reads the bodies.
 * Wall clock, RSS, addon stats and event-loop lag are emitted as structured
 * JSON for the acceptance record. macOS/other-platform results are never
 * produced by this file (it skips), so nothing here is a production claim
 * by itself.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import { NativeTransportFetch } from "@/provider/sdk/native-transport/fetch"
import { HttpLimit } from "@/provider/http-limit"
import os from "os"

const RUN = process.platform === "linux" && process.env.OPENCODE_RUST_TRANSPORT_LINUX300 === "1"
const it = RUN ? test : test.skip

const STREAMS = 300
/** Optional CFS variant (OPENCODE_RUST_TRANSPORT_LINUX300_CFS=1): limit 220,
 *  cfs mode, two alternating session flows. Env unset = the original
 *  300-permit measurement, semantically unchanged. */
const CFS = process.env.OPENCODE_RUST_TRANSPORT_LINUX300_CFS === "1"
const LIMIT = CFS ? 220 : STREAMS

function reqInit(i: number): { headers: Record<string, string> } | undefined {
  return CFS ? { headers: { "x-parent-session-id": i % 2 === 0 ? "even" : "odd" } } : undefined
}
/** Crate buffer.rs DEFAULT_BUFFER_CAPACITY — the per-stream byte ceiling. */
const PER_STREAM_BUFFER_CAP = 256 * 1024

// ---------------------------------------------------------------------------
// Env hygiene — the adapter delegates when a proxy env is set, and the kill
// switch would silently turn this into a Bun-fetch measurement.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "OPENCODE_RUST_TRANSPORT",
  "OPENCODE_RUST_TRANSPORT_IDLE_READER_TIMEOUT_MS",
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
  // Sibling fake-addon tests share this process; force a fresh REAL load.
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** The real native data plane — fails loudly when the opt-in has no addon. */
function nativeFetch() {
  const contract = NativeTransport.contractInfo()
  if (!contract)
    throw new Error(
      "OPENCODE_RUST_TRANSPORT_LINUX300=1 requires a loadable chimera-transport prebuild " +
        "(stage it with packages/chimera/script/build-transport.sh or set OPENCODE_RUST_TRANSPORT_PATH)",
    )
  if (contract.abiMinor < 1 || !contract.capabilities.includes("idle-reclaim"))
    throw new Error("linux300 requires the idle-reclaim addon contract (abiMinor >= 1) — rebuild the prebuild")
  const fn = NativeTransport.resolveFetch({ enabled: true, fallback: fetch })
  if (fn === fetch) throw new Error("resolveFetch returned the Bun fallback despite a loaded addon")
  return CFS ? HttpLimit.wrapFetch(fn, 220, { mode: "cfs" }) : HttpLimit.wrapFetch(fn, 300, { mode: "fifo" })
}

// ---------------------------------------------------------------------------
// Local SSE-style fixture (backpressured: one chunk per pull, so server-side
// memory stays small and TCP backpressure reaches the crate's bounded queue)
// ---------------------------------------------------------------------------

function chunkText(id: number, i: number, padBytes: number) {
  return `data: {"s":${id},"i":${i},"pad":"${padBytes > 0 ? "x".repeat(padBytes) : ""}"}\n\n`
}

function expectedText(id: number, chunks: number, padBytes = 0) {
  return Array.from({ length: chunks }, (_, i) => chunkText(id, i, padBytes)).join("")
}

function startFixture(opts: { chunks: number; delayMs: number; padBytes?: number }) {
  let active = 0
  let peak = 0
  let completed = 0
  let cancelled = 0
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      active++
      peak = Math.max(peak, active)
      const id = Number(new URL(req.url).pathname.slice(1))
      let settled = false
      const settle = (kind: "completed" | "cancelled") => {
        if (settled) return
        settled = true
        active--
        if (kind === "completed") completed++
        else cancelled++
      }
      let i = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (i >= opts.chunks) {
              controller.close()
              settle("completed")
              return
            }
            if (opts.delayMs > 0) await Bun.sleep(opts.delayMs)
            controller.enqueue(encoder.encode(chunkText(id, i, opts.padBytes ?? 0)))
            i++
          } catch {
            settle("cancelled")
          }
        },
        cancel() {
          settle("cancelled")
        },
      })
      req.signal.addEventListener("abort", () => settle("cancelled"))
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: (id: number) => `http://127.0.0.1:${server.port}/${id}`,
    peak: () => peak,
    active: () => active,
    completed: () => completed,
    cancelled: () => cancelled,
    stop: () => server.stop(true),
  }
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(10)
  }
}

/** Event-loop lag probe: a 10ms setTimeout chain measuring actual drift. */
function startLagProbe() {
  let max = 0
  let sum = 0
  let samples = 0
  let stopped = false
  const tick = () => {
    if (stopped) return
    const started = performance.now()
    setTimeout(() => {
      const lag = Math.max(0, performance.now() - started - 10)
      max = Math.max(max, lag)
      sum += lag
      samples++
      tick()
    }, 10)
  }
  tick()
  return {
    stop: () => {
      stopped = true
    },
    result: () => ({ maxMs: Number(max.toFixed(2)), meanMs: Number((samples ? sum / samples : 0).toFixed(2)), samples }),
  }
}

function report(phase: string, data: Record<string, unknown>) {
  console.log(
    `[native-transport-linux300] ${JSON.stringify({
      phase,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      contract: NativeTransport.contractInfo(),
      ...data,
    })}`,
  )
}

// ---------------------------------------------------------------------------
// v1.2 contract — TLS profile registrar on the real addon
// ---------------------------------------------------------------------------

it("v1.2 contract advertises tls and configureTls issues monotonic profile ids", () => {
  const contract = NativeTransport.contractInfo()
  if (!contract) throw new Error("nativeFetch() must run first to load the real addon")
  expect(contract.abiMinor).toBeGreaterThanOrEqual(2)
  expect(contract.capabilities).toContain("tls")
  expect(contract.capabilities).toContain("proxy-system")
  const first = NativeTransport.configureTls({ rejectUnauthorized: false })
  const second = NativeTransport.configureTls({ serverName: "example.test" })
  expect(first?.profileId).toBeGreaterThan(0)
  expect(second!.profileId).toBeGreaterThan(first!.profileId)
})

// ---------------------------------------------------------------------------
// Acceptance phases
// ---------------------------------------------------------------------------

it("300 concurrent SSE streams: peak in-flight 300, all complete, no hidden cap", async () => {
  const fx = startFixture({ chunks: 6, delayMs: 8 })
  const probe = startLagProbe()
  const rssBefore = process.memoryUsage().rss
  const started = performance.now()
  try {
    const fn = nativeFetch()
    const fallbackBefore = NativeTransportFetch.preSendFallbackCount()
    expect(NativeTransport.stats()?.workerThreads).toBe(expectedWorkerThreads())
    let texts: string[]
    if (CFS) {
      // limit 220 < 300: drain bodies as headers arrive so permits recycle;
      // the two-step headers-then-texts form would deadlock on the queued 80.
      texts = await Promise.all(
        Array.from({ length: STREAMS }, (_, i) => fn(fx.url(i), reqInit(i)).then((res) => res.text())),
      )
    } else {
      const responses = await Promise.all(Array.from({ length: STREAMS }, (_, i) => fn(fx.url(i), reqInit(i))))
      // Real-native proof mid-phase: every addon handle is live simultaneously.
      expect(NativeTransport.stats()?.activeHandles).toBe(STREAMS)
      texts = await Promise.all(responses.map((res) => res.text()))
    }
    const wallMs = performance.now() - started

    texts.forEach((text, i) => expect(text).toBe(expectedText(i, 6)))
    // Every request was simultaneously in flight on the server: neither the
    // JS adapter nor the addon serialized them behind a 64/256-style cap.
    expect(fx.peak()).toBe(LIMIT)
    // Permit-release probe: one more request through the SAME HttpLimit gate
    // and origin completes only if every permit was returned.
    const probeRes = await fn(fx.url(STREAMS), reqInit(STREAMS))
    expect(probeRes.status).toBe(200)
    await probeRes.text()
    expect(NativeTransportFetch.preSendFallbackCount() - fallbackBefore).toBe(0)
    expect(fx.completed()).toBe(STREAMS + 1)
    await waitFor(() => fx.active() === 0)
    await waitFor(() => NativeTransport.stats()?.activeHandles === 0)

    report("complete-300", {
      wallMs: Number(wallMs.toFixed(1)),
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      peakInFlight: fx.peak(),
      completed: fx.completed(),
      stats: NativeTransport.stats(),
      lag: probe.result(),
    })
  } finally {
    probe.stop()
    fx.stop()
  }
})

it("cancel storm: 300 mid-stream aborts reject with the reason and drain handles to zero", async () => {
  const fx = startFixture({ chunks: 200, delayMs: 10 })
  const probe = startLagProbe()
  const rssBefore = process.memoryUsage().rss
  const started = performance.now()
  try {
    const fn = nativeFetch()
    const controller = new AbortController()
    const reason = new Error("linux300 cancel storm")
    const fallbackBefore = NativeTransportFetch.preSendFallbackCount()
    const responses: Response[] = []
    const queueRejects: unknown[] = []
    const early = Array.from({ length: STREAMS }, (_, i) =>
      fn(fx.url(i), { ...reqInit(i), signal: controller.signal }).then(
        (res) => {
          responses.push(res)
        },
        (error) => {
          queueRejects.push(error)
        },
      ),
    )
    await waitFor(() => responses.length >= LIMIT)
    expect(NativeTransport.stats()?.activeHandles).toBe(LIMIT)
    expect(NativeTransport.stats()?.workerThreads).toBe(expectedWorkerThreads())
    const readers = responses.map((res) => res.body!.getReader())
    // Mid-stream: consume one chunk from every stream before aborting.
    await Promise.all(readers.map((reader) => reader.read()))
    controller.abort(reason)

    // Buffered chunks may still hand out once; keep reading until the
    // terminal error — it must be the caller's reason, identity intact.
    const outcomes = await Promise.allSettled(
      readers.map(async (reader) => {
        for (;;) {
          const part = await reader.read()
          if (part.done) return
        }
      }),
    )
    const wallMs = performance.now() - started
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected")
      expect((outcome as PromiseRejectedResult).reason).toBe(reason)
    }
    await Promise.all(early)
    expect(responses.length).toBe(LIMIT)
    expect(queueRejects.length).toBe(STREAMS - LIMIT)
    for (const rejected of queueRejects) expect(rejected).toBe(reason)
    await waitFor(() => NativeTransport.stats()?.activeHandles === 0)
    await waitFor(() => fx.active() === 0)
    expect(fx.cancelled()).toBe(LIMIT)
    const probeRes = await fn(fx.url(STREAMS), reqInit(STREAMS))
    expect(probeRes.status).toBe(200)
    await probeRes.text()
    expect(NativeTransportFetch.preSendFallbackCount() - fallbackBefore).toBe(0)

    report("cancel-storm-300", {
      wallMs: Number(wallMs.toFixed(1)),
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      cancelled: fx.cancelled(),
      stats: NativeTransport.stats(),
      lag: probe.result(),
    })
  } finally {
    probe.stop()
    fx.stop()
  }
})

it("buffered bytes stay bounded by 300 x 256KiB while 300 bodies are unread, then drain complete", async () => {
  // ~2MiB per stream, far above the 256KiB per-stream ceiling: the crate
  // must turn the unread bodies into TCP backpressure, not memory growth.
  const fx = startFixture({ chunks: 128, delayMs: 0, padBytes: 16_000 })
  const probe = startLagProbe()
  const rssBefore = process.memoryUsage().rss
  const started = performance.now()
  try {
    const fn = nativeFetch()
    const fallbackBefore = NativeTransportFetch.preSendFallbackCount()
    const responses: Response[] = []
    const pending = Array.from({ length: STREAMS }, (_, i) =>
      fn(fx.url(i), reqInit(i)).then((res) => {
        responses.push(res)
        return res
      }),
    )
    await waitFor(() => responses.length >= LIMIT)
    // Nobody reads the bodies; let the network tasks fill the bounded queues.
    await Bun.sleep(300)
    const saturated = NativeTransport.stats()
    expect(saturated?.activeHandles).toBe(LIMIT)
    expect(saturated!.bufferedBytes).toBeGreaterThan(0)
    expect(saturated!.bufferedBytes).toBeLessThanOrEqual(LIMIT * PER_STREAM_BUFFER_CAP)
    const rssSaturated = process.memoryUsage().rss

    const texts = await Promise.all(pending.map((p) => p.then((res) => res.text())))
    const wallMs = performance.now() - started
    texts.forEach((text, i) => expect(text).toBe(expectedText(i, 128, 16_000)))
    const probeRes = await fn(fx.url(STREAMS), reqInit(STREAMS))
    expect(probeRes.status).toBe(200)
    await probeRes.text()
    expect(NativeTransportFetch.preSendFallbackCount() - fallbackBefore).toBe(0)
    await waitFor(() => NativeTransport.stats()?.activeHandles === 0)
    await waitFor(() => fx.active() === 0)
    expect(fx.completed()).toBe(STREAMS + 1)

    report("bounded-buffer-300", {
      wallMs: Number(wallMs.toFixed(1)),
      rssBefore,
      rssSaturated,
      rssAfter: process.memoryUsage().rss,
      bufferedBytesSaturated: saturated!.bufferedBytes,
      bufferCeiling: LIMIT * PER_STREAM_BUFFER_CAP,
      completed: fx.completed(),
      stats: NativeTransport.stats(),
      lag: probe.result(),
    })
  } finally {
    probe.stop()
    fx.stop()
  }
})

/** The crate sizes its runtime from the env override or availableParallelism
 *  (runtime.rs worker_threads) — the stats gauge must match exactly. */
function expectedWorkerThreads() {
  const raw = process.env.OPENCODE_RUST_TRANSPORT_WORKER_THREADS
  const parsed = raw ? Number(raw.trim()) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : os.availableParallelism()
}