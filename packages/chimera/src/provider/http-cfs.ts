/**
 * CFS-style fair scheduler for the provider HTTP gate.
 *
 * First version: O(F) scan at decision points (flows are few); no heap, and
 * NEVER per-chunk scheduling — decisions happen on submit / release / abort /
 * expire / tick only.
 *
 * Invariants:
 * - active <= limit always; every release refills to the limit immediately
 *   (work conserving). The limit is fixed at construction.
 * - Submit enqueues and defers the grant scan to a queueMicrotask batch, so a
 *   synchronous burst of submits (e.g. Promise.all of 400 fetches) is scheduled
 *   ONCE with every flow's queue full — weights then shape the first allocation
 *   instead of each submit granting immediately against a half-empty queue.
 *   flush() runs the same scan synchronously (tests / internal drain).
 * - Cross-flow pick: min (vruntime, lastGrantSeq, flowKey) — longest-unserved
 *   first: an exact vruntime tie goes to the flow granted least recently, so a
 *   NEW flow (lastGrantSeq 0) always wins a tie against an older flow regardless
 *   of key order (2:1 over 220 permits lands 146/74). Within a flow: strict FIFO
 *   via the intrusive list.
 * - vruntime accrues activeCount * dt * 1024 / weight for every flow holding
 *   active permits (RUNNABLE or PARKED), settled on events and on the tick.
 * - Each admission additionally charges admissionGranularityMs * 1024 /
 *   weight so same-wall-clock batch grants rotate flows instead of tying.
 * - minVruntime is monotonic and tracks ONLY RUNNABLE flows (queue non-empty);
 *   a PARKED flow keeps accruing but never drags the floor down. A new flow
 *   starts at minVruntime; a flow whose queue was empty is clamped on wakeup to
 *   [minVruntime - wakeupCreditMs, minVruntime + maxDebtMs] — credit gives a
 *   bounded head start, maxDebt bounds how far behind it can be parked.
 * - A waiter settles exactly once (grant / abort / expire / dispose); every
 *   dequeue path refunds its bytes; release is idempotent.
 * - Idle flows (no queue, no active permits) are reclaimed after
 *   flowRetentionMs; a key returning after reclamation starts as a NEW flow at
 *   minVruntime. Reclamation piggybacks on settle (no extra timer).
 */

import {
  GateDisposedError,
  IntrusiveList,
  QueueOverflowError,
  QueueWaitTimeoutError,
  abortReason,
  unrefTimer,
  type LinkedNode,
} from "./http-queue"

export type CfsClock = { now(): number }

export type CfsHooks = {
  /** Called when a later wrapper requests a different limit for an existing
   *  gate; the creation-time limit is kept (never silently overwritten). */
  onLimitConflict?: (kept: number, requested: number) => void
  /** Called when a later wrapper requests different scheduling config (mode /
   *  weights / ceilings) for an existing gate; the creation-time config is kept.
   *  Changing it requires a rebuild/restart — the gate is process-wide. */
  onConfigConflict?: (origin: string, kept: string, requested: string) => void
}

export type CfsOptions = {
  limit: number
  defaultWeight?: number
  weights?: Record<string, number>
  admissionGranularityMs?: number
  wakeupCreditMs?: number
  maxDebtMs?: number
  /** 0 disables the periodic settle interval. */
  tickMs?: number
  maxQueueLength?: number
  maxQueueBytes?: number
  perFlowQueueBytes?: number
  queueWaitTimeoutMs?: number
  /** Idle-flow reclamation delay in ms; 0 disables. Default 30000. */
  flowRetentionMs?: number
  clock?: CfsClock
  hooks?: CfsHooks
}

export type FlowStats = {
  key: string
  weight: number
  state: "runnable" | "parked" | "idle"
  vruntime: number
  active: number
  queued: number
  queuedBytes: number
  grantedPermitTimeMs: number
  submitted: number
  completed: number
  aborted: number
}

export type SchedulerStats = {
  mode: "fifo" | "cfs"
  limit: number
  active: number
  queued: number
  queuedBytes: number
  oldestWaitMs: number
  minVruntime: number
  flows: FlowStats[]
}

type Waiter = LinkedNode & {
  flow: Flow
  bytes: number
  enqueuedAt: number
  settled: boolean
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal: AbortSignal | null
  onAbort: (() => void) | null
  waitTimer: ReturnType<typeof setTimeout> | null
}

type Flow = {
  key: string
  weight: number
  vruntime: number
  lastGrantSeq: number
  active: number
  queue: IntrusiveList<Waiter>
  queuedBytes: number
  submitted: number
  completed: number
  aborted: number
  grantedPermitTimeMs: number
  /** Clock time the flow became idle (queue empty AND active 0); null while it
   *  holds queued waiters or active permits. Drives retention reclamation. */
  idleSince: number | null
}

const REFERENCE_WEIGHT = 1024
const DEFAULT_FLOW_RETENTION_MS = 30_000

export class CfsScheduler {
  private limit: number
  private defaultWeight: number
  private weights: Record<string, number>
  private granularity: number
  private credit: number
  private maxDebt: number
  private maxQueueLength: number | undefined
  private maxQueueBytes: number | undefined
  private perFlowQueueBytes: number | undefined
  private queueWaitTimeoutMs: number | undefined
  private flowRetentionMs: number
  private clock: CfsClock
  private flows = new Map<string, Flow>()
  private active = 0
  private queued = 0
  private queuedBytes = 0
  private minVruntime = 0
  private grantSeq = 0
  private lastSettle: number
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private schedulePending = false
  private disposed = false

  constructor(options: CfsOptions) {
    this.limit = options.limit
    this.defaultWeight = options.defaultWeight ?? REFERENCE_WEIGHT
    this.weights = options.weights ?? {}
    this.granularity = options.admissionGranularityMs ?? 1
    this.credit = options.wakeupCreditMs ?? 50
    this.maxDebt = options.maxDebtMs ?? 500
    this.maxQueueLength = options.maxQueueLength
    this.maxQueueBytes = options.maxQueueBytes
    this.perFlowQueueBytes = options.perFlowQueueBytes
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs
    this.flowRetentionMs = options.flowRetentionMs ?? DEFAULT_FLOW_RETENTION_MS
    this.clock = options.clock ?? { now: () => performance.now() }
    this.lastSettle = this.clock.now()
    const tickMs = options.tickMs ?? 50
    if (tickMs > 0) {
      this.tickTimer = setInterval(() => this.settle(), tickMs)
      unrefTimer(this.tickTimer)
    }
  }

  /** Enqueue one request. The grant scan is deferred to a queueMicrotask batch
   *  (see flush) so a synchronous burst is scheduled once with full queues;
   *  the resolve callback receives an idempotent release. Overflow / pre-abort /
   *  dispose reject without ever touching the queue accounting. */
  submit(
    flowKey: string,
    bytes: number,
    signal: AbortSignal | null,
    resolve: (release: () => void) => void,
    reject: (error: unknown) => void,
  ): void {
    if (this.disposed) {
      reject(new GateDisposedError())
      return
    }
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    this.settle()
    // Global ceilings are checked BEFORE flowFor so an overflow never creates a
    // useless flow entry (the per-flow ceiling inherently needs the flow).
    if (this.maxQueueLength !== undefined && this.queued >= this.maxQueueLength) {
      reject(new QueueOverflowError("count", this.maxQueueLength, this.queued + 1))
      return
    }
    if (this.maxQueueBytes !== undefined && this.queuedBytes + bytes > this.maxQueueBytes) {
      reject(new QueueOverflowError("bytes", this.maxQueueBytes, this.queuedBytes + bytes))
      return
    }
    const flow = this.flowFor(flowKey)
    if (this.perFlowQueueBytes !== undefined && flow.queuedBytes + bytes > this.perFlowQueueBytes) {
      reject(new QueueOverflowError("flow-bytes", this.perFlowQueueBytes, flow.queuedBytes + bytes))
      return
    }

    const waiter: Waiter = {
      prev: null,
      next: null,
      flow,
      bytes,
      enqueuedAt: this.clock.now(),
      settled: false,
      resolve,
      reject,
      signal,
      onAbort: null,
      waitTimer: null,
    }
    // Waking an empty queue: bounded credit behind min, bounded debt ahead.
    if (flow.queue.length === 0) {
      flow.vruntime = Math.min(Math.max(flow.vruntime, this.minVruntime - this.credit), this.minVruntime + this.maxDebt)
    }
    flow.queue.push(waiter)
    flow.queuedBytes += bytes
    flow.submitted++
    flow.idleSince = null
    this.queued++
    this.queuedBytes += bytes

    if (signal) {
      waiter.onAbort = () => this.dropWaiter(waiter, abortReason(signal))
      signal.addEventListener("abort", waiter.onAbort, { once: true })
    }
    if (this.queueWaitTimeoutMs !== undefined) {
      const ms = this.queueWaitTimeoutMs
      waiter.waitTimer = setTimeout(() => this.dropWaiter(waiter, new QueueWaitTimeoutError(ms)), ms)
      unrefTimer(waiter.waitTimer)
    }
    this.requestSchedule()
  }

  /** Run the deferred grant scan synchronously. Tests call this at the end of a
   *  submit batch; the microtask path calls it automatically. Idempotent. */
  flush(): void {
    this.schedulePending = false
    if (!this.disposed) this.schedule()
  }

  /** Accrue vruntime / permit-time up to the clock's now, refresh min_vruntime
   *  and reclaim long-idle flows. Called on every event; stats() calls it too. */
  settle(): void {
    const now = this.clock.now()
    const dt = now - this.lastSettle
    if (dt > 0) {
      for (const flow of this.flows.values()) {
        // PARKED flows (queue empty, permits still out) keep accruing too.
        if (flow.active > 0) {
          flow.vruntime += (flow.active * dt * REFERENCE_WEIGHT) / flow.weight
          flow.grantedPermitTimeMs += flow.active * dt
        }
      }
      this.lastSettle = now
    }
    this.updateMin()
    this.reclaimIdle(now)
  }

  stats(): SchedulerStats {
    this.settle()
    const now = this.clock.now()
    let oldest = Number.POSITIVE_INFINITY
    const flows: FlowStats[] = []
    for (const flow of this.flows.values()) {
      if (flow.queue.head && flow.queue.head.enqueuedAt < oldest) oldest = flow.queue.head.enqueuedAt
      flows.push({
        key: flow.key,
        weight: flow.weight,
        state: flow.queue.length > 0 ? "runnable" : flow.active > 0 ? "parked" : "idle",
        vruntime: flow.vruntime,
        active: flow.active,
        queued: flow.queue.length,
        queuedBytes: flow.queuedBytes,
        grantedPermitTimeMs: flow.grantedPermitTimeMs,
        submitted: flow.submitted,
        completed: flow.completed,
        aborted: flow.aborted,
      })
    }
    return {
      mode: "cfs",
      limit: this.limit,
      active: this.active,
      queued: this.queued,
      queuedBytes: this.queuedBytes,
      oldestWaitMs: oldest === Number.POSITIVE_INFINITY ? 0 : now - oldest,
      minVruntime: this.minVruntime,
      flows,
    }
  }

  /** Clear the tick, reject every queued waiter, drop all flow state. Active
   *  permits' release closures become no-ops. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.schedulePending = false
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    for (const flow of this.flows.values()) {
      for (;;) {
        const waiter = flow.queue.popHead()
        if (!waiter) break
        this.detach(waiter)
        waiter.settled = true
        flow.queuedBytes -= waiter.bytes
        this.queued--
        this.queuedBytes -= waiter.bytes
        waiter.reject(new GateDisposedError())
      }
    }
    this.flows.clear()
    this.active = 0
    this.queued = 0
    this.queuedBytes = 0
  }

  private requestSchedule(): void {
    if (this.schedulePending || this.disposed) return
    this.schedulePending = true
    queueMicrotask(() => {
      this.schedulePending = false
      if (!this.disposed) this.schedule()
    })
  }

  private flowFor(key: string): Flow {
    const existing = this.flows.get(key)
    if (existing) return existing
    const flow: Flow = {
      key,
      weight: this.weights[key] ?? this.defaultWeight,
      // A brand-new flow starts at min_vruntime, never behind the pack.
      vruntime: this.minVruntime,
      lastGrantSeq: 0,
      active: 0,
      queue: new IntrusiveList<Waiter>(),
      queuedBytes: 0,
      submitted: 0,
      completed: 0,
      aborted: 0,
      grantedPermitTimeMs: 0,
      idleSince: this.clock.now(),
    }
    this.flows.set(key, flow)
    return flow
  }

  private updateMin(): void {
    let min = Number.POSITIVE_INFINITY
    for (const flow of this.flows.values()) {
      // F1: only RUNNABLE flows set the floor. A PARKED flow (permits out, queue
      // empty) keeps accruing vruntime but must not drag min down, or new flows
      // would start below the runnable pack and monopolize the next grants.
      if (flow.queue.length > 0 && flow.vruntime < min) min = flow.vruntime
    }
    if (min !== Number.POSITIVE_INFINITY && min > this.minVruntime) this.minVruntime = min
  }

  private reclaimIdle(now: number): void {
    if (this.flowRetentionMs <= 0) return
    for (const [key, flow] of this.flows) {
      if (
        flow.queue.length === 0 &&
        flow.active === 0 &&
        flow.idleSince !== null &&
        now - flow.idleSince >= this.flowRetentionMs
      )
        this.flows.delete(key)
    }
  }

  private pickFlow(): Flow | null {
    let best: Flow | null = null
    for (const flow of this.flows.values()) {
      if (flow.queue.length === 0) continue
      if (
        !best ||
        flow.vruntime < best.vruntime ||
        (flow.vruntime === best.vruntime &&
          (flow.lastGrantSeq < best.lastGrantSeq ||
            (flow.lastGrantSeq === best.lastGrantSeq && flow.key < best.key)))
      )
        best = flow
    }
    return best
  }

  private schedule(): void {
    this.settle()
    while (this.active < this.limit) {
      const flow = this.pickFlow()
      if (!flow) return
      const waiter = flow.queue.popHead()
      if (!waiter) continue
      flow.queuedBytes -= waiter.bytes
      this.queued--
      this.queuedBytes -= waiter.bytes
      this.grant(waiter, flow)
    }
  }

  private grant(waiter: Waiter, flow: Flow): void {
    waiter.settled = true
    this.detach(waiter)
    flow.active++
    this.active++
    flow.idleSince = null
    // Admission charge: rotates same-wall-clock batch grants across flows.
    flow.vruntime += (this.granularity * REFERENCE_WEIGHT) / flow.weight
    flow.lastGrantSeq = ++this.grantSeq
    this.updateMin()
    let released = false
    waiter.resolve(() => {
      if (released || this.disposed) return
      released = true
      // F2: settle BEFORE decrementing active so the final permit-time segment
      // (lastSettle .. now) is accrued while this permit still counts.
      this.settle()
      flow.active--
      this.active--
      flow.completed++
      if (flow.queue.length === 0 && flow.active === 0) flow.idleSince = this.clock.now()
      this.updateMin()
      this.schedule()
    })
  }

  /** Pre-grant removal (abort / wait timeout): settle once, refund bytes. */
  private dropWaiter(waiter: Waiter, error: unknown): void {
    if (waiter.settled) return
    waiter.settled = true
    this.detach(waiter)
    waiter.flow.queue.remove(waiter)
    waiter.flow.queuedBytes -= waiter.bytes
    waiter.flow.aborted++
    this.queued--
    this.queuedBytes -= waiter.bytes
    if (waiter.flow.queue.length === 0 && waiter.flow.active === 0) waiter.flow.idleSince = this.clock.now()
    waiter.reject(error)
  }

  private detach(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
    waiter.onAbort = null
    if (waiter.waitTimer) clearTimeout(waiter.waitTimer)
    waiter.waitTimer = null
  }
}

export * as HttpCfs from "./http-cfs"