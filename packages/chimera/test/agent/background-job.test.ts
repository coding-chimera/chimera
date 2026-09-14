import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { BackgroundJob } from "../../src/agent/background-job"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(BackgroundJob.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
})

const blocked = (gate: Deferred.Deferred<void>, output = "done") =>
  Effect.gen(function* () {
    yield* Deferred.await(gate)
    return output
  })

describe("agent.background-job", () => {
  it.instance(
    "starts a job as running and completes it via the done Deferred with output snapshot",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const started = yield* jobs.start({ id: "ses_job", type: "task", title: "probe", run: Effect.succeed("hello") })
        expect(started.status).toBe("running")
        expect(started.type).toBe("task")
        expect(started.title).toBe("probe")
        expect(started.started_at).toBeGreaterThan(0)
        expect(started.completed_at).toBeUndefined()

        const waited = yield* jobs.wait({ id: "ses_job" })
        expect(waited.timedOut).toBe(false)
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toBe("hello")
        expect(waited.info?.completed_at).toBeDefined()
        expect(waited.info?.error).toBeUndefined()

        const later = yield* jobs.get("ses_job")
        expect(later?.status).toBe("completed")
        expect(later?.output).toBe("hello")
      }),
  )

  it.instance(
    "deduplicates a second start of an already running id and runs the work only once",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const run = Effect.gen(function* () {
          runs += 1
          yield* Deferred.await(gate)
          return "out"
        })
        yield* jobs.start({ id: "ses_dup", run })
        yield* Effect.sleep(50)
        const second = yield* jobs.start({ id: "ses_dup", run })
        expect(second.status).toBe("running")
        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        const waited = yield* jobs.wait({ id: "ses_dup" })
        expect(waited.info?.output).toBe("out")
        expect(runs).toBe(1)
      }),
  )

  it.instance(
    "rejects cancelling a nonexistent job with undefined and leaves a completed job completed",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const missing = yield* jobs.cancel("ses_none")
        expect(missing).toBeUndefined()

        yield* jobs.start({ id: "ses_done", run: Effect.succeed("ok") })
        yield* Effect.sleep(20)
        const after = yield* jobs.cancel("ses_done")
        expect(after?.status).toBe("completed")
        expect((yield* jobs.get("ses_done"))?.status).toBe("completed")
      }),
  )

  it.instance(
    "cancels a running job to cancelled without an error, once",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "ses_cx", run: blocked(gate, "never") })
        yield* Effect.sleep(20)
        const cancelled = yield* jobs.cancel("ses_cx")
        expect(cancelled?.status).toBe("cancelled")
        expect(cancelled?.completed_at).toBeDefined()
        expect(cancelled?.error).toBeUndefined()
        const second = yield* jobs.cancel("ses_cx")
        expect(second?.status).toBe("cancelled")
      }),
  )

  it.instance(
    "marks a failed fiber as error with the error text and an interrupt-only fiber as cancelled",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        yield* jobs.start({ id: "ses_err", run: Effect.fail(new Error("boom")) })
        const failed = yield* jobs.wait({ id: "ses_err" })
        expect(failed.info?.status).toBe("error")
        expect(failed.info?.error).toContain("boom")

        yield* jobs.start({ id: "ses_int", run: Effect.interrupt })
        const interrupted = yield* jobs.wait({ id: "ses_int" })
        expect(interrupted.info?.status).toBe("cancelled")
      }),
  )

  it.instance(
    "wait returns the four documented shapes including the timeout path",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service

        const none = yield* jobs.wait({ id: "ses_missing", timeout: 10 })
        expect(none).toEqual({ timedOut: false })

        yield* jobs.start({ id: "ses_term", run: Effect.succeed("x") })
        yield* Effect.sleep(20)
        const terminal = yield* jobs.wait({ id: "ses_term", timeout: 10 })
        expect(terminal.timedOut).toBe(false)
        expect(terminal.info?.status).toBe("completed")

        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "ses_run", run: blocked(gate) })
        yield* Effect.sleep(20)

        const immediate = yield* jobs.wait({ id: "ses_run", timeout: 0 })
        expect(immediate.timedOut).toBe(true)
        expect(immediate.info?.status).toBe("running")

        const timed = yield* jobs.wait({ id: "ses_run", timeout: 50 })
        expect(timed.timedOut).toBe(true)
        expect(timed.info?.status).toBe("running")

        const waiting = yield* jobs.wait({ id: "ses_run" }).pipe(Effect.forkScoped)
        yield* Deferred.succeed(gate, undefined)
        const resolved = yield* Fiber.join(waiting)
        expect(resolved.timedOut).toBe(false)
        expect(resolved.info?.status).toBe("completed")
        expect(resolved.info?.output).toBe("done")
      }),
  )

  it.instance(
    "extend appends a serial segment that runs only after the previous one finishes",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const log: string[] = []
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({
          id: "ses_ext",
          run: Effect.gen(function* () {
            log.push("first-start")
            yield* Deferred.await(gate)
            log.push("first-end")
            return "first"
          }),
        })
        const extended = yield* jobs.extend({
          id: "ses_ext",
          run: Effect.sync(() => {
            log.push("second-start")
            log.push("second-end")
            return "second"
          }),
        })
        expect(extended).toBe(true)
        yield* Effect.sleep(30)
        expect(log).toEqual(["first-start"])
        yield* Deferred.succeed(gate, undefined)
        const waited = yield* jobs.wait({ id: "ses_ext" })
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toBe("second")
        expect(log).toEqual(["first-start", "first-end", "second-start", "second-end"])

        expect(yield* jobs.extend({ id: "ses_ext", run: Effect.succeed("late") })).toBe(false)
        expect(yield* jobs.extend({ id: "ses_gone", run: Effect.succeed("x") })).toBe(false)
      }),
  )

  it.instance(
    "fires onInterrupt only when the job ends cancelled",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        let interrupted = 0
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({
          id: "ses_oi",
          onInterrupt: Effect.sync(() => {
            interrupted += 1
          }),
          run: blocked(gate),
        })
        yield* Effect.sleep(20)
        yield* jobs.cancel("ses_oi")
        expect(interrupted).toBe(1)
        yield* jobs.cancel("ses_oi")
        expect(interrupted).toBe(1)

        yield* jobs.start({
          id: "ses_oerr",
          onInterrupt: Effect.sync(() => {
            interrupted += 1
          }),
          run: Effect.fail(new Error("boom")),
        })
        const failed = yield* jobs.wait({ id: "ses_oerr" })
        expect(failed.info?.status).toBe("error")
        expect(interrupted).toBe(1)
      }),
  )

  it.instance(
    "rejects start beyond background_concurrent with a clear error and accepts again after completion",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "ses_a", run: blocked(gate, "a") })
        yield* Effect.sleep(20)
        const rejected = yield* Effect.flip(jobs.start({ id: "ses_b", run: Effect.succeed("b") }))
        expect(rejected.message).toContain("background_concurrent")
        expect(rejected.message).toContain("ses_b")
        expect(rejected.limit).toBe(1)

        yield* Deferred.succeed(gate, undefined)
        const first = yield* jobs.wait({ id: "ses_a" })
        expect(first.info?.status).toBe("completed")
        const again = yield* jobs.start({ id: "ses_b", run: Effect.succeed("b") })
        expect(again.status).toBe("running")
        const second = yield* jobs.wait({ id: "ses_b" })
        expect(second.info?.output).toBe("b")
      }),
    { config: { delegation: { background_concurrent: 1 } } },
  )

  it.instance(
    "list and get return snapshots that do not leak internal mutations",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({
          id: "ses_snap",
          type: "task",
          ownerSessionId: "ses_parent",
          metadata: { model: "p/m" },
          run: blocked(gate),
        })
        yield* Effect.sleep(20)
        const snapshot = yield* jobs.get("ses_snap")
        if (snapshot?.metadata) snapshot.metadata["tamper"] = true
        const listed = yield* jobs.list()
        expect(listed.some((item) => item.id === "ses_snap")).toBe(true)
        const listedJob = listed.find((item) => item.id === "ses_snap")
        if (listedJob?.metadata) listedJob.metadata["tamper2"] = true
        const again = yield* jobs.get("ses_snap")
        expect(again?.metadata).toEqual({ sessionId: "ses_snap", parentSessionId: "ses_parent", model: "p/m" })
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.wait({ id: "ses_snap" })
      }),
  )

  it.instance(
    "waitOwnerQuiescent returns immediately when the owner has no jobs",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const out = yield* jobs.waitOwnerQuiescent("ghost-owner").pipe(Effect.as("done"), Effect.timeoutOption("200 millis"))
        expect(out._tag).toBe("Some")
      }),
  )

  it.instance(
    "waitOwnerQuiescent blocks while an owned running job is active and resolves after settle + markDelivered",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_run", ownerSessionId: "owner", run: blocked(gate) })
        yield* Effect.sleep(20)
        const waiter = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.forkScoped)
        const blockedProbe = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("40 millis"))
        expect(blockedProbe._tag).toBe("None")
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.markDelivered("q_run")
        const settled = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(settled?._tag).toBe("Some")
      }),
  )

  it.instance(
    "a settled but undelivered job still blocks quiescence until markDelivered (delivery window)",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_win", ownerSessionId: "owner", run: blocked(gate) })
        yield* Effect.sleep(20)
        const waiter = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.forkScoped)
        yield* Deferred.succeed(gate, undefined) // settle -> completed, delivery still pending
        yield* Effect.sleep(30) // let the settle propagate
        const during = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(during._tag).toBe("None")
        yield* jobs.markDelivered("q_win")
        const after = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(after?._tag).toBe("Some")
      }),
  )

  it.instance(
    "keeps blocking when the owner registers a new job while waiting",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate1 = yield* Deferred.make<void>()
        const gate2 = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_first", ownerSessionId: "owner", run: blocked(gate1) })
        yield* Effect.sleep(20)
        const waiter = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.forkScoped)
        yield* jobs.start({ id: "q_second", ownerSessionId: "owner", run: blocked(gate2) })
        yield* Deferred.succeed(gate1, undefined)
        yield* jobs.markDelivered("q_first")
        const still = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(still._tag).toBe("None") // q_second still running
        yield* Deferred.succeed(gate2, undefined)
        yield* jobs.markDelivered("q_second")
        const settled = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(settled?._tag).toBe("Some")
      }),
  )

  it.instance(
    "a cancelled job still blocks quiescence until markDelivered",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_cx", ownerSessionId: "owner", run: blocked(gate) })
        yield* Effect.sleep(20)
        yield* jobs.cancel("q_cx")
        const waiter = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.forkScoped)
        const blockedProbe = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("60 millis"))
        expect(blockedProbe._tag).toBe("None")
        yield* jobs.markDelivered("q_cx")
        const settled = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(settled?._tag).toBe("Some")
      }),
  )

  it.instance(
    "another owner's running job does not affect this owner's quiescence",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_other", ownerSessionId: "someone-else", run: blocked(gate) })
        yield* Effect.sleep(20)
        const out = yield* jobs.waitOwnerQuiescent("me").pipe(Effect.as("done"), Effect.timeoutOption("100 millis"))
        expect(out._tag).toBe("Some")
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.markDelivered("q_other")
      }),
  )

  it.instance(
    "markDelivered is idempotent for unknown and repeat ids",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        yield* jobs.markDelivered("missing")
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_alpha", ownerSessionId: "owner", run: blocked(gate) })
        yield* jobs.markDelivered("q_alpha")
        yield* jobs.markDelivered("q_alpha")
        yield* Effect.sleep(20)
        expect((yield* jobs.get("q_alpha"))?.delivery).toBe("delivered")
        const waiter = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.forkScoped)
        const blockedProbe = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("40 millis"))
        expect(blockedProbe._tag).toBe("None") // running status blocks regardless of delivery
        yield* Deferred.succeed(gate, undefined)
        const settled = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(settled?._tag).toBe("Some")
      }),
  )

  it.instance(
    "same-id restart bumps generation; markDelivered with a stale generation is a no-op and the current generation delivers",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate1 = yield* Deferred.make<void>()
        const first = yield* jobs.start({ id: "g_run", ownerSessionId: "owner", run: blocked(gate1) })
        expect(first.generation).toBe(1)
        yield* Effect.sleep(20)
        // Running short-circuit: the existing snapshot comes back with the generation unchanged.
        const dup = yield* jobs.start({ id: "g_run", run: Effect.succeed("never") })
        expect(dup.generation).toBe(1)
        yield* Deferred.succeed(gate1, undefined)
        yield* jobs.wait({ id: "g_run" })
        expect((yield* jobs.get("g_run"))?.generation).toBe(1) // settle preserves generation

        const gate2 = yield* Deferred.make<void>()
        const second = yield* jobs.start({ id: "g_run", ownerSessionId: "owner", run: blocked(gate2) })
        expect(second.generation).toBe(2)
        yield* Effect.sleep(20)

        // A stale notify fiber from generation 1 must not deliver the running generation 2.
        yield* jobs.markDelivered("g_run", 1)
        expect((yield* jobs.get("g_run"))?.delivery).toBe("pending")

        yield* Deferred.succeed(gate2, undefined)
        yield* jobs.wait({ id: "g_run" })
        yield* jobs.markDelivered("g_run", 2)
        expect((yield* jobs.get("g_run"))?.delivery).toBe("delivered")
      }),
  )

  it.instance(
    "waitOwnerQuiescent survives a stale delivery mark: same-id restart keeps the wait alive until the new generation settles and delivers",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate1 = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_gen", ownerSessionId: "owner", run: blocked(gate1) })
        yield* Effect.sleep(20)
        const waiter = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.forkScoped)
        yield* Deferred.succeed(gate1, undefined)
        yield* jobs.wait({ id: "q_gen" }) // settled, delivery pending: the long notify-injection window

        // Restart over the settled entry while the old notify fiber is still injecting.
        const gate2 = yield* Deferred.make<void>()
        const second = yield* jobs.start({ id: "q_gen", ownerSessionId: "owner", run: blocked(gate2) })
        expect(second.generation).toBe(2)
        yield* Effect.sleep(20)

        // The stale fiber finishes and marks by id + old generation: no-op.
        yield* jobs.markDelivered("q_gen", 1)
        expect((yield* jobs.get("q_gen"))?.delivery).toBe("pending")

        yield* Deferred.succeed(gate2, undefined)
        yield* jobs.wait({ id: "q_gen" })
        const early = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(early._tag).toBe("None") // settled but undelivered: not quiescent yet

        yield* jobs.markDelivered("q_gen", 2)
        const settled = yield* Fiber.await(waiter).pipe(Effect.timeoutOption("80 millis"))
        expect(settled?._tag).toBe("Some")
      }),
  )

  it.instance(
    "markDelivered without a generation keeps the legacy by-id behavior",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({ id: "q_legacy", ownerSessionId: "owner", run: blocked(gate) })
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.wait({ id: "q_legacy" })
        yield* jobs.markDelivered("q_legacy")
        expect((yield* jobs.get("q_legacy"))?.delivery).toBe("delivered")
        const quiet = yield* jobs.waitOwnerQuiescent("owner").pipe(Effect.as("ok"), Effect.timeoutOption("100 millis"))
        expect(quiet._tag).toBe("Some")
      }),
  )

  it.instance(
    "engine projection drift-guard: metadata.parentSessionId === ownerSessionId and metadata.sessionId === id after start/extend/settle",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        yield* jobs.start({
          id: "dg1",
          ownerSessionId: "dg-owner",
          metadata: { model: "p/m", background: true },
          run: blocked(gate),
        })
        const atStart = yield* jobs.get("dg1")
        expect(atStart?.ownerSessionId).toBe("dg-owner")
        expect(atStart?.metadata?.parentSessionId).toBe(atStart?.ownerSessionId)
        expect(atStart?.metadata?.sessionId).toBe("dg1")
        expect(atStart?.delivery).toBe("pending")
        expect(yield* jobs.extend({ id: "dg1", run: Effect.succeed("x") })).toBe(true)
        const afterExtend = yield* jobs.get("dg1")
        expect(afterExtend?.metadata?.parentSessionId).toBe(afterExtend?.ownerSessionId)
        expect(afterExtend?.metadata?.sessionId).toBe("dg1")
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.wait({ id: "dg1" })
        const afterSettle = yield* jobs.get("dg1")
        expect(afterSettle?.status).toBe("completed")
        expect(afterSettle?.metadata?.parentSessionId).toBe(afterSettle?.ownerSessionId)
        expect(afterSettle?.metadata?.sessionId).toBe("dg1")
        expect(afterSettle?.delivery).toBe("pending") // engine never auto-delivers
        yield* jobs.markDelivered("dg1")
        expect((yield* jobs.get("dg1"))?.delivery).toBe("delivered")
        const quiet = yield* jobs.waitOwnerQuiescent("dg-owner").pipe(Effect.as("ok"), Effect.timeoutOption("100 millis"))
        expect(quiet._tag).toBe("Some")
        // No owner: sessionId projection only; parentSessionId must not appear.
        yield* jobs.start({ id: "dg2", run: Effect.succeed("y") })
        const plain = yield* jobs.get("dg2")
        expect(plain?.metadata?.sessionId).toBe("dg2")
        expect(plain?.ownerSessionId).toBeUndefined()
        expect("parentSessionId" in (plain?.metadata ?? {})).toBe(false)
      }),
  )
})