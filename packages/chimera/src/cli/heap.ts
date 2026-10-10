import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "heap" })
const MINUTE = 60_000
const MB = 1024 * 1024
const DEFAULT_LIMIT = 2 * 1024 * MB
const DEFAULT_GC_COOLDOWN = 5 * MINUTE
const GC_INTERVAL = 30_000

let timer: Timer | undefined
let lock = false
let armed = true

let gcTimer: Timer | undefined
let lastCollectedAt = 0

export function snapshotLimitBytes(env: Record<string, string | undefined> = process.env) {
  const raw = env.OPENCODE_AUTO_HEAP_SNAPSHOT_MB
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.floor(parsed * MB)
}

export function shouldSnapshot(stat: Pick<NodeJS.MemoryUsage, "rss">, limit = snapshotLimitBytes()) {
  return stat.rss > limit
}

// Soft ceiling on `heapUsed` for long-running processes. Proactive collection is
// OPT-IN: it is disabled unless `CHIMERA_HEAP_SOFT_CAP_MB` is set to a positive
// number (unset, empty, invalid, or `0` all disable it). Default-off is deliberate:
// a measured RSS benefit was not reproducible while full-GC pauses (59-226ms) were
// real, so the mechanism only runs when an operator opts in.
export function softCapBytes(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.CHIMERA_HEAP_SOFT_CAP_MB
  if (raw === undefined || raw === "") return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed * MB)
}

export function gcCooldownMs(env: Record<string, string | undefined> = process.env) {
  const raw = env.CHIMERA_HEAP_GC_COOLDOWN_MS
  if (!raw) return DEFAULT_GC_COOLDOWN
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GC_COOLDOWN
  return Math.floor(parsed)
}

// Collection fires only when the heap is over the soft cap AND the cooldown
// since the previous collection has elapsed. The cooldown is the throttle that
// keeps forced GCs from turning into a latency tax under steady load.
export function shouldCollect(input: {
  heapUsed: number
  cap: number | undefined
  now: number
  lastCollectedAt: number
  cooldownMs: number
}) {
  if (input.cap === undefined) return false
  if (input.heapUsed <= input.cap) return false
  return input.now - input.lastCollectedAt >= input.cooldownMs
}

function collect() {
  if (typeof Bun === "undefined" || typeof Bun.gc !== "function") return
  Bun.gc(true)
}

function startSnapshot() {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return
  const limit = snapshotLimitBytes()

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (!shouldSnapshot(stat, limit)) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    log.warn("heap usage exceeded limit", {
      rss: stat.rss,
      heap: stat.heapUsed,
      limit,
      file,
    })

    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .catch((err) => {
        log.error("failed to write heap snapshot", {
          error: err instanceof Error ? err.message : String(err),
          file,
        })
      })

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

function startCollector() {
  if (gcTimer) return
  const cap = softCapBytes()
  if (cap === undefined) return
  const cooldownMs = gcCooldownMs()

  gcTimer = setInterval(() => {
    const now = Date.now()
    const heapUsed = process.memoryUsage().heapUsed
    if (!shouldCollect({ heapUsed, cap, now, lastCollectedAt, cooldownMs })) return
    lastCollectedAt = now
    collect()
    log.info("forced heap collection", {
      heapUsed,
      cap,
      reclaimed: heapUsed - process.memoryUsage().heapUsed,
    })
  }, GC_INTERVAL)
  gcTimer.unref?.()
}

export function start() {
  startSnapshot()
  startCollector()
}

export * as Heap from "./heap"