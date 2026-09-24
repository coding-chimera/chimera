import { describe, expect, test } from "bun:test"
import { GlobalBus } from "@/bus/global"
import { createSharedGlobalEventStream, type SharedFrameSubscription } from "@/server/global-event-stream"

const decoder = new TextDecoder()

type DecodedEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: { type: string; properties: Record<string, unknown> }
}

/**
 * Frames must be byte-identical to the former per-connection
 * `Sse.encode() |> encodeText` output: `data: <json>\n\n` (no id line, no
 * event line because the SSE event name is the default "message").
 */
function decodeFrame(frame: Uint8Array): DecodedEvent {
  const text = decoder.decode(frame)
  expect(text).toEndWith("\n\n")
  const body = text.slice(0, -2)
  expect(body).toStartWith("data: ")
  expect(body.includes("\n")).toBe(false)
  return JSON.parse(body.slice("data: ".length)) as DecodedEvent
}

function emit(type: string, scope: { directory?: string; project?: string; workspace?: string } = {}) {
  GlobalBus.emit("event", {
    directory: scope.directory ?? "/workspace",
    project: scope.project,
    workspace: scope.workspace,
    payload: {
      type,
      properties: {},
    },
  })
}

type DeltaScope = {
  directory?: string
  project?: string
  workspace?: string
  sessionID?: string
  messageID?: string
  partID?: string
  field?: string
}

function emitDelta(delta: string, scope: DeltaScope = {}) {
  GlobalBus.emit("event", {
    directory: scope.directory ?? "/workspace",
    project: scope.project,
    workspace: scope.workspace,
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: scope.sessionID ?? "ses_1",
        messageID: scope.messageID ?? "msg_1",
        partID: scope.partID ?? "prt_1",
        field: scope.field ?? "text",
        delta,
      },
    },
  })
}

async function nextFrame(subscription: SharedFrameSubscription) {
  const result = await subscription.frames.next()
  if (result.done || result.value === undefined) throw new Error("stream ended unexpectedly")
  return result.value
}

function subscribe(hub: ReturnType<typeof createSharedGlobalEventStream>) {
  const subscription = hub.subscribe()
  if (!subscription) throw new Error("subscribe rejected")
  return subscription
}

describe("shared global event stream", () => {
  test("shares one GlobalBus listener across connections and releases it when idle", () => {
    const before = GlobalBus.listenerCount("event")
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0 })
    const a = subscribe(hub)
    const b = subscribe(hub)
    expect(GlobalBus.listenerCount("event")).toBe(before + 1)
    expect(hub.connections).toBe(2)

    a.close()
    expect(GlobalBus.listenerCount("event")).toBe(before + 1)
    b.close()
    expect(GlobalBus.listenerCount("event")).toBe(before)
    expect(hub.connections).toBe(0)
  })

  test("serializes and encodes each event once for all connections", async () => {
    // The serialize seam counts only THIS hub's serialization. A process-wide
    // JSON.stringify spy is not usable here: in a shared test process other
    // live consumers (the default hub holding a draining SSE connection from
    // a prior file, legacy Hono connections) legitimately serialize the same
    // GlobalBus events.
    let serialized = 0
    const hub = createSharedGlobalEventStream({
      heartbeatIntervalMs: 0,
      serialize: (event) => {
        serialized += 1
        return JSON.stringify(event)
      },
    })
    const a = subscribe(hub)
    const b = subscribe(hub)
    try {
      decodeFrame(await nextFrame(a)) // connected
      decodeFrame(await nextFrame(b)) // connected
      serialized = 0

      emit("test.encode-once")
      const frameA = await nextFrame(a)
      const frameB = await nextFrame(b)

      // Both queues receive the identical pre-encoded frame instance, and the
      // hub serialized the event exactly once for both connections.
      expect(frameA).toBe(frameB)
      expect(decodeFrame(frameA).payload.type).toBe("test.encode-once")
      expect(serialized).toBe(1)
    } finally {
      a.close()
      b.close()
    }
  })

  test("coalesces deltas once for all connections", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 20 })
    const a = subscribe(hub)
    const b = subscribe(hub)
    try {
      await nextFrame(a)
      await nextFrame(b)
      emitDelta("Hello")
      emitDelta(", ")
      emitDelta("world")

      const frameA = await nextFrame(a)
      const frameB = await nextFrame(b)
      expect(frameA).toBe(frameB)
      expect(decodeFrame(frameA).payload).toMatchObject({
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "prt_1",
          field: "text",
          delta: "Hello, world",
        },
      })
    } finally {
      a.close()
      b.close()
    }
  })

  test("keeps deltas for different parts and envelopes separate", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 20 })
    const a = subscribe(hub)
    try {
      await nextFrame(a)
      emitDelta("a1", { partID: "prt_1" })
      emitDelta("b1", { partID: "prt_2" })
      emitDelta("a2", { partID: "prt_1" })
      // Same part ids on another instance must not merge into the local stream.
      emitDelta("c1", { directory: "/other", partID: "prt_1" })

      expect(decodeFrame(await nextFrame(a)).payload.properties).toMatchObject({ partID: "prt_1", delta: "a1a2" })
      expect(decodeFrame(await nextFrame(a)).payload.properties).toMatchObject({ partID: "prt_2", delta: "b1" })
      const remote = decodeFrame(await nextFrame(a))
      expect(remote.directory).toBe("/other")
      expect(remote.payload.properties).toMatchObject({ partID: "prt_1", delta: "c1" })
    } finally {
      a.close()
    }
  })

  test("flushes pending deltas before a non-delta event to keep causal order", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 5_000 })
    const a = subscribe(hub)
    try {
      await nextFrame(a)
      emitDelta("partial ")
      emitDelta("text")
      emit("message.part.updated")

      // The window is far longer than the test waits, so both frames can only
      // arrive because the non-delta event flushed the shared buffer first.
      expect(decodeFrame(await nextFrame(a)).payload).toMatchObject({
        type: "message.part.delta",
        properties: { delta: "partial text" },
      })
      expect(decodeFrame(await nextFrame(a)).payload.type).toBe("message.part.updated")
    } finally {
      a.close()
    }
  })

  test("forwards every delta untouched when coalescing is disabled", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 0 })
    const a = subscribe(hub)
    try {
      await nextFrame(a)
      emitDelta("one")
      emitDelta("two")
      expect(decodeFrame(await nextFrame(a)).payload.properties).toMatchObject({ delta: "one" })
      expect(decodeFrame(await nextFrame(a)).payload.properties).toMatchObject({ delta: "two" })
    } finally {
      a.close()
    }
  })

  test("emits an undroppable per-connection gap marker after queue overflow", async () => {
    const hub = createSharedGlobalEventStream({ capacity: 2, heartbeatIntervalMs: 0 })
    const a = subscribe(hub)
    try {
      emit("test.first")
      emit("test.second")
      emit("test.third")

      // The connected frame plus "test.first" were dropped from this
      // connection's 2-slot queue; the gap marker itself is undroppable.
      expect(decodeFrame(await nextFrame(a)).payload).toMatchObject({
        type: "server.event-gap",
        properties: { dropped: 2 },
      })
      const second = decodeFrame(await nextFrame(a))
      expect(second.directory).toBe("/workspace")
      expect(second.payload.type).toBe("test.second")
    } finally {
      a.close()
    }
  })

  test("delivers buffered deltas before a connection ends", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 60_000 })
    const a = subscribe(hub)
    await nextFrame(a)
    emitDelta("tail")
    a.close()

    expect(decodeFrame(await nextFrame(a)).payload.properties).toMatchObject({ delta: "tail" })
    expect(await a.frames.next()).toMatchObject({ done: true })
  })

  test("emits per-connection heartbeat frames", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 5 })
    const a = subscribe(hub)
    try {
      await nextFrame(a)
      expect(decodeFrame(await nextFrame(a)).payload.type).toBe("server.heartbeat")
    } finally {
      a.close()
    }
  })

  test("closes itself when never iterated (start watchdog)", async () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, startTimeoutMs: 20 })
    const a = subscribe(hub)
    expect(hub.connections).toBe(1)

    // Consumer never starts iterating: the start watchdog must release the slot.
    await Bun.sleep(80)
    expect(hub.connections).toBe(0)

    // A late consumer sees the buffered connected event and then termination.
    expect(decodeFrame(await nextFrame(a)).payload.type).toBe("server.connected")
    expect(await a.frames.next()).toMatchObject({ done: true })
  })

  test("rejects subscriptions beyond the configured connection cap", () => {
    const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0, maxConnections: 2 })
    const a = subscribe(hub)
    const b = subscribe(hub)
    try {
      expect(hub.connections).toBe(2)
      expect(hub.subscribe()).toBeUndefined()

      // A released slot is immediately reusable.
      a.close()
      const c = subscribe(hub)
      c.close()
    } finally {
      a.close()
      b.close()
    }
  })

  test("reads the default connection cap from OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS", () => {
    const previous = process.env["OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS"]
    process.env["OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS"] = "1"
    try {
      const hub = createSharedGlobalEventStream({ heartbeatIntervalMs: 0 })
      const a = subscribe(hub)
      try {
        expect(hub.subscribe()).toBeUndefined()
      } finally {
        a.close()
      }
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS"]
      else process.env["OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS"] = previous
    }
  })
})
