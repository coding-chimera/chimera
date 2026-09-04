export * as ModelTelemetry from "./model-telemetry"

import { createHash, randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm"
import { Schema } from "effect"
import {
  ModelTelemetryDelegationTable,
  ModelTelemetryEventTable,
  ModelTelemetryOracleLinkTable,
  ModelTelemetrySessionBindingTable,
  ModelTelemetryTombstoneTable,
} from "./model-telemetry.sql"
import { ProjectID, type ProjectID as ProjectIDType } from "@/project/schema"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import { Database, type TxOrDb } from "@/storage/db"

const MAX_STRING_LENGTH = 128
const MAX_READ_LIMIT = 1_000
const DEFAULT_READ_LIMIT = 100
const MAX_EVENT_TYPES = 9
const MAX_INDEX = 100_000
const MAX_FANOUT_SIZE = 100_000
const MAX_CONCURRENCY = 10_000
const MAX_CANDIDATES = 256
const MAX_COMPACT_BATCH = 500
const MAX_TELEMETRY_INPUT_BYTES = 256 * 1024
const MAX_TELEMETRY_INPUT_NODES = 8_192
const MAX_TELEMETRY_INPUT_DEPTH = 32
const MAX_TELEMETRY_INPUT_ARRAY_LENGTH = MAX_CANDIDATES
const MAX_TELEMETRY_INPUT_STRING_LENGTH = 16_384
const MAX_TELEMETRY_INPUT_OBJECT_KEYS = 512
export const BEST_EFFORT_QUEUE_LIMIT = 256
const telemetryHashSalt = randomUUID()

const SafeString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_STRING_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/),
)
const SafeID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_STRING_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/),
)
const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const ReadLimit = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_READ_LIMIT))
const Index = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_INDEX))
const FanoutSize = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_FANOUT_SIZE))
const Concurrency = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_CONCURRENCY))
const CandidateCount = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_CANDIDATES))
const CompactBatchSize = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_COMPACT_BATCH))
const Percent = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(100))
const Probability = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(1))
const Checksum = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const EventType = Schema.Literals([
  "decision.recorded",
  "delegation.prepared",
  "delegation.started",
  "delegation.finished",
  "delegation.failed",
  "delegation.cancelled",
  "verification.recorded",
  "feedback.recorded",
  "quota.observed",
])
export type EventType = Schema.Schema.Type<typeof EventType>

export const WorkloadLevel = Schema.Literals(["low", "medium", "high"])
export type WorkloadLevel = Schema.Schema.Type<typeof WorkloadLevel>

export const WorkloadContext = Schema.Struct({
  difficulty: WorkloadLevel,
  reasoningDemand: WorkloadLevel,
  ambiguity: WorkloadLevel,
  scope: WorkloadLevel,
  verifiability: WorkloadLevel,
  risk: WorkloadLevel,
})
export type WorkloadContext = Schema.Schema.Type<typeof WorkloadContext>

export const SelectionSource = Schema.Literals(["scheduler", "exploration", "explicit", "resume"])
export type SelectionSource = Schema.Schema.Type<typeof SelectionSource>

export const ResolutionSource = Schema.Literals([
  "request-profile",
  "role-route",
  "agent-config",
  "parent",
  "resume",
  "request-model",
  "request-model-identity",
])
export type ResolutionSource = Schema.Schema.Type<typeof ResolutionSource>

export const Route = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(MAX_STRING_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*$/),
)

export const Action = Schema.Struct({
  route: Route,
  identity: SafeString,
  variant: Schema.optional(SafeID),
  selectionSource: SelectionSource,
  resolutionSource: Schema.optional(ResolutionSource),
})
export type Action = Schema.Schema.Type<typeof Action>

export const FilterReason = Schema.Literals([
  "permission",
  "quota",
  "safety",
  "unsupported",
  "unavailable",
  "cost",
  "policy",
  "duplicate",
  "rate-limit",
])
export type FilterReason = Schema.Schema.Type<typeof FilterReason>

export const Candidate = Schema.Struct({
  action: Action,
  propensity: Probability,
  eligible: Schema.Boolean,
  filterReason: Schema.optional(FilterReason),
})
export type Candidate = Schema.Schema.Type<typeof Candidate>

export const Policy = Schema.Struct({
  version: SafeID,
  selectionMode: SelectionSource,
  decisionSeed: Schema.optional(SafeID),
  chosenPropensity: Schema.optional(Probability),
  candidateCount: CandidateCount,
  candidates: Schema.optional(Schema.Array(Candidate)),
})
export type Policy = Schema.Schema.Type<typeof Policy>

export const ExecutionStatus = Schema.Literals(["completed", "failed", "cancelled", "interrupted", "blocked"])
export type ExecutionStatus = Schema.Schema.Type<typeof ExecutionStatus>

export const FinishReason = Schema.Literals([
  "stop",
  "tool-calls",
  "length",
  "timeout",
  "cancelled",
  "interrupted",
  "blocked",
  "provider-error",
  "verification-failed",
  "unknown",
])
export type FinishReason = Schema.Schema.Type<typeof FinishReason>

export const ErrorClass = Schema.Literals([
  "auth",
  "authentication",
  "cancelled",
  "configuration",
  "network",
  "provider",
  "provider-error",
  "quota",
  "rate-limit",
  "timeout",
  "validation",
  "verification",
  "unknown",
])
export type ErrorClass = Schema.Schema.Type<typeof ErrorClass>

export const Execution = Schema.Struct({
  status: ExecutionStatus,
  finishReason: Schema.optional(FinishReason),
  errorClass: Schema.optional(ErrorClass),
  durationMs: Schema.optional(NonNegativeFinite),
  ttftMs: Schema.optional(NonNegativeFinite),
})
export type Execution = Schema.Schema.Type<typeof Execution>

export const KnownCostSource = Schema.Literals([
  "subscription",
  "explicit-free",
  "provider-pricing",
  "provider-pricing-over-200k",
])
export type KnownCostSource = Schema.Schema.Type<typeof KnownCostSource>

export const UnknownCostSource = Schema.Literals(["disposition", "metered", "usage"])
export type UnknownCostSource = Schema.Schema.Type<typeof UnknownCostSource>

export const CostSource = Schema.Literals([
  "subscription",
  "explicit-free",
  "provider-pricing",
  "provider-pricing-over-200k",
  "disposition",
  "metered",
  "usage",
])
export type CostSource = Schema.Schema.Type<typeof CostSource>

export const CostUnknownReason = Schema.Literals([
  "missing-pricing",
  "metered-zero-price",
  "not-applicable",
  "not-provided",
  "price-unavailable",
  "redacted",
  "unknown",
  "usage-pending",
  "usage-unavailable",
])
export type CostUnknownReason = Schema.Schema.Type<typeof CostUnknownReason>

const KnownCost = Schema.Struct({
  status: Schema.Literal("known"),
  usd: NonNegativeFinite,
  source: KnownCostSource,
})
const UnknownCost = Schema.Struct({
  status: Schema.Literal("unknown"),
  source: UnknownCostSource,
  reason: CostUnknownReason,
})

export const Cost = Schema.Union([KnownCost, UnknownCost]).annotate({ discriminator: "status" })
export type Cost = Schema.Schema.Type<typeof Cost>

const TokenCount = NonNegativeInt
export const Usage = Schema.Struct({
  input: TokenCount,
  output: TokenCount,
  reasoning: TokenCount,
  cacheRead: TokenCount,
  cacheWrite: TokenCount,
  cost: Schema.optional(Cost),
})
export type Usage = Schema.Schema.Type<typeof Usage>

export const QuotaStatus = Schema.Literals(["ok", "strained", "exhausted", "no-data"])
export type QuotaStatus = Schema.Schema.Type<typeof QuotaStatus>

export const Quota = Schema.Struct({
  status: QuotaStatus,
  source: SafeString,
  remainingPercent: Schema.optional(Percent),
  resetAt: Schema.optional(Timestamp),
  windowSeconds: Schema.optional(NonNegativeInt),
  retryAfterMs: Schema.optional(NonNegativeFinite),
})
export type Quota = Schema.Schema.Type<typeof Quota>

export const VerificationKind = Schema.Literals(["test", "typecheck", "lint", "build", "lsp", "explicit", "unknown"])
export type VerificationKind = Schema.Schema.Type<typeof VerificationKind>

export const VerificationStatus = Schema.Literals(["pass", "fail", "unknown"])
export type VerificationStatus = Schema.Schema.Type<typeof VerificationStatus>

export const Verification = Schema.Struct({
  kind: VerificationKind,
  status: VerificationStatus,
  linked: Schema.Boolean,
})
export type Verification = Schema.Schema.Type<typeof Verification>

export const FeedbackOutcome = Schema.Literals(["accepted", "reworked", "rejected", "blocked", "unknown"])
export type FeedbackOutcome = Schema.Schema.Type<typeof FeedbackOutcome>

export const Feedback = Schema.Struct({
  outcome: FeedbackOutcome,
  verification: Schema.optional(VerificationStatus),
})
export type Feedback = Schema.Schema.Type<typeof Feedback>

export const TemplateKind = Schema.Literals([
  "default",
  "delegation",
  "escalation",
  "feedback",
  "parallel",
  "retry",
  "sequential",
  "single",
  "swarm",
  "task",
  "verification",
])
export type TemplateKind = Schema.Schema.Type<typeof TemplateKind>

export const Fanout = Schema.Struct({
  fanoutID: SafeID,
  itemIndex: Schema.optional(Index),
  size: FanoutSize,
  concurrency: Concurrency,
  templateKind: TemplateKind,
})
export type Fanout = Schema.Schema.Type<typeof Fanout>

export const Event = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventID: SafeID,
  eventType: EventType,
  projectID: Schema.optional(ProjectID),
  episodeID: SafeID,
  decisionID: Schema.optional(SafeID),
  delegationID: Schema.optional(SafeID),
  parentDelegationID: Schema.optional(SafeID),
  attemptIndex: Schema.optional(Index),
  workload: SafeString,
  workloadContext: Schema.optional(WorkloadContext),
  action: Schema.optional(Action),
  policy: Schema.optional(Policy),
  execution: Schema.optional(Execution),
  usage: Schema.optional(Usage),
  quota: Schema.optional(Quota),
  verification: Schema.optional(Verification),
  feedback: Schema.optional(Feedback),
  fanout: Schema.optional(Fanout),
  createdAt: Timestamp,
})
export type Event = Schema.Schema.Type<typeof Event>
export type DelegationTelemetryEvent = Event

export const SHADOW_POLICY_VERSION = "p1-shadow-v1"

export type ShadowDecision = {
  readonly projectID: ProjectIDType
  readonly eventID: string
  readonly episodeID: string
  readonly decisionID: string
  readonly workload: string
  readonly action: Action
  readonly policy: Policy
  readonly fanout?: Fanout
}

export type ShadowDelegation = {
  readonly projectID: ProjectIDType
  readonly episodeID: string
  readonly decisionID: string
  readonly delegationID: string
  readonly workload: string
  readonly action: Action
  readonly parentDelegationID?: string
  readonly attemptIndex?: number
  readonly fanout?: Fanout
}

export interface BindShadowDelegationInput {
  delegation: ShadowDelegation
  sessionID: SessionID | string
}

export interface ShadowOracleAttribution {
  readonly projectID: ProjectIDType
  readonly sessionID: SessionID
  readonly episodeID: string
  readonly decisionID: string
  readonly delegationID: string
  readonly parentDelegationID?: string
  readonly attemptIndex: number
}

export interface ShadowDecisionInput {
  projectID: ProjectIDType
  workload: string
  action: Action
  candidates?: Candidate[]
  fanout?: Omit<Fanout, "itemIndex">
  episodeID?: string
}

export interface ShadowDelegationInput {
  parentDelegationID?: string
  attemptIndex?: number
  fanout?: Fanout
}

export interface RecommendationCandidate {
  route: string
  identity: string
  variant?: string
  overflow: boolean
}

export interface ActionInput {
  route: string
  identity?: string
  variant?: string
  selectionSource: SelectionSource
  resolutionSource?: ResolutionSource
}

const selectionSources = new Set<SelectionSource>(["scheduler", "exploration", "explicit", "resume"])
const resolutionSources = new Set<ResolutionSource>([
  "request-profile",
  "role-route",
  "agent-config",
  "parent",
  "resume",
  "request-model",
  "request-model-identity",
])
const filterReasons = new Set<FilterReason>([
  "permission",
  "quota",
  "safety",
  "unsupported",
  "unavailable",
  "cost",
  "policy",
  "duplicate",
  "rate-limit",
])
const templateKinds = new Set<TemplateKind>([
  "default",
  "delegation",
  "escalation",
  "feedback",
  "parallel",
  "retry",
  "sequential",
  "single",
  "swarm",
  "task",
  "verification",
])
const executionStatuses = new Set<ExecutionStatus>(["completed", "failed", "cancelled", "interrupted", "blocked"])
const finishReasons = new Set<FinishReason>([
  "stop",
  "tool-calls",
  "length",
  "timeout",
  "cancelled",
  "interrupted",
  "blocked",
  "provider-error",
  "verification-failed",
  "unknown",
])
const errorClasses = new Set<ErrorClass>([
  "auth",
  "authentication",
  "cancelled",
  "configuration",
  "network",
  "provider",
  "provider-error",
  "quota",
  "rate-limit",
  "timeout",
  "validation",
  "verification",
  "unknown",
])

function hashValue(input: unknown) {
  const value = typeof input === "string" ? input : typeof input
  return createHash("sha256").update(`${telemetryHashSalt}:${value}`).digest("hex").slice(0, 32)
}

function safeString(input: unknown, prefix: string, pattern: RegExp) {
  if (typeof input === "string" && input.length > 0 && input.length <= MAX_STRING_LENGTH && pattern.test(input)) return input
  return `${prefix}-${hashValue(input)}`
}

function safeIdentity(input: unknown) {
  return safeString(input, "identity", /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)
}

function safeID(input: unknown, prefix: string) {
  return safeString(input, prefix, /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/)
}

function safeRoute(input: unknown) {
  if (
    typeof input === "string" &&
    input.length >= 3 &&
    input.length <= MAX_STRING_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:@+-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(input)
  ) {
    return input
  }
  return `shadow/${hashValue(input)}`
}

function safeWorkload(input: unknown) {
  return safeString(input, "workload", /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/)
}

function normalizeSelectionSource(input: unknown): SelectionSource {
  if (typeof input === "string" && selectionSources.has(input as SelectionSource)) return input as SelectionSource
  return "explicit"
}

function normalizeResolutionSource(input: unknown): ResolutionSource | undefined {
  if (typeof input === "string" && resolutionSources.has(input as ResolutionSource)) return input as ResolutionSource
  return undefined
}

function normalizeFilterReason(input: unknown): FilterReason | undefined {
  if (typeof input === "string" && filterReasons.has(input as FilterReason)) return input as FilterReason
  return undefined
}

function normalizeTemplateKind(input: unknown): TemplateKind {
  if (typeof input === "string" && templateKinds.has(input as TemplateKind)) return input as TemplateKind
  return "delegation"
}

function boundedInt(input: unknown, fallback: number, min: number, max: number) {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback
  return Math.min(max, Math.max(min, Math.floor(input)))
}

function normalizeAction(input: Partial<Action> | undefined): Action {
  return actionForRoute({
    route: input?.route ?? "unknown/unknown",
    identity: input?.identity,
    variant: input?.variant,
    selectionSource: normalizeSelectionSource(input?.selectionSource),
    resolutionSource: normalizeResolutionSource(input?.resolutionSource),
  })
}

function normalizeFanout(input: Partial<Fanout> | undefined): Fanout | undefined {
  if (!input) return undefined
  const size = boundedInt(input.size, 1, 1, MAX_FANOUT_SIZE)
  return {
    fanoutID: safeID(input.fanoutID, "fanout"),
    ...(input.itemIndex === undefined ? {} : { itemIndex: boundedInt(input.itemIndex, 0, 0, size - 1) }),
    size,
    concurrency: boundedInt(input.concurrency, 1, 1, MAX_CONCURRENCY),
    templateKind: normalizeTemplateKind(input.templateKind),
  }
}

function normalizeCandidate(input: Partial<Candidate>): Candidate {
  const eligible = input.eligible === true
  return {
    action: normalizeAction(input.action),
    propensity:
      typeof input.propensity === "number" && Number.isFinite(input.propensity)
        ? Math.min(1, Math.max(0, input.propensity))
        : 0,
    eligible,
    ...(eligible ? {} : { filterReason: normalizeFilterReason(input.filterReason) ?? "policy" }),
  }
}

function normalizeExecution(input: Partial<Execution> | undefined): Execution | undefined {
  if (!input) return undefined
  const status =
    typeof input.status === "string" && executionStatuses.has(input.status as ExecutionStatus)
      ? (input.status as ExecutionStatus)
      : "failed"
  return {
    status,
    ...(typeof input.finishReason === "string" && finishReasons.has(input.finishReason as FinishReason)
      ? { finishReason: input.finishReason as FinishReason }
      : {}),
    ...(typeof input.errorClass === "string" && errorClasses.has(input.errorClass as ErrorClass)
      ? { errorClass: input.errorClass as ErrorClass }
      : {}),
    ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? { durationMs: Math.max(0, input.durationMs) }
      : {}),
    ...(typeof input.ttftMs === "number" && Number.isFinite(input.ttftMs) ? { ttftMs: Math.max(0, input.ttftMs) } : {}),
  }
}

function normalizeUsage(input: Partial<Usage> | undefined): Usage | undefined {
  if (!input) return undefined
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  return {
    input: count(input.input),
    output: count(input.output),
    reasoning: count(input.reasoning),
    cacheRead: count(input.cacheRead),
    cacheWrite: count(input.cacheWrite),
    ...(input.cost === undefined ? {} : { cost: input.cost }),
  }
}

export function actionForRoute(input: ActionInput): Action {
  const resolutionSource = normalizeResolutionSource(input.resolutionSource)
  const route = safeRoute(input.route)
  return {
    route,
    identity: safeIdentity(input.identity ?? `route:${route}`),
    ...(input.variant === undefined ? {} : { variant: safeID(input.variant, "variant") }),
    selectionSource: normalizeSelectionSource(input.selectionSource),
    ...(resolutionSource ? { resolutionSource } : {}),
  }
}

export function createFanoutID() {
  return `fanout-${randomUUID()}`
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function sameAction(a: Action, b: Action) {
  return a.route === b.route && a.identity === b.identity && a.variant === b.variant
}

export function candidatesFromRecommendations(input: {
  selected: Action
  recommendations: RecommendationCandidate[]
  resolutionSource?: ResolutionSource
}) {
  const selected = normalizeAction(input.selected)
  return [
    { action: selected, propensity: 1, eligible: true } satisfies Candidate,
    ...input.recommendations
      .slice(0, MAX_CANDIDATES - 1)
      .map((recommendation) => {
        const action = actionForRoute({
          route: recommendation.route,
          identity: recommendation.identity,
          variant: recommendation.variant,
          selectionSource: "scheduler",
          resolutionSource: input.resolutionSource,
        })
        const eligible = !recommendation.overflow
        return {
          action,
          propensity: 0,
          eligible,
          ...(eligible ? {} : { filterReason: "policy" as const }),
        } satisfies Candidate
      })
      .filter((candidate) => !sameAction(candidate.action, selected)),
  ]
}

const decisionRecords = new WeakMap<ShadowDecision, { recorded: boolean }>()
const delegationDecisions = new WeakMap<ShadowDelegation, ShadowDecision>()
const boundDelegations = new WeakMap<ShadowDelegation, { sessionID: SessionID; attemptIndex: number }>()
export function createShadowDecision(input: ShadowDecisionInput): ShadowDecision {
  const action = normalizeAction(input.action)
  const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, MAX_CANDIDATES).map(normalizeCandidate) : undefined
  const fanout = normalizeFanout(input.fanout)
  const policy: Policy = {
    version: SHADOW_POLICY_VERSION,
    selectionMode: action.selectionSource,
    ...(action.selectionSource === "scheduler" ? { chosenPropensity: 1 } : {}),
    candidateCount: candidates?.length ?? 0,
    ...(candidates ? { candidates } : {}),
  }
  return freeze({
    projectID: input.projectID,
    eventID: safeID(`decision-${randomUUID()}`, "decision"),
    episodeID: safeID(input.episodeID ?? `episode-${randomUUID()}`, "episode"),
    decisionID: safeID(`decision-${randomUUID()}`, "decision"),
    workload: safeWorkload(input.workload),
    action,
    policy,
    ...(fanout ? { fanout } : {}),
  })
}

export function recordShadowDecision(input: ShadowDecision) {
  const record = { recorded: false }
  decisionRecords.set(input, record)
  return appendBestEffortResult(
    {
      projectID: input.projectID,
      event: {
        schemaVersion: 1,
        eventID: input.eventID,
        eventType: "decision.recorded",
        episodeID: input.episodeID,
        decisionID: input.decisionID,
        workload: input.workload,
        action: input.action,
        policy: input.policy,
        ...(input.fanout ? { fanout: input.fanout } : {}),
        createdAt: Date.now(),
      },
    },
    (recorded) => (record.recorded = recorded),
  ).then(() => undefined)
}

export function createShadowDelegation(input: ShadowDecision, options?: ShadowDelegationInput): ShadowDelegation {
  const fanout = normalizeFanout(options?.fanout)
  const delegation = freeze({
    projectID: input.projectID,
    episodeID: input.episodeID,
    decisionID: input.decisionID,
    delegationID: safeID(`delegation-${randomUUID()}`, "delegation"),
    workload: input.workload,
    action: input.action,
    ...(options?.parentDelegationID ? { parentDelegationID: safeID(options.parentDelegationID, "delegation") } : {}),
    ...(options?.attemptIndex === undefined ? {} : { attemptIndex: boundedInt(options.attemptIndex, 0, 0, MAX_INDEX) }),
    ...(fanout ? { fanout } : {}),
  })
  delegationDecisions.set(delegation, input)
  return delegation
}

function lifecycleEvent(
  input: ShadowDelegation,
  eventType: "delegation.prepared" | "delegation.started" | "delegation.finished" | "delegation.failed" | "delegation.cancelled",
  execution: Execution | undefined,
  fanout: Fanout | undefined,
  usage?: Usage,
 ) {
  return {
    schemaVersion: 1,
    eventID: `${input.delegationID}:${eventType}`,
    eventType,
    episodeID: input.episodeID,
    decisionID: input.decisionID,
    delegationID: input.delegationID,
    ...(input.parentDelegationID ? { parentDelegationID: input.parentDelegationID } : {}),
    ...(input.attemptIndex === undefined ? {} : { attemptIndex: input.attemptIndex }),
    workload: input.workload,
    action: input.action,
    ...(execution ? { execution } : {}),
    ...(usage ? { usage } : {}),
    ...(fanout ? { fanout } : {}),
    createdAt: Date.now(),
  }
}

export function recordShadowLifecycle(
  input: ShadowDelegation,
  eventType: "delegation.prepared" | "delegation.started" | "delegation.finished" | "delegation.failed" | "delegation.cancelled",
  execution?: Execution,
  usage?: Usage,
 ) {
  const normalized = normalizeExecution(execution)
  const normalizedUsage = normalizeUsage(usage)
  const event = lifecycleEvent(input, eventType, normalized, input.fanout, normalizedUsage)
  if (!input.fanout) return appendBestEffort({ projectID: input.projectID, event })
  if (appendQueueSize >= BEST_EFFORT_QUEUE_LIMIT) return Promise.resolve(undefined)
  const appendInput = boundedTelemetrySnapshot({ projectID: input.projectID, event })
  const fallbackInput = boundedTelemetrySnapshot({
    projectID: input.projectID,
    event: lifecycleEvent(input, eventType, normalized, undefined, normalizedUsage),
  })
  if (!appendInput || !fallbackInput) return Promise.resolve(undefined)
  const decision = delegationDecisions.get(input)
  const record = decision ? decisionRecords.get(decision) : undefined
  return enqueueBestEffort(() => {
    if (record?.recorded) {
      try {
        const result = append(appendInput)
        if (result.status === "inserted" || !result.tombstoned) return true
      } catch {}
    }
    try {
      const result = append(fallbackInput)
      return result.status === "inserted" || !result.tombstoned
    } catch {
      return false
    }
  }).then(() => undefined)
}

type ValidEvent = Event

const ValidationReason = Schema.Literals([
  "invalid-event",
  "invalid-project-id",
  "invalid-read-input",
  "invalid-compact-input",
  "invalid-event-order",
  "invalid-cost",
])
type ValidationReason = Schema.Schema.Type<typeof ValidationReason>

export class TelemetryValidationError extends Schema.TaggedErrorClass<TelemetryValidationError>()("TelemetryValidationError", {
  reason: ValidationReason,
}) {
  override get message() {
    return `Telemetry validation failed: ${this.reason}`
  }
}

export class TelemetryIdempotencyConflictError extends Schema.TaggedErrorClass<TelemetryIdempotencyConflictError>()(
  "TelemetryIdempotencyConflictError",
  {
    projectID: ProjectID,
    eventID: SafeID,
    existingChecksum: Checksum,
    incomingChecksum: Checksum,
    tombstoned: Schema.Boolean,
  },
) {
  override get message() {
    return `Telemetry event ${this.eventID} conflicts with retained event data`
  }
}

const FanoutLinkReason = Schema.Literals(["self-link", "missing-parent", "index-out-of-range"])
export class TelemetryFanoutLinkError extends Schema.TaggedErrorClass<TelemetryFanoutLinkError>()(
  "TelemetryFanoutLinkError",
  { reason: FanoutLinkReason },
) {
  override get message() {
    return `Telemetry fanout link rejected: ${this.reason}`
  }
}

const BindingReason = Schema.Literals(["missing-session", "cross-project-session", "identity-conflict", "ambiguous-lineage", "unbound-delegation"])
export class TelemetryBindingError extends Schema.TaggedErrorClass<TelemetryBindingError>()("TelemetryBindingError", {
  reason: BindingReason,
}) {
  override get message() {
    return `Telemetry binding failed: ${this.reason}`
  }
}

export class TelemetryTerminalConflictError extends Schema.TaggedErrorClass<TelemetryTerminalConflictError>()(
  "TelemetryTerminalConflictError",
  { delegationID: SafeID, existingEventType: EventType, incomingEventType: EventType },
) {
  override get message() {
    return `Telemetry delegation ${this.delegationID} already has terminal event ${this.existingEventType}`
  }
}

const StorageOperation = Schema.Literals(["append", "read", "compact", "bind", "lineage", "oracle"])
type StorageOperation = Schema.Schema.Type<typeof StorageOperation>

export class TelemetryStorageError extends Schema.TaggedErrorClass<TelemetryStorageError>()("TelemetryStorageError", {
  operation: StorageOperation,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Telemetry storage failed during ${this.operation}`
  }
}

export { TelemetryValidationError as ModelTelemetryValidationError }
export { TelemetryIdempotencyConflictError as ModelTelemetryIdempotencyConflictError }
export { TelemetryStorageError as ModelTelemetryStorageError }
export { TelemetryBindingError as ModelTelemetryBindingError }
export { TelemetryTerminalConflictError as ModelTelemetryTerminalConflictError }
const ReadInputSchema = Schema.Struct({
  projectID: ProjectID,
  limit: Schema.optional(ReadLimit),
  before: Schema.optional(Timestamp),
  after: Schema.optional(Timestamp),
  eventTypes: Schema.optional(Schema.Array(EventType)),
  episodeID: Schema.optional(SafeID),
  delegationID: Schema.optional(SafeID),
})
type ReadInput = Schema.Schema.Type<typeof ReadInputSchema>

const CompactInputSchema = Schema.Struct({
  projectID: ProjectID,
  before: Schema.optional(Timestamp),
  tombstoneBefore: Schema.optional(Timestamp),
  now: Schema.optional(Timestamp),
  retentionMs: Schema.optional(NonNegativeFinite),
  batchSize: Schema.optional(CompactBatchSize),
})
type CompactInput = Schema.Schema.Type<typeof CompactInputSchema>
type NormalizedCompactInput = {
  projectID: ProjectIDType
  before: number
  tombstoneBefore?: number
  compactAt: number
  batchSize: number
}

const AppendEnvelopeSchema = Schema.Struct({
  projectID: Schema.Unknown,
  event: Schema.Unknown,
})
type AppendEnvelope = Schema.Schema.Type<typeof AppendEnvelopeSchema>

export type AppendResult =
  | { status: "inserted"; eventID: string; checksum: string }
  | { status: "duplicate"; eventID: string; checksum: string; tombstoned: boolean }

export interface AppendInput {
  projectID: ProjectIDType | string
  event: unknown
}

export interface CompactResult {
  deleted: number
  tombstoned: number
  prunedTombstones: number
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? "null" : encoded
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .flatMap((key) => {
      const item = record[key]
      return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`]
    })
    .join(",")}}`
}

function canonicalEvent(event: Event) {
  return {
    ...event,
    projectID: undefined,
    createdAt: undefined,
  }
}

function eventChecksum(event: Event) {
  return createHash("sha256").update(canonicalJson(canonicalEvent(event))).digest("hex")
}

function stableOpaqueID(prefix: string, domain: string, values: unknown[]) {
  return `${prefix}-${createHash("sha256").update(domain).update("\0").update(canonicalJson(values)).digest("hex")}`
}

function oracleLinkKey(projectID: ProjectIDType, oracleID: string) {
  return stableOpaqueID("oracle", "coding-chimera:model-telemetry:oracle-link:v1", [projectID, oracleID])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedTelemetryInput(input: unknown) {
  const state = { bytes: 0, nodes: 0 }
  const active = new WeakSet<object>()
  const addBytes = (bytes: number) => {
    state.bytes += bytes
    return state.bytes <= MAX_TELEMETRY_INPUT_BYTES
  }
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > MAX_TELEMETRY_INPUT_DEPTH) return false
    state.nodes += 1
    if (state.nodes > MAX_TELEMETRY_INPUT_NODES) return false
    if (value === null) return addBytes(4)
    if (value === undefined) return addBytes(9)
    if (typeof value === "string") {
      if (value.length > MAX_TELEMETRY_INPUT_STRING_LENGTH) return false
      return addBytes(Buffer.byteLength(value, "utf8") + 2)
    }
    if (typeof value === "boolean") return addBytes(5)
    if (typeof value === "number") return Number.isFinite(value) && addBytes(16)
    if (typeof value !== "object") return false
    if (active.has(value)) return false

    active.add(value)
    const valid = (() => {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_TELEMETRY_INPUT_ARRAY_LENGTH) return false
      } else {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return false
      }
      if (!addBytes(2)) return false
      let keyCount = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        keyCount += 1
        if (keyCount > MAX_TELEMETRY_INPUT_OBJECT_KEYS || key.length > MAX_TELEMETRY_INPUT_STRING_LENGTH) return false
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !("value" in descriptor)) return false
        if (!addBytes(Buffer.byteLength(key, "utf8") + 3) || !visit(descriptor.value, depth + 1)) return false
      }
      return true
    })()
    active.delete(value)
    return valid
  }

  try {
    return visit(input, 0)
  } catch {
    return false
  }
}

function boundedTelemetrySnapshot<T>(input: T): T | undefined {
  if (!isBoundedTelemetryInput(input)) return undefined
  try {
    const snapshot = structuredClone(input)
    return isBoundedTelemetryInput(snapshot) ? snapshot : undefined
  } catch {
    return undefined
  }
}

function hasLegacyCostAlias(input: unknown) {
  if (!isRecord(input) || !isRecord(input.usage)) return false
  return "costUsd" in input.usage
}

function validatePolicy(policy: Policy) {
  if (policy.candidates === undefined) return
  if (policy.candidates.length > MAX_CANDIDATES || policy.candidates.length !== policy.candidateCount) {
    throw new TelemetryValidationError({ reason: "invalid-event" })
  }
  policy.candidates.forEach((candidate) => {
    if (candidate.eligible && candidate.filterReason !== undefined) {
      throw new TelemetryValidationError({ reason: "invalid-event" })
    }
    if (!candidate.eligible && candidate.filterReason === undefined) {
      throw new TelemetryValidationError({ reason: "invalid-event" })
    }
  })
}

function validateCost(cost: Cost) {
  if (
    cost.status === "known" &&
    cost.usd === 0 &&
    (cost.source === "provider-pricing" || cost.source === "provider-pricing-over-200k")
  ) {
    throw new TelemetryValidationError({ reason: "invalid-cost" })
  }
}

function validateEvent(event: Event) {
  if (event.policy !== undefined) validatePolicy(event.policy)
  if (event.usage?.cost !== undefined) validateCost(event.usage.cost)
  if (event.fanout !== undefined) {
    if (event.decisionID === undefined) throw new TelemetryValidationError({ reason: "invalid-event" })
    if (event.fanout.itemIndex !== undefined && event.fanout.itemIndex >= event.fanout.size) {
      throw new TelemetryValidationError({ reason: "invalid-event" })
    }
    if (event.eventType !== "decision.recorded" && event.fanout.itemIndex === undefined) {
      throw new TelemetryValidationError({ reason: "invalid-event" })
    }
  }
}

function decodeEvent(input: unknown): ValidEvent {
  try {
    if (!isBoundedTelemetryInput(input)) throw new TelemetryValidationError({ reason: "invalid-event" })
    if (hasLegacyCostAlias(input)) throw new TelemetryValidationError({ reason: "invalid-cost" })
    const raw = Schema.decodeUnknownSync(Event)(input, { onExcessProperty: "error" })
    validateEvent(raw)
    return raw
  } catch (error) {
    if (error instanceof TelemetryValidationError) throw error
    throw new TelemetryValidationError({ reason: "invalid-event" })
  }
}

function decodeProjectID(input: unknown): ProjectIDType {
  try {
    return Schema.decodeUnknownSync(ProjectID)(input)
  } catch {
    throw new TelemetryValidationError({ reason: "invalid-project-id" })
  }
}

function decodeAppendEnvelope(input: AppendInput): AppendEnvelope {
  try {
    return Schema.decodeUnknownSync(AppendEnvelopeSchema)(input, { onExcessProperty: "error" })
  } catch {
    throw new TelemetryValidationError({ reason: "invalid-event" })
  }
}

function decodeReadInput(input: unknown): ReadInput {
  try {
    if (!isBoundedTelemetryInput(input)) throw new TelemetryValidationError({ reason: "invalid-read-input" })
    if (isRecord(input) && Array.isArray(input.eventTypes) && input.eventTypes.length > MAX_EVENT_TYPES) {
      throw new TelemetryValidationError({ reason: "invalid-read-input" })
    }
    const value = Schema.decodeUnknownSync(ReadInputSchema)(input, { onExcessProperty: "error" })
    if ((value.eventTypes?.length ?? 0) > MAX_EVENT_TYPES) throw new Error("too many event types")
    if (value.before !== undefined && value.after !== undefined && value.before <= value.after) {
      throw new TelemetryValidationError({ reason: "invalid-event-order" })
    }
    return value
  } catch (error) {
    if (error instanceof TelemetryValidationError) throw error
    throw new TelemetryValidationError({ reason: "invalid-read-input" })
  }
}

function decodeCompactInput(input: unknown): NormalizedCompactInput {
  try {
    if (!isBoundedTelemetryInput(input)) throw new TelemetryValidationError({ reason: "invalid-compact-input" })
    const value = Schema.decodeUnknownSync(CompactInputSchema)(input, { onExcessProperty: "error" })
    const before = value.before ?? value.now
    if (before === undefined) throw new Error("missing compact boundary")
    const compactAt = value.now ?? Date.now()
    const tombstoneBefore =
      value.tombstoneBefore ?? (value.now === undefined || value.retentionMs === undefined ? undefined : value.now - value.retentionMs)
    if (tombstoneBefore !== undefined && tombstoneBefore >= compactAt) throw new Error("invalid tombstone order")
    return {
      projectID: value.projectID,
      before,
      tombstoneBefore,
      compactAt,
      batchSize: value.batchSize ?? MAX_COMPACT_BATCH,
    }
  } catch (error) {
    if (error instanceof TelemetryValidationError) throw error
    throw new TelemetryValidationError({ reason: "invalid-compact-input" })
  }
}

function eventWhere(projectID: ProjectIDType, eventID: string) {
  return and(eq(ModelTelemetryEventTable.project_id, projectID), eq(ModelTelemetryEventTable.event_id, eventID))
}

function tombstoneWhere(projectID: ProjectIDType, eventID: string) {
  return and(eq(ModelTelemetryTombstoneTable.project_id, projectID), eq(ModelTelemetryTombstoneTable.event_id, eventID))
}

function conflict(
  projectID: ProjectIDType,
  eventID: string,
  existingChecksum: string,
  incomingChecksum: string,
  tombstoned: boolean,
): never {
  throw new TelemetryIdempotencyConflictError({
    projectID,
    eventID,
    existingChecksum,
    incomingChecksum,
    tombstoned,
  })
}

function decodeJsonField(value: unknown) {
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function decodeStoredFanout(value: unknown): Fanout | undefined {
  try {
    return Schema.decodeUnknownSync(Fanout)(decodeJsonField(value), { onExcessProperty: "error" })
  } catch {
    return undefined
  }
}

function validateFanoutLink(tx: TxOrDb, projectID: ProjectIDType, event: ValidEvent) {
  const fanout = event.fanout
  if (!fanout || event.eventType === "decision.recorded") return
  if (fanout.fanoutID === event.eventID) throw new TelemetryFanoutLinkError({ reason: "self-link" })
  const decisionID = event.decisionID
  if (decisionID === undefined) throw new TelemetryFanoutLinkError({ reason: "missing-parent" })
  const parents = tx
    .select({ eventID: ModelTelemetryEventTable.event_id, fanout: ModelTelemetryEventTable.fanout })
    .from(ModelTelemetryEventTable)
    .where(
      and(
        eq(ModelTelemetryEventTable.project_id, projectID),
        eq(ModelTelemetryEventTable.event_type, "decision.recorded"),
        eq(ModelTelemetryEventTable.decision_id, decisionID),
      ),
    )
    .all()
  const linked = parents.some(
    (parent) => parent.eventID === fanout.fanoutID || decodeStoredFanout(parent.fanout)?.fanoutID === fanout.fanoutID,
  )
  if (!linked) throw new TelemetryFanoutLinkError({ reason: "missing-parent" })
}

function insertEvent(tx: TxOrDb, projectID: ProjectIDType, event: ValidEvent, checksum: string) {
  tx.insert(ModelTelemetryEventTable)
    .values({
      project_id: projectID,
      event_id: event.eventID,
      content_checksum: checksum,
      schema_version: event.schemaVersion,
      event_type: event.eventType,
      episode_id: event.episodeID,
      decision_id: event.decisionID ?? null,
      delegation_id: event.delegationID ?? null,
      parent_delegation_id: event.parentDelegationID ?? null,
      attempt_index: event.attemptIndex ?? null,
      workload: event.workload,
      workload_context: event.workloadContext ?? null,
      action: event.action ?? null,
      policy: event.policy ?? null,
      execution: event.execution ?? null,
      usage: event.usage ?? null,
      quota: event.quota ?? null,
      verification: event.verification ?? null,
      feedback: event.feedback ?? null,
      fanout: event.fanout ?? null,
      time_occurred: event.createdAt,
    })
    .run()
}

function decodeStoredEvent(row: typeof ModelTelemetryEventTable.$inferSelect): ValidEvent | undefined {
  try {
    const event = decodeEvent({
      schemaVersion: row.schema_version,
      eventID: row.event_id,
      eventType: row.event_type,
      episodeID: row.episode_id,
      decisionID: row.decision_id ?? undefined,
      delegationID: row.delegation_id ?? undefined,
      parentDelegationID: row.parent_delegation_id ?? undefined,
      attemptIndex: row.attempt_index ?? undefined,
      workload: row.workload,
      workloadContext: decodeJsonField(row.workload_context),
      action: decodeJsonField(row.action),
      policy: decodeJsonField(row.policy),
      execution: decodeJsonField(row.execution),
      usage: decodeJsonField(row.usage),
      quota: decodeJsonField(row.quota),
      verification: decodeJsonField(row.verification),
      feedback: decodeJsonField(row.feedback),
      fanout: decodeJsonField(row.fanout),
      createdAt: row.time_occurred,
    })
    if (eventChecksum(event) !== row.content_checksum) return undefined
    return event
  } catch {
    return undefined
  }
}

function readWhere(input: ReadInput) {
  return and(
    eq(ModelTelemetryEventTable.project_id, input.projectID),
    input.after === undefined ? undefined : gt(ModelTelemetryEventTable.time_occurred, input.after),
    input.before === undefined ? undefined : lt(ModelTelemetryEventTable.time_occurred, input.before),
    input.eventTypes === undefined ? undefined : inArray(ModelTelemetryEventTable.event_type, [...input.eventTypes]),
    input.episodeID === undefined ? undefined : eq(ModelTelemetryEventTable.episode_id, input.episodeID),
    input.delegationID === undefined ? undefined : eq(ModelTelemetryEventTable.delegation_id, input.delegationID),
  )
}

function isAppendEnvelope(input: AppendInput | Event): input is AppendInput {
  return isRecord(input) && "event" in input
}

function isTelemetryError(error: unknown) {
  return (
    error instanceof TelemetryValidationError ||
    error instanceof TelemetryIdempotencyConflictError ||
    error instanceof TelemetryFanoutLinkError ||
    error instanceof TelemetryBindingError ||
    error instanceof TelemetryTerminalConflictError ||
    error instanceof TelemetryStorageError
  )
}

function throwStorageError(operation: StorageOperation, error: unknown): never {
  if (isTelemetryError(error)) throw error
  throw new TelemetryStorageError({ operation, cause: error })
}

const FINAL_EVENT_TYPES = ["delegation.finished", "delegation.failed", "delegation.cancelled"] as const
const DELEGATION_LIFECYCLE_EVENT_TYPES = ["delegation.prepared", "delegation.started", ...FINAL_EVENT_TYPES] as const

function isFinalEventType(eventType: EventType | string) {
  return FINAL_EVENT_TYPES.includes(eventType as (typeof FINAL_EVENT_TYPES)[number])
}

function isDelegationLifecycleEvent(event: Event) {
  return DELEGATION_LIFECYCLE_EVENT_TYPES.includes(event.eventType as (typeof DELEGATION_LIFECYCLE_EVENT_TYPES)[number])
}

function terminalLedgerIdentity(row: typeof ModelTelemetryDelegationTable.$inferSelect) {
  const fields = [row.terminal_event_type, row.terminal_event_id, row.terminal_checksum, row.terminal_time]
  if (fields.every((field) => field === null)) return undefined
  if (fields.some((field) => field === null) || !isFinalEventType(row.terminal_event_type ?? "")) {
    throw new TelemetryValidationError({ reason: "invalid-event" })
  }
  return {
    eventType: row.terminal_event_type as EventType,
    eventID: row.terminal_event_id!,
    checksum: row.terminal_checksum!,
  }
}

function validateDelegationLifecycleIdentity(row: typeof ModelTelemetryDelegationTable.$inferSelect, event: Event) {
  if (!isDelegationLifecycleEvent(event)) return
  if (
    event.eventID !== `${event.delegationID}:${event.eventType}` ||
    event.episodeID !== row.episode_id ||
    event.decisionID !== row.decision_id ||
    (event.parentDelegationID ?? null) !== row.parent_delegation_id ||
    event.attemptIndex !== row.attempt_index ||
    event.workload !== row.workload ||
    canonicalJson(event.action) !== canonicalJson(row.action) ||
    (event.fanout !== undefined && canonicalJson(event.fanout) !== canonicalJson(row.fanout))
  ) {
    throw new TelemetryValidationError({ reason: "invalid-event" })
  }
}

function terminalLifecycleDuplicate(row: typeof ModelTelemetryDelegationTable.$inferSelect, event: Event, checksum: string) {
  const terminal = terminalLedgerIdentity(row)
  if (!terminal || !isDelegationLifecycleEvent(event)) return false
  if (terminal.eventType === event.eventType && terminal.eventID === event.eventID && terminal.checksum === checksum) return true
  throw new TelemetryTerminalConflictError({
    delegationID: event.delegationID!,
    existingEventType: terminal.eventType,
    incomingEventType: event.eventType,
  })
}

/** Idempotency is guaranteed only while the event row or its tombstone remains retained. */
export function append(input: AppendInput): AppendResult
export function append(input: Event): AppendResult
export function append(input: AppendInput | Event): AppendResult {
  if (!isBoundedTelemetryInput(input)) throw new TelemetryValidationError({ reason: "invalid-event" })
  const envelope = isAppendEnvelope(input) ? decodeAppendEnvelope(input) : undefined
  const event = decodeEvent(envelope?.event ?? input)
  const projectID = decodeProjectID(envelope?.projectID ?? event.projectID)
  if (envelope && event.projectID !== undefined && event.projectID !== projectID) {
    throw new TelemetryValidationError({ reason: "invalid-project-id" })
  }
  const checksum = eventChecksum(event)

  try {
    return Database.transaction(
      (tx) => {
        const tombstone = tx.select().from(ModelTelemetryTombstoneTable).where(tombstoneWhere(projectID, event.eventID)).get()
        if (tombstone) {
          if (tombstone.content_checksum === checksum) {
            return { status: "duplicate", eventID: event.eventID, checksum, tombstoned: true }
          }
          return conflict(projectID, event.eventID, tombstone.content_checksum, checksum, true)
        }

        const existing = tx.select().from(ModelTelemetryEventTable).where(eventWhere(projectID, event.eventID)).get()
        if (existing) {
          if (existing.content_checksum === checksum) {
            return { status: "duplicate", eventID: event.eventID, checksum, tombstoned: false }
          }
          return conflict(projectID, event.eventID, existing.content_checksum, checksum, false)
        }

        validateFanoutLink(tx, projectID, event)
        const ledger = event.delegationID
          ? tx
              .select()
              .from(ModelTelemetryDelegationTable)
              .where(
                and(
                  eq(ModelTelemetryDelegationTable.project_id, projectID),
                  eq(ModelTelemetryDelegationTable.delegation_id, event.delegationID),
                ),
              )
              .get()
          : undefined
        if (ledger && isDelegationLifecycleEvent(event)) {
          if (terminalLifecycleDuplicate(ledger, event, checksum)) {
            return { status: "duplicate", eventID: event.eventID, checksum, tombstoned: false }
          }
          validateDelegationLifecycleIdentity(ledger, event)
        }
        insertEvent(tx, projectID, event, checksum)
        if (ledger && isFinalEventType(event.eventType)) {
          tx.update(ModelTelemetryDelegationTable)
            .set({
              terminal_event_type: event.eventType,
              terminal_event_id: event.eventID,
              terminal_checksum: checksum,
              terminal_time: event.createdAt,
            })
            .where(
              and(
                eq(ModelTelemetryDelegationTable.project_id, projectID),
                eq(ModelTelemetryDelegationTable.delegation_id, event.delegationID!),
              ),
            )
            .run()
        }
        return { status: "inserted", eventID: event.eventID, checksum }
      },
      { behavior: "immediate" },
    )
  } catch (error) {
    return throwStorageError("append", error)
  }
}

let appendQueue: Promise<void> = Promise.resolve()
let appendQueueSize = 0

function enqueueBestEffort(run: () => boolean) {
  if (appendQueueSize >= BEST_EFFORT_QUEUE_LIMIT) return Promise.resolve(false)
  appendQueueSize++
  const queued = appendQueue.then(() => {
      try {
        return run()
      } catch {
        return false
      }
    })
    .finally(() => {
      appendQueueSize--
    })
  appendQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued.catch(() => false)
}

function reportBestEffortResult(onResult: ((recorded: boolean) => void) | undefined, recorded: boolean) {
  try {
    onResult?.(recorded)
  } catch {}
}

function appendBestEffortResult(
  input: AppendInput | Event,
  onResult?: (recorded: boolean) => void,
): Promise<boolean> {
  if (appendQueueSize >= BEST_EFFORT_QUEUE_LIMIT) {
    reportBestEffortResult(onResult, false)
    return Promise.resolve(false)
  }
  const snapshot = boundedTelemetrySnapshot(input)
  if (snapshot === undefined) {
    reportBestEffortResult(onResult, false)
    return Promise.resolve(false)
  }
  return enqueueBestEffort(() => {
    try {
      const result = isAppendEnvelope(snapshot) ? append(snapshot) : append(snapshot)
      const recorded = result.status === "inserted" || !result.tombstoned
      reportBestEffortResult(onResult, recorded)
      return recorded
    } catch {
      reportBestEffortResult(onResult, false)
      return false
    }
  })
}

export function appendBestEffort(input: AppendInput): Promise<void>
export function appendBestEffort(input: Event): Promise<void>
export function appendBestEffort(input: AppendInput | Event): Promise<void> {
  return appendBestEffortResult(input).then(() => undefined)
}

export function drainBestEffort() {
  return appendQueue
}

export function read(input: unknown): Event[] {
  const value = decodeReadInput(input)
  if (value.eventTypes?.length === 0 || value.limit === 0) return []
  const target = value.limit ?? DEFAULT_READ_LIMIT

  try {
    return Database.use((db) => {
      const result: Event[] = []
      let cursor: { createdAt: number; eventID: string } | undefined

      while (result.length < target) {
        const batchSize = Math.min(target - result.length, MAX_READ_LIMIT)
        const rows = db
          .select()
          .from(ModelTelemetryEventTable)
          .where(
            and(
              readWhere(value),
              cursor === undefined
                ? undefined
                : or(
                    lt(ModelTelemetryEventTable.time_occurred, cursor.createdAt),
                    and(
                      eq(ModelTelemetryEventTable.time_occurred, cursor.createdAt),
                      lt(ModelTelemetryEventTable.event_id, cursor.eventID),
                    ),
                  ),
            ),
          )
          .orderBy(desc(ModelTelemetryEventTable.time_occurred), desc(ModelTelemetryEventTable.event_id))
          .limit(batchSize)
          .all()
        if (rows.length === 0) break

        rows.forEach((row) => {
          const event = decodeStoredEvent(row)
          if (event !== undefined && result.length < target) result.push(event)
        })
        const last = rows[rows.length - 1]
        cursor = { createdAt: last.time_occurred, eventID: last.event_id }
        if (rows.length < batchSize) break
      }

      return result
    })
  } catch (error) {
    return throwStorageError("read", error)
  }
}

export function compact(input: unknown): CompactResult {
  const value = decodeCompactInput(input)
  try {
    return Database.transaction(
      (tx) => {
        const rows = tx
          .select({ eventID: ModelTelemetryEventTable.event_id, checksum: ModelTelemetryEventTable.content_checksum })
          .from(ModelTelemetryEventTable)
          .where(
            and(
              eq(ModelTelemetryEventTable.project_id, value.projectID),
              lt(ModelTelemetryEventTable.time_occurred, value.before),
              inArray(ModelTelemetryEventTable.event_type, [...FINAL_EVENT_TYPES]),
            ),
          )
          .orderBy(asc(ModelTelemetryEventTable.time_occurred), asc(ModelTelemetryEventTable.event_id))
          .limit(value.batchSize)
          .all()

        rows.forEach((row) => {
          const tombstone = tx
            .select({ checksum: ModelTelemetryTombstoneTable.content_checksum })
            .from(ModelTelemetryTombstoneTable)
            .where(tombstoneWhere(value.projectID, row.eventID))
            .get()
          if (tombstone) {
            if (tombstone.checksum !== row.checksum) {
              conflict(value.projectID, row.eventID, tombstone.checksum, row.checksum, true)
            }
            return
          }
          tx.insert(ModelTelemetryTombstoneTable)
            .values({
              project_id: value.projectID,
              event_id: row.eventID,
              content_checksum: row.checksum,
              time_compacted: value.compactAt,
            })
            .run()
        })

        if (rows.length > 0) {
          tx.delete(ModelTelemetryEventTable)
            .where(
              and(
                eq(ModelTelemetryEventTable.project_id, value.projectID),
                inArray(
                  ModelTelemetryEventTable.event_id,
                  rows.map((row) => row.eventID),
                ),
              ),
            )
            .run()
        }

        const pruneWhere =
          value.tombstoneBefore === undefined
            ? undefined
            : and(
                eq(ModelTelemetryTombstoneTable.project_id, value.projectID),
                lt(ModelTelemetryTombstoneTable.time_compacted, value.tombstoneBefore),
              )
        const prunedRows = pruneWhere
          ? tx
              .select({ eventID: ModelTelemetryTombstoneTable.event_id })
              .from(ModelTelemetryTombstoneTable)
              .where(pruneWhere)
              .orderBy(asc(ModelTelemetryTombstoneTable.time_compacted), asc(ModelTelemetryTombstoneTable.event_id))
              .limit(value.batchSize)
              .all()
          : []
        if (prunedRows.length > 0) {
          tx.delete(ModelTelemetryTombstoneTable)
            .where(
              and(
                eq(ModelTelemetryTombstoneTable.project_id, value.projectID),
                inArray(
                  ModelTelemetryTombstoneTable.event_id,
                  prunedRows.map((row) => row.eventID),
                ),
              ),
            )
            .run()
        }

        return {
          deleted: rows.length,
          tombstoned: rows.length,
          prunedTombstones: prunedRows.length,
        }
      },
      { behavior: "immediate" },
    )
  } catch (error) {
    return throwStorageError("compact", error)
  }
}


function sameBoundIdentity(row: typeof ModelTelemetryDelegationTable.$inferSelect, delegation: ShadowDelegation, sessionID: SessionID) {
  return (
    row.session_id === sessionID &&
    row.project_id === delegation.projectID &&
    row.episode_id === delegation.episodeID &&
    row.decision_id === delegation.decisionID &&
    row.delegation_id === delegation.delegationID &&
    row.parent_delegation_id === (delegation.parentDelegationID ?? null) &&
    row.workload === delegation.workload &&
    canonicalJson(row.action) === canonicalJson(delegation.action) &&
    canonicalJson(row.fanout) === canonicalJson(delegation.fanout ?? null)
  )
}

function latestSessionDelegation(tx: TxOrDb, projectID: ProjectIDType, sessionID: SessionID) {
  return tx
    .select()
    .from(ModelTelemetryDelegationTable)
    .where(
      and(
        eq(ModelTelemetryDelegationTable.project_id, projectID),
        eq(ModelTelemetryDelegationTable.session_id, sessionID),
      ),
    )
    .orderBy(
      desc(ModelTelemetryDelegationTable.attempt_index),
      desc(ModelTelemetryDelegationTable.time_created),
      desc(ModelTelemetryDelegationTable.delegation_id),
    )
    .get()
}

function boundDelegationFromRow(row: typeof ModelTelemetryDelegationTable.$inferSelect, decision?: ShadowDecision): ShadowDelegation {
  const delegation = freeze({
    projectID: row.project_id,
    episodeID: row.episode_id,
    decisionID: row.decision_id,
    delegationID: row.delegation_id,
    workload: row.workload,
    action: row.action as Action,
    ...(row.parent_delegation_id ? { parentDelegationID: row.parent_delegation_id } : {}),
    attemptIndex: row.attempt_index,
    ...(row.fanout ? { fanout: row.fanout as Fanout } : {}),
  })
  if (decision) delegationDecisions.set(delegation, decision)
  boundDelegations.set(delegation, { sessionID: row.session_id, attemptIndex: row.attempt_index })
  return delegation
}

export function getShadowSessionLineage(input: { projectID: ProjectIDType; sessionID: SessionID | string }) {
  try {
    return Database.use((db) => {
      const sessionID = input.sessionID as SessionID
      const binding = db
        .select({ episodeID: ModelTelemetrySessionBindingTable.episode_id, parentDelegationID: ModelTelemetrySessionBindingTable.parent_delegation_id })
        .from(ModelTelemetrySessionBindingTable)
        .where(
          and(
            eq(ModelTelemetrySessionBindingTable.project_id, input.projectID),
            eq(ModelTelemetrySessionBindingTable.session_id, sessionID),
          ),
        )
        .get()
      if (!binding) return undefined
      const latest = latestSessionDelegation(db, input.projectID, sessionID)
      return {
        episodeID: binding.episodeID,
        ...(latest?.delegation_id
          ? { parentDelegationID: latest.delegation_id }
          : binding.parentDelegationID
            ? { parentDelegationID: binding.parentDelegationID }
            : {}),
      }
    })
  } catch (error) {
    return throwStorageError("lineage", error)
  }
}

export function bindShadowDelegation(input: BindShadowDelegationInput): ShadowDelegation {
  const sessionID = input.sessionID as SessionID
  try {
    return Database.transaction(
      (tx) => {
        const session = tx.select({ id: SessionTable.id, projectID: SessionTable.project_id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
        if (!session) throw new TelemetryBindingError({ reason: "missing-session" })
        if (session.projectID !== input.delegation.projectID) throw new TelemetryBindingError({ reason: "cross-project-session" })

        const existing = tx
          .select()
          .from(ModelTelemetryDelegationTable)
          .where(
            and(
              eq(ModelTelemetryDelegationTable.project_id, input.delegation.projectID),
              eq(ModelTelemetryDelegationTable.delegation_id, input.delegation.delegationID),
            ),
          )
          .get()
        if (existing) {
          if (!sameBoundIdentity(existing, input.delegation, sessionID)) throw new TelemetryBindingError({ reason: "identity-conflict" })
          return boundDelegationFromRow(existing, delegationDecisions.get(input.delegation))
        }

        const binding = tx
          .select()
          .from(ModelTelemetrySessionBindingTable)
          .where(
            and(
              eq(ModelTelemetrySessionBindingTable.project_id, input.delegation.projectID),
              eq(ModelTelemetrySessionBindingTable.session_id, sessionID),
            ),
          )
          .get()
        const episodeID = binding?.episode_id ?? input.delegation.episodeID
        const attemptIndex = binding?.next_attempt_index ?? 0
        const parentDelegationID = latestSessionDelegation(tx, input.delegation.projectID, sessionID)?.delegation_id ?? input.delegation.parentDelegationID
        if (binding) {
          tx.update(ModelTelemetrySessionBindingTable)
            .set({ next_attempt_index: attemptIndex + 1 })
            .where(
              and(
                eq(ModelTelemetrySessionBindingTable.project_id, input.delegation.projectID),
                eq(ModelTelemetrySessionBindingTable.session_id, sessionID),
              ),
            )
            .run()
        } else {
          tx.insert(ModelTelemetrySessionBindingTable)
            .values({
              project_id: input.delegation.projectID,
              session_id: sessionID,
              episode_id: episodeID,
              parent_delegation_id: input.delegation.parentDelegationID ?? null,
              next_attempt_index: 1,
            })
            .run()
        }
        const row = {
          project_id: input.delegation.projectID,
          session_id: sessionID,
          episode_id: episodeID,
          decision_id: input.delegation.decisionID,
          delegation_id: input.delegation.delegationID,
          parent_delegation_id: parentDelegationID ?? null,
          attempt_index: attemptIndex,
          workload: input.delegation.workload,
          action: input.delegation.action,
          fanout: input.delegation.fanout ?? null,
        }
        tx.insert(ModelTelemetryDelegationTable).values(row).run()
        return boundDelegationFromRow(
          { ...row, terminal_event_type: null, terminal_event_id: null, terminal_checksum: null, terminal_time: null, time_created: Date.now(), time_updated: Date.now() },
          delegationDecisions.get(input.delegation),
        )
      },
      { behavior: "immediate" },
    )
  } catch (error) {
    return throwStorageError("bind", error)
  }
}

export function bindShadowDelegationBestEffort(input: BindShadowDelegationInput) {
  try {
    return bindShadowDelegation(input)
  } catch {
    return undefined
  }
}


function oracleAttributionFromDelegation(row: typeof ModelTelemetryDelegationTable.$inferSelect): ShadowOracleAttribution {
  return freeze({
    projectID: row.project_id,
    sessionID: row.session_id,
    episodeID: row.episode_id,
    decisionID: row.decision_id,
    delegationID: row.delegation_id,
    ...(row.parent_delegation_id ? { parentDelegationID: row.parent_delegation_id } : {}),
    attemptIndex: row.attempt_index,
  })
}

function hasExactOracleAttribution(tx: TxOrDb, attribution: ShadowOracleAttribution) {
  const session = tx
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(and(eq(SessionTable.id, attribution.sessionID), eq(SessionTable.project_id, attribution.projectID)))
    .get()
  if (!session) return false
  const delegation = tx
    .select()
    .from(ModelTelemetryDelegationTable)
    .where(
      and(
        eq(ModelTelemetryDelegationTable.project_id, attribution.projectID),
        eq(ModelTelemetryDelegationTable.session_id, attribution.sessionID),
        eq(ModelTelemetryDelegationTable.delegation_id, attribution.delegationID),
      ),
    )
    .get()
  if (!delegation) return false
  const current = oracleAttributionFromDelegation(delegation)
  return (
    current.projectID === attribution.projectID &&
    current.sessionID === attribution.sessionID &&
    current.episodeID === attribution.episodeID &&
    current.decisionID === attribution.decisionID &&
    current.delegationID === attribution.delegationID &&
    current.parentDelegationID === attribution.parentDelegationID &&
    current.attemptIndex === attribution.attemptIndex
  )
}

export function getShadowOracleAttribution(input: { projectID: ProjectIDType; sessionID: SessionID | string }) {
  try {
    return Database.use((db) => {
      const sessionID = input.sessionID as SessionID
      const session = db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.project_id, input.projectID)))
        .get()
      if (!session) return undefined
      const delegations = db
        .select()
        .from(ModelTelemetryDelegationTable)
        .where(
          and(
            eq(ModelTelemetryDelegationTable.project_id, input.projectID),
            eq(ModelTelemetryDelegationTable.session_id, sessionID),
          ),
        )
        .all()
      if (delegations.length !== 1) return undefined
      return oracleAttributionFromDelegation(delegations[0]!)
    })
  } catch (error) {
    return throwStorageError("oracle", error)
  }
}

export function recordShadowOracle(input: {
  projectID: ProjectIDType
  sessionID: SessionID | string
  oracleID: string
  attribution?: ShadowOracleAttribution
  verificationKind: VerificationKind
  status: VerificationStatus
  trusted: boolean
  occurredAt?: number
}): Promise<void> {
  if (typeof input.oracleID !== "string" || input.oracleID.length === 0 || input.oracleID.length > MAX_STRING_LENGTH) {
    return Promise.resolve()
  }
  const attribution = input.attribution ?? getShadowOracleAttribution({ projectID: input.projectID, sessionID: input.sessionID })
  if (!attribution || attribution.projectID !== input.projectID || attribution.sessionID !== (input.sessionID as SessionID)) {
    return Promise.resolve()
  }
  const snapshot = boundedTelemetrySnapshot({
    projectID: input.projectID,
    sessionID: input.sessionID as SessionID,
    oracleKey: oracleLinkKey(input.projectID, input.oracleID),
    attribution,
    verificationKind: input.verificationKind,
    status: input.status,
    trusted: input.trusted,
    occurredAt: input.occurredAt,
  })
  if (!snapshot) return Promise.resolve()
  return enqueueBestEffort(() => {
    try {
      Database.transaction(
        (tx) => {
          if (!hasExactOracleAttribution(tx, snapshot.attribution)) return
          const existingLink = tx
            .select()
            .from(ModelTelemetryOracleLinkTable)
            .where(
              and(
                eq(ModelTelemetryOracleLinkTable.project_id, snapshot.projectID),
                eq(ModelTelemetryOracleLinkTable.oracle_key, snapshot.oracleKey),
              ),
            )
            .get()
          if (existingLink) return

          const verificationEventID = stableOpaqueID(
            "verification",
            "coding-chimera:model-telemetry:verification:v1",
            [
              snapshot.oracleKey,
              snapshot.attribution.delegationID,
              snapshot.verificationKind,
              snapshot.status,
              snapshot.trusted ? "1" : "0",
            ],
          )
          const event: ValidEvent = {
            schemaVersion: 1,
            eventID: verificationEventID,
            eventType: "verification.recorded",
            episodeID: snapshot.attribution.episodeID,
            decisionID: snapshot.attribution.decisionID,
            delegationID: snapshot.attribution.delegationID,
            ...(snapshot.attribution.parentDelegationID ? { parentDelegationID: snapshot.attribution.parentDelegationID } : {}),
            attemptIndex: snapshot.attribution.attemptIndex,
            workload: "verification",
            verification: { kind: snapshot.verificationKind, status: snapshot.status, linked: true },
            createdAt: snapshot.occurredAt ?? Date.now(),
          }
          const checksum = eventChecksum(event)
          const existingEvent = tx
            .select()
            .from(ModelTelemetryEventTable)
            .where(eventWhere(snapshot.projectID, verificationEventID))
            .get()
          if (existingEvent && existingEvent.content_checksum !== checksum) {
            throw new TelemetryIdempotencyConflictError({
              projectID: snapshot.projectID,
              eventID: verificationEventID,
              existingChecksum: existingEvent.content_checksum,
              incomingChecksum: checksum,
              tombstoned: false,
            })
          }
          if (!existingEvent) insertEvent(tx, snapshot.projectID, event, checksum)
          tx.insert(ModelTelemetryOracleLinkTable)
            .values({
              project_id: snapshot.projectID,
              oracle_key: snapshot.oracleKey,
              session_id: snapshot.attribution.sessionID,
              delegation_id: snapshot.attribution.delegationID,
              episode_id: snapshot.attribution.episodeID,
              attempt_index: snapshot.attribution.attemptIndex,
              verification_event_id: verificationEventID,
              verification_kind: snapshot.verificationKind,
              status: snapshot.status,
              trusted: snapshot.trusted,
              time_occurred: snapshot.occurredAt ?? Date.now(),
            })
            .run()
        },
        { behavior: "immediate" },
      )
      return true
    } catch {
      return false
    }
  }).then(() => undefined)
}
