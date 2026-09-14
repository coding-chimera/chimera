export * as BackgroundJob from "./background-job"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Schema, SynchronizedRef } from "effect"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { InstanceState } from "@/effect/instance-state"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type?: string
  title?: string
  /** Owning session id: the session whose Background Tasks block lists this job and
   * whose turn is parked until delivery completes. Kept as a loose string — the engine
   * is session-agnostic. */
  ownerSessionId?: string
  /** Delivery state machine: "pending" from start until the notify fiber finishes
   * injecting the result (markDelivered). Quiescence requires no running job and no
   * delivery-pending job for an owner. */
  delivery: "pending" | "delivered"
  /** Run generation on this id: incremented each time start() creates a new run.
   * start()'s running short-circuit returns the existing snapshot with the generation
   * unchanged, so a caller can tell whether it actually created the job. Delivery
   * marks may carry their generation; a stale-generation mark is a no-op. */
  generation: number
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  /** Completes when markDelivered runs; the settle-to-delivered in-flight window.
   * Created at start and succeeded at most once (idempotent markDelivered). */
  deliveryDone: Deferred.Deferred<void>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  fiber?: Fiber.Fiber<unknown, unknown>
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  onInterrupt?: Effect.Effect<void>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
  onInterrupt?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export class BackgroundJobLimitError extends Schema.TaggedErrorClass<BackgroundJobLimitError>()(
  "BackgroundJobLimitError",
  {
    id: Schema.String,
    running: Schema.Number,
    limit: Schema.Number,
  },
) {
  override get message() {
    return `Cannot start background job ${this.id}: concurrency limit reached (${this.running} running >= background_concurrent ${this.limit}). Complete or cancel a running background job before starting another.`
  }
}

export type StartInput = {
  /** Job id, supplied by the caller (phase 2 passes the child session id). The engine never issues ids itself. */
  id: string
  type?: string
  title?: string
  /** Owning session id; the engine derives metadata.parentSessionId from this (expand phase projection).
   * Optional because the engine is session-agnostic — jobs started without an owner are engine-level only.
   */
  ownerSessionId?: string
  metadata?: Record<string, unknown>
  /** Interruption hook: fires when the job ends cancelled, for phase 2 to cancel the bound child session. */
  onInterrupt?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info, BackgroundJobLimitError>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  readonly markDelivered: (id: string, generation?: number) => Effect.Effect<void>
  readonly waitOwnerQuiescent: (ownerSessionId: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Fork phase 1 keeps this trade-off on purpose — no Bus events, no
 * TTL. After a crash, phase 2 rebuilds degraded jobs from the persisted child
 * sessions (job id = child session id) instead of pretending this registry has
 * durable ownership semantics.
 */
export const make = (config: Config.Interface) =>
  Effect.gen(function* () {
    const cfg = yield* config.get()
    const limit = cfg.delegation?.background_concurrent ?? ConfigDelegation.DEFAULT_BACKGROUND_CONCURRENT
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map<string, Active>()),
    scope: yield* Scope.Scope,
  }

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const output =
        Exit.isSuccess(exit) && (!job.output || sequence > job.output.sequence)
          ? { sequence, text: exit.value }
          : job.output
      if (Exit.isSuccess(exit) && pending > 0) {
        return [{}, new Map(jobs).set(id, { ...job, pending, output })]
      }
      const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
        ? "completed"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "cancelled"
          : "error"
      const next = {
        ...job,
        onInterrupt: undefined,
        fiber: undefined,
        pending: 0,
        output,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
        },
      }
      return [
        {
          info: snapshot(next),
          done: job.done,
          scope: job.scope,
          onInterrupt: status === "cancelled" ? job.onInterrupt : undefined,
        },
        new Map(jobs).set(id, next),
      ]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.onInterrupt) yield* result.onInterrupt.pipe(Effect.ignore)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const attachFiber = Effect.fnUntraced(function* (id: string, token: object, fiber: Fiber.Fiber<unknown, unknown>) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(id)
      if (!job || job.token !== token) return jobs
      return new Map(jobs).set(id, { ...job, fiber })
    })
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return Array.from((yield* SynchronizedRef.get(state.jobs)).values())
      .map(snapshot)
      .toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id: string) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input: StartInput) {
    if (!input.id) return yield* Effect.die(new Error("BackgroundJob.start requires a non-empty job id"))
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const deliveryDone = yield* Deferred.make<void>()
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.get(input.id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            const running = Array.from(jobs.values()).filter((job) => job.info.status === "running").length
            if (running >= limit) {
              return yield* new BackgroundJobLimitError({ id: input.id, running, limit })
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id: input.id,
                type: input.type,
                title: input.title,
                ownerSessionId: input.ownerSessionId,
                delivery: "pending" as const,
                generation: (existing?.info.generation ?? 0) + 1,
                status: "running" as const,
                started_at,
                metadata: {
                  ...input.metadata,
                  sessionId: input.id,
                  ...(input.ownerSessionId !== undefined ? { parentSessionId: input.ownerSessionId } : {}),
                },
              },
              done,
              deliveryDone,
              scope,
              token,
              pending: 1,
              next: 1,
              tail,
              onInterrupt: input.onInterrupt,
            }
            return [
              { info: snapshot(job), scope, token },
              new Map(jobs).set(input.id, job),
            ] as readonly [StartResult, Map<string, Active>]
          }),
        )
        if ("scope" in result) {
          const fiber = yield* fork(
            result.scope,
            input.id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
          yield* attachFiber(input.id, result.token, fiber)
        }
        return result.info
      }),
    )
  })

  /**
   * Marks the delivery of a job's background result as complete (idempotent: unknown
   * ids and repeated calls are safe no-ops). The delivery state machine guards the
   * in-flight window between settle and the notify fiber finishing the injection;
   * waitOwnerQuiescent treats a delivery-pending job as still active for its owner.
   * When `generation` is given, the mark applies only if the current entry is still
   * that generation: a stale notify fiber from an earlier run on the same id (the
   * entry was overwritten by a restart mid-injection) is a no-op instead of falsely
   * delivering the newer run. Omitting it keeps the legacy by-id behavior.
   */
  const markDelivered: Interface["markDelivered"] = Effect.fn("BackgroundJob.markDelivered")(function* (
    id: string,
    generation?: number,
  ) {
    const result = yield* SynchronizedRef.modify(
      state.jobs,
      (jobs): readonly [Deferred.Deferred<void> | undefined, Map<string, Active>] => {
        const job = jobs.get(id)
        if (!job || job.info.delivery === "delivered") return [undefined, jobs]
        if (generation !== undefined && job.info.generation !== generation) return [undefined, jobs]
        return [job.deliveryDone, new Map(jobs).set(id, { ...job, info: { ...job.info, delivery: "delivered" } })]
      },
    )
    if (result) yield* Deferred.succeed(result, undefined).pipe(Effect.ignore)
  })

  /**
   * Waits until the owner has no running job and no delivery-pending job. Re-reads
   * the snapshot after every wake-up so jobs registered mid-wait become visible; a
   * settled-but-undelivered job keeps the wait alive until markDelivered (a stale-
   * generation markDelivered is a no-op, so a same-id restart keeps the wait alive
   * until the newest run settles and its own delivery completes). Each
   * iteration awaits exactly the still-unresolved signal per job (done while
   * running, deliveryDone once settled): awaiting an already-resolved deferred
   * would hot-spin the loop for the whole settle-to-delivered window, which
   * spans the entire woken turn. Naturally interruptible; deliberately has no
   * timeout.
   */
  const waitOwnerQuiescent: Interface["waitOwnerQuiescent"] = Effect.fn("BackgroundJob.waitOwnerQuiescent")(function* (
    ownerSessionId: string,
  ) {
    for (;;) {
      const relevant = Array.from((yield* SynchronizedRef.get(state.jobs)).values()).filter(
        (job) =>
          job.info.ownerSessionId === ownerSessionId &&
          (job.info.status === "running" || job.info.delivery === "pending"),
      )
      if (relevant.length === 0) return
      yield* Effect.raceAll(
        relevant.map((job) =>
          job.info.status === "running" ? Deferred.await(job.done) : Deferred.await(job.deliveryDone),
        ),
      )
    }
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input: ExtendInput) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [ExtendResult, Map<string, Active>] => {
          const job = jobs.get(input.id)
          if (!job || job.info.status !== "running") return [{ extended: false }, jobs]
          return [
            { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
            new Map(jobs).set(input.id, {
              ...job,
              pending: job.pending + 1,
              next: job.next + 1,
              tail,
            }),
          ]
        })
        if (!result.extended) return false
        const fiber = yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          Deferred.await(result.previous).pipe(
            Effect.andThen(restore(input.run)),
            Effect.ensuring(Deferred.succeed(result.tail, undefined)),
          ),
        )
        yield* attachFiber(input.id, result.token, fiber)
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input: WaitInput) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id: string) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const next = {
        ...job,
        onInterrupt: undefined,
        fiber: undefined,
        pending: 0,
        info: {
          ...job.info,
          status: "cancelled" as const,
          completed_at,
        },
      }
      return [
        { info: snapshot(next), done: job.done, scope: job.scope, onInterrupt: job.onInterrupt },
        new Map(jobs).set(id, next),
      ]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.onInterrupt) yield* result.onInterrupt.pipe(Effect.ignore)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  return Service.of({ list, get, start, extend, wait, cancel, markDelivered, waitOwnerQuiescent })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* InstanceState.make(() => make(config))
    return Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
      markDelivered: (id, generation) => InstanceState.useEffect(state, (jobs) => jobs.markDelivered(id, generation)),
      waitOwnerQuiescent: (ownerSessionId) => InstanceState.useEffect(state, (jobs) => jobs.waitOwnerQuiescent(ownerSessionId)),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))