export * as SubagentModelScheduling from "./subagent-model-scheduling"

import {
  CAPABILITY_PRIOR_VERSION,
  REASONING_TIER_ORDER,
  capabilityAnchor,
  reconstructScore,
} from "./subagent-capability-prior"
import { projectCost, type BillingDisposition, type CostSource, type ModelPricing } from "./subagent-model-pricing"
import type { ModelRoute } from "./subagent-model-catalog"
import { SIZE_CLASSES, staticSpeedNorm, type SizeClass } from "./subagent-model-size"
import { blendedSpeedNorm, TPS_MAX, TPS_MIN, type RouteSpeedEvidence } from "./subagent-speed-evidence"

export type BillingRegime = BillingDisposition
export type SpendPolicy = "subscription-first" | "metered-first"
export type EvidenceSource = "deepswe-anchor" | "curve" | "blended" | "local" | "heuristic" | "none"
export type QuotaGateState = "ok" | "strained" | "exhausted" | "no-data"

export interface WorkloadWeights {
  quality: number
  speed: number
  cost: number
  size?: number
}

export interface WorkloadArchetype {
  name: string
  description: string
  minQuality: number
  effortCap?: string
  maxSizeClass?: SizeClass
  weights: WorkloadWeights
  budgetUsdPerWorker?: number
}

export interface WorkloadArchetypeOverride {
  description?: string
  minQuality?: number
  effortCap?: string
  maxSizeClass?: SizeClass
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
  speed: { norm: number; source: EvidenceSource; tps?: number; samples?: number }
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
  speedSource: EvidenceSource
  sizeClass?: SizeClass
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

export interface EffortResolution {
  variant?: string
  tier?: string
  quality: number
  qualitySource: EvidenceSource
  effortMismatch: boolean
}

export const DISCLOSURE_MAX_CHARS = 1500
export const EFFORT_ORDER = REASONING_TIER_ORDER
export const HEURISTIC_TIER_QUALITY: Record<string, number> = {
  low: 0.4,
  medium: 0.45,
  high: 0.5,
  xhigh: 0.52,
  max: 0.54,
}
export const SIZE_SMALLNESS: Record<SizeClass, number> = { S: 1, M: 0.67, L: 0.33, XL: 0 }
export const DEFAULT_TOP_TIER_DISABLED_MIN_SIZE_CLASS: SizeClass = "XL"

const FALLBACK_HEURISTIC_QUALITY = 0.45
// Mirrors the fast-identity demotion in staticSpeedNorm so disclosure can explain static norms.
const FAST_IDENTITY_PATTERN = /fast|flash/i

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
    minQuality: 0.3,
    maxSizeClass: "L",
    weights: { quality: 0.1, speed: 0.45, cost: 0.3, size: 0.15 },
  },
  {
    name: "builder",
    description: "Parallel implementation; require stronger cognition while capping reasoning effort.",
    minQuality: 0.5,
    effortCap: "high",
    weights: { quality: 0.5, speed: 0.1, cost: 0.25, size: 0.1 },
  },
  {
    name: "reviewer",
    description: "Review and audit follow-up; favor quality with moderate reasoning effort.",
    minQuality: 0.5,
    effortCap: "medium",
    weights: { quality: 0.5, speed: 0.2, cost: 0.3, size: 0 },
  },
]

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

function tierIndex(variant: string) {
  return REASONING_TIER_ORDER.indexOf(variant.trim().toLowerCase() as (typeof REASONING_TIER_ORDER)[number])
}

function sizeClassRank(sizeClass: SizeClass | undefined) {
  return sizeClass === undefined ? -1 : SIZE_CLASSES.indexOf(sizeClass)
}

function exceedsMaxSizeClass(sizeClass: SizeClass | undefined, maxSizeClass: SizeClass | undefined) {
  if (sizeClass === undefined || maxSizeClass === undefined) return false
  return sizeClassRank(sizeClass) > sizeClassRank(maxSizeClass)
}

function normToTps(norm: number) {
  return TPS_MIN * (TPS_MAX / TPS_MIN) ** norm
}

/**
 * Picks the dispatch variant for one route under one archetype: the lowest
 * eligible reasoning tier whose quality at that tier meets minQuality, falling
 * back to the highest eligible tier (flagged unproven downstream). Quality is
 * always evaluated at the tier actually selected for dispatch.
 */
export function resolveEffort(
  route: ModelRoute,
  archetype: WorkloadArchetype,
  opts: { topTierDisabledMinSizeClass?: SizeClass } = {},
): EffortResolution {
  const anchor = capabilityAnchor(route.identity)
  const tiered = route.variants
    .filter((variant) => tierIndex(variant) >= 0)
    .toSorted((a, b) => tierIndex(a) - tierIndex(b))
  const minSizeClass = opts.topTierDisabledMinSizeClass ?? DEFAULT_TOP_TIER_DISABLED_MIN_SIZE_CLASS
  const topTierDisabled = sizeClassRank(route.sizeClass) >= sizeClassRank(minSizeClass)
  const offered = topTierDisabled ? tiered.slice(0, -1) : tiered
  const cap = archetype.effortCap === undefined ? -1 : tierIndex(archetype.effortCap)
  const eligible = cap < 0 ? offered : offered.filter((variant) => tierIndex(variant) <= cap)
  if (eligible.length === 0) {
    return {
      variant: undefined,
      tier: undefined,
      quality: FALLBACK_HEURISTIC_QUALITY,
      qualitySource: "heuristic",
      effortMismatch: route.variants.length > 0,
    }
  }
  const qualityAt = (variant: string): { value: number; source: EvidenceSource } => {
    const reconstructed = anchor === undefined ? undefined : reconstructScore(anchor, variant)
    if (anchor !== undefined && reconstructed !== undefined) {
      return { value: reconstructed, source: variant === anchor.anchorTier ? "deepswe-anchor" : "curve" }
    }
    return { value: HEURISTIC_TIER_QUALITY[variant] ?? FALLBACK_HEURISTIC_QUALITY, source: "heuristic" }
  }
  const selected =
    eligible.find((variant) => qualityAt(variant).value >= archetype.minQuality) ?? eligible[eligible.length - 1]
  const quality = qualityAt(selected)
  return {
    variant: selected,
    tier: selected,
    quality: quality.value,
    qualitySource: quality.source,
    effortMismatch: false,
  }
}

export function buildProfile(input: {
  route: ModelRoute
  regime: BillingRegime
  pricing?: ModelPricing
  quota?: QuotaGate
  workload: string
  effort?: string
  quality: { value: number; tier?: string; source: EvidenceSource }
  speedEvidence?: RouteSpeedEvidence
}): ModelCostProfile {
  const speed = blendedSpeedNorm(
    input.speedEvidence,
    staticSpeedNorm({ sizeClass: input.route.sizeClass, identity: input.route.identity }),
    input.effort,
  )
  const cost = projectCost({
    pricing: input.pricing,
    disposition: input.regime,
    workload: input.workload,
    tier: input.effort ?? "medium",
  })
  return {
    route: input.route.model,
    identity: input.route.identity,
    regime: input.regime,
    quality: input.quality,
    speed:
      speed.source === "heuristic"
        ? { norm: speed.norm, source: speed.source }
        : { norm: speed.norm, source: speed.source, tps: normToTps(speed.norm), samples: input.speedEvidence?.samples ?? 0 },
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

function sizeSmallness(sizeClass: SizeClass | undefined) {
  return sizeClass === undefined ? 0.5 : SIZE_SMALLNESS[sizeClass]
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
  const sizeWeight = archetype.weights.size ?? 0
  return candidates.map((candidate, index) => ({
    ...candidate,
    score:
      archetype.weights.quality * normalized(candidate.quality, quality) +
      archetype.weights.speed * normalized(candidate.profile.speed.norm, speed) +
      archetype.weights.cost * (1 - normalized(cost[index], cost)) +
      (sizeWeight > 0 ? sizeWeight * sizeSmallness(candidate.route.sizeClass) : 0) +
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

function speedRationale(candidate: Candidate) {
  const speed = candidate.profile.speed
  if (speed.source === "local" || speed.source === "blended") {
    const tps = Math.round(speed.tps ?? normToTps(speed.norm))
    return `${speed.source === "blended" ? "~" : ""}${tps} tps ${speed.source} (n=${speed.samples ?? 0})`
  }
  const norm = Math.round(speed.norm * 100) / 100
  if (candidate.route.sizeClass === undefined) return `${norm} static`
  return `${norm} static (${candidate.route.sizeClass}${FAST_IDENTITY_PATTERN.test(candidate.route.identity) ? "+fast" : ""})`
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
  return [
    quality,
    cost,
    speedRationale(candidate),
    candidate.route.sizeClass === undefined ? undefined : `size ${candidate.route.sizeClass}`,
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
    speedSource: candidate.profile.speed.source,
    ...(candidate.route.sizeClass === undefined ? {} : { sizeClass: candidate.route.sizeClass }),
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
  speedEvidence?: Record<string, RouteSpeedEvidence>
  topTierDisabledMinSizeClass?: SizeClass
  limit?: number
}): ScheduleRecommendation[] {
  const policy = input.policy ?? DEFAULT_POLICY
  const candidates = input.routes.flatMap((route): Candidate[] => {
    if (route.suppressed || route.dormant) return []
    if (exceedsMaxSizeClass(route.sizeClass, input.archetype.maxSizeClass)) return []
    const effort = resolveEffort(route, input.archetype, {
      topTierDisabledMinSizeClass: input.topTierDisabledMinSizeClass,
    })
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
      effort: effort.variant,
      quality: { value: effort.quality, tier: effort.tier, source: effort.qualitySource },
      speedEvidence: input.speedEvidence?.[route.model],
    })
    if (profile.quota?.state === "exhausted") return []
    const unproven = effort.qualitySource === "heuristic" || effort.quality < input.archetype.minQuality
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
        variant: effort.variant,
        effortMismatch: effort.effortMismatch,
        quality: effort.quality,
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
  speedEvidence?: Record<string, RouteSpeedEvidence>
  topTierDisabledMinSizeClass?: SizeClass
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
          speedEvidence: input.speedEvidence,
          topTierDisabledMinSizeClass: input.topTierDisabledMinSizeClass,
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
    const marker = recommendations.some((item) => !item.unproven) ? "" : " no-proven-candidate (unproven fallback)"
    if (recommendations.every((item) => item.overflow)) {
      return [
        `- ${archetype.name}: ${archetype.description}${marker}`,
        `  overflow only: ${displayRecommendation(recommendations[0])}`,
      ]
    }
    return [
      `- ${archetype.name}: ${archetype.description}${marker}`,
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
