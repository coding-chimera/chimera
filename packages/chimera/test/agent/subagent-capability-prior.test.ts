import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_ANCHORS,
  DEFAULT_CAPABILITY_PRIOR_PARAMS,
  SEMANTIC_TIERS,
  TIER_COORDINATES,
  capabilityAnchor,
  normalizeIdentity,
  rationalCapability,
  reconstructScore,
  relativeMaxGap,
  sharedCurve,
  tierCoordinate,
  validateCapabilityPriorParams,
} from "../../src/agent/subagent-capability-prior"
import type { CapabilityAnchor, SemanticTier } from "../../src/agent/subagent-capability-prior"

function anchor(identity: string, score: number, anchorTier: SemanticTier): CapabilityAnchor {
  return { identity, score, anchorTier, source: "deepswe" }
}

describe("subagent capability prior", () => {
  test("exposes the code-data calibration candidates as defaults", () => {
    expect(DEFAULT_CAPABILITY_PRIOR_PARAMS).toMatchObject({
      rho: 0.62,
      p: 4.5,
      q: 0.75,
      provenance: "code-data",
    })
  })

  test("keeps one compact anchor per proven identity with no cost/steps/per-tier fields", () => {
    expect(CAPABILITY_ANCHORS).toHaveLength(22)
    expect(new Set(CAPABILITY_ANCHORS.map((item) => item.identity)).size).toBe(CAPABILITY_ANCHORS.length)
    for (const item of CAPABILITY_ANCHORS) {
      expect(Object.keys(item).sort()).toEqual(["anchorTier", "identity", "score", "source", "uncertainty"])
      expect(SEMANTIC_TIERS).toContain(item.anchorTier)
    }
  })

  test("derives the registry from the bundled snapshot's unique identity anchors", () => {
    expect(capabilityAnchor("claude-opus-5")).toMatchObject({ score: 0.74, anchorTier: "max" })
    expect(capabilityAnchor("deepseek-v4-pro")).toMatchObject({ score: 0.63, anchorTier: "max" })
    expect(capabilityAnchor("gpt-5.5")).toMatchObject({ score: 0.67, anchorTier: "xhigh" })
    expect(capabilityAnchor("grok-4.5")).toMatchObject({ score: 0.54, anchorTier: "high" })
    expect(capabilityAnchor("gemini-3.5-flash")).toMatchObject({ score: 0.37, anchorTier: "medium" })
  })

  test("normalizes identity case and whitespace before anchor lookup", () => {
    expect(normalizeIdentity("  DeepSeek-V4-Pro ")).toBe("deepseek-v4-pro")
    expect(normalizeIdentity(undefined)).toBeUndefined()
    expect(normalizeIdentity("")).toBeUndefined()
    expect(capabilityAnchor("DEEPSEEK-V4-PRO")?.score).toBe(0.63)
  })

  test("falls back to unknown for identities without a proven anchor", () => {
    expect(capabilityAnchor("unknown-model")).toBeUndefined()
    expect(capabilityAnchor(undefined)).toBeUndefined()
    expect(capabilityAnchor("")).toBeUndefined()
    expect(capabilityAnchor("kimi-k2.7-code")).toBeUndefined()
  })

  test("maps global semantic tiers monotonically and rejects unproven tiers", () => {
    expect(SEMANTIC_TIERS).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(TIER_COORDINATES.low).toBe(0)
    expect(TIER_COORDINATES.max).toBe(1)
    expect(tierCoordinate("low")).toBeLessThan(tierCoordinate("medium")!)
    expect(tierCoordinate("medium")).toBeLessThan(tierCoordinate("high")!)
    expect(tierCoordinate("high")).toBeLessThan(tierCoordinate("xhigh")!)
    expect(tierCoordinate("xhigh")).toBeLessThan(tierCoordinate("max")!)
    for (const unproven of ["none", "minimal", "ultra", "", undefined]) {
      expect(tierCoordinate(unproven)).toBeUndefined()
    }
  })

  test("keeps semantic coordinates independent of sparse route variants", () => {
    expect(tierCoordinate("high")).toBe(0.5)
    const highAnchor = capabilityAnchor("grok-4.5")!
    expect(highAnchor.anchorTier).toBe("high")
    expect(reconstructScore(highAnchor, "max")).toBeGreaterThan(highAnchor.score)
    expect(reconstructScore(highAnchor, "low")).toBeLessThan(highAnchor.score)
  })

  test("matches the shared curve R(t)=1-(1-rho)(1-t)^p", () => {
    expect(sharedCurve(0)).toBeCloseTo(0.62)
    expect(sharedCurve(1)).toBe(1)
    expect(sharedCurve(0.5)).toBeCloseTo(0.9832062, 6)
    expect(sharedCurve(0)).toBeLessThan(sharedCurve(0.5)!)
    expect(sharedCurve(0.5)).toBeLessThan(sharedCurve(1)!)
  })

  test("reconstructs the anchor score exactly at its own tier", () => {
    for (const item of CAPABILITY_ANCHORS) {
      expect(reconstructScore(item, item.anchorTier)).toBe(item.score)
    }
    expect(reconstructScore(anchor("custom", 0.8, "xhigh"), "xhigh")).toBe(0.8)
  })

  test("reconstructs monotonic scores across tiers", () => {
    const opus = capabilityAnchor("claude-opus-5")!
    const scores = SEMANTIC_TIERS.map((tier) => reconstructScore(opus, tier)!)
    for (let index = 1; index < scores.length; index++) {
      expect(scores[index]).toBeGreaterThan(scores[index - 1])
    }
    expect(reconstructScore(opus, "max")).toBe(0.74)
    expect(reconstructScore(opus, "low")).toBeLessThan(0.74)
  })

  test("stretches capability rationally as c=S/(1-qS)", () => {
    expect(rationalCapability(1)).toBe(4)
    expect(rationalCapability(0)).toBe(0)
    expect(rationalCapability(0.62)).toBeCloseTo(1.1588785, 6)
    expect(Number.isFinite(rationalCapability(0.99)!)).toBe(true)
  })

  test("computes a non-negative relative max gap that grows at lower tiers", () => {
    const opus = capabilityAnchor("claude-opus-5")!
    expect(relativeMaxGap(opus, "max")).toBe(0)
    const medium = relativeMaxGap(opus, "medium")!
    const high = relativeMaxGap(opus, "high")!
    expect(medium).toBeGreaterThanOrEqual(0)
    expect(medium).toBeGreaterThan(high)
    expect(Number.isFinite(medium)).toBe(true)
  })

  test("validates illegal and non-finite parameters", () => {
    expect(validateCapabilityPriorParams({ rho: 0.62, p: 4.5, q: 0.75 })).toBeUndefined()
    for (const bad of [
      { rho: 1.5, p: 4.5, q: 0.75 },
      { rho: -0.1, p: 4.5, q: 0.75 },
      { rho: 1, p: 4.5, q: 0.75 },
      { rho: Number.NaN, p: 4.5, q: 0.75 },
      { rho: Number.POSITIVE_INFINITY, p: 4.5, q: 0.75 },
      { rho: 0.62, p: 0, q: 0.75 },
      { rho: 0.62, p: -1, q: 0.75 },
      { rho: 0.62, p: 4.5, q: 0 },
      { rho: 0.62, p: 4.5, q: 1 },
    ]) {
      expect(validateCapabilityPriorParams(bad)).toBeInstanceOf(Error)
    }
  })

  test("returns undefined for invalid parameters and non-finite inputs", () => {
    const opus = capabilityAnchor("claude-opus-5")!
    expect(sharedCurve(2)).toBeUndefined()
    expect(sharedCurve(Number.NaN)).toBeUndefined()
    expect(sharedCurve(0.5, { rho: 1.5, p: 4.5, q: 0.75 })).toBeUndefined()
    expect(rationalCapability(Number.NaN)).toBeUndefined()
    expect(rationalCapability(1.5)).toBeUndefined()
    expect(rationalCapability(0.5, { rho: 0.62, p: 4.5, q: 1 })).toBeUndefined()
    expect(reconstructScore(opus, "max", { rho: 0.62, p: 0, q: 0.75 })).toBeUndefined()
    expect(reconstructScore(opus, "ultra")).toBeUndefined()
    expect(reconstructScore(opus, "minimal")).toBeUndefined()
    expect(reconstructScore(opus, "none")).toBeUndefined()
    expect(reconstructScore(anchor("broken", Number.NaN, "max"), "max")).toBeUndefined()
    expect(relativeMaxGap(opus, "ultra")).toBeUndefined()
  })

  test("prefers an exact anchor over the dash-aligned prefix fallback", () => {
    expect(capabilityAnchor("gpt-5.6-luna")).toMatchObject({ identity: "gpt-5.6-luna", score: 0.67 })
  })

  test("falls back to the longest dash-aligned anchor prefix", () => {
    expect(capabilityAnchor("deepseek-v4-flash-0731")).toMatchObject({ identity: "deepseek-v4-flash", score: 0.53 })
    expect(capabilityAnchor("glm-5.2-fast-preview")).toMatchObject({ identity: "glm-5.2", score: 0.44 })
    expect(capabilityAnchor("gpt-5.6-luna-2026")).toMatchObject({ identity: "gpt-5.6-luna", score: 0.67 })
  })

  test("keeps the anchor prefix fallback dash-aligned", () => {
    expect(capabilityAnchor("qwen3.8-maximum")).toBeUndefined()
    expect(capabilityAnchor("completely-unknown-model")).toBeUndefined()
  })
})
