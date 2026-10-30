// WP-03 baseline measurement CLI.
//
// Usage (from packages/chimera):
//   bun run test/oracle/baselines/measure.ts --runs 5
//   bun run test/oracle/baselines/measure.ts --runs 5 --write-baseline
//   bun run test/oracle/baselines/measure.ts --runs 5 --check
//
// `--write-baseline` is the only maintenance path for baselines/baseline.json.
// Each invocation performs one untimed warm-up run plus N measured runs; the
// warm-up is included in hash/check stability but excluded from duration
// samples. `--check` compares a fresh same-environment measurement against the
// committed baseline; it is expected to be run on the same machine class as the
// baseline, not as a portable CI performance test.

import {
  CONTRACT_REV,
  canonicalJson,
  sha256,
  utf8ByteLength,
} from "../transcript/format"
import { cleanupSuite, runSuite } from "../transcript/harness"
import {
  checkAgainstBaseline,
  computeDurationStats,
  MIN_BASELINE_RUNS,
  NOISE_BAND_METHOD,
  type BaselineFile,
  type Measurement,
  type ScenarioHash,
} from "./stats"

const args = process.argv.slice(2)

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const runs = Number(valueAfter("--runs") ?? MIN_BASELINE_RUNS)
if (!Number.isSafeInteger(runs) || runs < MIN_BASELINE_RUNS) {
  console.error(`--runs must be an integer >= ${MIN_BASELINE_RUNS}`)
  process.exit(2)
}

const totalRuns = runs + 1
const samples: number[] = []
const hashRuns: ScenarioHash[][] = []
let checksTotal = 0
let checksPassed = 0
let allChecksPassed = true

for (let index = 0; index < totalRuns; index++) {
  const warmup = index === 0
  const started = performance.now()
  const suite = await runSuite()
  const elapsed = Math.round(performance.now() - started)
  if (!warmup) samples.push(elapsed)
  checksTotal = suite.checks.length
  checksPassed = suite.checks.filter((item) => item.status === "pass").length
  if (checksPassed !== checksTotal) allChecksPassed = false
  const hashes = suite.scenarios.map((item) => ({
    scenario: item.scenario.id,
    sha256: sha256(item.armA.text),
    bytes: utf8ByteLength(item.armA.text),
  }))
  hashRuns.push(hashes)
  await cleanupSuite(suite)
  if (!args.includes("--json")) {
    console.log(
      `${warmup ? "warm-up" : `run ${index}/${runs}`}: ${elapsed} ms, checks ${checksPassed}/${checksTotal}, ${hashes
        .map((item) => `${item.scenario}=${item.sha256.slice(0, 12)}`)
        .join(" ")}`,
    )
  }
}

if (samples.length !== runs) {
  console.error(`SAMPLE_COUNT_MISMATCH: collected ${samples.length}, expected ${runs}`)
  process.exit(1)
}

if (!allChecksPassed) {
  console.error(`CHECKS_FAILED: at least one run had failing WP-02 checks (last ${checksPassed}/${checksTotal})`)
  process.exit(1)
}

const first = hashRuns[0]!
for (const [index, hashes] of hashRuns.entries()) {
  if (canonicalJson(hashes) === canonicalJson(first)) continue
  console.error(`HASH_UNSTABLE: run ${index + 1} transcript hashes differ from run 1`)
  process.exit(1)
}

const environment = {
  runtime: `bun ${Bun.version}`,
  platform: `${process.platform}-${process.arch}`,
  note: "受管端点同环境单机重复测量；不含主机名、路径或凭据",
}

const measurement: Measurement = {
  environment,
  runs,
  samples_ms: samples,
  duration: computeDurationStats(samples),
  hashes: first,
  checks: { total: checksTotal, passed: checksPassed },
}

const baseline: BaselineFile = {
  format: "chimera.oracle.baseline",
  version: 1,
  contract_rev: CONTRACT_REV,
  environment,
  runs: measurement.runs,
  samples_ms: measurement.samples_ms,
  duration: measurement.duration,
  hashes: measurement.hashes,
  checks: measurement.checks,
  method: {
    noise_band: `${NOISE_BAND_METHOD}，样本为每次完整 WP-02 suite 的墙钟毫秒（1 次 warm-up 不计入）`,
    hash_stability: "每次运行对每个 scenario 的 transcript 取 sha256；全部运行必须逐 scenario 相同",
    gate: "候选测量 runs≥5、checks 全通过、hashes 与基线一致、duration.median_ms 不高于噪声带上沿（单侧）",
  },
}

if (args.includes("--write-baseline")) {
  await Bun.write(new URL("./baseline.json", import.meta.url), JSON.stringify(baseline, null, 2) + "\n")
  console.log("wrote test/oracle/baselines/baseline.json")
}

if (args.includes("--check")) {
  const existing = (await Bun.file(new URL("./baseline.json", import.meta.url)).json()) as BaselineFile
  const verdict = checkAgainstBaseline(existing, measurement)
  console.log(`baseline check: ${verdict.code}`)
  if (verdict.status === "fail") {
    console.log(JSON.stringify(verdict.detail))
    process.exit(1)
  }
}

if (args.includes("--json")) {
  console.log(JSON.stringify(args.includes("--write-baseline") ? baseline : measurement, null, 2))
}