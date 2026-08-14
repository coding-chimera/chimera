export * as SubagentModelScheduling from "./subagent-model-scheduling"

import {
  CAPABILITY_PRIOR_VERSION,
  REASONING_TIER_ORDER,
  capabilityAnchor,
  reconstructScore,
  semanticTier,
} from "./subagent-capability-prior"
import { projectCost, type BillingDisposition, type CostSource, type ModelPricing } from "./subagent-model-pricing"
import type { ModelRoute } from "./subagent-model-catalog"

export type BillingRegime = BillingDisposition
export type SpendPolicy = "subscription-first" | "metered-first"
export type EvidenceSource = "deepswe-anchor" | "curve" | "blended" | "local" | "heuristic" | "none"
export type QuotaGateState = "ok" | "strained" | "exhausted" | "no-data"


export interface WorkloadWeights {
  quality: number
  speed: number
  cost: number
}

export interface WorkloadArchetype {
  name: string
  description: string
  minQuality: number
  effortCap?: string
  weights: WorkloadWeights
  budgetUsdPerWorker?: number
}

export interface WorkloadArchetypeOverride {
  description?: string
  minQuality?: number
  effortCap?: string
  weights?: WorkloadWeights
  budgetUsdPerWorker?: number
}

export interface SchedulingPolicy {
  spend: SpendPolicy
  quotaFloorPercent: number
  quotaStrainPercent: number
  rlStrainThreshold: number
}

export interface SchedulingConfigInput extends Partial<SchedulingPolicy> {
  enabled?: boolean
  archetypes?: Record<string, WorkloadArchetypeOverride>
  overrides?: Record<string, { billing?: BillingRegime }>
}

export interface QuotaGate {
  state: QuotaGateState
  remainingPercent?: number
}

export interface ModelCostProfile {
  route: string
  identity: string
  regime: BillingRegime
  quality: { value: number; tier?: string; source: EvidenceSource }
  speed: { norm: number; source: EvidenceSource }
  unitCost: { usd?: number; source: CostSource; reason?: string }
  quota?: QuotaGate
}

export interface ScheduleRecommendation {
  archetype: string
  route: string
  identity: string
  variant?: string
  regime: BillingRegime
  score: number
  quality: { value: number; source: EvidenceSource }
  unitCostUsd?: number
  unitCostSource: CostSource
  unitCostReason?: string
  quota?: QuotaGate
  speedNorm: number
  rationale: string
  overflow: boolean
  unproven: boolean
  effortMismatch: boolean
}

export interface SchedulingView {
  archetypes: WorkloadArchetype[]
  recommendations: Record<string, ScheduleRecommendation[]>
  priorVersion: string
}

interface Candidate {
  route: ModelRoute
  profile: ModelCostProfile
  variant?: string
  effortMismatch: boolean
  quality: number
  score: number
  unproven: boolean
  overflow: boolean
}

export const DISCLOSURE_MAX_CHARS = 1500
export const EFFORT_ORDER = REASONING_TIER_ORDER
const IDENTITY_CONFIDENCE_RANK = {
  "provider-scoped": 0,
  "api-exact": 1,
  explicit: 2,
} as const satisfies Record<ModelRoute["identityConfidence"], number>
export const DEFAULT_POLICY = {
  spend: "subscription-first",
  quotaFloorPercent: 5,
  quotaStrainPercent: 25,
  rlStrainThreshold: 3,
} as const satisfies SchedulingPolicy

export const DEFAULT_ARCHETYPES: WorkloadArchetype[] = [
  {
    name: "scout",
    description: "Read-only discovery and localization; prefer fast, inexpensive models.",
    minQuality: 0.35,
    weights: { quality: 0.1, speed: 0.5, cost: 0.4 },
  },
  {
    name: "builder",
    description: "Parallel implementation; require stronger cognition while capping reasoning effort.",
    minQuality: 0.55,
    effortCap: "low",
    weights: { quality: 0.6, speed: 0.1, cost: 0.3 },
  },
  {
    name: "reviewer",
    description: "Review and audit follow-up; favor quality with moderate reasoning effort.",
    minQuality: 0.55,
    effortCap: "medium",
    weights: { quality: 0.5, speed: 0.2, cost: 0.3 },
  },
]


export function heuristicSpeedNorm(identity: string) {
  if (/flash|luna|spark|lite|fast|k2\.7/i.test(identity)) return 1
  if (/pro|sol|terra|opus|fable|ultra|k3|max/i.test(identity)) return 0.3
  return 0.6
}

function mergeArchetype(base: WorkloadArchetype, override: WorkloadArchetypeOverride | undefined) {
  if (!override) return { ...base, weights: { ...base.weights } }
  return {
    ...base,
    ...override,
    name: base.name,
    weights: override.weights ? { ...override.weights } : { ...base.weights },
  }
}

export function resolveArchetypes(config?: SchedulingConfigInput): WorkloadArchetype[] {
  const configured = config?.archetypes ?? {}
  const defaults = DEFAULT_ARCHETYPES.map((archetype) => mergeArchetype(archetype, configured[archetype.name]))
  const custom = Object.entries(configured)
    .filter(([name]) => !DEFAULT_ARCHETYPES.some((archetype) => archetype.name === name))
    .map(([name, override]) =>
      mergeArchetype(
        {
          name,
          description: "Custom delegation workload.",
          minQuality: 0.5,
          weights: { quality: 0.4, speed: 0.3, cost: 0.3 },
        },
        override,
      ),
    )
  return [...defaults, ...custom]
}

export function validateWorkload(workload: string | undefined, archetypes: WorkloadArchetype[]) {
  if (workload === undefined) return undefined
  if (archetypes.some((archetype) => archetype.name === workload)) return undefined
  return new Error(`Unknown workload: ${workload}. Valid workloads: ${archetypes.map((item) => item.name).join(", ")}`)
}

export function resolvePolicy(config?: SchedulingConfigInput): SchedulingPolicy {
  return {
    spend: config?.spend ?? DEFAULT_POLICY.spend,
    quotaFloorPercent: config?.quotaFloorPercent ?? DEFAULT_POLICY.quotaFloorPercent,
    quotaStrainPercent: config?.quotaStrainPercent ?? DEFAULT_POLICY.quotaStrainPercent,
    rlStrainThreshold: config?.rlStrainThreshold ?? DEFAULT_POLICY.rlStrainThreshold,
  }
}

export function detectRegime(authType: string | undefined, override?: BillingRegime): BillingRegime {
  if (override) return override
  if (authType === "oauth") return "subscription"
  if (authType === "api" || authType === "wellknown") return "metered"
  return "unknown"
}

export function quotaGate(input: {
  remainingPercent?: number
  rlEffective?: number
  insufficientQuotaRecent?: boolean
  policy?: SchedulingPolicy
}): QuotaGate {
  const policy = input.policy ?? DEFAULT_POLICY
  if (input.insufficientQuotaRecent || (input.remainingPercent !== undefined && input.remainingPercent <= policy.quotaFloorPercent)) {
    return { state: "exhausted", remainingPercent: input.remainingPercent }
  }
  if (
    (input.remainingPercent !== undefined && input.remainingPercent <= policy.quotaStrainPercent) ||
    (input.rlEffective ?? 0) >= policy.rlStrainThreshold
  ) {
    return { state: "strained", remainingPercent: input.remainingPercent }
  }
  if (input.remainingPercent === undefined && (input.rlEffective ?? 0) === 0) return { state: "no-data" }
  return { state: "ok", remainingPercent: input.remainingPercent }
}

export function selectVariant(variants: string[], effortCap?: string) {
  if (!effortCap) return { variant: undefined, mismatch: false }
  const cap = EFFORT_ORDER.indexOf(effortCap as (typeof EFFORT_ORDER)[number])
  if (cap < 0) return { variant: undefined, mismatch: false }
  const eligible = variants
    .filter((variant) => {
      const index = EFFORT_ORDER.indexOf(variant as (typeof EFFORT_ORDER)[number])
      return index >= 0 && index <= cap
    })
    .toSorted(
      (a, b) =>
        EFFORT_ORDER.indexOf(b as (typeof EFFORT_ORDER)[number]) -
        EFFORT_ORDER.indexOf(a as (typeof EFFORT_ORDER)[number]),
    )
  if (eligible[0]) return { variant: eligible[0], mismatch: false }
  const lowest = variants
    .filter((variant) => EFFORT_ORDER.includes(variant as (typeof EFFORT_ORDER)[number]))
    .toSorted(
      (a, b) =>
        EFFORT_ORDER.indexOf(a as (typeof EFFORT_ORDER)[number]) -
        EFFORT_ORDER.indexOf(b as (typeof EFFORT_ORDER)[number]),
    )[0]
  return { variant: lowest, mismatch: lowest !== undefined || variants.length > 0 }
}

export function buildProfile(input: {
  route: ModelRoute
  regime: BillingRegime
  pricing?: ModelPricing
  quota?: QuotaGate
  workload: string
  effort?: string
}): ModelCostProfile {
  const anchor = capabilityAnchor(input.route.identity)
  const tier = semanticTier(input.effort) ?? (input.effort === undefined ? anchor?.anchorTier : undefined)
  const score = anchor && tier ? reconstructScore(anchor, tier) : undefined
  const cost = projectCost({
    pricing: input.pricing,
    disposition: input.regime,
    workload: input.workload,
    tier: input.effort ?? anchor?.anchorTier ?? "medium",
  })
  return {
    route: input.route.model,
    identity: input.route.identity,
    regime: input.regime,
    quality:
      score === undefined
        ? { value: 0.45, source: "heuristic" }
        : { value: score, tier, source: tier === anchor?.anchorTier ? "deepswe-anchor" : "curve" },
    speed: { norm: heuristicSpeedNorm(input.route.identity), source: "heuristic" },
    unitCost:
      cost.status === "known"
        ? { usd: cost.usd, source: cost.source }
        : { source: cost.source, reason: cost.reason },
    ...(input.regime === "subscription" ? { quota: input.quota ?? { state: "no-data" as const } } : {}),
  }
}

function normalized(value: number, values: number[]) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return 0.5
  return (value - min) / (max - min)
}

function scoreCandidates(candidates: Candidate[], archetype: WorkloadArchetype) {
  const quality = candidates.map((candidate) => candidate.quality)
  const speed = candidates.map((candidate) => candidate.profile.speed.norm)
  const knownPositiveCosts = candidates.flatMap((candidate) =>
    candidate.profile.unitCost.usd !== undefined && candidate.profile.unitCost.usd > 0
      ? [candidate.profile.unitCost.usd]
      : [],
  )
  const fallbackCost = knownPositiveCosts.length === 0 ? Number.EPSILON : Math.max(...knownPositiveCosts) * 1.1
  const cost = candidates.map((candidate) => candidate.profile.unitCost.usd ?? fallbackCost)
  return candidates.map((candidate, index) => ({
    ...candidate,
    score:
      archetype.weights.quality * normalized(candidate.quality, quality) +
      archetype.weights.speed * normalized(candidate.profile.speed.norm, speed) +
      archetype.weights.cost * (1 - normalized(cost[index], cost)) +
      (candidate.route.preferred ? 0.05 : 0),
  }))
}

function candidateOrder(a: Candidate, b: Candidate) {
  return (
    Number(a.unproven) - Number(b.unproven) ||
    b.score - a.score ||
    b.profile.speed.norm - a.profile.speed.norm ||
    Number(b.route.preferred) - Number(a.route.preferred) ||
    IDENTITY_CONFIDENCE_RANK[b.route.identityConfidence] - IDENTITY_CONFIDENCE_RANK[a.route.identityConfidence] ||
    a.route.model.localeCompare(b.route.model)
  )
}

function rationale(candidate: Candidate) {
  const quality = `${Math.round(candidate.quality * 100)}% ${candidate.profile.quality.source}`
  const quota = candidate.profile.quota
    ? candidate.profile.quota.remainingPercent === undefined
      ? `, quota ${candidate.profile.quota.state}`
      : `, quota ${candidate.profile.quota.remainingPercent}% (${candidate.profile.quota.state})`
    : ""
  const cost =
    candidate.profile.regime === "subscription"
      ? `$0 subscription${quota}`
      : candidate.profile.regime === "free"
        ? "$0 free"
        : candidate.profile.unitCost.usd === undefined
          ? "cost unknown"
          : `$${candidate.profile.unitCost.usd.toFixed(2)}/task ${candidate.profile.unitCost.source}`
  const speed = candidate.profile.speed.norm >= 0.8 ? "fast" : candidate.profile.speed.norm >= 0.5 ? "normal" : "slow"
  return [
    quality,
    cost,
    `${speed} ${candidate.profile.speed.source}`,
    candidate.unproven ? "unproven" : undefined,
    candidate.effortMismatch ? "effort-mismatch" : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

function recommendation(candidate: Candidate, archetype: WorkloadArchetype): ScheduleRecommendation {
  return {
    archetype: archetype.name,
    route: candidate.route.model,
    identity: candidate.route.identity,
    variant: candidate.variant,
    regime: candidate.profile.regime,
    score: candidate.score,
    quality: { value: candidate.quality, source: candidate.profile.quality.source },
    unitCostUsd: candidate.profile.unitCost.usd,
    unitCostSource: candidate.profile.unitCost.source,
    unitCostReason: candidate.profile.unitCost.reason,
    quota: candidate.profile.quota,
    speedNorm: candidate.profile.speed.norm,
    rationale: rationale(candidate),
    overflow: candidate.overflow,
    unproven: candidate.unproven,
    effortMismatch: candidate.effortMismatch,
  }
}

export function resolveSchedule(input: {
  routes: ModelRoute[]
  archetype: WorkloadArchetype
  pricing?: Record<string, ModelPricing>
  regimes?: Record<string, BillingRegime>
  quota?: Record<string, QuotaGate>
  policy?: SchedulingPolicy
  limit?: number
}): ScheduleRecommendation[] {
  const policy = input.policy ?? DEFAULT_POLICY
  const candidates = input.routes.flatMap((route): Candidate[] => {
    if (route.suppressed || route.dormant) return []
    const selected = selectVariant(route.variants, input.archetype.effortCap)
    const profile = buildProfile({
      route,
      regime:
        input.regimes?.[route.model] ??
        input.regimes?.[route.identity] ??
        input.regimes?.[route.providerID] ??
        "unknown",
      pricing: input.pricing?.[route.model],
      quota: input.quota?.[route.model],
      workload: input.archetype.name,
      effort: selected.variant,
    })
    if (profile.quota?.state === "exhausted") return []
    const quality = profile.quality.value
    const belowThreshold = quality < input.archetype.minQuality
    const unproven = profile.quality.source === "heuristic" || (belowThreshold && profile.quality.source === "curve")
    if (belowThreshold && !unproven) return []
    if (
      input.archetype.budgetUsdPerWorker !== undefined &&
      profile.unitCost.usd !== undefined &&
      profile.unitCost.usd > input.archetype.budgetUsdPerWorker
    )
      return []
    return [
      {
        route,
        profile,
        variant: selected.variant,
        effortMismatch: selected.mismatch,
        quality,
        score: 0,
        unproven,
        overflow: false,
      },
    ]
  })
  if (candidates.length === 0) return []
  const scored = scoreCandidates(candidates, input.archetype)
  const zeroPaid = scored
    .filter((candidate) => candidate.profile.regime === "subscription" || candidate.profile.regime === "free")
    .toSorted(candidateOrder)
  const metered = scored
    .filter((candidate) => candidate.profile.regime !== "subscription" && candidate.profile.regime !== "free")
    .toSorted(candidateOrder)
  const eligibleZeroPaid = zeroPaid.filter(
    (candidate) =>
      candidate.profile.regime === "free" ||
      candidate.profile.quota?.state === "ok" ||
      candidate.profile.quota?.state === "no-data",
  )
  const strainedSubscription = zeroPaid.filter((candidate) => candidate.profile.quota?.state === "strained")
  const ordered =
    policy.spend === "subscription-first"
      ? eligibleZeroPaid.length > 0
        ? [
            eligibleZeroPaid[0],
            ...metered.map((candidate) => ({ ...candidate, overflow: true })),
            ...eligibleZeroPaid.slice(1),
            ...strainedSubscription.map((candidate) => ({ ...candidate, overflow: true })),
          ]
        : [...metered, ...strainedSubscription.map((candidate) => ({ ...candidate, overflow: true }))]
      : metered.length > 0
        ? [
            ...metered,
            ...eligibleZeroPaid.map((candidate) => ({ ...candidate, overflow: true })),
            ...strainedSubscription.map((candidate) => ({ ...candidate, overflow: true })),
          ]
        : [...eligibleZeroPaid, ...strainedSubscription.map((candidate) => ({ ...candidate, overflow: true }))]
  const unique = new Map<string, Candidate>()
  for (const candidate of ordered) if (!unique.has(candidate.route.model)) unique.set(candidate.route.model, candidate)
  return [...unique.values()]
    .slice(0, Math.max(1, input.limit ?? 3))
    .map((candidate) => recommendation(candidate, input.archetype))
}

export function buildSchedulingView(input: {
  routes: ModelRoute[]
  config?: SchedulingConfigInput
  authTypes?: Record<string, string | undefined>
  pricing?: Record<string, ModelPricing>
  quota?: Record<string, QuotaGate>
  limit?: number
}): SchedulingView {
  const archetypes = resolveArchetypes(input.config)
  const policy = resolvePolicy(input.config)
  const regimes = Object.fromEntries(
    input.routes.map((route) => [
      route.model,
      detectRegime(
        input.authTypes?.[route.providerID],
        input.config?.overrides?.[route.model]?.billing ??
        input.config?.overrides?.[route.identity]?.billing ?? input.config?.overrides?.[route.providerID]?.billing,
      ),
    ]),
  )
  return {
    archetypes,
    recommendations: Object.fromEntries(
      archetypes.map((archetype) => [
        archetype.name,
        resolveSchedule({
          routes: input.routes,
          archetype,
          pricing: input.pricing,
          regimes,
          quota: input.quota,
          policy,
          limit: input.limit,
        }),
      ]),
    ),
    priorVersion: CAPABILITY_PRIOR_VERSION,
  }
}

function displayRecommendation(item: ScheduleRecommendation) {
  const variant = item.variant ? ` variant ${item.variant}` : ""
  return `${item.route}${variant} [${item.rationale}]${item.overflow ? " (overflow)" : ""}`
}

export function disclosure(view: SchedulingView, maxChars = DISCLOSURE_MAX_CHARS) {
  const prefix =
    "## Subagent Model Scheduling\n\nDeclare workload on every task/chimera_swarm dispatch (drives scheduling and records attribution for future telemetry):\n"
  const footer =
    "\nNo model selector + workload => scheduler picks; workload + explicit model => records attribution for future telemetry. Split heterogeneous workloads by archetype."
  const lines = view.archetypes.flatMap((archetype) => {
    const recommendations = view.recommendations[archetype.name] ?? []
    if (recommendations.length === 0) return [`- ${archetype.name}: no feasible current route`]
    if (recommendations.every((item) => item.overflow)) {
      return [
        `- ${archetype.name}: ${archetype.description}`,
        `  overflow only: ${displayRecommendation(recommendations[0])}`,
      ]
    }
    return [
      `- ${archetype.name}: ${archetype.description}`,
      `  pick: ${displayRecommendation(recommendations[0])}`,
      ...(recommendations[1] ? [`  alt: ${displayRecommendation(recommendations[1])}`] : []),
    ]
  })
  for (let included = lines.length; included >= 0; included--) {
    const omitted = lines.length - included
    const omission = omitted > 0 ? `\n- ${omitted} scheduling lines omitted by the ${maxChars}-character budget.` : ""
    const text = `${prefix}${lines.slice(0, included).join("\n")}${omission}${footer}`
    if (text.length <= maxChars) return text
  }
  return undefined
}

export function disclosureProjection(view: SchedulingView) {
  return JSON.stringify({
    priorVersion: view.priorVersion,
    archetypes: view.archetypes.map((item) => ({ name: item.name, description: item.description })),
    recommendations: Object.fromEntries(
      Object.entries(view.recommendations).map(([name, items]) => [
        name,
        items.map((item) => ({
          route: item.route,
          variant: item.variant,
          score: item.score,
          rationale: item.rationale,
          overflow: item.overflow,
        })),
      ]),
    ),
  })
}

export function selectionForWorkload(view: SchedulingView, workload: string) {
  const error = validateWorkload(workload, view.archetypes)
  if (error) return { error }
  const recommendation = (view.recommendations[workload] ?? []).find((item) => !item.overflow)
  if (!recommendation) return { error: new Error(`No currently eligible route for workload: ${workload}; overflow routes are advisory only`) }
  return {
    workload,
    model: recommendation.route,
    variant: recommendation.variant,
    recommendation,
  }
}
