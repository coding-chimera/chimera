// WP-03 statistical gate primitives.
//
// A baseline is a same-environment repeated measurement of the WP-02 harness:
// N >= 5 measured full `runSuite()` executions (plus one warm-up). The gate has
// two independent parts:
//
//   hash stability: every run must emit the same transcript sha256 per scenario
//   duration band:  the candidate median must not exceed the band's high edge
//
// The duration band is `median ± max(3 × MAD, 20% × median, 20 ms)`. The MAD
// term absorbs ordinary jitter; the relative and absolute floors keep a
// zero-MAD or sub-50 ms sample from producing a zero-width band. The gate is
// one-sided (only slowdown fails): a faster candidate is never a regression.
// The band is deliberately wide: this is a regression gate, not a benchmark.
export const MIN_BASELINE_RUNS = 5
export const NOISE_BAND_MAD_MULTIPLIER = 3
export const NOISE_BAND_RELATIVE_FLOOR = 0.2
export const NOISE_BAND_ABSOLUTE_FLOOR_MS = 20
export const NOISE_BAND_METHOD = "median ± max(3×MAD, 20%×median, 20ms)"

export type NoiseBand = {
  low_ms: number
  high_ms: number
  half_width_ms: number
  method: string
}

export type DurationStats = {
  runs: number
  samples_ms: number[]
  min_ms: number
  max_ms: number
  median_ms: number
  mean_ms: number
  stdev_ms: number
  mad_ms: number
  cv: number
  noise_band_ms: NoiseBand
}

export type ScenarioHash = {
  scenario: string
  sha256: string
  bytes: number
}

export type BaselineEnvironment = {
  runtime: string
  platform: string
  note: string
}

export type BaselineMethod = {
  noise_band: string
  hash_stability: string
  gate: string
}

export type BaselineFile = {
  format: "chimera.oracle.baseline"
  version: 1
  contract_rev: string
  environment: BaselineEnvironment
  runs: number
  samples_ms: number[]
  duration: DurationStats
  hashes: ScenarioHash[]
  checks: { total: number; passed: number }
  method: BaselineMethod
}

export type Measurement = {
  environment: BaselineEnvironment
  runs: number
  samples_ms: number[]
  duration: DurationStats
  hashes: ScenarioHash[]
  checks: { total: number; passed: number }
}

export type BaselineVerdict = {
  status: "pass" | "fail"
  code: string
  detail: Record<string, unknown>
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median requires at least one sample")
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function computeNoiseBand(samples: number[]): NoiseBand {
  const medianMs = median(samples)
  const madMs = median(samples.map((value) => Math.abs(value - medianMs)))
  const halfWidth = Math.max(
    Math.ceil(NOISE_BAND_MAD_MULTIPLIER * madMs),
    Math.ceil(NOISE_BAND_RELATIVE_FLOOR * medianMs),
    NOISE_BAND_ABSOLUTE_FLOOR_MS,
  )
  return {
    low_ms: Math.max(0, Math.ceil(medianMs - halfWidth)),
    high_ms: Math.ceil(medianMs + halfWidth),
    half_width_ms: halfWidth,
    method: NOISE_BAND_METHOD,
  }
}

export function computeDurationStats(samples: number[]): DurationStats {
  if (samples.length === 0) throw new Error("computeDurationStats requires at least one sample")
  const medianMs = median(samples)
  const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const variance =
    samples.length > 1
      ? samples.reduce((sum, value) => sum + (value - meanMs) ** 2, 0) / (samples.length - 1)
      : 0
  const stdevMs = Math.sqrt(variance)
  const madMs = median(samples.map((value) => Math.abs(value - medianMs)))
  return {
    runs: samples.length,
    samples_ms: [...samples],
    min_ms: Math.min(...samples),
    max_ms: Math.max(...samples),
    median_ms: medianMs,
    mean_ms: round(meanMs, 2),
    stdev_ms: round(stdevMs, 2),
    mad_ms: round(madMs, 2),
    cv: meanMs === 0 ? 0 : round(stdevMs / meanMs, 4),
    noise_band_ms: computeNoiseBand(samples),
  }
}

function fail(code: string, detail: Record<string, unknown>): BaselineVerdict {
  return { status: "fail", code, detail }
}

export function checkAgainstBaseline(baseline: BaselineFile, measurement: Measurement): BaselineVerdict {
  if (baseline.runs < MIN_BASELINE_RUNS) {
    return fail("BASELINE_INVALID", { runs: baseline.runs, required: MIN_BASELINE_RUNS })
  }
  if (
    baseline.environment.runtime !== measurement.environment.runtime ||
    baseline.environment.platform !== measurement.environment.platform
  ) {
    return fail("BASELINE_ENV_MISMATCH", {
      expected: { runtime: baseline.environment.runtime, platform: baseline.environment.platform },
      actual: { runtime: measurement.environment.runtime, platform: measurement.environment.platform },
    })
  }
  if (measurement.runs < MIN_BASELINE_RUNS) {
    return fail("BASELINE_RUNS_INSUFFICIENT", { runs: measurement.runs, required: MIN_BASELINE_RUNS })
  }
  if (measurement.samples_ms.length !== measurement.runs) {
    return fail("BASELINE_SAMPLE_COUNT_MISMATCH", {
      runs: measurement.runs,
      samples: measurement.samples_ms.length,
    })
  }
  if (measurement.checks.total === 0 || measurement.checks.passed !== measurement.checks.total) {
    return fail("BASELINE_CHECKS_FAILED", {
      total: measurement.checks.total,
      passed: measurement.checks.passed,
    })
  }

  const expected = new Map(baseline.hashes.map((item) => [item.scenario, item.sha256]))
  const actual = new Map(measurement.hashes.map((item) => [item.scenario, item.sha256]))
  if (expected.size !== actual.size) {
    return fail("BASELINE_HASH_DRIFT", {
      expected_scenarios: [...expected.keys()],
      actual_scenarios: [...actual.keys()],
    })
  }
  for (const [scenario, hash] of expected) {
    if (actual.get(scenario) === hash) continue
    return fail("BASELINE_HASH_DRIFT", {
      scenario,
      expected: hash,
      actual: actual.get(scenario) ?? null,
    })
  }

  const band = baseline.duration.noise_band_ms
  if (measurement.duration.median_ms > band.high_ms) {
    return fail("BASELINE_DURATION_OUT_OF_BAND", {
      median_ms: measurement.duration.median_ms,
      high_ms: band.high_ms,
    })
  }

  return { status: "pass", code: "BASELINE_OK", detail: {} }
}