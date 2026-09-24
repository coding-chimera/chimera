import { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Sse from "effect/unstable/encoding/Sse"
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
  /**
   * (R1 B2) Abandoned-stream guard: if the consumer never starts iterating the
   * returned generator within this window, the stream closes itself so the
   * GlobalBus listener and heartbeat interval cannot leak. A healthy server
   * begins pulling the response body immediately after the handler returns;
   * 0 disables the guard.
   */
  startTimeoutMs?: number
}

const START_TIMEOUT_MS = 60_000

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
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
const pending = new Map<string, PendingDelta>()
  let flushTimer: Timer | undefined
  let startWatchdog: Timer | undefined
  let started = false
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
    if (startWatchdog) clearTimeout(startWatchdog)
    startWatchdog = undefined
    if (heartbeat) clearInterval(heartbeat)
    GlobalBus.off("event", handler)
    flush()
    queue.push(null, { force: true })
  }

  if (startTimeoutMs > 0) {
    startWatchdog = setTimeout(() => {
      if (!started) close()
    }, startTimeoutMs)
    startWatchdog.unref?.()
  }

  const events = (async function* () {
    started = true
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

const DEFAULT_MAX_CONNECTIONS = 64
const frameEncoder = new TextEncoder()

/**
 * Wire-identical replacement for the former per-connection
 * `Stream.map(eventData) |> Sse.encode() |> Stream.encodeText` pipeline: the
 * Sse encoder writes `data: <json>\n\n` for an untaged `message` event, so
 * encoding here once per event batch and fanning the same bytes out to every
 * connection keeps the wire contract byte-for-byte.
 */
function encodeFrame(event: GlobalEvent): Uint8Array {
  return frameEncoder.encode(
    Sse.encoder.write({
      _tag: "Event",
      event: "message",
      id: undefined,
      data: JSON.stringify(event),
    }),
  )
}

export interface SharedGlobalEventStreamOptions {
  capacity?: number
  heartbeatIntervalMs?: number
  /** 0 disables coalescing: every delta is forwarded as it arrives. */
  deltaMergeWindowMs?: number
  startTimeoutMs?: number
  /**
   * Hard cap on concurrent connections. Defaults to
   * `OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS` (positive integers only), then to
   * 64. `subscribe()` returns undefined when the cap is reached so the caller
   * can reject the connection (429).
   */
  maxConnections?: number
}

export interface SharedFrameSubscription {
  frames: AsyncGenerator<Uint8Array, void, unknown>
  close(): void
}

/**
 * (T0-3) Shared global SSE hub: one GlobalBus listener, one delta-merge
 * window, and one JSON.stringify + Sse encode per event batch for ALL
 * connections. The former per-connection `createGlobalEventStream` duplicated
 * merging and serialization once per open WebUI tab; every connection queue
 * here receives the same pre-encoded frame instances instead.
 *
 * Merge semantics are unchanged from the per-connection stream: deltaKey
 * identity, merge window measured from the first buffered delta, non-delta
 * events force a flush to keep causal order, per-connection drop-oldest queue
 * with undroppable gap markers. The bus listener and merge state are only
 * held while at least one connection is open (no idle residency).
 */
export function createSharedGlobalEventStream(options: SharedGlobalEventStreamOptions = {}) {
  const capacity = options.capacity ?? EVENT_QUEUE_CAPACITY
  const mergeWindowMs = options.deltaMergeWindowMs ?? DELTA_MERGE_WINDOW_MS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS

  const connections = new Set<{ queue: AsyncQueue<Uint8Array | null> }>()
  const pending = new Map<string, PendingDelta>()
  let flushTimer: Timer | undefined
  let busAttached = false

  const broadcast = (frame: Uint8Array) => {
    for (const connection of connections) connection.queue.push(frame)
  }

  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    for (const item of batch) broadcast(encodeFrame(item.merged > 1 ? mergedDeltaEvent(item) : item.event))
  }

  const handler = (event: GlobalEvent) => {
    // Consumers replay deltas on top of part snapshots, so anything that is not
    // a delta must be ordered after the deltas already buffered for that part.
    if (event.payload?.type !== DELTA_EVENT_TYPE) {
      flush()
      broadcast(encodeFrame(event))
      return
    }
    const key = mergeWindowMs > 0 ? deltaKey(event) : undefined
    if (!key) {
      broadcast(encodeFrame(event))
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

  const attachBus = () => {
    if (busAttached) return
    busAttached = true
    GlobalBus.on("event", handler)
  }

  const detachBusIfIdle = () => {
    if (!busAttached || connections.size > 0) return
    busAttached = false
    GlobalBus.off("event", handler)
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    pending.clear()
  }

  const subscribe = (): SharedFrameSubscription | undefined => {
    const maxConnections =
      options.maxConnections ?? Flag.OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS ?? DEFAULT_MAX_CONNECTIONS
    if (connections.size >= maxConnections) return
    attachBus()

    const queue = new AsyncQueue<Uint8Array | null>({ capacity, overflow: "drop-oldest" })
    const connection = { queue }
    connections.add(connection)
    let heartbeat: Timer | undefined
    let startWatchdog: Timer | undefined
    let started = false
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      if (startWatchdog) clearTimeout(startWatchdog)
      startWatchdog = undefined
      if (heartbeat) clearInterval(heartbeat)
      // Deliver shared buffered deltas to this connection before termination,
      // matching the per-connection close() contract.
      flush()
      connections.delete(connection)
      detachBusIfIdle()
      queue.push(null, { force: true })
    }

    if (heartbeatIntervalMs > 0) {
      heartbeat = setInterval(() => {
        flush()
        queue.push(encodeFrame(controlEvent(Event.Heartbeat.type, {})))
      }, heartbeatIntervalMs)
    }

    queue.push(encodeFrame(controlEvent(Event.Connected.type, {})))

    if (startTimeoutMs > 0) {
      startWatchdog = setTimeout(() => {
        if (!started) close()
      }, startTimeoutMs)
      startWatchdog.unref?.()
    }

    const frames = (async function* () {
      started = true
      let reportedDropped = 0

      try {
        for await (const frame of queue) {
          if (frame === null) return

          const dropped = queue.dropped - reportedDropped
          if (dropped > 0) {
            reportedDropped = queue.dropped
            yield encodeFrame(controlEvent(Event.Gap.type, { dropped }))
          }

          yield frame
        }
      } finally {
        close()
      }
    })()

    return { frames, close }
  }

  return {
    subscribe,
    get connections() {
      return connections.size
    },
  }
}

let shared: ReturnType<typeof createSharedGlobalEventStream> | undefined

/**
 * Process-wide default hub used by the effect-httpapi global event handler.
 * Created lazily on first connection; idle hubs hold no bus listener or
 * timers, so the singleton itself is the only resident state.
 */
export function sharedGlobalEventStream() {
  return (shared ??= createSharedGlobalEventStream())
}
