export * as SubagentModelPricing from "./subagent-model-pricing"

import { REASONING_TIER_ORDER, type ReasoningTier } from "./subagent-capability-prior"

export const TOKENS_PER_MILLION = 1_000_000
export const OVER_200K_INPUT_TOKENS = 200_000

export type BillingDisposition = "subscription" | "free" | "metered" | "unknown"

export interface ModelPricing {
  input: number
  output: number
  cache: {
    read: number
    write: number
  }
  experimentalOver200K?: {
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
  }
}

export interface TokenBasket {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type CostSource =
  | "subscription"
  | "explicit-free"
  | "provider-pricing"
  | "provider-pricing-over-200k"
  | "disposition"
  | "metered"

export type CostProjection =
  | { status: "known"; usd: number; source: CostSource }
  | { status: "unknown"; source: CostSource; reason: string }

const WORKLOAD_BASE: Record<string, Omit<TokenBasket, "reasoning">> = {
  scout: { input: 40_000, output: 4_000, cacheRead: 8_000, cacheWrite: 2_000 },
  builder: { input: 80_000, output: 12_000, cacheRead: 16_000, cacheWrite: 8_000 },
  reviewer: { input: 120_000, output: 8_000, cacheRead: 24_000, cacheWrite: 4_000 },
}

const REASONING_TOKENS: Record<ReasoningTier, number> = {
  minimal: 1_000,
  low: 2_000,
  medium: 6_000,
  high: 12_000,
  xhigh: 20_000,
  max: 32_000,
}

function tierBaskets(base: Omit<TokenBasket, "reasoning">): Record<ReasoningTier, TokenBasket> {
  return {
    minimal: { ...base, reasoning: REASONING_TOKENS.minimal },
    low: { ...base, reasoning: REASONING_TOKENS.low },
    medium: { ...base, reasoning: REASONING_TOKENS.medium },
    high: { ...base, reasoning: REASONING_TOKENS.high },
    xhigh: { ...base, reasoning: REASONING_TOKENS.xhigh },
    max: { ...base, reasoning: REASONING_TOKENS.max },
  }
}

export const DEFAULT_TOKEN_BASKETS: Record<string, Record<ReasoningTier, TokenBasket>> = {
  scout: tierBaskets(WORKLOAD_BASE.scout),
  builder: tierBaskets(WORKLOAD_BASE.builder),
  reviewer: tierBaskets(WORKLOAD_BASE.reviewer),
}

function isReasoningTier(tier: string): tier is ReasoningTier {
  return (REASONING_TIER_ORDER as readonly string[]).includes(tier)
}

export function resolveTokenBasket(workload?: string, tier?: string): TokenBasket | undefined {
  const normalized = tier?.trim().toLowerCase()
  if (!normalized || !isReasoningTier(normalized)) return undefined
  return (DEFAULT_TOKEN_BASKETS[workload ?? ""] ?? DEFAULT_TOKEN_BASKETS.builder)[normalized]
}

function isFiniteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0
}

function isUsableBasket(basket: TokenBasket) {
  return (
    isFiniteNonNegative(basket.input) &&
    isFiniteNonNegative(basket.output) &&
    isFiniteNonNegative(basket.reasoning) &&
    isFiniteNonNegative(basket.cacheRead) &&
    isFiniteNonNegative(basket.cacheWrite)
  )
}

function effectivePricing(pricing: ModelPricing, basket: TokenBasket) {
  if (pricing.experimentalOver200K && basket.input + basket.cacheRead > OVER_200K_INPUT_TOKENS) {
    return { pricing: pricing.experimentalOver200K, over200K: true }
  }
  return { pricing, over200K: false }
}

function prices(input: ReturnType<typeof effectivePricing>["pricing"]) {
  return [input.input, input.output, input.cache.read, input.cache.write]
}

function projectMetered(pricing: ModelPricing | undefined, basket: TokenBasket | undefined): CostProjection {
  if (!pricing) return { status: "unknown", source: "metered", reason: "provider pricing is missing" }
  if (!basket) return { status: "unknown", source: "metered", reason: "token basket is missing" }
  if (!isUsableBasket(basket)) {
    return { status: "unknown", source: "metered", reason: "token basket contains negative or non-finite tokens" }
  }
  if (prices(pricing).some((price) => !isFiniteNonNegative(price))) {
    return { status: "unknown", source: "metered", reason: "provider pricing contains negative or non-finite values" }
  }

  const effective = effectivePricing(pricing, basket)
  if (prices(effective.pricing).some((price) => !isFiniteNonNegative(price))) {
    return { status: "unknown", source: "metered", reason: "provider pricing contains negative or non-finite values" }
  }
  if (prices(effective.pricing).every((price) => price === 0)) {
    return { status: "unknown", source: "metered", reason: "provider pricing has no positive price evidence" }
  }

  const usd =
    (basket.input * effective.pricing.input +
      (basket.output + basket.reasoning) * effective.pricing.output +
      basket.cacheRead * effective.pricing.cache.read +
      basket.cacheWrite * effective.pricing.cache.write) /
    TOKENS_PER_MILLION
  return {
    status: "known",
    usd,
    source: effective.over200K ? "provider-pricing-over-200k" : "provider-pricing",
  }
}

export function projectCost(input: {
  pricing?: ModelPricing
  disposition: BillingDisposition
  basket?: TokenBasket
  workload?: string
  tier?: string
}): CostProjection {
  if (input.disposition === "subscription") return { status: "known", usd: 0, source: "subscription" }
  if (input.disposition === "free") return { status: "known", usd: 0, source: "explicit-free" }
  if (input.disposition === "unknown") {
    return { status: "unknown", source: "disposition", reason: "billing disposition is unknown" }
  }
  return projectMetered(input.pricing, input.basket ?? resolveTokenBasket(input.workload, input.tier))
}
