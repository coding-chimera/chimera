/**
 * CFS scheduler core tests — fake permits + controllable clock, no services,
 * no real fetch. Covers the confirmed design: exact weighted admission (batch
 * flush), permit-time fairness, work conservation, wakeup clamp bounds,
 * per-flow FIFO, seeded-random terminal invariants, queue ceilings, idle-flow
 * reclamation and dispose.
 *
 * Submit defers the grant scan to a microtask batch, so synchronous submit
 * bursts call sched.flush() at the batch end to run the weighted allocation
 * deterministically (the microtask would otherwise fire after the test body).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { CfsScheduler, type CfsOptions } from "@/provider/http-cfs"
import { GateDisposedError, QueueOverflowError, QueueWaitTimeoutError, bodyBytes } from "@/provider/http-queue"

function makeClock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

const scheds: CfsScheduler[] = []
function makeSched(opts: CfsOptions) {
  const sched = new CfsScheduler({ tickMs: 0, ...opts })
  scheds.push(sched)
  return sched
}
afterEach(() => {
  for (const sched of scheds.splice(0)) sched.dispose()
})

type Grant = { flow: string; id: number; release: () => void; released: boolean }
function harness(sched: CfsScheduler) {
  const grants: Grant[] = []
  const rejects: Array<{ flow: string; id: number; error: unknown }> = []
  let seq = 0
  const submit = (flow: string, bytes = 0, signal: AbortSignal | null = null) => {
    const id = seq++
    sched.submit(
      flow,
      bytes,
      signal,
      (release) => grants.push({ flow, id, release, released: false }),
      (error) => rejects.push({ flow, id, error }),
    )
    return id
  }
  const liveGrants = (flow?: string) => grants.filter((g) => !g.released && (flow === undefined || g.flow === flow))
  const releaseFlow = (flow: string, n: number) => {
    let done = 0
    for (const g of grants) {
      if (done >= n) break
      if (g.flow === flow && !g.released) {
        g.released = true
        g.release()
        done++
      }
    }
    return done
  }
  return { grants, rejects, submit, liveGrants, releaseFlow }
}

const flowOf = (sched: CfsScheduler, key: string) => sched.stats().flows.find((f) => f.key === key)!

describe("weighted admission (frozen clock, batch flush, exact counts)", () => {
  test("equal weights A300+B100 limit220: initial active A120/B100, queue A180/B0, per-flow FIFO", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 220, clock })
    const h = harness(sched)
    for (let i = 0; i < 100; i++) {
      h.submit("A")
      h.submit("B")
    }
    for (let i = 0; i < 200; i++) h.submit("A")
    sched.flush() // one weighted scan with both queues full

    const s = sched.stats()
    expect(s.active).toBe(220)
    expect(s.queued).toBe(180)
    expect(flowOf(sched, "A").active).toBe(120)
    expect(flowOf(sched, "B").active).toBe(100)
    expect(flowOf(sched, "A").queued).toBe(180)
    expect(flowOf(sched, "B").queued).toBe(0)

    // Within-flow FIFO: A's granted ids are its submission prefix. Interleaved
    // arrival gives A the even ids 0,2,..,198 (100 grants while B is runnable);
    // once B's 100 are exhausted the remaining 20 permits go to A's sequential
    // tail 200..219 — NOT all-even to 238. The next A release admits id 220.
    const aGrants = h.grants.filter((g) => g.flow === "A").map((g) => g.id)
    const expectedA = [...Array.from({ length: 100 }, (_, i) => i * 2), ...Array.from({ length: 20 }, (_, i) => 200 + i)]
    expect(aGrants).toEqual(expectedA)
    h.releaseFlow("A", 1)
    const aGrants2 = h.grants.filter((g) => g.flow === "A").map((g) => g.id)
    expect(aGrants2).toEqual([...expectedA, 220])
    expect(sched.stats().active).toBe(220)
  })

  test("weights A:B=2:1 limit220: exact initial 146/74, remaining A154/B26", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 220, clock, weights: { A: 2048, B: 1024 } })
    const h = harness(sched)
    for (let i = 0; i < 100; i++) {
      h.submit("A")
      h.submit("B")
    }
    for (let i = 0; i < 200; i++) h.submit("A")
    sched.flush() // weights now shape the first allocation (both queues full)

    expect(flowOf(sched, "A").active).toBe(146)
    expect(flowOf(sched, "B").active).toBe(74)
    expect(flowOf(sched, "A").queued).toBe(154)
    expect(flowOf(sched, "B").queued).toBe(26)
    expect(sched.stats().active).toBe(220)
  })
})

describe("permit-time fairness and work conservation", () => {
  test("2:1 permit-time integral while both runnable; A fills 220 after B exits", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 220, clock, weights: { A: 2048, B: 1024 } })
    const h = harness(sched)
    for (let i = 0; i < 100; i++) {
      h.submit("A")
      h.submit("B")
    }
    for (let i = 0; i < 200; i++) h.submit("A")
    sched.flush()

    // Sustained runnable phase: advance the clock, retire permits 2:1 and
    // resubmit the same amounts so both flows stay runnable throughout.
    for (let round = 0; round < 6; round++) {
      clock.advance(50)
      sched.settle()
      h.releaseFlow("A", 20)
      h.releaseFlow("B", 10)
      for (let i = 0; i < 20; i++) h.submit("A")
      for (let i = 0; i < 10; i++) h.submit("B")
      sched.flush()
    }
    clock.advance(50)
    const ratio = flowOf(sched, "A").grantedPermitTimeMs / flowOf(sched, "B").grantedPermitTimeMs
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(2.2)

    // B exits: drain every B permit; freed capacity must go to A (work
    // conserving) until A alone holds all 220.
    for (;;) {
      const liveB = h.liveGrants("B")
      if (liveB.length === 0) break
      for (const g of liveB) {
        g.released = true
        g.release()
      }
    }
    const s = sched.stats()
    expect(s.active).toBe(220)
    expect(flowOf(sched, "B").active).toBe(0)
    expect(flowOf(sched, "A").active).toBe(220)
  })

  test("F2: release accrues the final permit-time segment without a manual settle", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 1, clock })
    const h = harness(sched)
    h.submit("A")
    sched.flush() // granted at t0; lastSettle = t0
    clock.advance(100) // t=100, NO settle/stats in between
    h.releaseFlow("A", 1) // release settles FIRST (active still 1) then decrements
    const f = flowOf(sched, "A")
    expect(f.grantedPermitTimeMs).toBe(100) // the final 100ms segment was counted
    expect(f.active).toBe(0)
  })
})

describe("flow lifecycle: new flows, wakeup credit, maxDebt", () => {
  test("a new flow starts at min_vruntime and is granted on the next release", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 4, clock, wakeupCreditMs: 10, maxDebtMs: 20 })
    const h = harness(sched)
    for (let i = 0; i < 8; i++) h.submit("A")
    sched.flush()
    clock.advance(1000)
    const minBefore = sched.stats().minVruntime
    expect(minBefore).toBeGreaterThan(0)

    h.submit("C")
    expect(flowOf(sched, "C").vruntime).toBe(minBefore)
    expect(flowOf(sched, "C").active).toBe(0)
    h.releaseFlow("A", 1)
    expect(h.liveGrants("C").length).toBe(1)
  })

  test("waking flow is clamped to [min-credit, min+maxDebt]; credit does not monopolize", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 2, clock, wakeupCreditMs: 10, maxDebtMs: 20 })
    const h = harness(sched)
    h.submit("D")
    h.submit("D")
    sched.flush()
    clock.advance(500)
    sched.settle()
    h.releaseFlow("D", 2) // D goes idle with an old, low vruntime
    h.submit("A")
    h.submit("A")
    h.submit("A") // third A waiter so releases have A work to refill
    sched.flush()
    clock.advance(500)
    const min = sched.stats().minVruntime

    h.submit("D") // wake: old vruntime far below min-credit
    const d = flowOf(sched, "D")
    expect(d.vruntime).toBeGreaterThanOrEqual(min - 10)
    expect(d.vruntime).toBeLessThanOrEqual(min + 20)

    // Credit gives D one bounded head start, then A keeps its share.
    h.releaseFlow("A", 1)
    expect(h.liveGrants("D").length).toBe(1)
    h.releaseFlow("A", 1)
    expect(h.liveGrants("A").length).toBe(1)
  })

  test("maxDebt bounds how far behind a waking flow is parked (no long starvation)", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 1, clock, wakeupCreditMs: 0, maxDebtMs: 20, admissionGranularityMs: 1 })
    const h = harness(sched)
    h.submit("E")
    sched.flush()
    clock.advance(10)
    h.releaseFlow("E", 1) // E idle at vruntime ~1
    for (let i = 0; i < 5; i++) h.submit("A")
    sched.flush()
    clock.advance(1000) // A's vruntime and min_vruntime run far ahead
    const min = sched.stats().minVruntime
    expect(min).toBeGreaterThan(500)

    h.submit("E")
    expect(flowOf(sched, "E").vruntime).toBeLessThanOrEqual(min + 20)
    // Within maxDebt/granularity + 1 releases E must be admitted again.
    let admitted = false
    for (let i = 0; i < 25 && !admitted; i++) {
      h.releaseFlow("A", 1)
      h.submit("A")
      admitted = h.liveGrants("E").length > 0
    }
    expect(admitted).toBe(true)
  })

  test("F1: a PARKED low-vruntime flow does not drag min_vruntime; new flows start at the runnable floor", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 3, clock, wakeupCreditMs: 0, maxDebtMs: 100000 })
    const h = harness(sched)
    for (let i = 0; i < 10; i++) h.submit("R")
    sched.flush() // R holds all 3 permits, 7 queued (runnable)
    clock.advance(1000)
    sched.settle()
    h.submit("P")
    sched.flush() // active full; P queued at the runnable floor
    h.releaseFlow("R", 1) // P admitted (lower seq), P now PARKED with a low vruntime
    expect(flowOf(sched, "P").state).toBe("parked")
    clock.advance(1000)
    sched.settle()
    const rV = flowOf(sched, "R").vruntime
    const pV = flowOf(sched, "P").vruntime
    expect(pV).toBeLessThan(rV) // P parked below the runnable pack
    const min = sched.stats().minVruntime
    expect(min).toBe(rV) // F1: floor tracks runnable R, NOT parked P
    h.submit("N")
    expect(flowOf(sched, "N").vruntime).toBe(min) // new flow at the runnable floor, no monopoly
  })

  test("a new flow wins an exact vruntime tie over an older flow (longest-unserved first)", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 1, clock })
    const h = harness(sched)
    h.submit("A")
    h.submit("A")
    sched.flush() // A active (seq 1), one A queued; min_vruntime = A.vruntime
    h.submit("Z") // new flow at min_vruntime: exact tie, and "Z" sorts AFTER "A"
    expect(flowOf(sched, "Z").vruntime).toBe(flowOf(sched, "A").vruntime)
    h.releaseFlow("A", 1)
    // lastGrantSeq 0 (never served) beats A's older grant — key order must not
    // let the old flow win the tie (the flowKey-first regression).
    expect(h.liveGrants("Z").length).toBe(1)
  })
})

describe("FIFO within a flow", () => {
  test("single flow grants follow submission order exactly (legacy FIFO parity)", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 3, clock })
    const h = harness(sched)
    for (let i = 0; i < 10; i++) h.submit("solo")
    sched.flush()
    expect(h.grants.map((g) => g.id)).toEqual([0, 1, 2])
    for (let next = 3; next < 10; next++) {
      const oldest = h.liveGrants("solo")[0]
      oldest.released = true
      oldest.release()
      expect(h.grants.map((g) => g.id)).toEqual(Array.from({ length: next + 1 }, (_, i) => i))
    }
  })
})

describe("seeded random churn: terminal invariants", () => {
  test("random submits/releases/aborts end at zero active/queued/bytes; min_vruntime monotonic", () => {
    function mulberry32(seed: number) {
      return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const rand = mulberry32(42)
    const clock = makeClock()
    const sched = makeSched({ limit: 8, clock, maxQueueLength: 100 })
    const h = harness(sched)
    const controllers: AbortController[] = []
    let minSeen = 0

    for (let i = 0; i < 400; i++) {
      const op = rand()
      if (op < 0.5) {
        const flow = ["A", "B", "C", "D"][Math.floor(rand() * 4)]
        const ctl = new AbortController()
        controllers.push(ctl)
        h.submit(flow, Math.floor(rand() * 64), ctl.signal)
      } else if (op < 0.8) {
        const live = h.liveGrants()
        if (live.length > 0) {
          const g = live[Math.floor(rand() * live.length)]
          g.released = true
          g.release()
          if (rand() < 0.2) g.release() // idempotent double release
        }
      } else {
        const ctl = controllers[Math.floor(rand() * controllers.length)]
        if (ctl) ctl.abort(new Error("random abort"))
      }
      clock.advance(Math.floor(rand() * 5))
      sched.flush()
      const s = sched.stats()
      expect(s.minVruntime).toBeGreaterThanOrEqual(minSeen)
      minSeen = s.minVruntime
      expect(s.active).toBeLessThanOrEqual(8)
    }

    // Drain to a true terminal state: release every live permit, abort every
    // queued waiter, flush — repeat until nothing is active or queued. A grant
    // is NOT auto-cancelled by its signal (the real fetch wrapper handles that),
    // so granted permits must be drained explicitly rather than assumed gone.
    for (;;) {
      const live = h.liveGrants()
      if (live.length === 0 && sched.stats().queued === 0) break
      for (const g of live) {
        g.released = true
        g.release()
      }
      for (const ctl of controllers) ctl.abort(new Error("terminal"))
      sched.flush()
    }
    const s = sched.stats()
    expect(s.active).toBe(0)
    expect(s.queued).toBe(0)
    expect(s.queuedBytes).toBe(0)
    for (const f of s.flows) {
      expect(f.active).toBe(0)
      expect(f.queued).toBe(0)
      expect(f.queuedBytes).toBe(0)
    }
  })
})

describe("queue ceilings, byte accounting, wait timeout, dispose", () => {
  test("maxQueueLength rejects pre-send with QueueOverflowError(count)", () => {
    const sched = makeSched({ limit: 1, clock: makeClock(), maxQueueLength: 2 })
    const h = harness(sched)
    h.submit("A")
    sched.flush()
    h.submit("A")
    sched.flush()
    h.submit("A")
    sched.flush()
    h.submit("A") // queued already at the ceiling -> pre-send overflow
    expect(h.grants.length).toBe(1)
    expect(sched.stats().queued).toBe(2)
    expect(h.rejects.length).toBe(1)
    expect(h.rejects[0].error).toBeInstanceOf(QueueOverflowError)
    expect((h.rejects[0].error as QueueOverflowError).kind).toBe("count")
  })

  test("maxQueueBytes and perFlowQueueBytes reject pre-send; every dequeue refunds bytes", () => {
    const sched = makeSched({ limit: 1, clock: makeClock(), maxQueueBytes: 10, perFlowQueueBytes: 8 })
    const h = harness(sched)
    h.submit("A", 6) // granted (active, not queued)
    sched.flush()
    h.submit("A", 5) // queued: 5 <= 10 global, 5 <= 8 flow
    sched.flush()
    h.submit("A", 6) // 5+6 > 10 global
    expect((h.rejects[0].error as QueueOverflowError).kind).toBe("bytes")
    h.submit("B", 6) // other flow: 6 <= 8 flow, 5+6 > 10 global still
    expect((h.rejects[1].error as QueueOverflowError).kind).toBe("bytes")
    expect(sched.stats().queuedBytes).toBe(5)

    const ctl = new AbortController()
    h.submit("B", 2, ctl.signal) // queued: global 5+2<=10, flow B 2<=8
    sched.flush()
    expect(sched.stats().queuedBytes).toBe(7)
    ctl.abort(new Error("drop")) // abort refunds B's 2 bytes
    expect(sched.stats().queuedBytes).toBe(5)
    // B's waiter was aborted above, so A's 5-byte waiter is the ONLY one queued;
    // releasing A's active permit admits it and queuedBytes drops straight to 0.
    h.releaseFlow("A", 1)
    expect(sched.stats().queuedBytes).toBe(0)
    expect(sched.stats().flows.find((f) => f.key === "A")!.queuedBytes).toBe(0)
  })

  test("per-flow ceiling is independent per flow", () => {
    const sched = makeSched({ limit: 1, clock: makeClock(), perFlowQueueBytes: 8 })
    const h = harness(sched)
    h.submit("A", 6) // granted
    sched.flush()
    h.submit("A", 6) // queued 6 <= 8
    sched.flush()
    h.submit("A", 3) // 6+3 > 8 flow-bytes
    expect((h.rejects[0].error as QueueOverflowError).kind).toBe("flow-bytes")
    h.submit("B", 6) // B has its own budget
    sched.flush()
    expect(sched.stats().queued).toBe(2)
  })

  test("bodyBytes counts UTF-8 for strings and byteLength for Uint8Array", () => {
    expect(bodyBytes("你好")).toBe(6)
    expect(bodyBytes("abc")).toBe(3)
    expect(bodyBytes(new Uint8Array(7))).toBe(7)
    expect(bodyBytes(undefined)).toBe(0)
    expect(bodyBytes(null)).toBe(0)
  })

  test("queueWaitTimeoutMs rejects a queued waiter without a grant", async () => {
    const sched = makeSched({ limit: 1, clock: makeClock(), queueWaitTimeoutMs: 20 })
    const h = harness(sched)
    h.submit("A")
    h.submit("A")
    sched.flush()
    await Bun.sleep(40)
    expect(h.rejects.length).toBe(1)
    expect(h.rejects[0].error).toBeInstanceOf(QueueWaitTimeoutError)
    expect(sched.stats().queued).toBe(0)
    expect(sched.stats().active).toBe(1)
  })

  test("dispose rejects queued waiters, refuses new submits, zeroes state", () => {
    const sched = makeSched({ limit: 1, clock: makeClock() })
    const h = harness(sched)
    h.submit("A")
    sched.flush()
    h.submit("A")
    sched.flush()
    sched.dispose()
    expect(h.rejects.length).toBe(1)
    expect(h.rejects[0].error).toBeInstanceOf(GateDisposedError)
    h.submit("A")
    expect(h.rejects.length).toBe(2)
    expect(h.rejects[1].error).toBeInstanceOf(GateDisposedError)
    const s = sched.stats()
    expect(s.active).toBe(0)
    expect(s.queued).toBe(0)
  })

  test("PARKED flow (queue empty, permits out) keeps accruing vruntime and permit-time", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 2, clock })
    const h = harness(sched)
    h.submit("P")
    h.submit("P")
    sched.flush()
    const before = flowOf(sched, "P")
    expect(before.state).toBe("parked")
    clock.advance(100)
    const after = flowOf(sched, "P")
    expect(after.vruntime).toBeGreaterThan(before.vruntime)
    expect(after.grantedPermitTimeMs).toBe(before.grantedPermitTimeMs + 2 * 100)
  })
})

describe("idle flow reclamation (F4)", () => {
  test("many distinct idle flows are reclaimed after flow_retention_ms; a returning key is a new flow", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 50, clock, flowRetentionMs: 100 })
    const h = harness(sched)
    for (let i = 0; i < 50; i++) h.submit(`k${i}`)
    sched.flush()
    expect(sched.stats().flows.length).toBe(50)
    clock.advance(10)
    sched.settle()
    const minBefore = sched.stats().minVruntime
    for (const g of h.liveGrants()) {
      g.released = true
      g.release()
    }
    sched.flush()
    expect(sched.stats().flows.length).toBe(50) // idle but still within retention
    clock.advance(101)
    sched.settle() // reclamation piggybacks on settle — no extra timer
    expect(sched.stats().flows.length).toBe(0)
    // A key returning after reclamation is a NEW flow: fresh counters, starting
    // at min_vruntime rather than inheriting the old flow's accrued vruntime.
    h.submit("k0")
    sched.flush()
    const f = flowOf(sched, "k0")
    expect(f.submitted).toBe(1)
    expect(f.completed).toBe(0)
    expect(f.vruntime).toBeGreaterThanOrEqual(minBefore)
  })

  test("flow_retention_ms=0 disables reclamation", () => {
    const clock = makeClock()
    const sched = makeSched({ limit: 4, clock, flowRetentionMs: 0 })
    const h = harness(sched)
    for (let i = 0; i < 4; i++) h.submit(`z${i}`)
    sched.flush()
    for (const g of h.liveGrants()) {
      g.released = true
      g.release()
    }
    clock.advance(100000)
    sched.settle()
    expect(sched.stats().flows.length).toBe(4) // never reclaimed
  })

  test("global overflow rejects before creating a flow entry", () => {
    const sched = makeSched({ limit: 1, clock: makeClock(), maxQueueLength: 1 })
    const h = harness(sched)
    h.submit("A")
    sched.flush() // active 1
    h.submit("A")
    sched.flush() // queued 1 (ceiling)
    h.submit("ZZZ") // count overflow -> rejected pre-send, ZZZ never created
    expect(h.rejects[0].error).toBeInstanceOf(QueueOverflowError)
    expect(sched.stats().flows.find((f) => f.key === "ZZZ")).toBeUndefined()
  })
})