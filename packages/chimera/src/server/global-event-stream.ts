import { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Event } from "./event"

const EVENT_QUEUE_CAPACITY = 1024
const HEARTBEAT_INTERVAL_MS = 10_000
/**
 * A streaming turn publishes one `message.part.delta` per provider chunk, which
 * used to mean one SSE frame per token per connection. Every consumer applies
 * deltas additively to the addressed part field (WebUI `messageStore`, TUI
 * `context/sync`), so a short per-connection window can concatenate them into a
 * single frame without changing the wire contract. 40ms keeps the added first
 * token latency imperceptible while collapsing a 100-250 chunk/s stream several
 * times over, which is what keeps the 1024-slot queue from overflowing during
 * multi-project streaming.
 */
const DELTA_MERGE_WINDOW_MS = 40
const DELTA_EVENT_TYPE = "message.part.delta"

export interface GlobalEventStreamOptions {
  capacity?: number
  heartbeatIntervalMs?: number
  /** 0 disables coalescing: every delta is forwarded as it arrives. */
  deltaMergeWindowMs?: number
}

type PendingDelta = {
  event: GlobalEvent
  delta: string
  merged: number
}

function controlEvent(type: string, properties: Record<string, unknown>): GlobalEvent {
  return {
    directory: "global",
    payload: {
      id: Bus.createID(),
      type,
      properties,
    },
  }
}

/**
 * Merge identity of a delta: one part field on one instance. The envelope is
 * part of the key because the workspace loop re-emits remote envelopes on the
 * local bus, and a remote stream must never merge into a local one. Returns
 * undefined for payloads that are not mergeable deltas.
 */
function deltaKey(event: GlobalEvent) {
  const properties = event.payload?.properties
  if (!properties || typeof properties !== "object") return
  const { sessionID, messageID, partID, field, delta } = properties as Record<string, unknown>
  if (typeof delta !== "string") return
  if (typeof sessionID !== "string" || typeof messageID !== "string" || typeof partID !== "string") return
  return [event.directory, event.project, event.workspace, sessionID, messageID, partID, field].join("\u0000")
}

function mergedDeltaEvent(pending: PendingDelta): GlobalEvent {
  return {
    ...pending.event,
    payload: {
      ...pending.event.payload,
      properties: { ...pending.event.payload.properties, delta: pending.delta },
    },
  }
}

export function createGlobalEventStream(options: GlobalEventStreamOptions = {}) {
  const queue = new AsyncQueue<GlobalEvent | null>({
    capacity: options.capacity ?? EVENT_QUEUE_CAPACITY,
    overflow: "drop-oldest",
  })
  const mergeWindowMs = options.deltaMergeWindowMs ?? DELTA_MERGE_WINDOW_MS
  const pending = new Map<string, PendingDelta>()
  let flushTimer: Timer | undefined
  let closed = false

  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    for (const item of batch) queue.push(item.merged > 1 ? mergedDeltaEvent(item) : item.event)
  }

  const handler = (event: GlobalEvent) => {
    // Consumers replay deltas on top of part snapshots, so anything that is not
    // a delta must be ordered after the deltas already buffered for that part.
    if (event.payload?.type !== DELTA_EVENT_TYPE) {
      flush()
      queue.push(event)
      return
    }
    const key = mergeWindowMs > 0 ? deltaKey(event) : undefined
    if (!key) {
      queue.push(event)
      return
    }
    const existing = pending.get(key)
    if (existing) {
      existing.delta += (event.payload.properties as { delta: string }).delta
      existing.merged += 1
      return
    }
    pending.set(key, { event, delta: (event.payload.properties as { delta: string }).delta, merged: 1 })
    // The window is measured from the first buffered delta, so coalescing adds
    // at most mergeWindowMs of latency to any single chunk.
    flushTimer ??= setTimeout(flush, mergeWindowMs)
  }

  GlobalBus.on("event", handler)
  queue.push(controlEvent(Event.Connected.type, {}))

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const heartbeat =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          flush()
          queue.push(controlEvent(Event.Heartbeat.type, {}))
        }, heartbeatIntervalMs)
      : undefined

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    GlobalBus.off("event", handler)
    flush()
    queue.push(null, { force: true })
  }

  const events = (async function* () {
    let reportedDropped = 0

    try {
      for await (const event of queue) {
        if (event === null) return

        const dropped = queue.dropped - reportedDropped
        if (dropped > 0) {
          reportedDropped = queue.dropped
          yield controlEvent(Event.Gap.type, { dropped })
        }

        yield event
      }
    } finally {
      close()
    }
  })()

  return { events, close }
}
