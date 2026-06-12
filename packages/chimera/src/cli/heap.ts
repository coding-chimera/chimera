import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "heap" })
const MINUTE = 60_000
const MB = 1024 * 1024
const DEFAULT_LIMIT = 2 * 1024 * MB

let timer: Timer | undefined
let lock = false
let armed = true

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

export function start() {
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

export * as Heap from "./heap"
