export * as BrowserScenario from "./scenario"

import { Clock, Effect, Schema } from "effect"
import { ulid } from "ulid"
import { BrowserArtifact } from "./artifact"
import { BrowserRuntime } from "./runtime"
import { BrowserSnapshot } from "./snapshot"

const PositiveNumber = Schema.Number.check(Schema.isGreaterThan(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const LaunchOptionsSchema = Schema.Struct({
  cdpUrl: Schema.optional(Schema.String),
  executablePath: Schema.optional(Schema.String),
  headless: Schema.optional(Schema.Boolean),
  locale: Schema.optional(Schema.String),
  timeout: Schema.optional(PositiveNumber),
})

export const SnapshotOptionsSchema = Schema.Struct({
  preset: Schema.optional(Schema.Literal("efficient")),
  interactive: Schema.optional(Schema.Boolean),
  compact: Schema.optional(Schema.Boolean),
  depth: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChars: Schema.optional(PositiveInt),
})

export const RefTargetSchema = Schema.Struct({ ref: Schema.String })
export const SemanticTargetSchema = Schema.Struct({
  role: Schema.String,
  name: Schema.optional(Schema.String),
  nth: Schema.optional(PositiveInt),
})
export const TargetSchema = Schema.Union([RefTargetSchema, SemanticTargetSchema])

export const AssertionSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("url"),
    equals: Schema.optional(Schema.String),
    includes: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("text"), includes: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ref"), target: TargetSchema }),
  Schema.Struct({ type: Schema.Literal("interactable"), target: TargetSchema }),
])

export const StepSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("snapshot"), options: Schema.optional(SnapshotOptionsSchema) }),
  Schema.Struct({
    type: Schema.Literal("click"),
    target: TargetSchema,
    timeout: Schema.optional(PositiveNumber),
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    target: TargetSchema,
    text: Schema.String,
    timeout: Schema.optional(PositiveNumber),
  }),
  Schema.Struct({
    type: Schema.Literal("screenshot"),
    name: Schema.optional(Schema.String),
    fullPage: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    assertion: AssertionSchema,
    timeout: Schema.optional(PositiveNumber),
    interval: Schema.optional(PositiveNumber),
    options: Schema.optional(SnapshotOptionsSchema),
  }),
  Schema.Struct({ type: Schema.Literal("assert"), assertion: AssertionSchema }),
  Schema.Struct({ type: Schema.Literal("close") }),
])

export const ScenarioSchema = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  timeout: Schema.optional(PositiveNumber),
  browser: Schema.optional(LaunchOptionsSchema),
  steps: Schema.Array(StepSchema),
})

export type Scenario = Schema.Schema.Type<typeof ScenarioSchema>
export type Step = Schema.Schema.Type<typeof StepSchema>
export type Target = Schema.Schema.Type<typeof TargetSchema>

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("BrowserScenarioParseError", {
  message: Schema.String,
}) {}

export class RunFailure extends Schema.TaggedErrorClass<RunFailure>()("BrowserScenarioRunFailure", {
  stepIndex: Schema.Number,
  stepType: Schema.String,
  message: Schema.String,
}) {}

export interface StepResult {
  readonly index: number
  readonly type: Step["type"]
  readonly status: "passed" | "failed"
  readonly durationMs: number
  readonly error?: string
}

export interface Result {
  readonly name: string
  readonly status: "passed" | "failed"
  readonly startedAt: string
  readonly durationMs: number
  readonly steps: readonly StepResult[]
  readonly artifacts: readonly BrowserArtifact.Artifact[]
  readonly error?: {
    readonly stepIndex: number
    readonly stepType: string
    readonly message: string
  }
}

export interface RunOutput {
  readonly result: Result
  readonly json: BrowserArtifact.Artifact
  readonly junit: BrowserArtifact.Artifact
}

export const decode = (input: unknown) =>
  Schema.decodeUnknownEffect(ScenarioSchema)(input, { errors: "all", propertyOrder: "original" }).pipe(
    Effect.mapError((cause) => new ParseError({ message: String(cause) })),
  )

export const run = Effect.fn("BrowserScenario.run")(function* (input: {
  readonly scenario: Scenario
  readonly sessionID?: string
}) {
  const runtime = yield* BrowserRuntime.Service
  const artifacts = yield* BrowserArtifact.Service
  const sessionID = input.sessionID ?? `scenario-${ulid()}`
  const started = yield* Clock.currentTimeMillis
  const state: {
    tabID?: string
    snapshot?: BrowserRuntime.SnapshotResult
    readonly artifacts: BrowserArtifact.Artifact[]
    readonly steps: StepResult[]
    activeIndex: number
    activeType: string
  } = {
    artifacts: [],
    steps: [],
    activeIndex: -1,
    activeType: "scenario",
  }

  const failure = (message: string) =>
    new RunFailure({ stepIndex: state.activeIndex, stepType: state.activeType, message })

  const runtimeEffect = <A>(effect: Effect.Effect<A, BrowserRuntime.RuntimeError>) =>
    effect.pipe(Effect.mapError((cause) => failure(cause.message)))

  const requireTab = () =>
    state.tabID ? Effect.succeed(state.tabID) : Effect.fail(failure("Scenario has no open browser tab"))

  const requireSnapshot = () =>
    state.snapshot
      ? Effect.succeed(state.snapshot)
      : Effect.fail(failure("Take a new snapshot before resolving a browser target"))

  const resolveTarget = (target: Target) =>
    Effect.gen(function* () {
      if ("ref" in target) return target.ref
      const snapshot = yield* requireSnapshot()
      const matches = Array.from(snapshot.refs, ([ref, candidate]) => ({ ref, candidate })).filter((item) => {
        if (item.candidate.role !== target.role) return false
        if (target.name !== undefined && item.candidate.name !== target.name) return false
        if (target.nth !== undefined && item.candidate.nth !== target.nth) return false
        return true
      })
      if (matches.length === 1) return matches[0]!.ref
      const description = `${target.role}${target.name ? ` named ${JSON.stringify(target.name)}` : ""}${target.nth ? ` nth ${target.nth}` : ""}`
      if (matches.length === 0) return yield* failure(`Browser target not found: ${description}`)
      return yield* failure(`Browser target is ambiguous: ${description}`)
    })

  const executeAssertion = (assertion: Schema.Schema.Type<typeof AssertionSchema>) =>
    Effect.gen(function* () {
      if (assertion.type === "text") {
        const snapshot = yield* requireSnapshot()
        if (snapshot.text.includes(assertion.includes)) return
        return yield* failure(`Snapshot does not include ${JSON.stringify(assertion.includes)}`)
      }
      if (assertion.type === "ref" || assertion.type === "interactable") {
        yield* resolveTarget(assertion.target)
        return
      }
      if (assertion.equals === undefined && assertion.includes === undefined)
        return yield* failure("URL assertion requires equals or includes")
      const tabs = yield* runtimeEffect(runtime.tabs(sessionID))
      const tab = state.tabID ? tabs.find((item) => item.id === state.tabID) : tabs.find((item) => item.current)
      if (!tab) return yield* failure("Browser tab not found for URL assertion")
      if (assertion.equals !== undefined && tab.url !== assertion.equals)
        return yield* failure(`Expected URL ${JSON.stringify(assertion.equals)}, received ${JSON.stringify(tab.url)}`)
      if (assertion.includes !== undefined && !tab.url.includes(assertion.includes))
        return yield* failure(`Expected URL to include ${JSON.stringify(assertion.includes)}, received ${JSON.stringify(tab.url)}`)
    })

  const waitForAssertion = (step: Extract<Step, { readonly type: "wait" }>) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + (step.timeout ?? 10_000)
      const interval = step.interval ?? 100
      while (true) {
        if (step.assertion.type !== "url") {
          const tabID = yield* requireTab()
          state.snapshot = yield* runtimeEffect(
            runtime.snapshot({
              sessionID,
              tabID,
              options: step.options as BrowserSnapshot.Options | undefined,
            }),
          )
        }
        const error = yield* executeAssertion(step.assertion).pipe(
          Effect.as(undefined as RunFailure | undefined),
          Effect.catch((cause) => Effect.succeed(cause)),
        )
        if (!error) return
        if ((yield* Clock.currentTimeMillis) >= deadline) return yield* error
        yield* Effect.sleep(`${interval} millis`)
      }
    })

  const executeStep = (step: Step) =>
    Effect.gen(function* () {
      if (step.type === "open") {
        const url = yield* Effect.try({
          try: () => (input.scenario.baseUrl ? new URL(step.url, input.scenario.baseUrl) : new URL(step.url)),
          catch: () => failure(`Invalid browser URL: ${step.url}`),
        })
        if (url.protocol !== "http:" && url.protocol !== "https:")
          return yield* failure(`Browser scenario URL must use http:// or https://: ${url.href}`)
        const tab = yield* runtimeEffect(
          runtime.open({ sessionID, url: url.href, launch: input.scenario.browser as BrowserRuntime.LaunchOptions | undefined }),
        )
        state.tabID = tab.id
        state.snapshot = undefined
        return
      }
      if (step.type === "snapshot") {
        const tabID = yield* requireTab()
        state.snapshot = yield* runtimeEffect(
          runtime.snapshot({
            sessionID,
            tabID,
            options: step.options as BrowserSnapshot.Options | undefined,
          }),
        )
        return
      }
      if (step.type === "wait") {
        yield* waitForAssertion(step)
        return
      }
      if (step.type === "click") {
        const tabID = yield* requireTab()
        const ref = yield* resolveTarget(step.target)
        yield* runtimeEffect(runtime.click({ sessionID, tabID, ref, timeout: step.timeout }))
        state.snapshot = undefined
        return
      }
      if (step.type === "type") {
        const tabID = yield* requireTab()
        const ref = yield* resolveTarget(step.target)
        yield* runtimeEffect(runtime.type({ sessionID, tabID, ref, text: step.text, timeout: step.timeout }))
        state.snapshot = undefined
        return
      }
      if (step.type === "screenshot") {
        const tabID = yield* requireTab()
        const screenshot = yield* runtimeEffect(
          runtime.screenshot({ sessionID, tabID, name: step.name, fullPage: step.fullPage }),
        )
        state.artifacts.push(screenshot.artifact)
        return
      }
      if (step.type === "assert") {
        yield* executeAssertion(step.assertion)
        return
      }
      yield* runtimeEffect(runtime.closeSession(sessionID))
      state.tabID = undefined
      state.snapshot = undefined
    })

  const captureFailureArtifacts = () =>
    Effect.gen(function* () {
      const tabID = state.tabID
      if (!tabID) return
      const snapshot = yield* runtime.snapshot({ sessionID, tabID, options: { preset: "efficient" } }).pipe(
        Effect.map((value) => value as BrowserRuntime.SnapshotResult | undefined),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (snapshot) {
        const artifact = yield* artifacts
          .write({
            sessionID,
            kind: "snapshot",
            name: `${input.scenario.name}-failure`,
            extension: "txt",
            mime: "text/plain",
            data: snapshot.text,
          })
          .pipe(
            Effect.map((value) => value as BrowserArtifact.Artifact | undefined),
            Effect.catch(() => Effect.succeed(undefined)),
          )
        if (artifact) state.artifacts.push(artifact)
      }
      const screenshot = yield* runtime
        .screenshot({ sessionID, tabID, name: `${input.scenario.name}-failure`, fullPage: true })
        .pipe(
          Effect.map((value) => value as BrowserRuntime.ScreenshotResult | undefined),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      if (screenshot) state.artifacts.push(screenshot.artifact)
    })

  const execution = Effect.forEach(input.scenario.steps, (step, index) =>
    Effect.gen(function* () {
      state.activeIndex = index
      state.activeType = step.type
      const stepStarted = yield* Clock.currentTimeMillis
      const error = yield* executeStep(step).pipe(
        Effect.as(undefined as RunFailure | undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      )
      const ended = yield* Clock.currentTimeMillis
      state.steps.push({
        index,
        type: step.type,
        status: error ? "failed" : "passed",
        durationMs: ended - stepStarted,
        ...(error ? { error: error.message } : {}),
      })
      if (error) return yield* Effect.fail(error)
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: `${input.scenario.timeout ?? 30_000} millis`,
      orElse: () => Effect.fail(failure(`Scenario timed out after ${input.scenario.timeout ?? 30_000}ms`)),
    }),
    Effect.tapError(() => captureFailureArtifacts()),
    Effect.ensuring(runtime.closeSession(sessionID).pipe(Effect.ignore)),
  )

  const runFailure = yield* execution.pipe(
    Effect.as(undefined as RunFailure | undefined),
    Effect.catch((cause) => Effect.succeed(cause)),
  )

  if (runFailure && !state.steps.some((step) => step.status === "failed")) {
    state.steps.push({
      index: runFailure.stepIndex,
      type: (input.scenario.steps[runFailure.stepIndex]?.type ?? "close") as Step["type"],
      status: "failed",
      durationMs: 0,
      error: runFailure.message,
    })
  }


  const ended = yield* Clock.currentTimeMillis
  const result: Result = {
    name: input.scenario.name,
    status: runFailure ? "failed" : "passed",
    startedAt: new Date(started).toISOString(),
    durationMs: ended - started,
    steps: state.steps,
    artifacts: state.artifacts,
    ...(runFailure
      ? {
          error: {
            stepIndex: runFailure.stepIndex,
            stepType: runFailure.stepType,
            message: runFailure.message,
          },
        }
      : {}),
  }

  const reportFailure = (message: string) =>
    new RunFailure({ stepIndex: -1, stepType: "report", message })
  const json = yield* artifacts
    .write({
      sessionID,
      kind: "scenario",
      name: `${input.scenario.name}-result`,
      extension: "json",
      mime: "application/json",
      data: JSON.stringify(result, undefined, 2),
    })
    .pipe(Effect.mapError((cause) => reportFailure(String(cause))))
  const junit = yield* artifacts
    .write({
      sessionID,
      kind: "scenario",
      name: `${input.scenario.name}-junit`,
      extension: "xml",
      mime: "application/xml",
      data: junitXML(result),
    })
    .pipe(Effect.mapError((cause) => reportFailure(String(cause))))

  return { result, json, junit } satisfies RunOutput
})

export function junitXML(result: Result) {
  const failures = result.steps.filter((step) => step.status === "failed").length
  const cases = result.steps
    .map((step) => {
      const failure = step.error ? `<failure message="${escapeXML(step.error)}">${escapeXML(step.error)}</failure>` : ""
      return `<testcase name="${escapeXML(`${step.index + 1} ${step.type}`)}" time="${(step.durationMs / 1000).toFixed(3)}">${failure}</testcase>`
    })
    .join("")
  const artifactPaths = result.artifacts.map((artifact) => artifact.path).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="${escapeXML(result.name)}" tests="${result.steps.length}" failures="${failures}" errors="0" time="${(result.durationMs / 1000).toFixed(3)}">${cases}<system-out>${escapeXML(artifactPaths)}</system-out></testsuite>`
}

function escapeXML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
