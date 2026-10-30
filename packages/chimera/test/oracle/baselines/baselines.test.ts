import { describe, expect, test } from "bun:test"
import os from "node:os"
import { sha256, utf8ByteLength } from "../transcript/format"
import { SCENARIOS } from "../transcript/fixtures/scenarios"
import {
  checkAgainstBaseline,
  computeDurationStats,
  computeNoiseBand,
  MIN_BASELINE_RUNS,
  NOISE_BAND_METHOD,
  type BaselineFile,
  type Measurement,
} from "./stats"

const baseline = (await Bun.file(new URL("./baseline.json", import.meta.url)).json()) as BaselineFile
const goldenDir = new URL("../transcript/golden/", import.meta.url)

function makeBaseline(samples: number[]): BaselineFile {
  return {
    format: "chimera.oracle.baseline",
    version: 1,
    contract_rev: "cr-2026-10-30-r1",
    environment: { runtime: "test", platform: "test", note: "test" },
    runs: samples.length,
    samples_ms: samples,
    duration: computeDurationStats(samples),
    hashes: [{ scenario: "synthetic", sha256: "a".repeat(64), bytes: 1 }],
    checks: { total: 1, passed: 1 },
    method: { noise_band: NOISE_BAND_METHOD, hash_stability: "test", gate: "test" },
  }
}

function makeMeasurement(base: BaselineFile): Measurement {
  return {
    environment: { ...base.environment },
    runs: base.runs,
    samples_ms: base.samples_ms,
    duration: base.duration,
    hashes: base.hashes,
    checks: base.checks,
  }
}

describe("duration statistics", () => {
  test("median, MAD, and band for a five-sample series", () => {
    const stats = computeDurationStats([100, 110, 120, 130, 140])
    expect(stats.median_ms).toBe(120)
    expect(stats.mad_ms).toBe(10)
    expect(stats.stdev_ms).toBeCloseTo(15.81, 2)
    expect(stats.cv).toBeCloseTo(0.1318, 4)
    expect(stats.noise_band_ms).toEqual({
      low_ms: 90,
      high_ms: 150,
      half_width_ms: 30,
      method: NOISE_BAND_METHOD,
    })
  })

  test("zero MAD uses the relative/absolute floor instead of a zero-width band", () => {
    expect(computeNoiseBand([100, 100, 100, 100, 100])).toEqual({
      low_ms: 80,
      high_ms: 120,
      half_width_ms: 20,
      method: NOISE_BAND_METHOD,
    })
  })

  test("sub-10 ms samples get a 20 ms absolute floor", () => {
    expect(computeNoiseBand([9, 9, 14, 10, 9])).toEqual({
      low_ms: 0,
      high_ms: 29,
      half_width_ms: 20,
      method: NOISE_BAND_METHOD,
    })
  })
})

describe("baseline gate", () => {
  test("identical measurement passes", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    expect(checkAgainstBaseline(base, makeMeasurement(base))).toEqual({
      status: "pass",
      code: "BASELINE_OK",
      detail: {},
    })
  })

  test("environment mismatch fails before the duration gate", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.environment = { ...base.environment, platform: "other-platform" }
    expect(checkAgainstBaseline(base, measurement).code).toBe("BASELINE_ENV_MISMATCH")
  })

  test("baseline with fewer than five runs is invalid", () => {
    const base = makeBaseline([100, 110, 120, 130])
    expect(checkAgainstBaseline(base, makeMeasurement(base)).code).toBe("BASELINE_INVALID")
  })

  test("hash drift fails before the duration check", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.hashes = [{ ...base.hashes[0]!, sha256: "b".repeat(64) }]
    expect(checkAgainstBaseline(base, measurement).code).toBe("BASELINE_HASH_DRIFT")
  })

  test("fewer than five runs fails", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.runs = 4
    measurement.samples_ms = [100, 110, 120, 130]
    measurement.duration = computeDurationStats(measurement.samples_ms)
    expect(checkAgainstBaseline(base, measurement).code).toBe("BASELINE_RUNS_INSUFFICIENT")
  })

  test("sample count mismatch fails", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.samples_ms = [100, 110, 120, 130]
    expect(checkAgainstBaseline(base, measurement).code).toBe("BASELINE_SAMPLE_COUNT_MISMATCH")
  })

  test("failed WP-02 checks fail", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.checks = { total: 24, passed: 23 }
    expect(checkAgainstBaseline(base, measurement).code).toBe("BASELINE_CHECKS_FAILED")
  })

  test("a slower median outside the band fails", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.samples_ms = [1000, 1000, 1000, 1000, 1000]
    measurement.duration = computeDurationStats(measurement.samples_ms)
    const verdict = checkAgainstBaseline(base, measurement)
    expect(verdict.code).toBe("BASELINE_DURATION_OUT_OF_BAND")
    expect(verdict.detail).toEqual({ median_ms: 1000, high_ms: 150 })
  })

  test("a faster median passes because the gate is one-sided", () => {
    const base = makeBaseline([100, 110, 120, 130, 140])
    const measurement = makeMeasurement(base)
    measurement.samples_ms = [10, 10, 10, 10, 10]
    measurement.duration = computeDurationStats(measurement.samples_ms)
    expect(checkAgainstBaseline(base, measurement).code).toBe("BASELINE_OK")
  })
})

describe("committed baseline", () => {
  test("has at least five measured runs", () => {
    expect(baseline.runs).toBeGreaterThanOrEqual(MIN_BASELINE_RUNS)
    expect(baseline.samples_ms.length).toBe(baseline.runs)
    expect(baseline.samples_ms.every((value) => Number.isSafeInteger(value) && value > 0)).toBe(true)
  })

  test("duration block matches the raw samples", () => {
    expect(baseline.duration).toEqual(computeDurationStats(baseline.samples_ms))
  })

  test("all WP-02 checks passed when the baseline was captured", () => {
    expect(baseline.checks.passed).toBe(baseline.checks.total)
    expect(baseline.checks.total).toBeGreaterThan(0)
  })

  test("hashes match the current WP-02 goldens", async () => {
    for (const scenario of SCENARIOS) {
      const recorded = baseline.hashes.find((item) => item.scenario === scenario.id)
      expect(recorded).toBeDefined()
      if (!recorded) continue
      const text = await Bun.file(new URL(scenario.golden, goldenDir)).text()
      expect(recorded.sha256).toBe(sha256(text))
      expect(recorded.bytes).toBe(utf8ByteLength(text))
    }
  })

  test("baseline is contract-locked and contains no host paths", () => {
    expect(baseline.contract_rev).toBe("cr-2026-10-30-r1")
    expect(baseline.method.noise_band).toContain("20%")
    expect(JSON.stringify(baseline)).not.toContain(os.homedir())
  })
})