import { describe, expect, test } from "bun:test"
import { GlobalBus } from "@/bus/global"
import { createGlobalEventStream } from "@/server/global-event-stream"

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

describe("global event stream", () => {
  test("emits schema-valid connected events", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0 })

    try {
      expect(await stream.events.next()).toMatchObject({
        done: false,
        value: {
          directory: "global",
          payload: {
            type: "server.connected",
            properties: {},
          },
        },
      })
    } finally {
      stream.close()
    }
  })

  test("emits schema-valid heartbeat events", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 5 })

    try {
      await stream.events.next()
      expect(await stream.events.next()).toMatchObject({
        done: false,
        value: {
          directory: "global",
          payload: {
            type: "server.heartbeat",
            properties: {},
          },
        },
      })
    } finally {
      stream.close()
    }
  })

  test("preserves forwarded project and workspace scope", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0 })

    try {
      await stream.events.next()
      emit("test.scoped", { directory: "/workspace", project: "project-1", workspace: "workspace-1" })
      expect(await stream.events.next()).toMatchObject({
        done: false,
        value: {
          directory: "/workspace",
          project: "project-1",
          workspace: "workspace-1",
          payload: { type: "test.scoped" },
        },
      })
    } finally {
      stream.close()
    }
  })

  test("emits an undroppable gap marker after queue overflow", async () => {
    const stream = createGlobalEventStream({ capacity: 2, heartbeatIntervalMs: 0 })

    try {
      emit("test.first")
      emit("test.second")
      emit("test.third")

      expect(await stream.events.next()).toMatchObject({
        done: false,
        value: {
          directory: "global",
          payload: {
            type: "server.event-gap",
            properties: { dropped: 2 },
          },
        },
      })
      expect(await stream.events.next()).toMatchObject({
        done: false,
        value: {
          directory: "/workspace",
          payload: { type: "test.second" },
        },
      })
    } finally {
      stream.close()
    }
  })

  test("coalesces deltas for the same part field into one event", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 20 })

    try {
      await stream.events.next()
      emitDelta("Hello")
      emitDelta(", ")
      emitDelta("world")

      const merged = await stream.events.next()
      expect(merged.value?.payload).toMatchObject({
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
      stream.close()
    }
  })

  test("keeps deltas for different parts and envelopes separate", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 20 })

    try {
      await stream.events.next()
      emitDelta("a1", { partID: "prt_1" })
      emitDelta("b1", { partID: "prt_2" })
      emitDelta("a2", { partID: "prt_1" })
      // Same part ids on another instance must not merge into the local stream.
      emitDelta("c1", { directory: "/other", partID: "prt_1" })

      expect((await stream.events.next()).value?.payload?.properties).toMatchObject({
        partID: "prt_1",
        delta: "a1a2",
      })
      expect((await stream.events.next()).value?.payload?.properties).toMatchObject({
        partID: "prt_2",
        delta: "b1",
      })
      expect((await stream.events.next()).value).toMatchObject({
        directory: "/other",
        payload: { properties: { partID: "prt_1", delta: "c1" } },
      })
    } finally {
      stream.close()
    }
  })

  test("flushes pending deltas before a non-delta event to keep causal order", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 5_000 })

    try {
      await stream.events.next()
      emitDelta("partial ")
      emitDelta("text")
      emit("message.part.updated")

      // The window is far longer than the test waits, so both events can only
      // arrive because the non-delta event flushed the buffer first.
      expect((await stream.events.next()).value?.payload).toMatchObject({
        type: "message.part.delta",
        properties: { delta: "partial text" },
      })
      expect((await stream.events.next()).value?.payload).toMatchObject({ type: "message.part.updated" })
    } finally {
      stream.close()
    }
  })

  test("forwards every delta untouched when coalescing is disabled", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 0 })

    try {
      await stream.events.next()
      emitDelta("one")
      emitDelta("two")

      expect((await stream.events.next()).value?.payload?.properties).toMatchObject({ delta: "one" })
      expect((await stream.events.next()).value?.payload?.properties).toMatchObject({ delta: "two" })
    } finally {
      stream.close()
    }
  })

  test("delivers buffered deltas before the stream ends", async () => {
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, deltaMergeWindowMs: 60_000 })

    try {
      await stream.events.next()
      emitDelta("tail")
      stream.close()

      expect((await stream.events.next()).value?.payload?.properties).toMatchObject({ delta: "tail" })
      expect(await stream.events.next()).toMatchObject({ done: true })
    } finally {
      stream.close()
    }
  })

  test("closes itself and releases the GlobalBus listener when never iterated (R1 B2)", async () => {
    const before = GlobalBus.listenerCount("event")
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, startTimeoutMs: 20 })
    expect(GlobalBus.listenerCount("event")).toBe(before + 1)

    // Consumer never starts iterating: the start watchdog must close the stream.
    await Bun.sleep(80)
    expect(GlobalBus.listenerCount("event")).toBe(before)

    // A late consumer sees the buffered connected event and then termination.
    expect((await stream.events.next()).value?.payload?.type).toBe("server.connected")
    expect(await stream.events.next()).toMatchObject({ done: true })
  })

  test("the start watchdog does not fire once iteration began", async () => {
    const before = GlobalBus.listenerCount("event")
    const stream = createGlobalEventStream({ heartbeatIntervalMs: 0, startTimeoutMs: 20 })
    try {
      await stream.events.next()
      await Bun.sleep(80)
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
    } finally {
      stream.close()
    }
    expect(GlobalBus.listenerCount("event")).toBe(before)
  })
})
