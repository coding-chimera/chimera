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
})
