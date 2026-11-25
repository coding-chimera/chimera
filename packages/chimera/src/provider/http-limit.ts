/**
 * Per-origin cap on concurrent model HTTP requests.
 *
 * The model transport is the AI SDK fetch path (Bun's native fetch or the
 * native Rust transport). Bun exposes no per-origin connection-pool setting,
 * so the fetch wrapper installed by the provider SDK resolver is the seam
 * where the cap can be enforced. The cap defaults to 128 concurrent requests
 * per origin — the same value as delegation.max_concurrent — and is
 * configurable per provider (`provider.<id>.options.maxConnections`) or
 * process-wide (`OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS`).
 *
 * Overcommit is the default: requests beyond the cap are QUEUED, never
 * rejected. Under CFS each session flow is admitted fairly and excess work
 * waits its turn; queue-count/byte ceilings and wait timeouts are opt-in
 * (`experimental.http_scheduler`), so a default install always makes progress.
 *
 * A permit is held for the whole response body, not only until headers arrive:
 * a streaming model response keeps its connection busy for the full turn, so
 * releasing at headers would not bound connections. A queued request that
 * aborts leaves the queue without consuming a permit.
 *
 * Two scheduling modes share this seam:
 * - "cfs" (default): per-flow fair scheduling (http-cfs.ts) keyed by session
 *   headers, with queue count/bytes ceilings, wait timeouts and permit-time stats.
 * - "fifo": explicit downgrade to the historical single-queue behavior.
 * The third wrapFetch argument is WRAPPER-CREATION configuration only — the
 * public fetch signature stays `(input, init) => Promise<Response>`.
 *
 * A gate's limit AND scheduling config are fixed at creation; a later wrapper
 * asking for different ones on the same origin keeps the first and warns (the
 * gate is process-wide — changing config requires a rebuild/restart).
 */
import { Flag } from "@opencode-ai/core/flag/flag"
import { ResponseMetadata } from "./response-metadata"
import { CfsScheduler, type CfsHooks, type FlowStats, type SchedulerStats } from "./http-cfs"
import { GateDisposedError, PermitLeaseExpiredError, abortReason, bodyBytes, unrefTimer } from "./http-queue"
import { withHeaderTimeout } from "./header-timeout"

export { QueueOverflowError, QueueWaitTimeoutError, PermitLeaseExpiredError, GateDisposedError, bodyBytes } from "./http-queue"

export const DEFAULT_MAX_CONNECTIONS = 128

/** Explicit provider option wins, then the env flag, then the caller's
 *  default (DEFAULT_MAX_CONNECTIONS, 128, for every channel). The
 *  single-argument form keeps the shared default. */
export function resolveMaxConnections(configured: unknown, fallbackDefault: number = DEFAULT_MAX_CONNECTIONS): number {
  if (typeof configured === "number" && Number.isInteger(configured) && configured > 0) return configured
  return Flag.OPENCODE_PROVIDER_HTTP_MAX_CONNECTIONS ?? fallbackDefault
}

/** Wrapper-creation configuration (NOT per-request fetch parameters). */
export type HttpLimitOptions = {
  /** Scheduling discipline; defaults to "cfs". "fifo" is an explicit downgrade. */
  mode?: "fifo" | "cfs"
  defaultWeight?: number
  /** Management-plane flow weights; dynamic flows fall back to defaultWeight. */
  weights?: Record<string, number>
  admissionGranularityMs?: number
  wakeupCreditMs?: number
  maxDebtMs?: number
  tickMs?: number
  maxQueueLength?: number
  maxQueueBytes?: number
  perFlowQueueBytes?: number
  queueWaitTimeoutMs?: number
  /** 0 (default) disables the permit lease; >0 cancels upstream + frees the
   *  JS permit when a permit is held longer than this (abandoned bodies). */
  permitLeaseMs?: number
  /** Idle-flow reclamation delay in ms (CFS); 0 disables. Default 30000. */
  flowRetentionMs?: number
  /** G1 header budget in ms, applied INNERMOST after the permit grant so
   *  queue wait never consumes it; false disables the timer entirely.
   *  Undefined (default) = no header deadline, byte-identical passthrough. */
  headerTimeoutMs?: number | false
  /** Injectable clock for deterministic tests; production never passes it. */
  clock?: { now(): number }
  hooks?: CfsHooks
}

export type GateStats = SchedulerStats & { origin: string }

type Fetch = (input: any, init?: any) => Promise<Response>
type FifoEntry = { start: () => void; reject: (error: unknown) => void; enqueuedAt: number; detach: () => void }
type Gate = {
  active: number
  limit: number
  mode: "fifo" | "cfs"
  queue: FifoEntry[]
  cfs: CfsScheduler | null
  now: () => number
  disposed: boolean
  fingerprint: string
}

// Process-wide so every provider/SDK instance sharing a gateway origin draws
// from the same budget. The map is bounded by the number of distinct origins
// the process talks to, which stays small for model traffic.
const gates = new Map<string, Gate>()

function pump(gate: Gate) {
  while (gate.active < gate.limit && gate.queue.length > 0) {
    gate.active++
    gate.queue.shift()!.start()
  }
}
/** Stable fingerprint of the gate's scheduling config (NOT per-request options
 *  like headerTimeoutMs). Used to warn when a later wrapper disagrees (F5). */
function configFingerprint(options?: HttpLimitOptions): string {
  const weights = options?.weights
  return JSON.stringify({
    mode: options?.mode ?? "cfs",
    defaultWeight: options?.defaultWeight,
    weights: weights ? Object.fromEntries(Object.keys(weights).sort().map((k) => [k, weights[k]])) : undefined,
    admissionGranularityMs: options?.admissionGranularityMs,
    wakeupCreditMs: options?.wakeupCreditMs,
    maxDebtMs: options?.maxDebtMs,
    tickMs: options?.tickMs,
    maxQueueLength: options?.maxQueueLength,
    maxQueueBytes: options?.maxQueueBytes,
    perFlowQueueBytes: options?.perFlowQueueBytes,
    queueWaitTimeoutMs: options?.queueWaitTimeoutMs,
    permitLeaseMs: options?.permitLeaseMs,
    flowRetentionMs: options?.flowRetentionMs,
  })
}


function gateFor(origin: string, limit: number, options: HttpLimitOptions | undefined, fingerprint: string): Gate {
  const existing = gates.get(origin)
  if (existing) {
    // The creation-time limit AND scheduling config are fixed; never silently
    // overwrite them. A later wrapper with different config keeps the first.
    if (existing.limit !== limit) options?.hooks?.onLimitConflict?.(existing.limit, limit)
    if (existing.fingerprint !== fingerprint) {
      // F5: never silent. Prefer the caller's hook (the provider wires it to its
      // own logger); without a hook, a lightweight stderr write — this module
      // pulls in no logger/zod dependency just for a warning.
      if (options?.hooks?.onConfigConflict) {
        options.hooks.onConfigConflict(origin, existing.fingerprint, fingerprint)
      } else {
        process.stderr.write(
          `[http-limit] gate config conflict on ${origin}: keeping the creation-time scheduler config; restart to change it\n`,
        )
      }
    }
    return existing
  }
  const mode = options?.mode ?? "cfs"
  const now = options?.clock?.now ?? (() => performance.now())
  const gate: Gate = { active: 0, limit, mode, queue: [], cfs: null, now, disposed: false, fingerprint }
  if (mode === "cfs") {
    gate.cfs = new CfsScheduler({
      limit,
      defaultWeight: options?.defaultWeight,
      weights: options?.weights,
      admissionGranularityMs: options?.admissionGranularityMs,
      wakeupCreditMs: options?.wakeupCreditMs,
      maxDebtMs: options?.maxDebtMs,
      tickMs: options?.tickMs,
      maxQueueLength: options?.maxQueueLength,
      maxQueueBytes: options?.maxQueueBytes,
      perFlowQueueBytes: options?.perFlowQueueBytes,
      queueWaitTimeoutMs: options?.queueWaitTimeoutMs,
      flowRetentionMs: options?.flowRetentionMs,
      clock: { now },
      hooks: options?.hooks,
    })
  }
  gates.set(origin, gate)
  return gate
}

/** Flow identity from request headers: x-parent-session-id first, then
 *  x-session-affinity, else "default". Case-insensitive across Headers
 *  instances, pair arrays and plain objects. Weights never come from here. */
export function flowKeyOf(init: { headers?: unknown } | null | undefined): string {
  const headers = init?.headers
  if (headers instanceof Headers) {
    return headers.get("x-parent-session-id") || headers.get("x-session-affinity") || "default"
  }
  let parent: string | undefined
  let affinity: string | undefined
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2 || typeof entry[1] !== "string") continue
      const name = typeof entry[0] === "string" ? entry[0].toLowerCase() : ""
      if (name === "x-parent-session-id" && parent === undefined) parent = entry[1]
      else if (name === "x-session-affinity" && affinity === undefined) affinity = entry[1]
    }
  } else if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") continue
      const lower = name.toLowerCase()
      if (lower === "x-parent-session-id" && parent === undefined) parent = value
      else if (lower === "x-session-affinity" && affinity === undefined) affinity = value
    }
  }
  return parent || affinity || "default"
}

function acquire(gate: Gate, signal?: AbortSignal | null): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const start = () => {
      settled = true
      signal?.removeEventListener("abort", onAbort)
      let released = false
      resolve(() => {
        if (released || gate.disposed) return
        released = true
        gate.active--
        pump(gate)
      })
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      const index = gate.queue.findIndex((entry) => entry.start === start)
      if (index >= 0) gate.queue.splice(index, 1)
      reject(abortReason(signal!))
    }
    const entry: FifoEntry = {
      start,
      reject,
      enqueuedAt: gate.now(),
      detach: () => signal?.removeEventListener("abort", onAbort),
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    gate.queue.push(entry)
    pump(gate)
  })
}

function acquireCfs(sched: CfsScheduler, flowKey: string, bytes: number, signal?: AbortSignal | null): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    sched.submit(flowKey, bytes, signal ?? null, resolve, reject)
  })
}

function originOf(input: unknown): string | undefined {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string"
          ? (input as { url: string }).url
          : undefined
  if (!url) return
  try {
    const origin = new URL(url).origin
    return origin === "null" ? undefined : origin
  } catch {
    return
  }
}

function holdResponse(res: Response, release: () => void): Response {
  if (!res.body) {
    release()
    return res
  }

  const reader = res.body.getReader()
  let released = false
  const finish = () => {
    if (released) return
    released = true
    release()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read()
        if (part.done) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(part.value)
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      await reader.cancel(reason)
    },
  })

  return ResponseMetadata.carry(res, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }))
}

export function wrapFetch(fetchFn: Fetch, limit: number, options?: HttpLimitOptions): Fetch {
  if (!(limit > 0)) return fetchFn
  const leaseMs = options?.permitLeaseMs ?? 0
  const innerFetch = withHeaderTimeout(fetchFn, options?.headerTimeoutMs)
  // Fingerprint computed ONCE per wrapper, not per request (no per-call sort/JSON).
  const fingerprint = configFingerprint(options)
  return async (input, init) => {
    const origin = originOf(input)
    if (!origin) return innerFetch(input, init)

    const gate = gateFor(origin, limit, options, fingerprint)
    if (gate.disposed) throw new GateDisposedError()
    const signal: AbortSignal | null | undefined = init?.signal
    const release = gate.cfs
      ? await acquireCfs(gate.cfs, flowKeyOf(init), bodyBytes(init?.body), signal)
      : await acquire(gate, signal)

    // Default path: with no header budget configured this is the unchanged
    // historical behavior — init passes through untouched and the permit lives
    // exactly as long as the response body. headerTimeoutMs (G1) adds the
    // header signal innermost, starting only now that the permit is granted.
    if (leaseMs <= 0) {
      let response: Response
      try {
        response = await innerFetch(input, init)
      } catch (error) {
        release()
        throw error
      }
      return holdResponse(response, release)
    }

    // Lease mode: an internal controller lets an expired lease cancel the
    // upstream (pending fetch OR streaming/abandoned body) while the JS
    // permit is freed immediately. Never retries — the error surfaces.
    const leaseCtl = new AbortController()
    const combined = signal ? AbortSignal.any([signal, leaseCtl.signal]) : leaseCtl.signal
    let leaseTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      leaseTimer = null
      leaseCtl.abort(new PermitLeaseExpiredError(leaseMs))
      release()
    }, leaseMs)
    unrefTimer(leaseTimer)
    const releaseWithLease = () => {
      if (leaseTimer) {
        clearTimeout(leaseTimer)
        leaseTimer = null
      }
      release()
    }
    let response: Response
    try {
      response = await innerFetch(input, { ...init, signal: combined })
    } catch (error) {
      releaseWithLease()
      throw error
    }
    return holdResponse(response, releaseWithLease)
  }
}

/** Management plane: a snapshot of every live gate (settles CFS accounting
 *  first). FIFO gates report their legacy queue; flows/bytes are CFS-only. */
export function stats(): GateStats[] {
  const out: GateStats[] = []
  for (const [origin, gate] of gates) {
    if (gate.cfs) {
      out.push({ origin, ...gate.cfs.stats() })
      continue
    }
    let oldest = Number.POSITIVE_INFINITY
    for (const entry of gate.queue) if (entry.enqueuedAt < oldest) oldest = entry.enqueuedAt
    out.push({
      origin,
      mode: "fifo",
      limit: gate.limit,
      active: gate.active,
      queued: gate.queue.length,
      queuedBytes: 0,
      oldestWaitMs: oldest === Number.POSITIVE_INFINITY ? 0 : gate.now() - oldest,
      minVruntime: 0,
      flows: [] as FlowStats[],
    })
  }
  return out
}

/** Tear down every gate: clear tick/wait timers, reject queued waiters with
 *  GateDisposedError, make outstanding releases no-ops. Idempotent; intended
 *  for tests and embedder shutdown so no timer keeps the process alive. */
export function dispose(): void {
  for (const gate of gates.values()) {
    gate.disposed = true
    gate.cfs?.dispose()
    for (const entry of gate.queue.splice(0)) {
      entry.detach()
      entry.reject(new GateDisposedError())
    }
    gate.active = 0
  }
  gates.clear()
}

export * as HttpLimit from "./http-limit"