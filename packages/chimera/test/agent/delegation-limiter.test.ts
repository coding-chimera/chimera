import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { SessionID } from "../../src/contracts/session-ids"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(DelegationLimiter.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("agent.delegation-limiter", () => {
  it.instance(
    "queues runs beyond the configured concurrency budget until capacity frees",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        const started: string[] = []
        let release!: () => void
        const gate = new Promise<void>((done) => {
          release = done
        })

        const run = (name: string) =>
          limiter.run({
            parentSessionID: root,
            sessionID: SessionID.make(name),
            effect: Effect.gen(function* () {
              started.push(name)
              yield* Effect.promise(() => gate)
            }),
          })

        const fiberA = yield* run("ses_a").pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        const fiberB = yield* run("ses_b").pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        expect(started).toEqual(["ses_a"])

        release()
        yield* Fiber.join(fiberA)
        yield* Fiber.join(fiberB)
        expect(started).toEqual(["ses_a", "ses_b"])
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )

  it.instance(
    "lends the waiting parent's permit to child runs instead of deadlocking",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        const parent = SessionID.make("ses_parent")
        const done: string[] = []

        yield* limiter.run({
          parentSessionID: root,
          sessionID: parent,
          effect: Effect.gen(function* () {
            yield* limiter.run({
              parentSessionID: parent,
              sessionID: SessionID.make("ses_child1"),
              effect: Effect.sync(() => done.push("child1")),
            })
            yield* limiter.run({
              parentSessionID: parent,
              sessionID: SessionID.make("ses_child2"),
              effect: Effect.sync(() => done.push("child2")),
            })
            done.push("parent")
          }),
        })

        expect(done).toEqual(["child1", "child2", "parent"])
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )

  it.instance(
    "keeps the permit with the borrower when the lender finishes first",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        const parent = SessionID.make("ses_parent")
        const started: string[] = []
        let openChild!: () => void
        const childGate = new Promise<void>((done) => {
          openChild = done
        })

        // The parent takes the only permit, lends it to the forked child, then finishes
        // while the child is still running.
        yield* limiter.run({
          parentSessionID: root,
          sessionID: parent,
          effect: limiter
            .run({
              parentSessionID: parent,
              sessionID: SessionID.make("ses_child"),
              effect: Effect.gen(function* () {
                started.push("ses_child")
                yield* Effect.promise(() => childGate)
              }),
            })
            .pipe(Effect.forkScoped, Effect.asVoid),
        })
        yield* Effect.sleep(50)
        expect(started).toEqual(["ses_child"])

        // The pool is empty: an unrelated run must queue until the child releases.
        let next = false
        const fiberNext = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: SessionID.make("ses_next"),
            effect: Effect.sync(() => {
              next = true
            }),
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        expect(next).toBe(false)

        openChild()
        yield* Fiber.join(fiberNext)
        expect(next).toBe(true)
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )

  it.instance(
    "serializes concurrent runs on the same session and returns the permit afterwards",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        const same = SessionID.make("ses_same")
        const order: string[] = []
        const gate = yield* Deferred.make<void>()
        const first = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: same,
            effect: Effect.gen(function* () {
              order.push("first")
              yield* Deferred.await(gate)
            }),
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        const second = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: same,
            effect: Effect.sync(() => order.push("second")),
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        expect(order).toEqual(["first"])
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(order).toEqual(["first", "second"])
        // The same-session runs must not have consumed each other's permit.
        const after = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: SessionID.make("ses_after_same"),
            effect: Effect.succeed("ok"),
          })
          .pipe(Effect.timeoutOption("500 millis"))
        expect(after._tag).toBe("Some")
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )

  it.instance(
    "concurrent runs on the same session at max=2 each release their own permit",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        const same = SessionID.make("ses_same")
        const gate = yield* Deferred.make<void>()
        const run = (name: string) =>
          limiter.run({
            parentSessionID: root,
            sessionID: same,
            effect: Deferred.await(gate).pipe(Effect.as(name)),
          })
        const a = yield* run("a").pipe(Effect.forkScoped)
        const b = yield* run("b").pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(a)
        yield* Fiber.join(b)
        // Both permits must be back in the pool: with per-session registration
        // one run's release used to drop the other run's permit.
        const first = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: SessionID.make("ses_after_same_1"),
            effect: Effect.succeed("1"),
          })
          .pipe(Effect.timeoutOption("500 millis"))
        expect(first._tag).toBe("Some")
        const second = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: SessionID.make("ses_after_same_2"),
            effect: Effect.succeed("2"),
          })
          .pipe(Effect.timeoutOption("500 millis"))
        expect(second._tag).toBe("Some")
      }),
    { config: { delegation: { max_concurrent: 2 } } },
  )

  it.instance(
    "interrupting a run right after acquire does not leak the permit",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        // Repeat to sample the take-success -> holder-register window.
        for (let i = 0; i < 25; i++) {
          const fiber = yield* limiter
            .run({
              parentSessionID: root,
              sessionID: SessionID.make(`ses_int_${i}`),
              effect: Effect.never,
            })
            .pipe(Effect.forkScoped)
          yield* Fiber.interrupt(fiber)
        }
        const after = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: SessionID.make("ses_after_interrupt"),
            effect: Effect.succeed("ok"),
          })
          .pipe(Effect.timeoutOption("500 millis"))
        expect(after._tag).toBe("Some")
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )

  it.instance(
    "returns the permit to the pool after a multi-level borrow chain unwinds",
    () =>
      Effect.gen(function* () {
        const limiter = yield* DelegationLimiter.Service
        const root = SessionID.make("ses_root")
        const parent = SessionID.make("ses_parent")
        const child = SessionID.make("ses_child")
        const started: string[] = []
        let openGrandchild!: () => void
        const gate = new Promise<void>((done) => {
          openGrandchild = done
        })

        // root holds the only permit; parent borrows it, child borrows from parent,
        // and the grandchild ends up owning the chain while parent/child finish.
        yield* limiter.run({
          parentSessionID: root,
          sessionID: parent,
          effect: limiter.run({
            parentSessionID: parent,
            sessionID: child,
            effect: limiter
              .run({
                parentSessionID: child,
                sessionID: SessionID.make("ses_grandchild"),
                effect: Effect.gen(function* () {
                  started.push("grandchild")
                  yield* Effect.promise(() => gate)
                }),
              })
              .pipe(Effect.forkScoped, Effect.asVoid),
          }),
        })
        yield* Effect.sleep(50)
        expect(started).toEqual(["grandchild"])

        let next = false
        const fiberNext = yield* limiter
          .run({
            parentSessionID: root,
            sessionID: SessionID.make("ses_next"),
            effect: Effect.sync(() => {
              next = true
            }),
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(50)
        expect(next).toBe(false)

        openGrandchild()
        yield* Fiber.join(fiberNext)
        expect(next).toBe(true)
      }),
    { config: { delegation: { max_concurrent: 1 } } },
  )
})
