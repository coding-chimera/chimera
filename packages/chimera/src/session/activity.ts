import { BackgroundJob } from "@/agent/background-job"
import { SessionID } from "@/contracts/session-ids"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Context, Effect, Layer, Option, Schedule, Stream } from "effect"

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
  /** Resolves once isActive reads false; polls on a short cadence so it always resolves. */
  readonly waitQuiescent: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionActivity") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
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
        // Id-only projection (B4 bounded reads): the 50ms isActive poll used
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

    // Single authoritative predicate: family has work in flight (a member's
    // turn running/retrying/busy, or a running∨delivery-pending job the family
    // owns) = active. Cross-process or crashed jobs are invisible to this
    // predicate (the registry is per-process in-memory state); cross-process
    // mutual exclusion stays the turn lease's job (SessionRunState).
    const isActive = Effect.fn("SessionActivity.isActive")(function* (sessionID: SessionID) {
      const family = yield* familyIDs(sessionID)
      if ((yield* activeJobsIn(family)).length > 0) return true
      for (const member of family) {
        if ((yield* status.get(SessionID.make(member))).type !== "idle") return true
      }
      return false
    })

    const waitQuiescent = Effect.fn("SessionActivity.waitQuiescent")(function* (sessionID: SessionID) {
      // Polls instead of only subscribing to the status bus: a transition
      // landing between a read and a later subscription would hang the waiter
      // forever, and quiescence waits must always resolve. With no job engine
      // in the context this degrades to watching family statuses only.
      yield* Stream.fromEffectSchedule(isActive(sessionID), Schedule.spaced("50 millis")).pipe(
        Stream.dropWhile((active) => active),
        Stream.take(1),
        Stream.runDrain,
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
  Layer.provide(Layer.mergeAll(SessionStatus.defaultLayer, Session.defaultLayer, BackgroundJob.defaultLayer)),
)

export * as SessionActivity from "./activity"
