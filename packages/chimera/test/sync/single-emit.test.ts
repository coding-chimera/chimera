import { describe, expect, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The sync layer must put each event on the global stream exactly once for
// default (non-workspace) runtimes. `ProjectBus.publish` already forwards the
// converted bus payload to `GlobalBus`; the extra `sync` envelope is replication
// metadata that only remote workspaces consume, so it is gated on the
// experimental workspaces flag that also gates event persistence.

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const it = testEffect(Layer.mergeAll(SyncEvent.defaultLayer, CrossSpawnSpawner.defaultLayer))
const sessionLayers = Layer.mergeAll(Session.defaultLayer, Bus.defaultLayer, SyncEvent.defaultLayer)
const workspaceID = WorkspaceID.ascending("wrk_single_emit")
const slotRules = [{ permission: "task", pattern: "*", action: "deny" as const }]

afterEach(() => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
})

function capture() {
  const global: GlobalEvent[] = []
  const handler = (event: GlobalEvent) => global.push(event)
  GlobalBus.on("event", handler)
  return {
    global,
    dispose: () => GlobalBus.off("event", handler),
  }
}

const runInWorkspace = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.promise(() =>
    WorkspaceContext.provide({
      workspaceID,
      async fn() {
        return Effect.runPromise(effect)
      },
    }),
  )

const settle = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

describe("SyncEvent global stream", () => {
  it.live("emits one frame per event when workspaces are disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const sync = yield* SyncEvent.Service
        const info = yield* svc.create({})
        const captured = capture()
        try {
          Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = false
          yield* runInWorkspace(
            sync.run(Session.Event.PermissionSlot, {
              sessionID: info.id,
              rules: slotRules,
              timestamp: 1234,
            }),
          )
          yield* settle()

          const slot = captured.global.filter((event) => event.payload.type === Session.Event.PermissionSlot.type)
          expect(slot).toHaveLength(1)
          expect(slot[0].payload.properties).toMatchObject({ sessionID: info.id, rules: slotRules })
          expect(captured.global.filter((event) => event.payload.type === "sync")).toHaveLength(0)
        } finally {
          captured.dispose()
        }
      }).pipe(Effect.provide(sessionLayers)),
    ),
  )

  it.live("keeps the replication envelope when workspaces are enabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const sync = yield* SyncEvent.Service
        const info = yield* svc.create({})
        const captured = capture()
        try {
          Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
          yield* runInWorkspace(
            sync.run(Session.Event.PermissionSlot, {
              sessionID: info.id,
              rules: slotRules,
              timestamp: 1234,
            }),
          )
          yield* settle()

          expect(
            captured.global.filter((event) => event.payload.type === Session.Event.PermissionSlot.type),
          ).toHaveLength(1)
          const syncs = captured.global.filter(
            (event) => event.payload.type === "sync" && event.payload.syncEvent.aggregateID === info.id,
          )
          expect(syncs.map((event) => event.payload.syncEvent.type).sort()).toEqual([
            "session.permission.slot.1",
            "session.updated.1",
          ])
        } finally {
          captured.dispose()
        }
      }).pipe(Effect.provide(sessionLayers)),
    ),
  )
})