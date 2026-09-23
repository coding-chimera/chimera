// (F4-P2) Dispose matrix: every teardown path that must reach a background-job
// engine entry, verified end to end —
//   1. instance dispose interrupts running jobs (registry scope close),
//   2. instance dispose cancels all live session runners (run-state finalizer,
//      the "instance dispose 全杀" leg of the matrix),
//   3. session.remove single-level cleanup cancels the session-as-job and the
//      jobs it dispatched, hooks firing exactly once ("父会话 remove" /
//      "孤儿后台子" legs; the transitive closure is the cancel cascade, covered
//      by task-cancel and swarm engine tests).
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import { BackgroundJob } from "../../src/agent/background-job"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(BackgroundJob.defaultLayer, CrossSpawnSpawner.defaultLayer))
const itRunState = testEffect(
  Layer.mergeAll(SessionRunState.defaultLayer, BackgroundJob.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const itSession = testEffect(
  Layer.mergeAll(Session.defaultLayer, BackgroundJob.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("agent.background-job dispose matrix (F4-P2)", () => {
  it.live("instance dispose interrupts running jobs and fires their interrupt hooks", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const jobs = yield* BackgroundJob.Service
          yield* jobs.start({
            id: "ses_dispose_job",
            ownerSessionId: "ses_dispose_owner",
            onInterrupt: Deferred.succeed(interrupted, undefined),
            run: Effect.never,
          })
          expect((yield* jobs.get("ses_dispose_job"))?.status).toBe("running")
        }),
      )
      // The job fiber outlives the provideInstance block: it is forked into the
      // registry scope held by instance state, not into the caller's scope.
      expect((yield* Deferred.await(interrupted).pipe(Effect.timeoutOption(50)))._tag).toBe("None")
      // Disposing the instance closes the registry scope, interrupting the job
      // fiber; settle classifies the interrupt-only cause as cancelled and fires
      // the onInterrupt hook (the same path a cascade cancel would take).
      yield* Effect.promise(() => disposeAllInstances())
      expect((yield* Deferred.await(interrupted).pipe(Effect.timeoutOption(5000)))._tag).toBe("Some")
    }),
  )

  // The runner's work fiber is forked into the startShell CALLER's scope, and the
  // fixture's disposeAllInstances() only disposes instances loaded through the
  // shared test instance store — so the shell is started under an explicit
  // provideInstance(dir), with the awaiting fiber forked into the test body's
  // scope where it stays alive across the dispose.
  itRunState.live("instance dispose cancels every live session runner (run-state finalizer)", () =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const torn = yield* Deferred.make<void>()
      const dir = yield* tmpdirScoped()
      const sessionID = SessionID.make("ses_dispose_runner")
      yield* state
        .startShell(
          sessionID,
          Effect.never,
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(torn, undefined))),
        )
        .pipe(provideInstance(dir), Effect.forkChild)
      // Wait until the runner is actually busy so dispose has something to kill.
      for (let attempt = 0; attempt < 200; attempt++) {
        const exit = yield* state.assertNotBusy(sessionID).pipe(provideInstance(dir), Effect.exit)
        if (Exit.isFailure(exit)) break
        yield* Effect.sleep(10)
      }
      expect((yield* Deferred.await(torn).pipe(Effect.timeoutOption(50)))._tag).toBe("None")
      // The run-state instance finalizer cancels every live runner on dispose.
      yield* Effect.promise(() => disposeAllInstances())
      expect((yield* Deferred.await(torn).pipe(Effect.timeoutOption(5000)))._tag).toBe("Some")
    }),
  )

  itSession.instance(
    "session.remove cancels the session-as-job and the jobs it dispatched, each hook exactly once",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const owner = yield* sessions.create({ title: "Dispose owner" })
        const child = yield* sessions.create({ title: "Dispose child", parentID: owner.id })
        const unrelated = yield* sessions.create({ title: "Unrelated session" })
        const release = yield* Deferred.make<void>()
        const hooks: string[] = []
        const gated = (tag: string) => ({
          onInterrupt: Effect.sync(() => {
            hooks.push(tag)
          }),
          run: Deferred.await(release).pipe(Effect.as(tag)),
        })
        // The owner session itself as a job (dispatched by some root session), a job
        // the owner dispatched onto the child session, and an unrelated job that the
        // single-level cleanup filter must not touch.
        yield* jobs.start({ id: owner.id, ownerSessionId: "ses_root", ...gated("owner-as-job") })
        yield* jobs.start({ id: child.id, ownerSessionId: owner.id, ...gated("child-job") })
        yield* jobs.start({ id: unrelated.id, ownerSessionId: "ses_elsewhere", ...gated("unrelated") })

        yield* sessions.remove(owner.id)

        expect((yield* jobs.get(owner.id))?.status).toBe("cancelled")
        expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
        expect((yield* jobs.get(unrelated.id))?.status).toBe("running")
        // The child recursion cancels the child job through the child's own cleanup,
        // and the owner's single-level pass cancels the session-as-job; neither hook
        // may fire twice even though both passes see the same job set.
        expect([...hooks].sort()).toEqual(["child-job", "owner-as-job"])

        // A repeated remove of an already-terminal set re-fires nothing.
        const before = hooks.length
        yield* Effect.forEach(
          (yield* jobs.list()).filter(
            (job) => job.status === "running" && (job.id === owner.id || job.ownerSessionId === owner.id),
          ),
          (job) => jobs.cancel(job.id),
          { concurrency: "unbounded", discard: true },
        )
        expect(hooks).toHaveLength(before)
        yield* jobs.cancel(unrelated.id)
        yield* Deferred.succeed(release, undefined)
      }),
  )
})
