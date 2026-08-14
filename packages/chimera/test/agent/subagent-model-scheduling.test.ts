import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_PRIOR_VERSION,
  capabilityAnchor,
  reconstructScore,
} from "../../src/agent/subagent-capability-prior"
import type { ModelPricing } from "../../src/agent/subagent-model-pricing"
import type { ModelRoute } from "../../src/agent/subagent-model-catalog"
import {
  buildSchedulingView,
  DEFAULT_ARCHETYPES,
  DEFAULT_POLICY,
  disclosure,
  disclosureProjection,
  resolveSchedule,
  selectVariant,
  selectionForWorkload,
  validateWorkload,
} from "../../src/agent/subagent-model-scheduling"

function route(identity: string, providerID: string, variants: string[] = []): ModelRoute {
  return {
    identity,
    identityConfidence: "explicit",
    providerID,
    modelID: identity,
    model: `${providerID}/${identity}`,
    name: identity,
    variants,
    source: "config",
    dormant: false,
    preferred: false,
    suppressed: false,
  }
}

function archetype(name: string) {
  return DEFAULT_ARCHETYPES.find((item) => item.name === name)!
}

function pricing(input = 1, output = 2, cacheRead = 0.5, cacheWrite = 1): ModelPricing {
  return { input, output, cache: { read: cacheRead, write: cacheWrite } }
}

describe("subagent model scheduling", () => {
  test("uses the compact capability curve and Provider pricing for a selected effort tier", () => {
    const result = resolveSchedule({
      routes: [route("deepseek-v4-pro", "deepseek", ["low", "max"])],
      archetype: archetype("builder"),
      regimes: { deepseek: "metered" },
      pricing: { "deepseek/deepseek-v4-pro": pricing() },
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.variant).toBe("low")
    expect(result[0]?.quality.source).toBe("curve")
    expect(result[0]?.quality.value).toBeCloseTo(0.3906, 6)
    expect(result[0]?.unitCostUsd).toBeCloseTo(0.124, 6)
    expect(result[0]?.unitCostSource).toBe("provider-pricing")
    expect(result[0]?.quota).toBeUndefined()
    expect(result[0]?.rationale).toContain("curve")
    expect(result[0]?.rationale).toContain("provider-pricing")
    expect(result[0]?.rationale).toContain("unproven")
    expect(result[0]?.unproven).toBe(true)
  })

  test("uses global semantic tiers rather than sparse route-relative positions", () => {
    const selected = resolveSchedule({
      routes: [route("gpt-5.5", "metered", ["high", "max"])],
      archetype: { ...archetype("builder"), minQuality: 0.5, effortCap: "high" },
      regimes: { metered: "metered" },
      pricing: { "metered/gpt-5.5": pricing() },
    })
    const anchor = capabilityAnchor("gpt-5.5")!

    expect(selected[0]?.variant).toBe("high")
    expect(selected[0]?.quality.source).toBe("curve")
    expect(selected[0]?.quality.value).toBeCloseTo(reconstructScore(anchor, "high")!)
    expect(selected[0]?.quality.value).toBeLessThan(anchor.score)

    const exact = resolveSchedule({
      routes: [route("gpt-5.5", "metered", ["xhigh", "max"])],
      archetype: { ...archetype("builder"), minQuality: 0.5, effortCap: "xhigh" },
      regimes: { metered: "metered" },
      pricing: { "metered/gpt-5.5": pricing() },
    })
    expect(exact[0]?.quality).toEqual({ value: 0.67, source: "deepswe-anchor" })
    expect(exact[0]?.unproven).toBe(false)
  })

  test("keeps minimal reasoning unproven while pricing its token basket", () => {
    const result = resolveSchedule({
      routes: [route("gpt-5.6-sol", "metered", ["minimal"])],
      archetype: { ...archetype("builder"), minQuality: 0.4, effortCap: "minimal" },
      regimes: { metered: "metered" },
      pricing: { "metered/gpt-5.6-sol": pricing() },
    })

    expect(result[0]).toMatchObject({
      variant: "minimal",
      quality: { value: 0.45, source: "heuristic" },
      unitCostSource: "provider-pricing",
      unproven: true,
    })
    expect(result[0]?.unitCostUsd).toBeCloseTo(0.122, 6)
  })

  test("marks non-empty variant sets without a selectable reasoning tier as effort-mismatched", () => {
    expect(selectVariant(["ultra"], "low")).toEqual({ variant: undefined, mismatch: true })
    expect(selectVariant(["none"], "low")).toEqual({ variant: undefined, mismatch: true })
    expect(selectVariant([], "low")).toEqual({ variant: undefined, mismatch: false })
    expect(selectVariant(["ultra", "low"], "low")).toEqual({ variant: "low", mismatch: false })
    expect(selectVariant(["max"], "low")).toEqual({ variant: "max", mismatch: true })

    const result = resolveSchedule({
      routes: [route("gpt-5.6-sol", "metered", ["ultra"])],
      archetype: archetype("builder"),
      regimes: { metered: "metered" },
      pricing: { "metered/gpt-5.6-sol": pricing() },
    })
    expect(result[0]).toMatchObject({ variant: undefined, effortMismatch: true })
    expect(result[0]?.rationale).toContain("effort-mismatch")
  })

  test("ranks an eligible subscription route first at zero paid USD", () => {
    const result = resolveSchedule({
      routes: [
        route("claude-opus-5", "metered", ["medium", "max"]),
        route("gpt-5.6-sol", "subscription", ["medium", "max"]),
      ],
      archetype: archetype("reviewer"),
      regimes: { metered: "metered", subscription: "subscription" },
      pricing: { "metered/claude-opus-5": pricing(3, 15, 0.3, 3.75) },
    })

    expect(result.map((item) => item.route)).toEqual([
      "subscription/gpt-5.6-sol",
      "metered/claude-opus-5",
    ])
    expect(result[0]?.unitCostUsd).toBe(0)
    expect(result[0]?.unitCostSource).toBe("subscription")
    expect(result[0]?.regime).toBe("subscription")
    expect(result[0]?.rationale).toContain("$0 subscription")
    expect(result[0]?.rationale).toContain("quota no-data")
    expect(result[0]?.quota).toEqual({ state: "no-data" })
    expect(result[1]?.overflow).toBe(true)
  })

  test("uses quota only as a feasibility gate for subscription routes", () => {
    const routes = [
      route("claude-opus-5", "metered", ["medium", "max"]),
      route("gpt-5.6-sol", "subscription", ["medium", "max"]),
    ]
    const input = {
      routes,
      archetype: archetype("reviewer"),
      regimes: { metered: "metered" as const, subscription: "subscription" as const },
      pricing: { "metered/claude-opus-5": pricing() },
    }

    const strained = resolveSchedule({
      ...input,
      quota: { "subscription/gpt-5.6-sol": { state: "strained", remainingPercent: 20 } },
    })
    expect(strained.map((item) => item.route)).toEqual([
      "metered/claude-opus-5",
      "subscription/gpt-5.6-sol",
    ])
    expect(strained[1]?.overflow).toBe(true)

    const overflowOnly = resolveSchedule({
      ...input,
      routes: [routes[1]],
      quota: { "subscription/gpt-5.6-sol": { state: "strained", remainingPercent: 20 } },
    })
    const overflowView = {
      archetypes: [archetype("reviewer")],
      recommendations: { reviewer: overflowOnly },
      priorVersion: "test",
    }
    expect(overflowOnly[0]?.overflow).toBe(true)
    expect(selectionForWorkload(overflowView, "reviewer").error?.message).toContain("overflow routes are advisory only")
    expect(disclosure(overflowView)).toContain("overflow only:")

    const exhausted = resolveSchedule({
      ...input,
      quota: { "subscription/gpt-5.6-sol": { state: "exhausted", remainingPercent: 5 } },
    })
    expect(exhausted.map((item) => item.route)).toEqual(["metered/claude-opus-5"])
  })

  test("retains strained subscription overflow under metered-first policy", () => {
    const result = resolveSchedule({
      routes: [
        route("claude-opus-5", "metered", ["medium", "max"]),
        route("gpt-5.6-sol", "subscription", ["medium", "max"]),
      ],
      archetype: archetype("reviewer"),
      regimes: { metered: "metered", subscription: "subscription" },
      pricing: { "metered/claude-opus-5": pricing() },
      quota: { "subscription/gpt-5.6-sol": { state: "strained", remainingPercent: 20 } },
      policy: { ...DEFAULT_POLICY, spend: "metered-first" },
    })

    expect(result.map((item) => item.route)).toEqual([
      "metered/claude-opus-5",
      "subscription/gpt-5.6-sol",
    ])
    expect(result[1]?.overflow).toBe(true)
  })

  test("supports explicit free billing without subscription quota semantics", () => {
    const view = buildSchedulingView({
      routes: [route("alpha", "shared"), route("beta", "shared")],
      authTypes: { shared: "api" },
      config: { overrides: { "shared/alpha": { billing: "free" } } },
      pricing: {
        "shared/alpha": { input: 0, output: 0, cache: { read: 0, write: 0 } },
        "shared/beta": pricing(),
      },
    })
    const recommendations = view.recommendations.scout ?? []

    expect(recommendations.find((item) => item.route === "shared/alpha")).toMatchObject({
      regime: "free",
      unitCostUsd: 0,
      unitCostSource: "explicit-free",
      quota: undefined,
    })
    expect(recommendations.find((item) => item.route === "shared/beta")?.regime).toBe("metered")
  })

  test("keeps all-zero metered pricing unknown instead of treating it as free", () => {
    const result = resolveSchedule({
      routes: [route("deepseek-v4-pro", "metered", ["max"])],
      archetype: archetype("scout"),
      regimes: { metered: "metered" },
      pricing: { "metered/deepseek-v4-pro": { input: 0, output: 0, cache: { read: 0, write: 0 } } },
    })

    expect(result[0]).toMatchObject({
      unitCostUsd: undefined,
      unitCostSource: "metered",
      unitCostReason: "provider pricing has no positive price evidence",
    })
    expect(result[0]?.rationale).toContain("cost unknown")
  })

  test("penalizes unknown cost relative to explicit zero in candidate scoring", () => {
    const result = resolveSchedule({
      routes: [
        route("deepseek-v4-pro", "free", ["max"]),
        route("deepseek-v4-pro", "metered", ["max"]),
      ],
      archetype: archetype("scout"),
      regimes: {
        "free/deepseek-v4-pro": "free",
        "metered/deepseek-v4-pro": "metered",
      },
      pricing: {
        "metered/deepseek-v4-pro": { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    })
    const free = result.find((item) => item.route === "free/deepseek-v4-pro")
    const unknown = result.find((item) => item.route === "metered/deepseek-v4-pro")

    expect(free?.unitCostUsd).toBe(0)
    expect(unknown?.unitCostUsd).toBeUndefined()
    expect(free!.score).toBeGreaterThan(unknown!.score)
  })

  test("applies identity billing overrides per route without leaking across one provider", () => {
    const view = buildSchedulingView({
      routes: [route("alpha", "shared"), route("beta", "shared")],
      authTypes: { shared: "api" },
      config: { overrides: { alpha: { billing: "subscription" } } },
      pricing: { "shared/beta": pricing() },
    })
    const recommendations = view.recommendations.scout ?? []

    expect(recommendations.find((item) => item.route === "shared/alpha")).toMatchObject({
      regime: "subscription",
      unitCostUsd: 0,
    })
    expect(recommendations.find((item) => item.route === "shared/beta")?.regime).toBe("metered")
  })

  test("uses identity confidence before lexical route order for otherwise tied candidates", () => {
    const result = resolveSchedule({
      routes: [
        { ...route("alpha", "a"), identityConfidence: "provider-scoped" },
        route("beta", "z"),
      ],
      archetype: archetype("scout"),
      regimes: { "a/alpha": "metered", "z/beta": "metered" },
    })

    expect(result.map((item) => item.route)).toEqual(["z/beta", "a/alpha"])
  })

  test("changes the disclosure projection when visible workload guidance changes", () => {
    const first = buildSchedulingView({
      routes: [route("gpt-5.6-sol", "subscription", ["low"])],
      authTypes: { subscription: "oauth" },
      config: { archetypes: { triage: { description: "Fast triage." } } },
    })
    const second = buildSchedulingView({
      routes: [route("gpt-5.6-sol", "subscription", ["low"])],
      authTypes: { subscription: "oauth" },
      config: { archetypes: { triage: { description: "Careful triage." } } },
    })

    expect(first.priorVersion).toBe(CAPABILITY_PRIOR_VERSION)
    expect(disclosureProjection(first)).not.toBe(disclosureProjection(second))
  })

  test("merges custom workloads and validates names against the effective vocabulary", () => {
    const view = buildSchedulingView({
      routes: [route("custom-flash", "test", ["low"])],
      authTypes: { test: "oauth" },
      config: {
        archetypes: {
          triage: {
            description: "Fast custom triage.",
            minQuality: 0.4,
            effortCap: "low",
            weights: { quality: 0.2, speed: 0.6, cost: 0.2 },
          },
        },
      },
    })

    expect(view.archetypes.map((item) => item.name)).toEqual(["scout", "builder", "reviewer", "triage"])
    expect(validateWorkload("triage", view.archetypes)).toBeUndefined()
    expect(validateWorkload("unknown", view.archetypes)?.message).toContain(
      "Valid workloads: scout, builder, reviewer, triage",
    )
    expect(selectionForWorkload(view, "triage")).toMatchObject({
      workload: "triage",
      model: "test/custom-flash",
      variant: "low",
    })
    expect(view.recommendations.triage?.[0]?.unitCostUsd).toBe(0)
  })

  test("keeps the compact disclosure within its configured character budget", () => {
    const view = buildSchedulingView({
      routes: [route("gpt-5.6-sol", "subscription", ["low", "medium", "max"])],
      authTypes: { subscription: "oauth" },
    })
    const text = disclosure(view, 500)

    expect(text).toBeDefined()
    expect(text!.length).toBeLessThanOrEqual(500)
    expect(text).toContain("No model selector + workload => scheduler picks")
    expect(text).toContain("scheduling lines omitted")
  })
})
