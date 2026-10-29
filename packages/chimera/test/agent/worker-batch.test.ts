import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { BackgroundJob } from "../../src/agent/background-job"
import { WorkerBatch } from "../../src/agent/worker-batch"
import type { SubagentDispatchPrepared, SubagentPromptOps } from "../../src/agent/subagent-dispatch"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID } from "../../src/contracts/session-ids"
import { Config } from "@/config/config"
import { Truncate } from "../../src/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(BackgroundJob.defaultLayer, Truncate.defaultLayer, Config.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const prepared = {
  parentSessionID: SessionID.make("ses_parent"),
  resolved: { model: { providerID: "test", modelID: "test-model" }, profile: undefined, source: "explicit" },
  parent: {},
  subagent: { name: "general" },
  config: {},
} as unknown as SubagentDispatchPrepared

const item = (index: number): WorkerBatch.WorkerItem => ({
  index,
  title: `worker-${index}`,
  prompt: `Review item ${index}`,
})

type FakeDispatchOptions = {
  gate?: Deferred.Deferred<void>
  text?: string
}

const fakeDispatch = (opts: FakeDispatchOptions = {}) =>
  ({
    prepare: () => Effect.die(new Error("prepare is not used by worker-batch")),
    materialize: (_prepared: SubagentDispatchPrepared, description: string) =>
      Effect.succeed({
        nextSession: { id: SessionID.make(`ses_${description}`) },
        execution: { version: 2, parentSessionId: SessionID.make("ses_parent"), agent: "general" },
        atDepthCap: false,
      }),
    runPrepared: (input: { description: string; onStarted?: () => Effect.Effect<void> }) =>
      Effect.gen(function* () {
        if (input.onStarted) yield* input.onStarted()
        if (opts.gate) yield* Deferred.await(opts.gate)
        return {
          title: input.description,
          sessionId: SessionID.make(`ses_${input.description}`),
          model: { providerID: "test", modelID: "test-model" },
          execution: { version: 2 },
          output: opts.text ?? "done",
        }
      }),
    runPreparedBackground: (input: { description: string; materialized: { nextSession: { id: SessionID } } }) =>
      Effect.gen(function* () {
        if (opts.gate) yield* Deferred.await(opts.gate)
        return {
          title: input.description,
          sessionId: input.materialized.nextSession.id,
          model: { providerID: "test", modelID: "test-model" },
          execution: { version: 2 },
          output: opts.text ?? "done",
        }
      }),
    run: () => Effect.die(new Error("run is not used by worker-batch")),
  }) as unknown as WorkerBatch.Dispatch

const promptOps = (opts: {
  onInject?: (input: { sessionID: SessionID; text: string }) => void
  onCancel?: (sessionID: SessionID) => void
}): SubagentPromptOps => ({
  cancel: (sessionID) => Effect.sync(() => opts.onCancel?.(sessionID)),
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: () => Effect.die(new Error("prompt is not used by worker-batch")),
  injectSynthetic: (input) =>
    Effect.sync(() => opts.onInject?.(input)).pipe(Effect.as({} as MessageV2.WithParts)),
})

const childRuns = (items: ReadonlyArray<WorkerBatch.WorkerItem>) =>
  new Map<number, WorkerBatch.ChildRun>(
    items.map((entry) => [
      entry.index,
      { index: entry.index, title: entry.title, subagentType: "general", status: "queued" as const },
    ]),
  )

const waitFor = (check: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (yield* check()) return
      yield* Effect.sleep(10)
    }
    return yield* Effect.die(new Error("timed out waiting for condition"))
  })

describe("agent.worker-batch helpers", () => {
  it.effect("extracts the structured summary labels from a child output", () =>
    Effect.gen(function* () {
      const summary = WorkerBatch.extractSummary(
        [
          "<task_result>",
          "Status: actionable",
          "Changed files: src/a.ts",
          "Verification: bun test passed",
          "Remaining risk: low",
          "Parent follow-up: closeout",
          "</task_result>",
        ].join("\n"),
      )
      expect(summary).toEqual({
        status: "actionable",
        changedFiles: "src/a.ts",
        verification: "bun test passed",
        remainingRisk: "low",
        parentFollowUp: "closeout",
      })
      expect(WorkerBatch.renderSummary(summary)).toBe(
        "Status: actionable | Changed files: src/a.ts | Verification: bun test passed | Remaining risk: low | Parent follow-up: closeout",
      )
      expect(WorkerBatch.renderSummary(undefined)).toBe("(none)")
    }),
  )

  it.effect("clamps long text and derives child sessions only from started runs", () =>
    Effect.gen(function* () {
      expect(WorkerBatch.clamp("abcdef", 3)).toBe("abc...")
      expect(WorkerBatch.clamp("abc", 3)).toBe("abc")
      const runs: WorkerBatch.ChildRun[] = [
        { index: 2, title: "two", subagentType: "general", status: "completed", sessionId: "ses_two", model_profile: "flash" },
        { index: 1, title: "one", subagentType: "general", status: "error" },
      ]
      expect(WorkerBatch.childSessionsFrom(runs)).toEqual([
        { index: 2, title: "two", sessionId: "ses_two", model: undefined, model_profile: "flash" },
      ])
    }),
  )

  it.instance("reuses an existing outputPath and writes new output through Truncate", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      expect(yield* WorkerBatch.writeChildOutput({ output: "text", metadata: { outputPath: "existing.txt" } }, truncate)).toBe(
        "existing.txt",
      )
      const written = yield* WorkerBatch.writeChildOutput({ output: "full output", metadata: {} }, truncate)
      expect(typeof written).toBe("string")
      expect(yield* WorkerBatch.writeChildOutput({ output: "", metadata: {} }, truncate)).toBeUndefined()
    }),
  )

  it.instance("resolves the background engine under the kill-switch", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const config = yield* Config.Service
      expect(yield* WorkerBatch.resolveEngine({ background: jobs, config })).toBe(jobs)
    }),
  )

  it.instance(
    "returns no engine when the background kill-switch is off",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const config = yield* Config.Service
        expect(yield* WorkerBatch.resolveEngine({ background: jobs, config })).toBeUndefined()
      }),
    { config: { delegation: { background_subagents: false } } },
  )
})

describe("agent.worker-batch background launch", () => {
  it.instance("registers parent-owned background jobs and delivers one notification per worker", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const truncate = yield* Truncate.Service
      const scope = yield* Scope.Scope
      const gate = yield* Deferred.make<void>()
      const injected: Array<{ sessionID: SessionID; text: string }> = []
      const items = [item(1), item(2)]
      const runs = childRuns(items)
      const receipt = yield* WorkerBatch.runBackground({
        engine: jobs,
        dispatch: fakeDispatch({ gate }),
        prepared,
        promptOps: promptOps({ onInject: (input) => injected.push(input) }),
        truncate,
        parentSessionID: SessionID.make("ses_parent"),
        jobType: "swarm",
        workerLabel: "swarm worker",
        items,
        concurrency: 2,
        poolLimit: 16,
        childRuns: runs,
        setChildRun: (index, update) => runs.set(index, { ...runs.get(index)!, ...update }),
        notification: (result) => `result:${result.index}:${result.state}:${result.sessionId ?? "none"}`,
        scope,
      })

      expect(receipt.childRuns.map((run) => run.status)).toEqual(["running", "running"])
      expect(receipt.childSessions.map((session) => session.sessionId)).toEqual(["ses_worker-1", "ses_worker-2"])
      const started = (yield* jobs.list()).filter((job) => job.type === "swarm")
      expect(started).toHaveLength(2)
      expect(started.every((job) => job.status === "running")).toBe(true)
      expect(started.every((job) => job.metadata?.background === true)).toBe(true)
      expect(started.every((job) => job.ownerSessionId === "ses_parent")).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* waitFor(() => jobs.list().pipe(Effect.map((list) => list.every((job) => job.delivery === "delivered"))))
      expect(injected.map((input) => input.text).sort()).toEqual(["result:1:completed:ses_worker-1", "result:2:completed:ses_worker-2"])
    }),
  )

  it.instance("queues items beyond concurrency and refills slots as workers settle", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const truncate = yield* Truncate.Service
      const scope = yield* Scope.Scope
      const gate = yield* Deferred.make<void>()
      const items = [item(1), item(2), item(3)]
      const runs = childRuns(items)
      const receipt = yield* WorkerBatch.runBackground({
        engine: jobs,
        dispatch: fakeDispatch({ gate }),
        prepared,
        promptOps: promptOps({}),
        truncate,
        parentSessionID: SessionID.make("ses_parent"),
        jobType: "swarm",
        workerLabel: "swarm worker",
        items,
        concurrency: 1,
        poolLimit: 16,
        childRuns: runs,
        setChildRun: (index, update) => runs.set(index, { ...runs.get(index)!, ...update }),
        notification: (result) => `result:${result.index}:${result.state}`,
        scope,
      })

      expect(receipt.childRuns.map((run) => run.status)).toEqual(["running", "queued", "queued"])
      expect((yield* jobs.list()).filter((job) => job.status === "running")).toHaveLength(1)

      yield* Deferred.succeed(gate, undefined)
      yield* waitFor(() =>
        jobs.list().pipe(Effect.map((list) => list.length === 3 && list.every((job) => job.status === "completed"))),
      )
    }),
  )

  it.instance(
    "rejects a worker with an error notification when the background pool is full",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const truncate = yield* Truncate.Service
        const scope = yield* Scope.Scope
        const gate = yield* Deferred.make<void>()
        const injected: string[] = []
        yield* jobs.start({ id: "ses_saturated", run: Deferred.await(gate).pipe(Effect.as("bg")) })
        const items = [item(1)]
        const runs = childRuns(items)

        const receipt = yield* WorkerBatch.runBackground({
          engine: jobs,
          dispatch: fakeDispatch({}),
          prepared,
          promptOps: promptOps({ onInject: (input) => injected.push(input.text) }),
          truncate,
          parentSessionID: SessionID.make("ses_parent"),
          jobType: "swarm",
          workerLabel: "swarm worker",
          items,
          concurrency: 1,
          poolLimit: 1,
          childRuns: runs,
          setChildRun: (index, update) => runs.set(index, { ...runs.get(index)!, ...update }),
          notification: (result) => `result:${result.index}:${result.state}:${result.error ?? ""}`,
          scope,
        })

        expect(receipt.childRuns[0]?.status).toBe("error")
        expect(receipt.childRuns[0]?.error).toContain("background_concurrent 1")
        expect(receipt.childSessions).toHaveLength(0)
        expect((yield* jobs.list()).filter((job) => job.type === "swarm")).toHaveLength(0)
        yield* waitFor(() => Effect.sync(() => injected.length === 1))
        expect(injected[0]).toContain("background_concurrent 1")
        yield* Deferred.succeed(gate, undefined)
      }),
  )
})

describe("agent.worker-batch foreground and cancel", () => {
  it.instance("runs one worker as a parent-owned foreground job and marks it delivered", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const truncate = yield* Truncate.Service
      let started = 0
      const result = yield* WorkerBatch.runWorkerJob({
        engine: jobs,
        dispatch: fakeDispatch({}),
        prepared,
        promptOps: promptOps({}),
        truncate,
        parentSessionID: SessionID.make("ses_parent"),
        jobType: "swarm",
        workerLabel: "Swarm worker",
        item: item(1),
        abort: new AbortController().signal,
        onStarted: () => Effect.sync(() => void (started += 1)),
      })
      expect(result.output).toBe("done")
      expect(started).toBeGreaterThan(0)
      const info = yield* jobs.get("ses_worker-1")
      expect(info?.type).toBe("swarm")
      expect(info?.status).toBe("completed")
      expect(info?.delivery).toBe("delivered")
      expect(info?.metadata?.background).toBe(false)
      expect(info?.ownerSessionId).toBe("ses_parent")
    }),
  )

  it.instance("cancels workers through the engine, or through promptOps when no engine exists", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const gate = yield* Deferred.make<void>()
      const interrupted: string[] = []
      const cancelled: string[] = []
      yield* jobs.start({
        id: "ses_engine_child",
        run: Deferred.await(gate).pipe(Effect.as("bg")),
        onInterrupt: Effect.sync(() => interrupted.push("ses_engine_child")),
      })

      yield* WorkerBatch.cancelSessions({
        engine: jobs,
        promptOps: promptOps({ onCancel: (sessionID) => cancelled.push(sessionID) }),
        sessions: [{ sessionId: "ses_engine_child" }],
      })
      expect(interrupted).toEqual(["ses_engine_child"])
      expect(cancelled).toEqual([])

      yield* WorkerBatch.cancelSessions({
        engine: undefined,
        promptOps: promptOps({ onCancel: (sessionID) => cancelled.push(sessionID) }),
        sessions: [{ sessionId: "ses_legacy_child" }],
      })
      expect(cancelled).toEqual(["ses_legacy_child"])
      yield* Deferred.succeed(gate, undefined)
    }),
  )

  it.instance("interrupting a foreground worker wait cancels its engine job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const truncate = yield* Truncate.Service
      const gate = yield* Deferred.make<void>()
      const fiber = yield* WorkerBatch.runWorkerJob({
        engine: jobs,
        dispatch: fakeDispatch({ gate }),
        prepared,
        promptOps: promptOps({}),
        truncate,
        parentSessionID: SessionID.make("ses_parent"),
        jobType: "swarm",
        workerLabel: "Swarm worker",
        item: item(1),
        abort: new AbortController().signal,
      }).pipe(Effect.forkChild)
      yield* waitFor(() => jobs.get("ses_worker-1").pipe(Effect.map((info) => info?.status === "running")))
      yield* Fiber.interrupt(fiber)
      yield* Effect.sleep(50)
      expect((yield* jobs.get("ses_worker-1"))?.status).toBe("cancelled")
      yield* Deferred.succeed(gate, undefined)
    }),
  )
})