import { describe, expect, test } from "bun:test"
import { REASONING_TIER_ORDER } from "../../src/agent/subagent-capability-prior"
import {
  DEFAULT_TOKEN_BASKETS,
  projectCost,
  resolveTokenBasket,
  type CostProjection,
  type ModelPricing,
  type TokenBasket,
} from "../../src/agent/subagent-model-pricing"

function known(result: CostProjection) {
  if (result.status !== "known") throw new Error(`expected known projection, got ${result.status}`)
  return result
}

function basket(overrides: Partial<TokenBasket> = {}): TokenBasket {
  return { input: 1_000, output: 1_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

function pricing(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    input: overrides.input ?? 1,
    output: overrides.output ?? 2,
    cache: {
      read: overrides.cache?.read ?? 0.5,
      write: overrides.cache?.write ?? 1.25,
    },
    ...(overrides.experimentalOver200K ? { experimentalOver200K: overrides.experimentalOver200K } : {}),
  }
}

describe("subagent model pricing", () => {
  test("converts Provider per-million-token prices across every basket category", () => {
    const result = projectCost({
      disposition: "metered",
      pricing: pricing(),
      basket: basket({ input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000 }),
    })

    expect(result.status).toBe("known")
    expect(known(result).usd).toBeCloseTo(2.225, 10)
    expect(result.source).toBe("provider-pricing")
  })

  test("projects subscription and explicit free dispositions as known zero cost", () => {
    expect(projectCost({ disposition: "subscription" })).toEqual({ status: "known", usd: 0, source: "subscription" })
    expect(projectCost({ disposition: "free" })).toEqual({ status: "known", usd: 0, source: "explicit-free" })
  })

  test("keeps an unknown billing disposition unknown even when pricing is present", () => {
    expect(projectCost({ disposition: "unknown", pricing: pricing() })).toEqual({
      status: "unknown",
      source: "disposition",
      reason: "billing disposition is unknown",
    })
  })

  test("treats missing and all-zero metered pricing as unknown rather than free", () => {
    expect(projectCost({ disposition: "metered", basket: basket() })).toEqual({
      status: "unknown",
      source: "metered",
      reason: "provider pricing is missing",
    })
    expect(
      projectCost({
        disposition: "metered",
        pricing: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        basket: basket({ cacheRead: 100, cacheWrite: 100 }),
      }),
    ).toMatchObject({ status: "unknown", reason: "provider pricing has no positive price evidence" })
  })

  test("accepts zero cache rates when positive input or output pricing proves a metered price map", () => {
    const result = projectCost({
      disposition: "metered",
      pricing: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      basket: basket({ cacheRead: 500, cacheWrite: 500 }),
    })

    expect(result.status).toBe("known")
    expect(known(result).usd).toBeCloseTo((1_000 * 1 + 1_000 * 2) / 1_000_000)
  })

  test("charges cache reads and writes at distinct rates", () => {
    const result = projectCost({
      disposition: "metered",
      pricing: pricing({ cache: { read: 0.5, write: 1.5 } }),
      basket: basket({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
    })

    expect(known(result).usd).toBeCloseTo(2, 10)
  })

  test("charges reasoning tokens at the output price", () => {
    const result = projectCost({
      disposition: "metered",
      pricing: pricing({ input: 1, output: 4, cache: { read: 0, write: 0 } }),
      basket: basket({ input: 0, output: 100_000, reasoning: 50_000 }),
    })

    expect(known(result).usd).toBeCloseTo((150_000 * 4) / 1_000_000)
  })

  test("resolves deterministic positive baskets and uses builder defaults for custom workloads", () => {
    expect(resolveTokenBasket("builder", "high")).toBe(DEFAULT_TOKEN_BASKETS.builder.high)
    expect(resolveTokenBasket("scout", "max")).toBe(DEFAULT_TOKEN_BASKETS.scout.max)
    expect(resolveTokenBasket("custom", "high")).toBe(DEFAULT_TOKEN_BASKETS.builder.high)
    expect(resolveTokenBasket("builder", "bogus")).toBeUndefined()
    expect(resolveTokenBasket()).toBeUndefined()

    expect(Object.keys(DEFAULT_TOKEN_BASKETS)).toEqual(["scout", "builder", "reviewer"])
    for (const workload of Object.keys(DEFAULT_TOKEN_BASKETS)) {
      for (const tier of REASONING_TIER_ORDER) {
        const value = DEFAULT_TOKEN_BASKETS[workload]?.[tier]
        expect(value).toBeDefined()
        for (const count of [value.input, value.output, value.reasoning, value.cacheRead, value.cacheWrite]) {
          expect(count).toBeGreaterThan(0)
        }
      }
    }
  })

  test("grows reasoning tokens and projected cost monotonically with tier", () => {
    const reasoning = REASONING_TIER_ORDER.map((tier) => DEFAULT_TOKEN_BASKETS.builder[tier].reasoning)
    const costs = REASONING_TIER_ORDER.map(
      (tier) => known(projectCost({ disposition: "metered", pricing: pricing(), workload: "builder", tier })).usd,
    )
    for (let index = 1; index < reasoning.length; index++) {
      expect(reasoning[index]).toBeGreaterThan(reasoning[index - 1])
      expect(costs[index]).toBeGreaterThan(costs[index - 1])
    }
  })

  test("rejects negative and non-finite prices instead of treating them as free", () => {
    for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = projectCost({ disposition: "metered", pricing: pricing({ input }), basket: basket() })
      expect(result.status).toBe("unknown")
      expect(result).toMatchObject({ reason: expect.stringContaining("provider pricing") })
    }
  })

  test("rejects negative and non-finite token baskets", () => {
    for (const tokens of [basket({ input: -1 }), basket({ output: Number.NaN }), basket({ cacheRead: Infinity })]) {
      const result = projectCost({ disposition: "metered", pricing: pricing(), basket: tokens })
      expect(result.status).toBe("unknown")
      expect(result).toMatchObject({ reason: expect.stringContaining("token basket") })
    }
  })

  test("selects the over-200K tier when input plus cache reads exceed the threshold", () => {
    const result = projectCost({
      disposition: "metered",
      pricing: pricing({
        experimentalOver200K: { input: 0.5, output: 1, cache: { read: 0.25, write: 0.5 } },
      }),
      basket: basket({ input: 180_000, output: 10_000, cacheRead: 40_000 }),
    })

    expect(result.status).toBe("known")
    expect(result.source).toBe("provider-pricing-over-200k")
    expect(known(result).usd).toBeCloseTo((180_000 * 0.5 + 10_000 * 1 + 40_000 * 0.25) / 1_000_000)
  })

  test("rejects invalid over-200K pricing rather than falling back to the base tier", () => {
    const result = projectCost({
      disposition: "metered",
      pricing: pricing({
        experimentalOver200K: { input: 0.5, output: Number.NaN, cache: { read: 0.25, write: 0.5 } },
      }),
      basket: basket({ input: 180_000, output: 10_000, cacheRead: 40_000 }),
    })

    expect(result.status).toBe("unknown")
    expect(result).toMatchObject({ reason: expect.stringContaining("provider pricing") })
  })
})
