import { Cause, Effect, Scope, Semaphore } from "effect"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { SessionID } from "@/contracts/session-ids"
import { Truncate } from "@/tool/truncate"
import { BackgroundJob } from "./background-job"
import type {
  SubagentDispatch,
  SubagentDispatchPrepared,
  SubagentDispatchStarted,
  SubagentPromptOps,
} from "./subagent-dispatch"
import type * as ModelTelemetry from "./model-telemetry"

export type Summary = {
  status?: string
  changedFiles?: string
  verification?: string
  remainingRisk?: string
  parentFollowUp?: string
}

export type ChildRunStatus = "queued" | "running" | "completed" | "error" | "cancelled"

export type ChildRun = {
  index: number
  title: string
  subagentType: string
  status: ChildRunStatus
  sessionId?: string
  model?: unknown
  model_profile?: string
  execution?: unknown
  outputPath?: string
  summary?: Summary
  error?: string
}

export type ChildSession = {
  index: number
  title: string
  sessionId: string
  model?: unknown
  model_profile?: string
}

export type WorkerItem = {
  index: number
  title: string
  prompt: string
  telemetry?: ModelTelemetry.ShadowDelegation
}

export type NotificationResult = {
  index: number
  title: string
  sessionId?: string
  state: "completed" | "error"
  summary?: Summary
  outputPath?: string
  error?: string
}

export type Dispatch = Effect.Success<typeof SubagentDispatch>
export type BatchRunResult = Effect.Success<ReturnType<Dispatch["runPrepared"]>>

export type BatchContext = {
  dispatch: Dispatch
  prepared: SubagentDispatchPrepared
  promptOps: SubagentPromptOps
  truncate: Truncate.Interface
  parentSessionID: SessionID
}

const SUMMARY_LABELS = [
  ["status", "Status:"],
  ["changedFiles", "Changed files:"],
  ["verification", "Verification:"],
  ["remainingRisk", "Remaining risk:"],
  ["parentFollowUp", "Parent follow-up:"],
] as const

type SummaryKey = (typeof SUMMARY_LABELS)[number][0]

export function clamp(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, max) + "..."
}

export function extractSummary(output: string): Summary {
  const text = output.replace(/<task_result>|<\/task_result>/g, "")
  const positions = SUMMARY_LABELS.map(([key, label]) => ({
    key,
    label,
    index: text.indexOf(label),
  }))
    .filter((item) => item.index !== -1)
    .sort((a, b) => a.index - b.index)

  const summary: { [K in SummaryKey]?: string } = {}
  for (let i = 0; i < positions.length; i++) {
    const current = positions[i]
    const next = positions[i + 1]
    const start = current.index + current.label.length
    const end = next ? next.index : text.length
    const value = text
      .slice(start, end)
      .replace(/\n+/g, " ")
      .trim()
    if (value.length > 0) summary[current.key] = clamp(value, 1000)
  }
  return summary
}

export function renderSummary(summary: Summary | undefined) {
  if (!summary) return "(none)"
  const parts = SUMMARY_LABELS.flatMap(([key, label]) => (summary[key] ? [`${label} ${summary[key]}`] : []))
  return parts.length > 0 ? parts.join(" | ") : "(none)"
}

export function writeChildOutput(result: { output: string; metadata?: unknown }, truncate: Truncate.Interface) {
  return Effect.gen(function* () {
    const existing = (result.metadata as { outputPath?: unknown } | undefined)?.outputPath
    if (typeof existing === "string") return existing
    if (typeof result.output !== "string" || result.output.length === 0) return undefined
    return yield* truncate.write(result.output)
  })
}

export function childSessionsFrom(runs: ReadonlyArray<ChildRun>): ChildSession[] {
  return runs.flatMap((run) =>
    run.sessionId
      ? [
          {
            index: run.index,
            title: run.title,
            sessionId: run.sessionId,
            model: run.model,
            model_profile: run.model_profile,
          },
        ]
      : [],
  )
}

/** Resolve the background-job engine under the `delegation.background_subagents` kill-switch. */
export const resolveEngine = Effect.fn("WorkerBatch.resolveEngine")(function* (input: {
  background: BackgroundJob.Interface | undefined
  config: Config.Interface
}) {
  if (!input.background) return undefined
  const cfg = yield* input.config.get()
  const enabled = cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
  return enabled ? input.background : undefined
})

/** Cancel every child session through its durable job handle, or directly when no engine exists. */
export const cancelSessions = (input: {
  engine: BackgroundJob.Interface | undefined
  promptOps: SubagentPromptOps
  sessions: ReadonlyArray<{ sessionId: string }>
}) =>
  Effect.forEach(
    input.sessions,
    (child) =>
      input.engine
        ? input.engine.cancel(child.sessionId).pipe(Effect.ignore)
        : input.promptOps.cancel(SessionID.make(child.sessionId)).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  )

/**
 * Run one worker as a foreground engine job and consume its result inline. The
 * tool fiber parks on the job; interruption cancels the job (whose onInterrupt
 * hook cancels the bound child session), and delivery is marked as soon as the
 * inline result is consumed so the owner's park/quiescence never waits on it.
 */
export const runWorkerJob = Effect.fn("WorkerBatch.runWorkerJob")(function* (
  input: BatchContext & {
    engine: BackgroundJob.Interface
    jobType: string
    workerLabel: string
    item: WorkerItem
    abort: AbortSignal
    onStarted?: (started: SubagentDispatchStarted) => Effect.Effect<void>
  },
) {
  const materialized = yield* input.dispatch.materialize(input.prepared, input.item.title)
  const workerSessionID = materialized.nextSession.id
  let workerResult: BatchRunResult | undefined
  const started = yield* input.engine.start({
    id: workerSessionID,
    type: input.jobType,
    title: input.item.title,
    ownerSessionId: input.parentSessionID,
    metadata: {
      model: input.prepared.resolved.model,
      background: false,
    },
    onInterrupt: input.promptOps.cancel(workerSessionID).pipe(Effect.ignore),
    run: input.dispatch
      .runPrepared({
        prepared: input.prepared,
        materialized,
        description: input.item.title,
        prompt: input.item.prompt,
        promptOps: input.promptOps,
        abort: input.abort,
        telemetry: input.item.telemetry,
        onStarted: input.onStarted,
      })
      .pipe(
        Effect.map((result) => {
          workerResult = result
          return result.output
        }),
      ),
  })
  const generation = started.generation
  const settled = yield* input.engine.wait({ id: workerSessionID }).pipe(
    Effect.map((waited) => waited.info),
    Effect.onInterrupt(() => input.engine.cancel(workerSessionID).pipe(Effect.ignore)),
  )
  yield* input.engine.markDelivered(workerSessionID, generation).pipe(Effect.ignore)
  if (settled?.status === "error") return yield* Effect.fail(new Error(settled.error ?? `${input.workerLabel} failed`))
  if (settled?.status === "cancelled") {
    if (input.abort.aborted) return yield* Effect.interrupt
    return yield* Effect.fail(new Error(`${input.workerLabel} ${workerSessionID} was cancelled`))
  }
  if (workerResult) return workerResult
  return yield* Effect.fail(new Error(`${input.workerLabel} ${workerSessionID} settled without a result`))
})

/**
 * Launch a background batch: precheck the shared background pool before each
 * materialize, start up to `concurrency` workers synchronously so the receipt
 * carries real child session ids, then refill slots as workers settle. Each
 * worker registers a parent-owned background job; completion injects one
 * notification and marks delivery after the injection completes.
 */
export const runBackground = Effect.fn("WorkerBatch.runBackground")(function* (
  input: BatchContext & {
    engine: BackgroundJob.Interface
    jobType: string
    workerLabel: string
    items: ReadonlyArray<WorkerItem>
    concurrency: number
    poolLimit: number
    childRuns: Map<number, ChildRun>
    setChildRun: (index: number, update: Partial<ChildRun>) => void
    notification: (result: NotificationResult) => string
    scope: Scope.Scope
  },
) {
  const slots = Semaphore.makeUnsafe(input.concurrency)
  // Background workers are detached from the tool fiber's abort signal; only the
  // engine (session.remove / task_cancel) can stop them.
  const workerAbort = new AbortController().signal
  const inject = (text: string) =>
    (input.promptOps.injectSynthetic?.({ sessionID: input.parentSessionID, text }) ?? Effect.void).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(input.scope, { startImmediately: true }),
    )
  const notifyStartError = (item: WorkerItem, error: string) =>
    inject(input.notification({ index: item.index, title: item.title, state: "error", error }))
  const notifySettled = Effect.fn("WorkerBatch.notifyBackgroundWorker")(function* (
    item: WorkerItem,
    workerSessionID: SessionID,
    generation: number,
  ) {
    yield* input.engine.wait({ id: workerSessionID }).pipe(
      Effect.flatMap((waited) => {
        const info = waited.info
        if (!info) return Effect.void
        const completed = info.status === "completed"
        const text = completed ? (info.output ?? "") : (info.error ?? `worker ${info.status}`)
        return Effect.gen(function* () {
          const outputPath = text.length > 0 ? yield* input.truncate.write(text) : undefined
          yield* inject(
            input.notification({
              index: item.index,
              title: item.title,
              sessionId: workerSessionID,
              state: completed ? "completed" : "error",
              summary: completed ? extractSummary(text) : undefined,
              outputPath,
              error: completed ? undefined : text,
            }),
          )
        })
      }),
      // Delivery is final once the notify fiber finishes, and the mark is
      // generation-bound so a same-id restart is never falsely delivered.
      // The slot is released only after the worker settled, preserving the
      // batch concurrency cap for queued items.
      Effect.ensuring(input.engine.markDelivered(workerSessionID, generation).pipe(Effect.ignore)),
      Effect.ensuring(slots.release(1)),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(input.scope, { startImmediately: true }),
    )
  })
  const startWorker = Effect.fn("WorkerBatch.startBackgroundWorker")(function* (item: WorkerItem) {
    // Precheck the background pool before materialize (which creates the child
    // session as a side effect), so an over-cap worker never leaves an orphan
    // empty session behind. The engine re-checks atomically.
    const runningCount = (yield* input.engine.list()).filter(
      (job) => job.status === "running" && job.metadata?.background !== false,
    ).length
    if (runningCount >= input.poolLimit) {
      const error = `Cannot start ${input.workerLabel} ${item.index}: concurrency limit reached (${runningCount} running >= background_concurrent ${input.poolLimit}). Complete or cancel a running background task before starting another.`
      input.setChildRun(item.index, { status: "error", error })
      yield* notifyStartError(item, error)
      return false
    }
    const materialized = yield* input.dispatch.materialize(input.prepared, item.title).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.pretty(cause)
        input.setChildRun(item.index, { status: "error", error })
        return notifyStartError(item, error).pipe(Effect.as(undefined))
      }),
    )
    if (!materialized) return false
    const workerSessionID = materialized.nextSession.id
    // onStarted is deliberately omitted: it fires inside the detached job after
    // the tool returned, when ctx.metadata is no longer accepted.
    input.setChildRun(item.index, {
      status: "running",
      sessionId: workerSessionID,
      model: input.prepared.resolved.model,
      model_profile: materialized.execution.modelProfile,
      execution: materialized.execution,
    })
    const started = yield* input.engine
      .start({
        id: workerSessionID,
        type: input.jobType,
        title: item.title,
        ownerSessionId: input.parentSessionID,
        metadata: {
          model: input.prepared.resolved.model,
          background: true,
        },
        onInterrupt: input.promptOps.cancel(workerSessionID).pipe(Effect.ignore),
        run: input.dispatch
          .runPreparedBackground({
            prepared: input.prepared,
            materialized,
            description: item.title,
            prompt: item.prompt,
            promptOps: input.promptOps,
            abort: workerAbort,
            telemetry: item.telemetry,
          })
          .pipe(Effect.map((result) => result.output)),
      })
      .pipe(
        Effect.map((info) => ({ info })),
        Effect.catchTag("BackgroundJobLimitError", (error) => {
          input.setChildRun(item.index, { status: "error", error: error.message })
          return notifyStartError(item, error.message).pipe(Effect.as(undefined))
        }),
      )
    if (!started) return false
    yield* notifySettled(item, workerSessionID, started.info.generation)
    return true
  })
  const startWithSlot = Effect.fn("WorkerBatch.startBackgroundWorkerWithSlot")(function* (item: WorkerItem) {
    yield* slots.take(1)
    const started = yield* startWorker(item)
    // A rejected start never owns a notify fiber, so release the slot here.
    if (!started) yield* slots.release(1)
  })
  yield* Effect.forEach(input.items.slice(0, input.concurrency), startWithSlot, { discard: true })
  const remaining = input.items.slice(input.concurrency)
  if (remaining.length > 0) {
    yield* Effect.forEach(remaining, startWithSlot, { discard: true }).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(input.scope, { startImmediately: true }),
    )
  }
  const runs = Array.from(input.childRuns.values()).sort((a, b) => a.index - b.index)
  return { childRuns: runs, childSessions: childSessionsFrom(runs) }
})

export * as WorkerBatch from "./worker-batch"