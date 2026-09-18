/**
 * (R1 A3) Durable background-job registry: write-through persistence to the
 * `background_job` table, open-time reconciliation of phantom `running` rows,
 * durable fallback in get/list/wait, and the settled+delivered live-entry cap.
 *
 * These tests drive `BackgroundJob.make` directly with explicit directory keys
 * so a "process restart" is simulated by opening a second registry on the same
 * key — no instance machinery required.
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { BackgroundJob } from "../../src/agent/background-job"
import { Config } from "../../src/config/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Config.defaultLayer)

function testDirectory(kind: string) {
  return `/tmp/a3-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

describe("agent.background-job durable registry (R1 A3)", () => {
  it.instance("get/list/wait survive a registry restart via the durable table", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const dir = testDirectory("restart")
      const first = yield* BackgroundJob.make(config, dir)
      yield* first.start({ id: "ses_a3_restart", title: "probe", run: Effect.succeed("payload") })
      const waited = yield* first.wait({ id: "ses_a3_restart" })
      expect(waited.info?.status).toBe("completed")
      yield* first.markDelivered("ses_a3_restart")

      // Simulated process restart: a fresh registry keyed by the same directory.
      const second = yield* BackgroundJob.make(config, dir)
      const recovered = yield* second.get("ses_a3_restart")
      expect(recovered?.status).toBe("completed")
      expect(recovered?.output).toBe("payload")
      expect(recovered?.title).toBe("probe")

      const list = yield* second.list()
      expect(list.map((job) => job.id)).toContain("ses_a3_restart")

      const rewait = yield* second.wait({ id: "ses_a3_restart" })
      expect(rewait.timedOut).toBe(false)
      expect(rewait.info?.output).toBe("payload")

      // A never-seen id still resolves to undefined, not a durable phantom.
      expect(yield* second.get("ses_a3_never_started")).toBeUndefined()
    }),
  )

  it.instance("running rows left by a dead process reconcile to an interrupted terminal state", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const dir = testDirectory("crash")
      const first = yield* BackgroundJob.make(config, dir)
      const gate = yield* Deferred.make<void>()
      yield* first.start({
        id: "ses_a3_crash",
        ownerSessionId: "ses_a3_owner",
        run: Deferred.await(gate).pipe(Effect.as("late")),
      })

      // "Crash": the registry is abandoned mid-run; its durable row says running.
      const second = yield* BackgroundJob.make(config, dir)
      const recovered = yield* second.get("ses_a3_crash")
      expect(recovered?.status).toBe("error")
      expect(recovered?.error).toContain("interrupted")
      // Delivered so waitOwnerQuiescent can never park on a phantom injection.
      expect(recovered?.delivery).toBe("delivered")

      // The live map of the new registry does not count the phantom as running:
      // a fresh job with the same id starts at generation+1.
      const restarted = yield* second.start({ id: "ses_a3_crash", run: Effect.succeed("again") })
      expect(restarted.status).toBe("running")
      expect(restarted.generation).toBe(2)
      yield* second.wait({ id: "ses_a3_crash" })
      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.instance("evicts settled+delivered live entries past settledLiveMax", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      // In-memory registry (no directory): eviction is directly observable.
      const jobs = yield* BackgroundJob.make(config, undefined, { settledLiveMax: 3 })
      for (let i = 0; i < 6; i++) {
        yield* jobs.start({ id: `ses_a3_evict_${i}`, run: Effect.succeed(`out-${i}`) })
        yield* jobs.wait({ id: `ses_a3_evict_${i}` })
        yield* jobs.markDelivered(`ses_a3_evict_${i}`)
      }
      const list = yield* jobs.list()
      expect(list.length).toBe(3)
      expect(yield* jobs.get("ses_a3_evict_0")).toBeUndefined()
      expect((yield* jobs.get("ses_a3_evict_5"))?.status).toBe("completed")
    }),
  )

  it.instance("delivery-pending settled entries are never evicted", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const jobs = yield* BackgroundJob.make(config, undefined, { settledLiveMax: 1 })
      // Two settled jobs whose delivery is still pending must both survive the
      // cap — waitOwnerQuiescent relies on them.
      yield* jobs.start({ id: "ses_a3_pending_0", ownerSessionId: "ses_a3_owner", run: Effect.succeed("a") })
      yield* jobs.start({ id: "ses_a3_pending_1", ownerSessionId: "ses_a3_owner", run: Effect.succeed("b") })
      yield* jobs.wait({ id: "ses_a3_pending_0" })
      yield* jobs.wait({ id: "ses_a3_pending_1" })

      let quiescent = false
      const park = yield* Effect.forkScoped(
        jobs.waitOwnerQuiescent("ses_a3_owner").pipe(Effect.tap(() => Effect.sync(() => (quiescent = true)))),
      )
      yield* Effect.sleep(20)
      expect(quiescent).toBe(false)

      yield* jobs.markDelivered("ses_a3_pending_0")
      yield* Effect.sleep(20)
      expect(quiescent).toBe(false)

      yield* jobs.markDelivered("ses_a3_pending_1")
      yield* Fiber.await(park)
      expect(quiescent).toBe(true)
      const list = yield* jobs.list()
      expect(list.length).toBe(1)
    }),
  )

  it.instance("evicted entries keep serving from the durable table", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const dir = testDirectory("evict-durable")
      const jobs = yield* BackgroundJob.make(config, dir, { settledLiveMax: 2 })
      for (let i = 0; i < 4; i++) {
        yield* jobs.start({ id: `ses_a3_durable_${i}`, run: Effect.succeed(`out-${i}`) })
        yield* jobs.wait({ id: `ses_a3_durable_${i}` })
        yield* jobs.markDelivered(`ses_a3_durable_${i}`)
      }
      // Live map capped at 2, but the durable rows keep every job readable.
      const list = yield* jobs.list()
      expect(list.length).toBe(4)
      const evicted = yield* jobs.get("ses_a3_durable_0")
      expect(evicted?.status).toBe("completed")
      expect(evicted?.output).toBe("out-0")
    }),
  )
})
