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
          metadata: { parentSessionId: "ses_parent", model: "p/m" },
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
        expect(again?.metadata).toEqual({ parentSessionId: "ses_parent", model: "p/m" })
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.wait({ id: "ses_snap" })
      }),
  )
})