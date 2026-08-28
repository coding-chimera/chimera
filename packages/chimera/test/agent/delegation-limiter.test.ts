import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { SessionID } from "../../src/session/schema"
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
})
