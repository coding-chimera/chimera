import { BackgroundJob } from "@/agent/background-job"
import { Bus } from "@/bus"
import { SessionID } from "@/contracts/session-ids"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Context, Deferred, Effect, Layer, Option, Queue, Stream } from "effect"

/**
 * Upper bound on how long a quiescence wait can miss a wake-up signal. The
 * wait is event-driven (SessionStatus transitions + job settle/delivery
 * deferreds); this timer only bounds residual gaps, so it is deliberately
 * slow — the old 50ms poll re-read the whole family and job registry per tick.
 */
const FALLBACK_QUIESCENCE_INTERVAL = "2 seconds"

/**
 * SessionActivity — the single authority for "is this session's family still
 * working?". A session family is the session itself plus every descendant
 * (SessionTable.parent_id, walked through Session.children). Correct liveness
 * semantics: a family member's turn running OR a family-owned background job
 * still in flight both mean "active". Callers historically re-derived this
 * predicate from the root session alone and kept racing their own subagents,
 * so every "session active/idle" decision must go through this service —
 * do not reassemble status/job checks at the consumption site.
 */
export interface Interface {
  /** This session plus every descendant (BFS, visited set, 256 cap). */
  readonly familyIDs: (sessionID: SessionID) => Effect.Effect<ReadonlySet<string>>
  /** Jobs owned by any family member that are running or awaiting result delivery. */
  readonly ownedActiveJobs: (sessionID: SessionID) => Effect.Effect<BackgroundJob.Info[]>
  /** True while any family member is non-idle or the family owns an active job. */
  readonly isActive: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Resolves once isActive reads false; event-driven with a low-frequency fallback timer. */
  readonly waitQuiescent: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionActivity") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    // Same optional treatment as SessionPrompt: compositions without the job
    // engine degrade to status-only family liveness (ownedActiveJobs -> []).
    const background = yield* Effect.serviceOption(BackgroundJob.Service)

    const familyIDs = Effect.fn("SessionActivity.familyIDs")(function* (sessionID: SessionID) {
      const family = new Set<string>()
      const pending: string[] = [sessionID]
      // Subagent nesting is shallow (≤3); the size cap bounds pathological
      // fan-out and the visited set breaks cycles.
      while (pending.length > 0 && family.size < 256) {
        const current = pending.shift()!
        if (family.has(current)) continue
        family.add(current)
        // Id-only projection (B4 bounded reads): the liveness checks used to
        // run children() — a full-row SELECT parsing every json column
        // to run children() — a full-row SELECT parsing every json column
        // (summary_diffs, revert, ...) per child — while only .id is read.
        // Falls back to children() for partial Session.Service mocks that
        // predate the optional childrenIDs member.
        const children = yield* (sessions.childrenIDs
          ? sessions.childrenIDs(SessionID.make(current))
          : sessions.children(SessionID.make(current)).pipe(Effect.map((kids) => kids.map((kid) => kid.id)))
        ).pipe(Effect.catchCause(() => Effect.succeed([] as string[])))
        for (const child of children) pending.push(child)
      }
      return family
    })

    const activeJobsIn = Effect.fnUntraced(function* (family: ReadonlySet<string>) {
      const jobs = Option.getOrUndefined(background)
      if (!jobs) return [] as BackgroundJob.Info[]
      return (yield* jobs.list()).filter(
        (job) =>
          typeof job.ownerSessionId === "string" &&
          // delivery-pending counts as active: between a job settling and its
          // notify fiber finishing injectSynthetic + markDelivered there is a
          // window where the job is no longer "running" but the result-
          // aggregation turn is about to start. A running-only filter would
          // read the family as quiescent inside that window — releasing edit-
          // intent claims early or firing a goal continuation that competes
          // with the woken turn. Same predicate waitOwnerQuiescent uses.
          (job.status === "running" || job.delivery === "pending") &&
          family.has(job.ownerSessionId!),
      )
    })

    const ownedActiveJobs = Effect.fn("SessionActivity.ownedActiveJobs")(function* (sessionID: SessionID) {
      return yield* activeJobsIn(yield* familyIDs(sessionID))
    })

    const anyMemberBusy = Effect.fnUntraced(function* (family: ReadonlySet<string>) {
      for (const member of family) {
        if ((yield* status.get(SessionID.make(member))).type !== "idle") return true
      }
      return false
    })

    // Single authoritative predicate: family has work in flight (a member's
    // turn running/retrying/busy, or a running∨delivery-pending job the family
    // owns) = active. Cross-process or crashed jobs are invisible to this
    // predicate (the registry is per-process in-memory state); cross-process
    // mutual exclusion stays the turn lease's job (SessionRunState).
    const isActive = Effect.fn("SessionActivity.isActive")(function* (sessionID: SessionID) {
      const family = yield* familyIDs(sessionID)
      if ((yield* activeJobsIn(family)).length > 0) return true
      return yield* anyMemberBusy(family)
    })

    const waitQuiescent = Effect.fn("SessionActivity.waitQuiescent")(function* (sessionID: SessionID) {
      // Event-driven instead of a 50ms family poll: one persistent subscription
      // to family SessionStatus transitions feeds a capacity-1 queue, so a
      // transition that lands between two iterations is never lost, and each
      // iteration awaits the first of: a queued status transition, the
      // BackgroundJob settle/delivery deferreds of the family's active jobs, or
      // the fallback timer. The timer bounds any residual gap (a dropped event,
      // a family that gains a member without a status event) so a quiescence
      // wait always resolves. With no job engine in the context this degrades
      // to status watching only.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const wake = yield* Queue.sliding<void>(1)
          // Updated every iteration; the filter reads it at publish time so a
          // family that gains members mid-wait is covered without re-subscribing.
          let family: ReadonlySet<string> = new Set<string>()
          // Subscribe BEFORE the first liveness read: a transition landing
          // between the read and the wait must not be missed.
          yield* bus.subscribe(SessionStatus.Event.Status).pipe(
            Stream.filter((event) => family.has(event.properties.sessionID)),
            Stream.runForEach(() => Queue.offer(wake, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          )
          for (;;) {
            family = yield* familyIDs(sessionID)
            const jobs = yield* activeJobsIn(family)
            if (jobs.length === 0 && !(yield* anyMemberBusy(family))) return
            const engine = Option.getOrUndefined(background)
            const owners = new Set(jobs.flatMap((job) => (job.ownerSessionId ? [job.ownerSessionId] : [])))
            const jobWaits = engine ? Array.from(owners).map((owner) => engine.waitOwnerQuiescent(owner)) : []
            yield* Effect.raceAll([
              Queue.take(wake).pipe(Effect.asVoid),
              ...jobWaits,
              Effect.sleep(FALLBACK_QUIESCENCE_INTERVAL),
            ])
          }
        }),
      )
    })

    return Service.of({ familyIDs, ownedActiveJobs, isActive, waitQuiescent })
  }),
)

// Explicit BackgroundJob provide (the SessionRunState.defaultLayer pattern):
// sibling layers in a mergeAll/provide list are NOT visible to each other at
// construction, so a construction-time serviceOption only resolves Some when
// the engine is provided inside this layer's own chain. The shared memoMap
// plus the ambient per-directory InstanceState registry keep every composition
// on the same live engine.
export const defaultLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(SessionStatus.defaultLayer, Session.defaultLayer, BackgroundJob.defaultLayer, Bus.layer),
  ),
)

export * as SessionActivity from "./activity"
