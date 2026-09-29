import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { InstanceStore } from "@/project/instance-store"
import { BackgroundJob } from "@/agent/background-job"
import { Effect, Fiber, Latch, Layer, Option, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionPartReconcile } from "./part-reconcile"
import { SessionTurnLease } from "./turn-lease"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

/**
 * BusyError extension for the cross-process case: another live chimera process
 * holds this session's turn lease. The HTTP middlewares' `instanceof
 * Session.BusyError` mapping keeps applying (400 + message); the message names
 * the holder so it is actionable — the background-job limit error is the
 * cautionary precedent for a busy message that cannot be acted on.
 */
export class RemoteBusyError extends Session.BusyError {
  constructor(sessionID: SessionID, holder: SessionTurnLease.Holder) {
    super(sessionID)
    this.message = `Session ${sessionID} is busy in another chimera process (pid ${holder.ownerPID}, ${holder.ownerBootID}) which holds its turn lease until ${new Date(holder.expiresAt).toISOString()}. Wait for that run to finish, cancel it in that process, or retry after the lease expires.`
  }
}

/**
 * TTL renewal for every lease this process owns. A fiber per busy window
 * (forked in onBusy, interrupted in onIdle) was chosen over piggybacking on
 * runner activity because Runner exposes no mid-turn hook, and turns can
 * legitimately outlive the TTL (long tool calls, nested-background parks with
 * no abandonment timeout). One renewAll statement covers all sessions of this
 * process; transient DB failures are logged and swallowed so one bad tick
 * cannot kill the renewal of a still-live turn. An idle process runs no timer.
 */
const renewalLoop = Effect.forever(
  Effect.sleep(SessionTurnLease.RENEW_INTERVAL_MS).pipe(
    Effect.andThen(Effect.sync(() => SessionTurnLease.renewAll()).pipe(Effect.ignoreCause({ log: true }))),
  ),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const store = yield* Effect.serviceOption(InstanceStore.Service)
    const background = yield* Effect.serviceOption(BackgroundJob.Service)
    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    // Pin reconciliation authority (W1): sweeps call this with the target instance's
    // InstanceRef provided as fiber context. Busy runners are the ground truth for live
    // pin holders (onBusy pins, onIdle releases); the session status storage count rides
    // along as diagnostic context for dangling-pin warnings. `undefined` = state unknown
    // (instance never ran a session or is being torn down) and skips correction.
    if (Option.isSome(store))
      yield* store.value.registerPinReconciler(() =>
        Effect.gen(function* () {
          if (!(yield* InstanceState.has(state))) return undefined
          const data = yield* InstanceState.get(state)
          const statuses = yield* status.list()
          return {
            expectedPins: [...data.runners.values()].filter((runner) => runner.busy).length,
            busyStatuses: statuses.size,
          }
        }),
      )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die(new Error("Session runner requires an instance"))
      const leases: Array<InstanceStore.Lease | undefined> = []
      let renewFiber: Fiber.Fiber<never, never> | undefined
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          SessionPartReconcile.markIdle(sessionID)
          if (renewFiber) {
            const fiber = renewFiber
            renewFiber = undefined
            yield* Fiber.interrupt(fiber)
          }
          // Owner-guarded release: a lease legitimately taken over after our
          // TTL lapsed is never deleted. A failure here must not break the
          // idle transition — a leftover row expires or is inherited through
          // the liveness probe.
          yield* Effect.sync(() => SessionTurnLease.release(sessionID)).pipe(Effect.ignoreCause({ log: true }))
          const lease = leases.shift()
          if (lease) yield* lease.release
          if (leases.length > 0) return
          if (data.runners.get(sessionID) === next) data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: Effect.gen(function* () {
          // Cross-process turn claim before any turn state is written: the
          // successful acquire proves no foreign live process holds this
          // session, and the runner's work (assistant message, tool parts)
          // only starts after onBusy returns.
          const claim = yield* Effect.sync(() => SessionTurnLease.acquire(sessionID))
          if (!claim.acquired) throw new RemoteBusyError(sessionID, claim.holder)
          // Turn-start orphan heal: forced (guard-free) reconciliation, so a
          // long-lived process also cleans up after a sibling process crashed
          // mid-turn — its stale boot marker would skip the lazy read path.
          yield* Effect.sync(() => SessionPartReconcile.reconcileOrphansNow(sessionID))
          SessionPartReconcile.markBusy(sessionID)
          renewFiber = yield* renewalLoop.pipe(Effect.forkIn(data.scope))
          leases.push(store._tag === "Some" ? yield* store.value.pin(instance) : undefined)
          yield* status.set(sessionID, { type: "busy" })
        }),
        onInterrupt,
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) throw new Session.BusyError(sessionID)
      // Cross-process visibility for the HTTP entry probes: a live foreign
      // lease means another process is mid-turn on this session.
      const holder = yield* Effect.sync(() => SessionTurnLease.foreignLiveHolder(sessionID))
      if (holder) throw new RemoteBusyError(sessionID, holder)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      // Cascade first: cancel the background jobs this session dispatched
      // (and, transitively, everything they dispatched) before interrupting
      // the session's own runner. Mirrors the upstream cancel entry that runs
      // cancelBackgroundJobs first.
      const jobs = Option.getOrUndefined(background)
      if (jobs) yield* cancelBackgroundJobs(jobs, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).startShell(work, ready)
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

// BFS transitive closure over the background job graph (upstream
// cancelBackgroundJobs): start from the cancelled session and expand through job
// ids and the typed ownerSessionId field until no running job remains in reach.
// `cancelled` is the visited set for jobs (a job is cancelled at most once —
// onInterrupt fires exactly on the running -> cancelled transition, so the nested
// onInterrupt -> state.cancel(child) recursion from task.ts cannot loop); `pending`
// is the frontier of session ids to expand from. The `running` status filter means
// the loop always terminates even with pathological ownership cycles.
const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    return typeof job.ownerSessionId === "string" && pending.has(job.ownerSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

export * as SessionRunState from "./run-state"
