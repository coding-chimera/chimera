/**
 * (Phase 4) SessionActivity.waitQuiescent is event-driven: it wakes on family
 * SessionStatus transitions and on the BackgroundJob settle/delivery deferreds,
 * with a slow fallback timer instead of the old 50ms family poll. `isActive`
 * semantics are unchanged (family non-idle ∨ family-owned running∨delivery-
 * pending job).
 */
import { describe, expect, spyOn } from "bun:test"
import { Effect, Fiber, Layer, Ref } from "effect"
import { BackgroundJob } from "../../src/agent/background-job"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { SessionID } from "../../src/contracts/session-ids"
import { Session } from "../../src/session/session"
import { SessionActivity } from "../../src/session/activity"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"

const deps = Layer.mergeAll(
  Config.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  BackgroundJob.defaultLayer,
  Bus.layer,
)
const activity = SessionActivity.layer.pipe(Layer.provideMerge(deps))
const it = testEffect(Layer.mergeAll(deps, activity))

// A status service whose `set` never publishes a bus event: it simulates a
// dropped wake-up so the fallback timer is the only path to resolution.
const silentStatus = Layer.effect(
  SessionStatus.Service,
  Effect.gen(function* () {
    const busy = yield* Ref.make(true)
    return SessionStatus.Service.of({
      get: () =>
        Ref.get(busy).pipe(
          Effect.map((value): SessionStatus.Info => (value ? { type: "busy" } : { type: "idle" })),
        ),
      list: () => Effect.succeed(new Map<SessionID, SessionStatus.Info>()),
      set: (_sessionID, status) => Ref.set(busy, status.type !== "idle"),
    })
  }),
)
const silentDeps = Layer.mergeAll(
  Config.defaultLayer,
  Session.defaultLayer,
  silentStatus,
  BackgroundJob.defaultLayer,
  Bus.layer,
)
const silentIt = testEffect(Layer.mergeAll(silentDeps, SessionActivity.layer.pipe(Layer.provideMerge(silentDeps))))

describe("session.activity waitQuiescent", () => {
  it.instance("wakes on a family status transition instead of polling the family", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const service = yield* SessionActivity.Service
      const chat = yield* sessions.create({ title: "activity-event" })

      yield* status.set(chat.id, { type: "busy" })
      const childrenIDs = spyOn(sessions, "childrenIDs")
      try {
        const waiting = yield* service.waitQuiescent(chat.id).pipe(Effect.forkChild)
        // A polling implementation re-reads the family on every tick; the
        // event-driven one reads it once per iteration and then blocks.
        yield* Effect.sleep("300 millis")
        expect(childrenIDs.mock.calls.length).toBeLessThanOrEqual(2)
        expect((yield* Fiber.await(waiting).pipe(Effect.timeoutOption("10 millis")))._tag).toBe("None")

        const wakeStartedAt = Date.now()
        yield* status.set(chat.id, { type: "idle" })
        const settled = yield* Fiber.await(waiting).pipe(Effect.timeoutOption("1 second"))
        expect(settled._tag).toBe("Some")
        // Event-driven wake-up, not a tick (the old cadence was 50ms) and far
        // below the 2s fallback timer.
        expect(Date.now() - wakeStartedAt).toBeLessThan(40)
      } finally {
        childrenIDs.mockRestore()
      }
    }),
  )

  silentIt.instance("fallback timer resolves a wait whose wake-up event never arrives", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const service = yield* SessionActivity.Service
      const chat = yield* sessions.create({ title: "activity-fallback" })

      const startedAt = Date.now()
      const waiting = yield* service.waitQuiescent(chat.id).pipe(Effect.forkChild)
      yield* Effect.sleep("100 millis")
      // Flip the status WITHOUT publishing a bus event.
      yield* status.set(chat.id, { type: "idle" })
      yield* Fiber.await(waiting).pipe(Effect.timeout("10 seconds"))
      const elapsed = Date.now() - startedAt
      // The event was dropped, so only the 2s fallback timer can notice.
      expect(elapsed).toBeGreaterThanOrEqual(1_500)
      expect(elapsed).toBeLessThan(6_000)
    }),
  )
})