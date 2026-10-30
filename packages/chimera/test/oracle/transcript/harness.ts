// Dual-arm harness for WP-02.
//
// One scenario is recorded twice into two isolated directories, each with its
// own sqlite database file. The two transcript files are compared byte for
// byte, then checked against a committed golden, replayed, and finally probed
// with every negative fixture that targets the scenario.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  canonicalJson,
  parseTranscript,
  TranscriptFormatError,
  type Transcript,
} from "./format"
import { recordScenario, type ArmResult } from "./record"
import { checkCausality, checkDeterminism, OracleCheckError, verifyReplay, type ReplayState } from "./verify"
import type { Scenario } from "./scenario"
import { SCENARIOS } from "./fixtures/scenarios"
import { applyNegativeCase, NEGATIVE_CASES, type NegativeCase } from "./fixtures/negative-cases"

export type CheckResult = {
  id: string
  scenario: string
  layer: string
  kind: "dual-arm" | "golden" | "causality" | "replay" | "negative"
  status: "pass" | "fail"
  code: string
  detail?: string
}

export type ScenarioResult = {
  scenario: Scenario
  rootDir: string
  armA: ArmResult
  armB: ArmResult
  goldenText: string
  replay?: ReplayState
  checks: CheckResult[]
}

export type SuiteResult = {
  rootDir: string
  scenarios: ScenarioResult[]
  checks: CheckResult[]
  passed: boolean
}

export function goldenPathFor(scenario: Scenario): string {
  return path.join(import.meta.dir, "golden", scenario.golden)
}

function errorCode(error: unknown): string {
  if (error instanceof OracleCheckError) return error.code
  if (error instanceof TranscriptFormatError) return error.code
  if (error instanceof Error) return error.name
  return "UNKNOWN"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function check(
  checks: CheckResult[],
  scenario: Scenario,
  id: string,
  kind: CheckResult["kind"],
  code: string,
  detail?: string,
): void {
  checks.push({
    id,
    scenario: scenario.id,
    layer: scenario.layer,
    kind,
    status: code === "PASS" ? "pass" : "fail",
    code,
    detail,
  })
}

async function runCheck(
  checks: CheckResult[],
  scenario: Scenario,
  id: string,
  kind: CheckResult["kind"],
  body: () => void | Promise<void>,
): Promise<void> {
  try {
    await body()
    check(checks, scenario, id, kind, "PASS")
  } catch (error) {
    check(checks, scenario, id, kind, errorCode(error), errorMessage(error))
  }
}

async function readGolden(scenario: Scenario): Promise<string | undefined> {
  const file = Bun.file(goldenPathFor(scenario))
  if (!(await file.exists())) return undefined
  return file.text()
}

function assertArmIsolation(rootDir: string, armA: ArmResult, armB: ArmResult): void {
  if (armA.dir === armB.dir) throw new OracleCheckError("ARM_DIR_NOT_ISOLATED", "both arms share one directory")
  if (armA.dbPath === armB.dbPath) throw new OracleCheckError("ARM_DB_NOT_ISOLATED", "both arms share one database")
  for (const value of [rootDir, os.homedir()]) {
    if (value.length > 1 && armA.text.includes(value)) {
      throw new OracleCheckError("ARM_PATH_LEAK", "transcript contains an absolute host path")
    }
  }
  if (armA.text.includes("file://")) {
    throw new OracleCheckError("ARM_PATH_LEAK", "transcript contains a file URL")
  }
}

function expectedRejection(
  negative: NegativeCase,
  baseText: string,
  transcript: Transcript,
): { actual: string } {
  const mutated = applyNegativeCase(transcript, negative)
  if (negative.layer === "determinism") {
    try {
      checkDeterminism(baseText, mutated.text, negative.id)
    } catch (error) {
      return { actual: errorCode(error) }
    }
    throw new OracleCheckError("NEGATIVE_NOT_REJECTED", `${negative.id} passed the determinism layer`)
  }
  if (negative.layer === "causality") {
    const parsed = parseTranscript(mutated.text)
    try {
      checkCausality(parsed)
    } catch (error) {
      return { actual: errorCode(error) }
    }
    throw new OracleCheckError("NEGATIVE_NOT_REJECTED", `${negative.id} passed the causality layer`)
  }
  try {
    parseTranscript(mutated.text)
  } catch (error) {
    return { actual: errorCode(error) }
  }
  throw new OracleCheckError("NEGATIVE_NOT_REJECTED", `${negative.id} passed the integrity layer`)
}

export async function runScenarioDualArm(
  scenario: Scenario,
  options: { rootDir?: string } = {},
): Promise<ScenarioResult> {
  const rootDir = options.rootDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "chimera-oracle-transcript-")))
  await fs.mkdir(rootDir, { recursive: true })

  const armA = await recordScenario(scenario, path.join(rootDir, "arm-a"))
  const armB = await recordScenario(scenario, path.join(rootDir, "arm-b"))
  const fileA = path.join(armA.dir, "transcript.jsonl")
  const fileB = path.join(armB.dir, "transcript.jsonl")
  await Bun.write(fileA, armA.text)
  await Bun.write(fileB, armB.text)
  const writtenA = await Bun.file(fileA).text()
  const writtenB = await Bun.file(fileB).text()

  const checks: CheckResult[] = []

  await runCheck(checks, scenario, "dual-arm-zero-diff", "dual-arm", () => {
    checkDeterminism(armA.text, armB.text, `${scenario.id}:arm-a-vs-arm-b`)
    checkDeterminism(armA.text, writtenA, `${scenario.id}:memory-vs-file-a`)
    checkDeterminism(writtenA, writtenB, `${scenario.id}:file-a-vs-file-b`)
  })

  await runCheck(checks, scenario, "arm-isolation", "dual-arm", async () => {
    assertArmIsolation(rootDir, armA, armB)
    if (!(await Bun.file(armA.dbPath).exists())) {
      throw new OracleCheckError("ARM_DB_MISSING", "arm-a database file is missing")
    }
    if (!(await Bun.file(armB.dbPath).exists())) {
      throw new OracleCheckError("ARM_DB_MISSING", "arm-b database file is missing")
    }
  })

  const goldenText = await readGolden(scenario)
  if (!goldenText) {
    check(checks, scenario, "golden-present", "golden", "GOLDEN_MISSING", `missing golden/${scenario.golden}`)
  } else {
    await runCheck(checks, scenario, "golden-match", "golden", () => {
      checkDeterminism(goldenText, armA.text, `${scenario.id}:golden`)
    })
    await runCheck(checks, scenario, "golden-causality", "causality", () => {
      checkCausality(parseTranscript(goldenText))
    })
    await runCheck(checks, scenario, "golden-replay", "replay", () => {
      verifyReplay(parseTranscript(goldenText))
    })
  }

  let replay: ReplayState | undefined
  await runCheck(checks, scenario, "arm-causality", "causality", () => {
    checkCausality(armA.transcript)
  })
  await runCheck(checks, scenario, "arm-replay", "replay", () => {
    replay = verifyReplay(armA.transcript)
  })

  for (const negative of NEGATIVE_CASES.filter((item) => item.base === scenario.id)) {
    await runCheck(checks, scenario, `negative:${negative.id}`, "negative", () => {
      const { actual } = expectedRejection(negative, armA.text, armA.transcript)
      if (actual !== negative.expected_code) {
        throw new OracleCheckError(
          "NEGATIVE_WRONG_CODE",
          `${negative.id}: expected ${negative.expected_code}, got ${actual}`,
        )
      }
    })
  }

  return {
    scenario,
    rootDir,
    armA,
    armB,
    goldenText: goldenText ?? "",
    replay,
    checks,
  }
}

export async function runSuite(options: { outDir?: string } = {}): Promise<SuiteResult> {
  const rootDir = options.outDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "chimera-oracle-transcript-suite-")))
  await fs.mkdir(rootDir, { recursive: true })

  const scenarios: ScenarioResult[] = []
  for (const scenario of SCENARIOS) {
    scenarios.push(await runScenarioDualArm(scenario, { rootDir: path.join(rootDir, scenario.id) }))
  }

  const checks = scenarios.flatMap((scenario) => scenario.checks)
  const passed = checks.every((item) => item.status === "pass")
  await Bun.write(
    path.join(rootDir, "summary.json"),
    canonicalJson({
      contract_rev: "cr-2026-10-30-r1",
      passed,
      checks: checks.map((item) => ({
        id: item.id,
        scenario: item.scenario,
        layer: item.layer,
        kind: item.kind,
        status: item.status,
        code: item.code,
      })),
    }) + "\n",
  )

  return { rootDir, scenarios, checks, passed }
}

export async function cleanupSuite(suite: SuiteResult): Promise<void> {
  await fs.rm(suite.rootDir, { recursive: true, force: true })
}

export async function writeGoldens(): Promise<{ scenario: string; path: string; eventCount: number }[]> {
  const written: { scenario: string; path: string; eventCount: number }[] = []
  for (const scenario of SCENARIOS) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "chimera-oracle-transcript-golden-"))
    const arm = await recordScenario(scenario, path.join(rootDir, "arm"))
    const target = goldenPathFor(scenario)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Bun.write(target, arm.text)
    written.push({ scenario: scenario.id, path: target, eventCount: arm.eventCount })
    await fs.rm(rootDir, { recursive: true, force: true })
  }
  return written
}