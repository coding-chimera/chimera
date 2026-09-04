import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_PRIOR_VERSION,
  capabilityAnchor,
  reconstructScore,
} from "../../src/agent/subagent-capability-prior"
import type { ModelPricing } from "../../src/agent/subagent-model-pricing"
import type { ModelRoute } from "../../src/agent/subagent-model-catalog"
import { resolveSizeClass, staticSpeedNorm } from "../../src/agent/subagent-model-size"
import { tpsToNorm, type RouteSpeedEvidence } from "../../src/agent/subagent-speed-evidence"
import {
  buildSchedulingView,
  DEFAULT_ARCHETYPES,
  DEFAULT_POLICY,
  disclosure,
  disclosureProjection,
  resolveEffort,
  resolveSchedule,
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
    sizeClass: resolveSizeClass({ identity }),
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
    expect(result[0]?.quality.value).toBeCloseTo(reconstructScore(capabilityAnchor("deepseek-v4-pro")!, "low")!)
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
      routes: [route("gpt-5.6-sol", "metered", ["minimal", "max"])],
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
    const cap = { ...archetype("builder"), minQuality: 0.1, effortCap: "low" }
    expect(resolveEffort(route("gpt-5.6-sol", "metered", ["ultra"]), cap)).toMatchObject({
      variant: undefined,
      effortMismatch: true,
    })
    expect(resolveEffort(route("gpt-5.6-sol", "metered", ["none"]), cap)).toMatchObject({
      variant: undefined,
      effortMismatch: true,
    })
    expect(resolveEffort(route("gpt-5.6-sol", "metered", []), cap)).toMatchObject({
      variant: undefined,
      effortMismatch: false,
    })
    expect(resolveEffort(route("gpt-5.5", "metered", ["ultra", "low"]), cap)).toMatchObject({
      variant: "low",
      effortMismatch: false,
    })
    // A cap below every offered tier no longer dispatches above the cap.
    expect(resolveEffort(route("gpt-5.6-sol", "metered", ["max"]), cap)).toMatchObject({
      variant: undefined,
      effortMismatch: true,
    })

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
        route("kimi-k3", "metered", ["medium", "max"]),
        route("gpt-5.6-sol", "subscription", ["medium", "max"]),
      ],
      archetype: archetype("reviewer"),
      regimes: { metered: "metered", subscription: "subscription" },
      pricing: { "metered/kimi-k3": pricing(3, 15, 0.3, 3.75) },
    })

    expect(result.map((item) => item.route)).toEqual([
      "subscription/gpt-5.6-sol",
      "metered/kimi-k3",
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
      route("kimi-k3", "metered", ["medium", "max"]),
      route("gpt-5.6-sol", "subscription", ["medium", "max"]),
    ]
    const input = {
      routes,
      archetype: archetype("reviewer"),
      regimes: { metered: "metered" as const, subscription: "subscription" as const },
      pricing: { "metered/kimi-k3": pricing() },
    }

    const strained = resolveSchedule({
      ...input,
      quota: { "subscription/gpt-5.6-sol": { state: "strained", remainingPercent: 20 } },
    })
    expect(strained.map((item) => item.route)).toEqual([
      "metered/kimi-k3",
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
    expect(exhausted.map((item) => item.route)).toEqual(["metered/kimi-k3"])
  })

  test("retains strained subscription overflow under metered-first policy", () => {
    const result = resolveSchedule({
      routes: [
        route("kimi-k3", "metered", ["medium", "max"]),
        route("gpt-5.6-sol", "subscription", ["medium", "max"]),
      ],
      archetype: archetype("reviewer"),
      regimes: { metered: "metered", subscription: "subscription" },
      pricing: { "metered/kimi-k3": pricing() },
      quota: { "subscription/gpt-5.6-sol": { state: "strained", remainingPercent: 20 } },
      policy: { ...DEFAULT_POLICY, spend: "metered-first" },
    })

    expect(result.map((item) => item.route)).toEqual([
      "metered/kimi-k3",
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

  test("fills the lowest sufficient tier when the archetype has no effort cap", () => {
    const result = resolveSchedule({
      routes: [route("deepseek-v4-flash", "test-relay", ["low", "high", "max", "ultra"])],
      archetype: archetype("scout"),
      regimes: { "test-relay": "metered" },
      pricing: { "test-relay/deepseek-v4-flash": pricing() },
    })

    expect(result[0]?.variant).toBe("low")
  })
})

describe("effort resolution", () => {
  const open = { name: "open", description: "", minQuality: 0.5, weights: { quality: 1, speed: 0, cost: 0 } }

  test("anchored big model passes at the lowest sufficient tier", () => {
    const result = resolveEffort(route("claude-opus-5", "anthropic", ["low", "medium", "high", "max"]), archetype("scout"))
    expect(result.variant).toBe("low")
    expect(result.quality).toBeCloseTo(reconstructScore(capabilityAnchor("claude-opus-5")!, "low")!)
    expect(result.qualitySource).toBe("curve")
    expect(result.effortMismatch).toBe(false)
  })

  test("unanchored small model climbs tiers until minQuality is met", () => {
    const result = resolveEffort(route("tiny-helper", "test", ["low", "medium", "high"]), archetype("builder"))
    expect(result.variant).toBe("high")
    expect(result.quality).toBeCloseTo(0.5, 6)
    expect(result.qualitySource).toBe("heuristic")
  })

  test("drops the highest tier for XL routes but L routes keep max", () => {
    const qwen = resolveEffort(route("qwen3.8-max", "test-relay", ["low", "medium", "high", "xhigh"]), open)
    expect(qwen.variant).not.toBe("xhigh")

    const kimi = resolveEffort(route("kimi-k3", "moonshot", ["low", "high", "max"]), open)
    expect(kimi.variant).not.toBe("max")

    const large = resolveEffort(route("deepseek-v4-pro", "deepseek", ["low", "max"]), open)
    expect(large.variant).toBe("max")
  })

  test("respects the archetype effort cap", () => {
    const result = resolveEffort(route("deepseek-v4-pro", "deepseek", ["low", "high", "max"]), archetype("builder"))
    expect(result.variant).toBe("high")
  })

  test("returns the heuristic fallback for a route without tiered variants", () => {
    const result = resolveEffort(route("alpha", "test"), archetype("scout"))
    expect(result.variant).toBeUndefined()
    expect(result.quality).toBeCloseTo(0.45, 6)
    expect(result.qualitySource).toBe("heuristic")
    expect(result.effortMismatch).toBe(false)
  })

  test("scores quality at the dispatched tier rather than the anchor tier", () => {
    const anchor = capabilityAnchor("deepseek-v4-flash")!
    const result = resolveSchedule({
      routes: [route("deepseek-v4-flash", "test-relay", ["low", "max"])],
      archetype: { ...archetype("scout"), minQuality: 0.3 },
      regimes: { "test-relay": "metered" },
      pricing: { "test-relay/deepseek-v4-flash": pricing() },
    })

    expect(result[0]?.variant).toBe("low")
    expect(result[0]?.quality.value).toBeCloseTo(reconstructScore(anchor, "low")!)
    expect(result[0]?.quality.value).toBeLessThan(anchor.score)
    expect(result[0]?.quality.source).toBe("curve")
  })

  test("an anchored model clears minQuality only at xhigh under the builder effort cap", () => {
    const qwen = resolveEffort(route("qwen3.8-max", "test-relay", ["low", "medium", "high", "xhigh", "max"]), {
      ...archetype("builder"),
      minQuality: 0.57,
    })
    expect(qwen.variant).toBe("xhigh")
    expect(qwen.quality).toBe(0.57)
    expect(qwen.qualitySource).toBe("deepswe-anchor")
    expect(qwen.effortMismatch).toBe(false)

    const capped = resolveEffort(route("qwen3.8-max", "test-relay", ["low", "medium", "high", "xhigh", "max"]), {
      ...archetype("builder"),
      minQuality: 0.57,
      effortCap: "high",
    })
    expect(capped.variant).toBe("high")
  })

})

describe("size gating and layering", () => {
  test("scout excludes XL routes while builder does not gate size", () => {
    const routes = [route("qwen3.8-max", "test-relay", ["low", "max"]), route("deepseek-v4-flash", "test-relay", ["low", "max"])]
    const regimes = { "test-relay": "metered" as const }

    const scouted = resolveSchedule({ routes, archetype: archetype("scout"), regimes })
    expect(scouted.map((item) => item.route)).toEqual(["test-relay/deepseek-v4-flash"])

    const built = resolveSchedule({ routes, archetype: archetype("builder"), regimes })
    expect(built.map((item) => item.route)).toEqual(["test-relay/qwen3.8-max", "test-relay/deepseek-v4-flash"])
  })

  test("keeps routes with an unknown size class eligible", () => {
    const result = resolveSchedule({
      routes: [route("mystery-model", "test", ["low"])],
      archetype: archetype("scout"),
      regimes: { test: "metered" },
    })
    expect(result.map((item) => item.route)).toEqual(["test/mystery-model"])
  })

  test("layers proven candidates before unproven regardless of score", () => {
    const result = resolveSchedule({
      routes: [
        route("mystery-model", "metered", ["low"]),
        route("deepseek-v4-flash", "metered", ["low"]),
      ],
      archetype: archetype("scout"),
      regimes: { metered: "metered" },
      pricing: {
        "metered/mystery-model": pricing(0.01, 0.02, 0.005, 0.01),
        "metered/deepseek-v4-flash": pricing(),
      },
    })

    expect(result.map((item) => item.route)).toEqual(["metered/deepseek-v4-flash", "metered/mystery-model"])
    expect(result[0]?.unproven).toBe(false)
    expect(result[1]?.unproven).toBe(true)
    expect(result[1]!.score).toBeGreaterThan(result[0]!.score)
  })

  test("flags an archetype with no proven candidate in the disclosure", () => {
    const view = buildSchedulingView({
      routes: [route("mystery-model", "test", ["low"])],
      authTypes: { test: "oauth" },
    })

    expect(view.recommendations.scout?.every((item) => item.unproven)).toBe(true)
    expect(disclosure(view)).toContain("no-proven-candidate (unproven fallback)")
  })

  test("reviewer's minSizeClass XL gate keeps XL routes and excludes smaller ones", () => {
    const routes = [route("qwen3.8-max", "test-relay", ["low", "max"]), route("deepseek-v4-flash", "test-relay", ["low", "max"])]
    const regimes = { "test-relay": "metered" as const }

    const reviewed = resolveSchedule({ routes, archetype: archetype("reviewer"), regimes })
    expect(reviewed.map((item) => item.route)).toEqual(["test-relay/qwen3.8-max"])
  })

  test("passes routes with an unknown size class through the reviewer gate", () => {
    const result = resolveSchedule({
      routes: [route("mystery-model", "test", ["low"])],
      archetype: archetype("reviewer"),
      regimes: { test: "metered" },
    })
    expect(result.map((item) => item.route)).toEqual(["test/mystery-model"])
  })

  test("excludes suppressed and dormant routes from schedule candidates", () => {
    const routes = [
      { ...route("mystery-suppressed", "test", ["low"]), suppressed: true },
      { ...route("mystery-dormant", "test", ["low"]), dormant: true },
      route("mystery-model", "test", ["low"]),
    ]
    const result = resolveSchedule({
      routes,
      archetype: archetype("builder"),
      regimes: { test: "metered" },
    })
    expect(result.map((item) => item.route)).toEqual(["test/mystery-model"])
  })

})

describe("speed evidence", () => {
  const evidenceRoute = route("deepseek-v4-flash", "test-relay", ["low"])
  const input = {
    routes: [evidenceRoute],
    archetype: archetype("scout"),
    regimes: { "test-relay": "metered" as const },
    pricing: { "test-relay/deepseek-v4-flash": pricing() },
  }

  test("uses trustworthy measured speed once past the prior-sample threshold", () => {
    const evidence: RouteSpeedEvidence = {
      samples: 12,
      trustworthy: true,
      decodeTokPerSec: { low: 108 },
      decodeSamples: { low: 12 },
    }
    const result = resolveSchedule({ ...input, speedEvidence: { "test-relay/deepseek-v4-flash": evidence } })

    expect(result[0]?.speedNorm).toBeCloseTo(tpsToNorm(108), 6)
    expect(result[0]?.speedSource).toBe("local")
    expect(result[0]?.rationale).toContain("108 tps local (n=12)")
  })

  test("blends sparse measured speed with the static norm", () => {
    const evidence: RouteSpeedEvidence = {
      samples: 2,
      trustworthy: true,
      decodeTokPerSec: { low: 108 },
      decodeSamples: { low: 2 },
    }
    const staticNorm = staticSpeedNorm({ sizeClass: "L", identity: "deepseek-v4-flash" })
    const expected = (2 * tpsToNorm(108) + 3 * staticNorm) / 5
    const result = resolveSchedule({ ...input, speedEvidence: { "test-relay/deepseek-v4-flash": evidence } })

    expect(result[0]?.speedNorm).toBeCloseTo(expected, 6)
    expect(result[0]?.speedSource).toBe("blended")
    expect(result[0]?.rationale).toContain("tps blended (n=2)")
  })

  test("falls back to the static norm when evidence is untrustworthy", () => {
    const evidence: RouteSpeedEvidence = { samples: 12, trustworthy: false, decodeTokPerSec: { low: 108 } }
    const result = resolveSchedule({ ...input, speedEvidence: { "test-relay/deepseek-v4-flash": evidence } })
    const staticNorm = staticSpeedNorm({ sizeClass: "L", identity: "deepseek-v4-flash" })

    expect(result[0]?.speedNorm).toBeCloseTo(staticNorm, 6)
    expect(result[0]?.speedSource).toBe("heuristic")
    expect(result[0]?.rationale).toContain("static")
  })
})
