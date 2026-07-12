import { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Event } from "./event"

const EVENT_QUEUE_CAPACITY = 1024
const HEARTBEAT_INTERVAL_MS = 10_000

export interface GlobalEventStreamOptions {
  capacity?: number
  heartbeatIntervalMs?: number
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

export function createGlobalEventStream(options: GlobalEventStreamOptions = {}) {
  const queue = new AsyncQueue<GlobalEvent | null>({
    capacity: options.capacity ?? EVENT_QUEUE_CAPACITY,
    overflow: "drop-oldest",
  })
  const handler = (event: GlobalEvent) => queue.push(event)
  let closed = false

  GlobalBus.on("event", handler)
  queue.push(controlEvent(Event.Connected.type, {}))

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const heartbeat =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          queue.push(controlEvent(Event.Heartbeat.type, {}))
        }, heartbeatIntervalMs)
      : undefined

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    GlobalBus.off("event", handler)
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
