import { afterEach, expect, test } from "bun:test"
import {
  DEFAULT_MAX_CONNECTIONS,
  dispose as disposeGates,
  flowKeyOf,
  resolveMaxConnections,
  stats as gateStats,
  wrapFetch,
} from "@/provider/http-limit"
import { GateDisposedError, PermitLeaseExpiredError, QueueOverflowError, QueueWaitTimeoutError } from "@/provider/http-queue"
import { HeaderTimeoutError, timeoutController, withHeaderTimeout } from "@/provider/header-timeout"
import { ResponseMetadata } from "@/provider/response-metadata"
import { wrapSSE } from "@/provider/sse"

const encoder = new TextEncoder()
const previous = process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"]

afterEach(() => {
  if (previous === undefined) delete process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"]
  else process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"] = previous
  // Gate limits are fixed at creation now; clear gates between tests so each
  // test builds its own (hygiene for the new semantics, not an assertion change).
  disposeGates()
})

function delayedResponse(ms: number, onDone: () => void) {
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(ms)
        controller.enqueue(encoder.encode("ok"))
        controller.close()
        onDone()
      },
    }),
  )
}

test("resolveMaxConnections prefers config, then env, then the default", () => {
  delete process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"]
  expect(resolveMaxConnections(8)).toBe(8)
  expect(resolveMaxConnections(undefined)).toBe(DEFAULT_MAX_CONNECTIONS)

  process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"] = "12"
  expect(resolveMaxConnections(undefined)).toBe(12)
  expect(resolveMaxConnections(8)).toBe(8)

  process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"] = "not-a-number"
  expect(resolveMaxConnections(undefined)).toBe(DEFAULT_MAX_CONNECTIONS)
})

test("caps in-flight requests per origin until the body is consumed", async () => {
  let active = 0
  let max = 0
  const fetchFn = async () => {
    active++
    max = Math.max(max, active)
    return delayedResponse(10, () => {
      active--
    })
  }
  const limited = wrapFetch(fetchFn, 2, { mode: "fifo" })

  const results = await Promise.all(
    Array.from({ length: 5 }, () => limited("http://gateway.test/v1/chat").then((res) => res.text())),
  )

  expect(results).toEqual(["ok", "ok", "ok", "ok", "ok"])
  expect(max).toBe(2)
})

test("different origins use independent budgets", async () => {
  let active = 0
  let max = 0
  const fetchFn = async () => {
    active++
    max = Math.max(max, active)
    return delayedResponse(10, () => {
      active--
    })
  }
  const limited = wrapFetch(fetchFn, 1, { mode: "fifo" })

  await Promise.all([
    limited("http://a.test/v1").then((res) => res.text()),
    limited("http://b.test/v1").then((res) => res.text()),
  ])

  expect(max).toBe(2)
})

test("aborting a queued request rejects it without leaking a permit", async () => {
  let releaseFirst!: () => void
  let active = 0
  const fetchFn = async () => {
    active++
    if (active === 1)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            releaseFirst = () => {
              controller.enqueue(encoder.encode("first"))
              controller.close()
              active--
            }
          },
        }),
      )
    active--
    return new Response("second")
  }
  const limited = wrapFetch(fetchFn, 1, { mode: "fifo" })

  const first = limited("http://gateway.test/first")
  const ctrl = new AbortController()
  const second = limited("http://gateway.test/second", { signal: ctrl.signal })
  ctrl.abort()

  await expect(second).rejects.toThrow()
  releaseFirst()
  expect(await (await first).text()).toBe("first")
})

// ---------------------------------------------------------------------------
// H1: config priority — option > env > shared 128 default
// ---------------------------------------------------------------------------

test("resolveMaxConnections: the shared 128 default applies to every channel", () => {
  delete process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"]
  expect(DEFAULT_MAX_CONNECTIONS).toBe(128)
  expect(resolveMaxConnections(undefined)).toBe(128)
  // The caller may still pass a channel-specific default (linux300 uses 300).
  expect(resolveMaxConnections(undefined, 300)).toBe(300)
  // Explicit provider option beats every default.
  expect(resolveMaxConnections(128, 300)).toBe(128)
  expect(resolveMaxConnections(8)).toBe(8)
  // Invalid options fall through to the caller's default.
  expect(resolveMaxConnections(0, 300)).toBe(300)
  expect(resolveMaxConnections(-1, 300)).toBe(300)
  expect(resolveMaxConnections(1.5, 300)).toBe(300)
  expect(resolveMaxConnections("64", 300)).toBe(300)
})

test("resolveMaxConnections: env flag beats the default, option beats env", () => {
  process.env["OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS"] = "256"
  expect(resolveMaxConnections(undefined, 300)).toBe(256)
  expect(resolveMaxConnections(undefined)).toBe(256)
  expect(resolveMaxConnections(8, 300)).toBe(8)
})

// ---------------------------------------------------------------------------
// M1: metadata survives every Response-rebuild layer
// ---------------------------------------------------------------------------

test("response metadata survives a clone chain", () => {
  const res = ResponseMetadata.withMetadata(new Response("ok"), {
    url: "http://x.test/final",
    redirected: true,
    type: "basic",
  })
  const grandclone = res.clone().clone()
  expect(grandclone.url).toBe("http://x.test/final")
  expect(grandclone.redirected).toBe(true)
  expect(grandclone.type).toBe("basic")
})

test("holdResponse carries url/redirected/type through the permit wrapper and its clones", async () => {
  const inner = ResponseMetadata.withMetadata(new Response("ok"), {
    url: "http://gateway.test/final",
    redirected: true,
    type: "basic",
  })
  const limited = wrapFetch(async () => inner, 1, { mode: "fifo" })
  const res = await limited("http://gateway.test/v1")
  expect(res.url).toBe("http://gateway.test/final")
  expect(res.redirected).toBe(true)
  expect(res.type).toBe("basic")
  const clone = res.clone()
  expect(clone.url).toBe("http://gateway.test/final")
  expect(clone.redirected).toBe(true)
  expect(await clone.text()).toBe("ok")
  expect(await res.text()).toBe("ok")
})

test("wrapSSE carries metadata through the watchdog wrapper", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
      controller.close()
    },
  })
  const res = ResponseMetadata.withMetadata(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    { url: "http://gateway.test/sse", redirected: true, type: "basic" },
  )
  const wrapped = wrapSSE(res, 30_000, new AbortController())
  expect(wrapped.url).toBe("http://gateway.test/sse")
  expect(wrapped.redirected).toBe(true)
  expect(wrapped.type).toBe("basic")
  const clone = wrapped.clone()
  expect(clone.url).toBe("http://gateway.test/sse")
  expect(await wrapped.text()).toBe("data: hello\n\n")
})

test("wrapSSE passthrough keeps the original response identity", () => {
  const res = new Response("ok")
  expect(wrapSSE(res, 0, new AbortController())).toBe(res)
  expect(wrapSSE(res, 30_000, new AbortController())).toBe(res)
})

// ---------------------------------------------------------------------------
// CFS wrapper integration: flow keys, ceilings, wait timeout, lease, stats
// ---------------------------------------------------------------------------

function pendingFetch() {
  const calls: Array<{
    input: unknown
    init: any
    signal: AbortSignal | undefined
    resolve: (response: Response) => void
    reject: (error: unknown) => void
  }> = []
  const fn = (input: any, init?: any) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      calls.push({ input, init, signal, resolve, reject })
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  return { fn, calls }
}
const drain = (p: Promise<Response>) => p.then((r) => r.text())
const frozenClock = { now: () => 0 }

test("flowKeyOf: header priority, case-insensitivity, all header shapes, default", () => {
  expect(flowKeyOf(undefined)).toBe("default")
  expect(flowKeyOf({})).toBe("default")
  expect(flowKeyOf({ headers: { "X-Parent-Session-Id": "s1", "x-session-affinity": "s2" } })).toBe("s1")
  expect(flowKeyOf({ headers: { "x-session-affinity": "s2" } })).toBe("s2")
  expect(flowKeyOf({ headers: [["X-SESSION-AFFINITY", "s2"], ["x-parent-session-id", "s1"]] })).toBe("s1")
  expect(flowKeyOf({ headers: new Headers([["x-session-affinity", "s2"]]) })).toBe("s2")
  expect(flowKeyOf({ headers: { "x-parent-session-id": "" } })).toBe("default")
})

test("default mode is cfs: no options yields a cfs gate that schedules per flow", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 2) // no options at all -> CFS is the default
  const p1 = wrapped("http://default-cfs.test/1", { headers: { "x-parent-session-id": "A" } })
  const p2 = wrapped("http://default-cfs.test/2", { headers: { "x-parent-session-id": "B" } })
  const p3 = wrapped("http://default-cfs.test/3", { headers: { "x-parent-session-id": "A" } })
  await Bun.sleep(0)
  const s = gateStats().find((g) => g.origin === "http://default-cfs.test")!
  expect(s.mode).toBe("cfs")
  expect(s.active).toBe(2)
  expect(s.queued).toBe(1)
  expect(s.flows.find((f) => f.key === "A")!.queued).toBe(1)
  expect(s.flows.find((f) => f.key === "B")!.active).toBe(1)
  expect(calls.length).toBe(2)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
  await Bun.sleep(0)
  expect(calls.length).toBe(3) // A's queued request admitted next (per-flow FIFO)
  calls[1].resolve(new Response("ok"))
  calls[2].resolve(new Response("ok"))
  await Promise.all([drain(p2), drain(p3)])
  expect(gateStats().find((g) => g.origin === "http://default-cfs.test")!.active).toBe(0)
})

test("cfs wrapper routes flows by header, stats observe them, per-flow FIFO refills", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 2, { mode: "cfs", tickMs: 0, clock: frozenClock })
  const p1 = wrapped("http://cfs-route.test/1", { headers: { "x-parent-session-id": "A" } })
  const p2 = wrapped("http://cfs-route.test/2", { headers: { "x-parent-session-id": "B" } })
  const p3 = wrapped("http://cfs-route.test/3", { headers: { "x-parent-session-id": "A" } })
  await Bun.sleep(0)
  expect(calls.length).toBe(2)
  const s = gateStats().find((g) => g.origin === "http://cfs-route.test")!
  expect(s.mode).toBe("cfs")
  expect(s.active).toBe(2)
  expect(s.queued).toBe(1)
  expect(s.flows.find((f) => f.key === "A")!.queued).toBe(1)
  expect(s.flows.find((f) => f.key === "B")!.active).toBe(1)

  calls[0].resolve(new Response("ok"))
  await drain(p1)
  await Bun.sleep(0)
  expect(calls.length).toBe(3) // A's queued request admitted next (FIFO within A)
  calls[1].resolve(new Response("ok"))
  calls[2].resolve(new Response("ok"))
  await Promise.all([drain(p2), drain(p3)])
  expect(gateStats().find((g) => g.origin === "http://cfs-route.test")!.active).toBe(0)
})

test("cfs single flow admits in submission order (legacy FIFO parity at the wrapper)", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 2, { mode: "cfs", tickMs: 0, clock: frozenClock })
  const pending = Array.from({ length: 5 }, (_, i) =>
    wrapped(`http://cfs-solo.test/${i}`, { headers: { "x-parent-session-id": "solo" } }),
  )
  await Bun.sleep(0)
  expect(calls.map((c) => c.input)).toEqual(["http://cfs-solo.test/0", "http://cfs-solo.test/1"])
  for (let i = 0; i < 3; i++) {
    calls[i].resolve(new Response("ok"))
    await drain(pending[i])
    await Bun.sleep(0)
  }
  expect(calls.map((c) => c.input)).toEqual([0, 1, 2, 3, 4].map((i) => `http://cfs-solo.test/${i}`))
  calls[3].resolve(new Response("ok"))
  calls[4].resolve(new Response("ok"))
  await Promise.all([drain(pending[3]), drain(pending[4])])
})

test("maxQueueLength rejects pre-send through the wrapper; fetch untouched for the overflow", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "cfs", tickMs: 0, clock: frozenClock, maxQueueLength: 2 })
  const p1 = wrapped("http://cfs-cap.test/1")
  await Bun.sleep(0) // each submit is its own microtask batch (models async fetch calls)
  const p2 = wrapped("http://cfs-cap.test/2")
  await Bun.sleep(0)
  const p3 = wrapped("http://cfs-cap.test/3")
  await Bun.sleep(0)
  const p4 = wrapped("http://cfs-cap.test/4") // queued at the ceiling -> pre-send overflow
  await expect(p4).rejects.toBeInstanceOf(QueueOverflowError)
  expect(calls.length).toBe(1)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
  await Bun.sleep(0)
  calls[1].resolve(new Response("ok"))
  await drain(p2)
  await Bun.sleep(0)
  calls[2].resolve(new Response("ok"))
  await drain(p3)
})

test("queued bytes count UTF-8 (Chinese) through the wrapper", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "cfs", tickMs: 0, clock: frozenClock, maxQueueBytes: 100 })
  const p1 = wrapped("http://cfs-bytes.test/1", { method: "POST", body: "你好" })
  const p2 = wrapped("http://cfs-bytes.test/2", { method: "POST", body: "你好" })
  const p3 = wrapped("http://cfs-bytes.test/3", { method: "POST", body: "你好" })
  await Bun.sleep(0)
  const s = gateStats().find((g) => g.origin === "http://cfs-bytes.test")!
  expect(s.queuedBytes).toBe(12) // two queued x 6 UTF-8 bytes; the active one is not queued
  calls[0].resolve(new Response("ok"))
  await drain(p1)
  await Bun.sleep(0)
  calls[1].resolve(new Response("ok"))
  await drain(p2)
  await Bun.sleep(0)
  calls[2].resolve(new Response("ok"))
  await drain(p3)
  expect(gateStats().find((g) => g.origin === "http://cfs-bytes.test")!.queuedBytes).toBe(0)
})

test("queueWaitTimeout rejects a queued request without ever calling fetch", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "cfs", tickMs: 0, queueWaitTimeoutMs: 25 })
  const p1 = wrapped("http://cfs-wait.test/1")
  const p2 = wrapped("http://cfs-wait.test/2")
  await expect(p2).rejects.toBeInstanceOf(QueueWaitTimeoutError)
  expect(calls.length).toBe(1)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
})

test("abort(null) on a queued cfs request rejects with null itself", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "cfs", tickMs: 0, clock: frozenClock })
  const p1 = wrapped("http://cfs-abort.test/1")
  await Bun.sleep(0)
  const ctl = new AbortController()
  ctl.abort(null)
  const p2 = wrapped("http://cfs-abort.test/2", { signal: ctl.signal })
  const error = await p2.then(() => undefined, (e) => e)
  expect(error).toBeNull()
  calls[0].resolve(new Response("ok"))
  await drain(p1)
})

test("permit lease cancels a pending fetch and frees the permit for the next request", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "fifo", permitLeaseMs: 25 })
  const p1 = wrapped("http://lease-pending.test/1")
  await Bun.sleep(0)
  expect(calls.length).toBe(1)
  await expect(p1).rejects.toBeInstanceOf(PermitLeaseExpiredError)
  const p2 = wrapped("http://lease-pending.test/2")
  await Bun.sleep(0)
  expect(calls.length).toBe(2) // permit was freed, not leaked
  calls[1].resolve(new Response("ok"))
  await drain(p2)
})

test("permit lease frees the permit of a returned-but-unread (abandoned) body", async () => {
  const fn = async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))
  const wrapped = wrapFetch(fn, 1, { mode: "fifo", permitLeaseMs: 25 })
  const res = await wrapped("http://lease-body.test/1") // body never read
  expect(res.body).not.toBeNull()
  await Bun.sleep(50)
  expect(gateStats().find((g) => g.origin === "http://lease-body.test")!.active).toBe(0)
  const p2 = wrapped("http://lease-body.test/2")
  await Bun.sleep(0)
  expect(gateStats().find((g) => g.origin === "http://lease-body.test")!.active).toBe(1)
  void p2
})

test("lease off: init passes through untouched (old behavior)", async () => {
  let seenInit: unknown
  const fn = async (_input: unknown, init?: unknown) => {
    seenInit = init
    return new Response("ok")
  }
  const wrapped = wrapFetch(fn, 1, { mode: "fifo" })
  const init = { headers: { a: "b" } }
  await drain(wrapped("http://lease-off.test/", init))
  expect(seenInit).toBe(init)
})

test("normal body completion clears the lease timer (no late abort)", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "fifo", permitLeaseMs: 30 })
  const p1 = wrapped("http://lease-clear.test/1")
  await Bun.sleep(0)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
  await Bun.sleep(60)
  expect(calls[0].signal?.aborted).toBe(false)
})

test("gate limit is fixed at creation; a conflicting wrapper warns via the hook", async () => {
  const conflicts: Array<[number, number]> = []
  const fn = async () => new Response("ok")
  const hooks = { onLimitConflict: (kept: number, requested: number) => conflicts.push([kept, requested]) }
  const w1 = wrapFetch(fn, 2, { mode: "fifo", hooks })
  const w2 = wrapFetch(fn, 1, { mode: "fifo", hooks })
  await drain(w1("http://limit-conflict.test/1"))
  await drain(w2("http://limit-conflict.test/2"))
  expect(conflicts).toEqual([[2, 1]])
  expect(gateStats().find((g) => g.origin === "http://limit-conflict.test")!.limit).toBe(2)
})

test("gate config conflict warns beyond limit; the creation-time config is kept", async () => {
  const conflicts: Array<[string, string]> = []
  const fn = async () => new Response("ok")
  const hooks = {
    onConfigConflict: (_origin: string, kept: string, requested: string) => conflicts.push([kept, requested]),
  }
  const w1 = wrapFetch(fn, 2, { mode: "cfs", tickMs: 0, clock: frozenClock, hooks, maxQueueLength: 5 })
  const w2 = wrapFetch(fn, 2, { mode: "cfs", tickMs: 0, clock: frozenClock, hooks, maxQueueLength: 9 })
  await drain(w1("http://config-conflict.test/1"))
  await drain(w2("http://config-conflict.test/2"))
  // Same limit (no onLimitConflict), different ceiling -> a config conflict fires.
  expect(conflicts.length).toBe(1)
  expect(gateStats().find((g) => g.origin === "http://config-conflict.test")!.limit).toBe(2)
})

test("dispose rejects queued fifo waiters and empties the management plane", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "fifo" })
  const p1 = wrapped("http://dispose.test/1")
  const p2 = wrapped("http://dispose.test/2")
  await Bun.sleep(0)
  expect(calls.length).toBe(1)
  disposeGates()
  await expect(p2).rejects.toBeInstanceOf(GateDisposedError)
  expect(gateStats()).toEqual([])
  calls[0].resolve(new Response("ok"))
  await drain(p1) // outstanding release is a no-op after dispose
})

// ---------------------------------------------------------------------------
// G1: header deadline starts at permit grant, not at call time
// ---------------------------------------------------------------------------

test("G1: queue wait does not consume the header budget; timing starts when the permit is granted", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "fifo", headerTimeoutMs: 40 })
  const p1 = wrapped("http://g1.test/1")
  await Bun.sleep(0)
  expect(calls.length).toBe(1)
  // p1's headers arrive immediately (clearing its own header budget), but its
  // body stays open under the test's control: the permit is held for the whole
  // body, so p1 neither times out nor frees the permit during p2's queue wait.
  let closeBody!: () => void
  calls[0].resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeBody = () => controller.close()
        },
      }),
    ),
  )
  const d1 = drain(p1) // background consume; completes only when closeBody() runs
  const p2 = wrapped("http://g1.test/2") // headers never arrive (pendingFetch)
  // Queue wait longer than the header budget: p2 must still be alive and
  // its fetch must not have been submitted yet.
  await Bun.sleep(80)
  let p2Settled = false
  void p2.then(
    () => {
      p2Settled = true
    },
    () => {
      p2Settled = true
    },
  )
  await Bun.sleep(0)
  expect(p2Settled).toBe(false)
  expect(calls.length).toBe(1)
  // Close p1's body: the permit is released NOW, p2 is submitted NOW and its
  // header budget starts here. Headers never arrive -> HeaderTimeoutError.
  closeBody()
  await d1
  await Bun.sleep(0)
  expect(calls.length).toBe(2)
  await expect(p2).rejects.toBeInstanceOf(HeaderTimeoutError)
})

test("G1: headerTimeout=false creates no timer at all", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "fifo", headerTimeoutMs: false })
  const p1 = wrapped("http://g1-off.test/1")
  await Bun.sleep(60)
  let settled = false
  void p1.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Bun.sleep(0)
  expect(settled).toBe(false)
  expect(calls.length).toBe(1)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
})

test("G1: the caller/total deadline still covers queue wait (unchanged semantics)", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "fifo", headerTimeoutMs: 5000 })
  const p1 = wrapped("http://g1-total.test/1")
  await Bun.sleep(0)
  const p2 = wrapped("http://g1-total.test/2", { signal: AbortSignal.timeout(30) })
  await expect(p2).rejects.toThrow()
  expect(calls.length).toBe(1)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
})

test("withHeaderTimeout: headers arrival clears the timer; false/undefined are identity", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = withHeaderTimeout(fn, 30)
  const p1 = wrapped("http://ht.test/", {})
  await Bun.sleep(0)
  calls[0].resolve(new Response("ok"))
  await drain(p1)
  await Bun.sleep(60)
  expect(calls[0].signal?.aborted).toBe(false)
  const identity = async () => new Response("ok")
  expect(withHeaderTimeout(identity, false)).toBe(identity)
  expect(withHeaderTimeout(identity, undefined)).toBe(identity)
})

test("withHeaderTimeout: the error path clears the timer and preserves the error", async () => {
  const boom = new Error("upstream broke")
  const fn = async () => {
    throw boom
  }
  const wrapped = withHeaderTimeout(fn, 30)
  await expect(wrapped("http://ht-err.test/", {})).rejects.toBe(boom)
})

test("timeoutController aborts with HeaderTimeoutError; clear stops it", async () => {
  const ctl = timeoutController(20)
  await Bun.sleep(40)
  expect(ctl.signal.aborted).toBe(true)
  expect(ctl.signal.reason).toBeInstanceOf(HeaderTimeoutError)
  const ctl2 = timeoutController(20)
  ctl2.clear()
  await Bun.sleep(40)
  expect(ctl2.signal.aborted).toBe(false)
})

test("G1 (cfs): queue wait does not consume the header budget; timing starts when the permit is granted", async () => {
  const { fn, calls } = pendingFetch()
  const wrapped = wrapFetch(fn, 1, { mode: "cfs", tickMs: 0, clock: frozenClock, headerTimeoutMs: 40 })
  const p1 = wrapped("http://g1-cfs.test/1")
  await Bun.sleep(0) // microtask batch flush grants p1
  expect(calls.length).toBe(1)
  // p1's headers arrive immediately (clearing its own header budget), but its
  // body stays open under the test's control: the CFS permit is held for the
  // whole body, so p1 neither times out nor frees the permit during p2's wait.
  let closeBody!: () => void
  calls[0].resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeBody = () => controller.close()
        },
      }),
    ),
  )
  const d1 = drain(p1) // background consume; completes only when closeBody() runs
  const p2 = wrapped("http://g1-cfs.test/2") // headers never arrive (pendingFetch)
  // Queue wait longer than the header budget: p2 must still be alive and its
  // fetch must not have been submitted yet (no permit -> no header timer).
  await Bun.sleep(80)
  let p2Settled = false
  void p2.then(
    () => {
      p2Settled = true
    },
    () => {
      p2Settled = true
    },
  )
  await Bun.sleep(0)
  expect(p2Settled).toBe(false)
  expect(calls.length).toBe(1)
  // Close p1's body: the CFS permit is released NOW, p2 is submitted NOW and its
  // header budget starts here. Headers never arrive -> HeaderTimeoutError.
  closeBody()
  await d1
  await Bun.sleep(0)
  expect(calls.length).toBe(2)
  await expect(p2).rejects.toBeInstanceOf(HeaderTimeoutError)
})

test("cfs lease frees the permit of a returned-but-unread (abandoned) body", async () => {
  const fn = async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))
  const wrapped = wrapFetch(fn, 1, { mode: "cfs", tickMs: 0, clock: frozenClock, permitLeaseMs: 25 })
  const res = await wrapped("http://cfs-lease-body.test/1") // body never read
  expect(res.body).not.toBeNull()
  // The lease (real 25ms timer) expires: upstream is aborted and the CFS permit
  // is freed even though nobody read the returned body.
  await Bun.sleep(50)
  expect(gateStats().find((g) => g.origin === "http://cfs-lease-body.test")!.active).toBe(0)
  const p2 = wrapped("http://cfs-lease-body.test/2")
  await Bun.sleep(0)
  expect(gateStats().find((g) => g.origin === "http://cfs-lease-body.test")!.active).toBe(1)
  void p2
})
