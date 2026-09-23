export * as BackgroundJob from "./background-job"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Schema, SynchronizedRef } from "effect"
import { and, desc, eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { Database } from "@/storage/db"
import { InstanceState } from "@/effect/instance-state"
import { BackgroundJobTable } from "./background-job.sql"

const log = Log.create({ service: "background-job" })

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
  /** Succeeded by promote() with the post-promotion snapshot; wakes waitForPromotion
   * waiters (the task tool's sync-dispatch raceFirst racer). */
  promoted: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  fiber?: Fiber.Fiber<unknown, unknown>
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  onInterrupt?: Effect.Effect<void>
  /** Fires once when promote() flips the job to background; the task tool uses it
   * to publish the backgrounded tool-part metadata and fork the result-notify fiber. */
  onPromote?: Effect.Effect<void>
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

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
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
  /** Fires once when the job is promoted from foreground to background (see promote). */
  onPromote?: Effect.Effect<void>
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
  /** Resolves when the job is promoted to background; Effect.never for unknown or settled jobs. */
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  /** Flip a running foreground job to background without interrupting or restarting its fiber. */
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
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

/** (R1 A3) Cap on settled+delivered live entries; older ones are evicted and served from the durable registry. */
const DEFAULT_SETTLED_LIVE_MAX = 200
/** (R1 A3) Durable row cap per instance directory, pruned oldest-first when a registry opens. */
const DURABLE_ROWS_MAX = 500

function parseDurableInfo(data: string): Info | undefined {
  try {
    const parsed = JSON.parse(data) as Info
    if (typeof parsed?.id !== "string" || typeof parsed?.status !== "string") return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * (R1 A3) Write-through snapshot of a job's latest Info. Best effort: the
 * in-memory registry stays the authority for live semantics (limits,
 * quiescence, delivery), and a persistence failure degrades to the pre-R1
 * behavior instead of failing the job.
 */
function persistJobInfo(directory: string, info: Info) {
  try {
    const now = Date.now()
    Database.use((db) => {
      db.insert(BackgroundJobTable)
        .values({
          id: info.id,
          instance_directory: directory,
          generation: info.generation,
          status: info.status,
          data: JSON.stringify(info),
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [BackgroundJobTable.instance_directory, BackgroundJobTable.id],
          set: { generation: info.generation, status: info.status, data: JSON.stringify(info), updated_at: now },
        })
        .run()
    })
  } catch (error) {
    log.warn("background job persist failed", { id: info.id, error })
  }
}

function readDurableJob(directory: string, id: string): Info | undefined {
  try {
    const row = Database.use((db) =>
      db
        .select()
        .from(BackgroundJobTable)
        .where(and(eq(BackgroundJobTable.instance_directory, directory), eq(BackgroundJobTable.id, id)))
        .get(),
    )
    return row ? parseDurableInfo(row.data) : undefined
  } catch (error) {
    log.warn("background job durable read failed", { id, error })
    return undefined
  }
}

function readDurableJobs(directory: string): Info[] {
  try {
    return Database.use((db) =>
      db.select().from(BackgroundJobTable).where(eq(BackgroundJobTable.instance_directory, directory)).all(),
    ).flatMap((row) => {
      const info = parseDurableInfo(row.data)
      return info ? [info] : []
    })
  } catch (error) {
    log.warn("background job durable list failed", { error })
    return []
  }
}

function pruneDurableJobs(directory: string) {
  try {
    Database.use((db) => {
      const stale = db
        .select({ id: BackgroundJobTable.id })
        .from(BackgroundJobTable)
        .where(eq(BackgroundJobTable.instance_directory, directory))
        .orderBy(desc(BackgroundJobTable.updated_at))
        .all()
        .slice(DURABLE_ROWS_MAX)
      for (const row of stale) {
        db.delete(BackgroundJobTable)
          .where(and(eq(BackgroundJobTable.instance_directory, directory), eq(BackgroundJobTable.id, row.id)))
          .run()
      }
    })
  } catch (error) {
    log.warn("background job durable prune failed", { error })
  }
}

/**
 * Makes one scoped registry for a single instance directory. The in-memory map
 * stays the authority for live work — fibers, Deferreds, and delivery state
 * cannot survive a restart by construction — but every transition is written
 * through to the durable `background_job` table (R1 A3):
 *
 * - `get`/`list`/`wait` fall back to durable rows the live map does not hold,
 *   so job status survives process restart and owner-scope closure (the
 *   registry-loss incident class); after a restart, phase 2 still rebuilds
 *   degraded jobs from the persisted child sessions (job id = child session
 *   id) — persistence coordinates with that by never claiming a durable row
 *   is still running (open-time reconciliation rewrites `running` rows to an
 *   interrupted terminal state, because their fibers are provably gone);
 * - settled+delivered entries are evicted from the live map past
 *   `settledLiveMax` (oldest completed first) and served from the durable
 *   table afterwards. Delivery-pending entries are never evicted: an early
 *   eviction would collapse waitOwnerQuiescent before the notify fiber's
 *   injection completed and re-orphan the result.
 *
 * When `directory` is omitted the registry is purely in-memory (pre-R1
 * behavior), which keeps engine-level tests and non-instance callers durable-
 * free.
 */
/**
 * Closeout protocol (F4-P2, per the migration plan's "closeout 协议成文" item).
 *
 * Responsibility split when a dispatch chain involves background jobs:
 *
 * 1. Child self-closeout: a subagent finishes its own session-level closeout
 *    (audit / oracle / obligation handling) inside its own turn, before its run
 *    effect settles. The engine never defers or reopens a child's closeout.
 * 2. Delivery state machine: a job's result is delivered either inline by the
 *    waiting consumer (the task tool's synchronous race, or a chimera_swarm
 *    worker wait — both mark delivery right after consuming the result) or by
 *    the notify fiber of a background dispatch, which marks delivery only after
 *    injectSynthetic has fully returned, i.e. the woken parent turn that
 *    aggregates the result has completed. markDelivered is generation-bound, so
 *    a stale notify fiber from an earlier run on the same id can never falsely
 *    complete delivery for the newer run.
 * 3. Parent park: a dispatch whose child owns running or delivery-pending jobs
 *    parks on waitOwnerQuiescent inside runPreparedCore and re-reads the child's
 *    newest assistant message afterwards, so aggregation turns are never
 *    orphaned. The park has no abandonment timeout; onParkProgress publishes
 *    periodic metadata on the foreground path and the cancel cascade is the
 *    escape hatch. On a background dispatch the tool call has already returned,
 *    so the park surfaces differently: the job stays `running` until the child's
 *    subtree is quiescent, keeping it visible in the owner's Background Tasks
 *    runtime-context section.
 * 4. Run-mode drain: `chimera run` polls GET /session/:id/background/quiescence
 *    after the prompt returns so injected aggregation turns flow out through
 *    the event stream before the process exits.
 * 5. Parent aggregation: the injection-triggered turn is where the parent
 *    performs cross-child closeout (conflict resolution, chimera_audit_recent,
 *    focused verification) — see the task/chimera_swarm tool guidance.
 *
 * Because waitOwnerQuiescent treats delivery-pending jobs as active, EVERY
 * inline consumer of a job result must mark delivery: a missed mark would park
 * the owner (or the run-mode drain) forever on a result that was already
 * consumed. Cancellation is the exception: a cancelled job's notify fiber (if
 * any) still runs its ensuring-markDelivered, and interrupt paths tear down the
 * owner's turn alongside the job, so no park survives to observe the gap.
 */
export const make = (config: Config.Interface, directory?: string, options?: { settledLiveMax?: number }) =>
  Effect.gen(function* () {
    const cfg = yield* config.get()
    const limit = cfg.delegation?.background_concurrent ?? ConfigDelegation.DEFAULT_BACKGROUND_CONCURRENT
    const settledLiveMax = Math.max(1, Math.floor(options?.settledLiveMax ?? DEFAULT_SETTLED_LIVE_MAX))

  if (directory !== undefined) {
    // Open-time reconciliation: `running` rows were persisted by a process
    // whose fibers are gone; rewrite them to an interrupted terminal state so
    // durable readers never see a phantom running job. Rows for jobs this
    // process will (re)start get overwritten by start()'s write-through.
    const reconciledAt = yield* Clock.currentTimeMillis
    for (const info of readDurableJobs(directory)) {
      if (info.status !== "running") continue
      persistJobInfo(directory, {
        ...info,
        status: "error",
        error: "host process restarted; background job interrupted",
        delivery: "delivered",
        completed_at: info.completed_at ?? reconciledAt,
      })
    }
    pruneDurableJobs(directory)
  }
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
        onPromote: undefined,
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
    if (result.info && result.done) {
      yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      if (directory !== undefined) yield* Effect.sync(() => persistJobInfo(directory, result.info!))
    }
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
    const live = Array.from((yield* SynchronizedRef.get(state.jobs)).values()).map(snapshot)
    if (directory === undefined) return live.toSorted((a, b) => a.started_at - b.started_at)
    // (R1 A3) Merge durable rows the live map no longer holds (pre-restart or
    // settled-evicted); live entries win over their own durable snapshot.
    const liveIDs = new Set(live.map((info) => info.id))
    const durable = readDurableJobs(directory).filter((info) => !liveIDs.has(info.id))
    return [...live, ...durable].toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id: string) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (job) return snapshot(job)
    if (directory === undefined) return
    return readDurableJob(directory, id)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input: StartInput) {
    if (!input.id) return yield* Effect.die(new Error("BackgroundJob.start requires a non-empty job id"))
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const started_at = yield* Clock.currentTimeMillis
        // (R1 A3) Continue the durable generation sequence across restarts so
        // ids reused after a crash never rewind their generation counter.
        const durableGeneration = directory !== undefined ? readDurableJob(directory, input.id)?.generation ?? 0 : 0
        const done = yield* Deferred.make<Info>()
        const deliveryDone = yield* Deferred.make<void>()
        const tail = yield* Deferred.make<void>()
        const promoted = yield* Deferred.make<Info>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.get(input.id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            // Foreground (sync) dispatches register with metadata.background === false:
            // they are exempt from the background_concurrent cap (the cap governs
            // background work only) and do not consume a slot while running. promote()
            // flips the flag, so a promoted job counts toward the cap from then on.
            if (input.metadata?.background !== false) {
              const running = Array.from(jobs.values()).filter(
                (job) => job.info.status === "running" && job.info.metadata?.background !== false,
              ).length
              if (running >= limit) {
                return yield* new BackgroundJobLimitError({ id: input.id, running, limit })
              }
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
                generation: Math.max(existing?.info.generation ?? 0, durableGeneration) + 1,
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
              promoted,
              onInterrupt: input.onInterrupt,
              onPromote: input.onPromote,
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
          if (directory !== undefined) yield* Effect.sync(() => persistJobInfo(directory, result.info))
}
        return result.info
      }),
    )
  })

  /**
   * (R1 A3) Bounds the live map's settled+delivered entries. Runs only after
   * markDelivered; the durable row (when persistence is on) still serves the
   * Info through get/list/wait, so nothing is lost by eviction. Delivery-
   * pending entries are never evicted — waitOwnerQuiescent relies on them to
   * keep a park alive until the notify injection completed.
   */
  const evictSettled = Effect.fnUntraced(function* () {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const settled = [...jobs.entries()].filter(
        ([, job]) => job.info.status !== "running" && job.info.delivery === "delivered",
      )
      if (settled.length <= settledLiveMax) return jobs
      settled.sort((a, b) => (a[1].info.completed_at ?? 0) - (b[1].info.completed_at ?? 0))
      const next = new Map(jobs)
      for (const [id] of settled.slice(0, settled.length - settledLiveMax)) next.delete(id)
      return next
    })
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
      (jobs): readonly [{ deferred?: Deferred.Deferred<void>; info?: Info }, Map<string, Active>] => {
        const job = jobs.get(id)
        if (!job || job.info.delivery === "delivered") return [{}, jobs]
        if (generation !== undefined && job.info.generation !== generation) return [{}, jobs]
        const next = { ...job, info: { ...job.info, delivery: "delivered" as const } }
        return [{ deferred: job.deliveryDone, info: snapshot(next) }, new Map(jobs).set(id, next)]
      },
    )
    if (result.deferred) yield* Deferred.succeed(result.deferred, undefined).pipe(Effect.ignore)
    if (result.info) {
      if (directory !== undefined) yield* Effect.sync(() => persistJobInfo(directory, result.info!))
      yield* evictSettled()
    }
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
    if (!job) {
      // (R1 A3) Durable fallback: a settled job from before a restart (or one
      // evicted from the live map) answers from the durable registry instead of
      // pretending it never existed.
      const durable = directory !== undefined ? readDurableJob(directory, input.id) : undefined
      return durable ? { info: durable, timedOut: false } : { timedOut: false }
    }
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
        onPromote: undefined,
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
    if (result.info && result.done) {
      yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      if (directory !== undefined) yield* Effect.sync(() => persistJobInfo(directory, result.info!))
    }
    if (result.onInterrupt) yield* result.onInterrupt.pipe(Effect.ignore)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  // (F4-P2 dispose matrix) Instance teardown must not leave running jobs behind:
  // closing the registry scope alone does not interrupt the run fibers forked into
  // the job scopes, so the registry finalizer explicitly settles every running job
  // — the same "finalizer cancels live work" shape as the SessionRunState instance
  // finalizer (run-state.ts). It deliberately does NOT call cancel(): the finalizer
  // runs while the registry scope is already closing, where re-entering Scope.close
  // on a child job scope is unsafe and ambient services may already be unavailable.
  // Instead it performs the same
  // terminal transition with finalizer-safe primitives only: status cancelled,
  // done Deferred succeeded, onInterrupt hook fired (phase 2 binds it to the bound
  // child session's cancel), so no orphaned subagent run keeps burning tokens or
  // permits after the owning instance is disposed.
  yield* Effect.addFinalizer(
    Effect.fnUntraced(function* () {
      const now = Date.now()
      const running = Array.from((yield* SynchronizedRef.get(state.jobs)).values()).filter(
        (job) => job.info.status === "running",
      )
      yield* Effect.forEach(
        running,
        (job) =>
          Effect.gen(function* () {
            const result = yield* SynchronizedRef.modify(
              state.jobs,
              (jobs): readonly [FinishResult, Map<string, Active>] => {
                const current = jobs.get(job.info.id)
                if (!current || current.info.status !== "running") return [{}, jobs]
                const next = {
                  ...current,
                  onInterrupt: undefined,
                  onPromote: undefined,
                  fiber: undefined,
                  pending: 0,
                  info: { ...current.info, status: "cancelled" as const, completed_at: now },
                }
                return [
                  { info: snapshot(next), done: current.done, onInterrupt: current.onInterrupt },
                  new Map(jobs).set(current.info.id, next),
                ]
              },
            )
            if (result.info && result.done) {
              yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
              if (directory !== undefined) yield* Effect.sync(() => persistJobInfo(directory, result.info!))
            }
            if (result.onInterrupt) yield* result.onInterrupt.pipe(Effect.ignoreCause({ log: true }))
          }),
        { discard: true },
      )
    }),
  )

  /**
   * Waits until the job is promoted to background (upstream waitForPromotion semantics):
   * resolves immediately for a job that is already background, and never resolves for an
   * unknown or settled job so the task tool's raceFirst(wait, waitForPromotion) racer
   * always terminates through the done side instead.
   */
  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (
    id: string,
  ) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    return yield* Deferred.await(job.promoted)
  })

  /**
   * Promotes a running foreground job to background WITHOUT interrupting or restarting
   * its fiber: flips metadata.background to true, wakes waitForPromotion racers through
   * the promoted Deferred, and fires the one-shot onPromote hook (the task tool publishes
   * the backgrounded tool-part metadata and forks its result-notify fiber there).
   * Idempotent: an already-background running job returns its snapshot unchanged;
   * a settled or unknown job returns undefined (upstream parity).
   */
  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id: string) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.info.status !== "running")
          return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        return [
          { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted },
          new Map(jobs).set(id, next),
        ] as readonly [PromoteResult, Map<string, Active>]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    if (result.info && directory !== undefined) yield* Effect.sync(() => persistJobInfo(directory, result.info!))
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  return Service.of({
    list,
    get,
    start,
    extend,
    wait,
    waitForPromotion,
    promote,
    cancel,
    markDelivered,
    waitOwnerQuiescent,
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* InstanceState.make(
      Effect.fn("BackgroundJob.state")(function* (ctx) {
        return yield* make(config, ctx.directory)
      }),
    )
    return Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
      markDelivered: (id, generation) => InstanceState.useEffect(state, (jobs) => jobs.markDelivered(id, generation)),
      waitOwnerQuiescent: (ownerSessionId) => InstanceState.useEffect(state, (jobs) => jobs.waitOwnerQuiescent(ownerSessionId)),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))