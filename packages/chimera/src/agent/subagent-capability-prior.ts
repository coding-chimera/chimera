export * as SubagentCapabilityPrior from "./subagent-capability-prior"

import { ModelIdentity } from "../provider/model-identity"
import { matchByDashPrefix } from "./subagent-model-size"
export const CAPABILITY_PRIOR_VERSION = "deepswe-v1.1-curve-v2"
export const SEMANTIC_TIERS = ["low", "medium", "high", "xhigh", "max"] as const
export const REASONING_TIER_ORDER = ["minimal", ...SEMANTIC_TIERS] as const
export type SemanticTier = (typeof SEMANTIC_TIERS)[number]
export type ReasoningTier = (typeof REASONING_TIER_ORDER)[number]

function nonUltraTierIndex(variant: string) {
  return REASONING_TIER_ORDER.indexOf(variant.toLowerCase() as ReasoningTier)
}

export function highestNonUltraVariant(variants: readonly string[]) {
  const candidates = variants.filter((variant) => variant.toLowerCase() !== "ultra")
  if (candidates.length === 0) return undefined
  const tiered = candidates.filter((variant) => nonUltraTierIndex(variant) >= 0)
  if (tiered.length === 0) return candidates[candidates.length - 1]
  return tiered.toSorted((a, b) => nonUltraTierIndex(b) - nonUltraTierIndex(a))[0]
}

export function lowestNonUltraVariant(variants: readonly string[]) {
  const candidates = variants.filter((variant) => variant.toLowerCase() !== "ultra")
  if (candidates.length === 0) return undefined
  const tiered = candidates.filter((variant) => nonUltraTierIndex(variant) >= 0)
  if (tiered.length === 0) return candidates[0]
  return tiered.toSorted((a, b) => nonUltraTierIndex(a) - nonUltraTierIndex(b))[0]
}

export interface CapabilityPriorParams {
  rho: number
  p: number
  q: number
}

export interface CapabilityAnchor {
  identity: string
  score: number
  anchorTier: SemanticTier
  source: "deepswe"
  uncertainty?: number
}

export const DEFAULT_CAPABILITY_PRIOR_PARAMS = {
  rho: 0.75,
  p: 4.5,
  q: 0.75,
  provenance: "code-data",
} as const satisfies CapabilityPriorParams & { provenance: "code-data" }

export const TIER_COORDINATES: Record<SemanticTier, number> = {
  low: 0,
  medium: 0.25,
  high: 0.5,
  xhigh: 0.75,
  max: 1,
}

export const CAPABILITY_ANCHORS: CapabilityAnchor[] = [
  { identity: "claude-opus-5", score: 0.74, anchorTier: "max", source: "deepswe", uncertainty: 0.04 },
  { identity: "gpt-5.6-sol", score: 0.73, anchorTier: "max", source: "deepswe", uncertainty: 0.03 },
  { identity: "claude-fable-5", score: 0.7, anchorTier: "max", source: "deepswe", uncertainty: 0.04 },
  { identity: "gpt-5.6-terra", score: 0.7, anchorTier: "max", source: "deepswe", uncertainty: 0.03 },
  { identity: "kimi-k3", score: 0.69, anchorTier: "max", source: "deepswe", uncertainty: 0.05 },
  { identity: "gpt-5.6-luna", score: 0.67, anchorTier: "max", source: "deepswe", uncertainty: 0.04 },
  { identity: "gpt-5.5", score: 0.67, anchorTier: "xhigh", source: "deepswe", uncertainty: 0.06 },
  { identity: "grok-4.6", score: 0.67, anchorTier: "xhigh", source: "deepswe", uncertainty: 0.02 },
  { identity: "deepseek-v4-pro", score: 0.63, anchorTier: "max", source: "deepswe", uncertainty: 0.06 },
  { identity: "claude-opus-4.8", score: 0.59, anchorTier: "max", source: "deepswe", uncertainty: 0.02 },
  { identity: "qwen3.8-flash", score: 0.587, anchorTier: "max", source: "deepswe", uncertainty: 0.04 },
  { identity: "qwen3.8-max", score: 0.57, anchorTier: "xhigh", source: "deepswe", uncertainty: 0.03 },
  { identity: "muse-spark-1.2", score: 0.55, anchorTier: "xhigh", source: "deepswe", uncertainty: 0.02 },
  { identity: "claude-sonnet-5", score: 0.54, anchorTier: "max", source: "deepswe", uncertainty: 0.04 },
  { identity: "grok-4.5", score: 0.54, anchorTier: "high", source: "deepswe", uncertainty: 0.02 },
  { identity: "deepseek-v4-flash", score: 0.53, anchorTier: "max", source: "deepswe", uncertainty: 0.04 },
  { identity: "muse-spark-1.1", score: 0.53, anchorTier: "xhigh", source: "deepswe", uncertainty: 0.03 },
  { identity: "gpt-5.4", score: 0.52, anchorTier: "xhigh", source: "deepswe", uncertainty: 0.02 },
  { identity: "gemini-3.6-flash", score: 0.49, anchorTier: "high", source: "deepswe", uncertainty: 0.05 },
  { identity: "glm-5.2", score: 0.44, anchorTier: "max", source: "deepswe", uncertainty: 0.02 },
  { identity: "gemini-3.5-flash", score: 0.37, anchorTier: "medium", source: "deepswe", uncertainty: 0.02 },
  { identity: "claude-sonnet-4.6", score: 0.3, anchorTier: "high", source: "deepswe", uncertainty: 0.04 },
  { identity: "gemini-3.1-pro", score: 0.12, anchorTier: "high", source: "deepswe", uncertainty: 0.02 },
]

function isSemanticTier(tier: string): tier is SemanticTier {
  return (SEMANTIC_TIERS as readonly string[]).includes(tier)
}

export function normalizeIdentity(identity: string | undefined): string | undefined {
  return ModelIdentity.normalize(identity)
}

export function capabilityAnchor(identity: string | undefined): CapabilityAnchor | undefined {
  const normalized = normalizeIdentity(identity)
  if (!normalized) return undefined
  const exact = CAPABILITY_ANCHORS.find((anchor) => anchor.identity === normalized)
  if (exact) return exact
  const matches = CAPABILITY_ANCHORS.filter((anchor) => matchByDashPrefix(anchor.identity, normalized))
  return matches.toSorted((a, b) => b.identity.length - a.identity.length)[0]
}

export function semanticTier(tier: string | undefined): SemanticTier | undefined {
  const normalized = tier?.trim().toLowerCase()
  return normalized && isSemanticTier(normalized) ? normalized : undefined
}

export function tierCoordinate(tier: string | undefined): number | undefined {
  const normalized = semanticTier(tier)
  return normalized === undefined ? undefined : TIER_COORDINATES[normalized]
}

export function validateCapabilityPriorParams(params: CapabilityPriorParams): Error | undefined {
  if (!Number.isFinite(params.rho) || params.rho < 0 || params.rho >= 1)
    return new Error(`Invalid capability prior rho: ${params.rho}; expected a finite value in [0, 1)`)
  if (!Number.isFinite(params.p) || params.p <= 0)
    return new Error(`Invalid capability prior p: ${params.p}; expected a finite value > 0`)
  if (!Number.isFinite(params.q) || params.q <= 0 || params.q >= 1)
    return new Error(`Invalid capability prior q: ${params.q}; expected a finite value in (0, 1)`)
  return undefined
}

export function sharedCurve(
  t: number,
  params: CapabilityPriorParams = DEFAULT_CAPABILITY_PRIOR_PARAMS,
): number | undefined {
  if (!Number.isFinite(t) || t < 0 || t > 1) return undefined
  if (validateCapabilityPriorParams(params)) return undefined
  const result = 1 - (1 - params.rho) * (1 - t) ** params.p
  return Number.isFinite(result) ? result : undefined
}

export function reconstructScore(
  anchor: CapabilityAnchor,
  tier: string | undefined,
  params: CapabilityPriorParams = DEFAULT_CAPABILITY_PRIOR_PARAMS,
): number | undefined {
  if (!Number.isFinite(anchor.score) || anchor.score < 0 || anchor.score > 1) return undefined
  const target = tierCoordinate(tier)
  const sourceCoord = tierCoordinate(anchor.anchorTier)
  if (target === undefined || sourceCoord === undefined) return undefined
  const sourceCurve = sharedCurve(sourceCoord, params)
  const targetCurve = sharedCurve(target, params)
  if (sourceCurve === undefined || targetCurve === undefined || sourceCurve === 0) return undefined
  const result = anchor.score * (targetCurve / sourceCurve)
  return Number.isFinite(result) ? result : undefined
}

export function rationalCapability(
  score: number,
  params: CapabilityPriorParams = DEFAULT_CAPABILITY_PRIOR_PARAMS,
): number | undefined {
  if (!Number.isFinite(score) || score < 0 || score > 1) return undefined
  if (validateCapabilityPriorParams(params)) return undefined
  const result = score / (1 - params.q * score)
  return Number.isFinite(result) ? result : undefined
}

export function rationalCapabilityAtTier(
  anchor: CapabilityAnchor,
  tier: string | undefined,
  params: CapabilityPriorParams = DEFAULT_CAPABILITY_PRIOR_PARAMS,
): number | undefined {
  const score = reconstructScore(anchor, tier, params)
  return score === undefined ? undefined : rationalCapability(score, params)
}

export function relativeMaxGap(
  anchor: CapabilityAnchor,
  tier: string | undefined,
  params: CapabilityPriorParams = DEFAULT_CAPABILITY_PRIOR_PARAMS,
): number | undefined {
  const max = rationalCapabilityAtTier(anchor, "max", params)
  const at = rationalCapabilityAtTier(anchor, tier, params)
  if (max === undefined || at === undefined) return undefined
  const gap = max - at
  return Number.isFinite(gap) ? gap : undefined
}
