// Fault-matrix runner shared by the CLI and the bun meta-test.
//
// For every matrix row it loads the named WP-02 golden, applies the fixture
// injection, and asserts that the comparator rejects with exactly the expected
// code. It also runs the un-injected golden as a positive control.

import { parseTranscript } from "../transcript/format"
import { FAULT_CLASSES, type FaultClass, type RunArtifact } from "./types"
import { compareArtifact, CompareRejection } from "./compare"
import {
  loadFaultFixture,
  loadFaultMatrix,
  type FaultFixture,
  type FaultMatrix,
} from "../faults/matrix"
import { buildInjectedArtifact } from "../faults/inject"

const GOLDEN_DIR = new URL("../transcript/golden/", import.meta.url)

export type MatrixCheck = {
  id: string
  status: "pass" | "fail"
  code: string
  detail?: string
}

export type FaultCheck = {
  id: string
  fault_class: FaultClass | "control"
  base_golden: string
  expected_code: string
  actual_code: string
  status: "pass" | "fail"
  detail?: string
}

export type FaultMatrixReport = {
  matrix: FaultMatrix
  matrix_checks: MatrixCheck[]
  controls: FaultCheck[]
  results: FaultCheck[]
  passed: boolean
}

export async function loadGoldenArtifact(golden: string): Promise<RunArtifact> {
  const file = Bun.file(new URL(golden, GOLDEN_DIR))
  if (!(await file.exists())) throw new Error(`missing WP-02 golden: ${golden}`)
  const transcript = await file.text()
  const parsed = parseTranscript(transcript)
  return {
    envelope: { scenario: parsed.header.scenario, status: "complete" },
    transcript,
  }
}

function errorCode(error: unknown): string {
  if (error instanceof CompareRejection) return error.code
  if (error instanceof Error) return error.name
  return "UNKNOWN"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function check(id: string, code: string, detail?: string): MatrixCheck {
  return { id, status: code === "PASS" ? "pass" : "fail", code, detail }
}

function fixtureMismatch(row: FaultMatrix["classes"][number], fixture: FaultFixture): string | undefined {
  if (fixture.id !== row.id) return `fixture id ${fixture.id} != matrix id ${row.id}`
  if (fixture.fault_class !== row.fault_class) return `fixture class ${fixture.fault_class} != matrix class ${row.fault_class}`
  if (fixture.base_golden !== row.base_golden) return `fixture golden ${fixture.base_golden} != matrix golden ${row.base_golden}`
  if (fixture.expected.code !== row.expected_code) {
    return `fixture code ${fixture.expected.code} != matrix code ${row.expected_code}`
  }
  return undefined
}

function checkMatrixShape(matrix: FaultMatrix): MatrixCheck[] {
  const classes = matrix.classes.map((row) => row.fault_class)
  const missing = FAULT_CLASSES.filter((faultClass) => !classes.includes(faultClass))
  const duplicates = classes.filter((faultClass, index) => classes.indexOf(faultClass) !== index)
  const codes = matrix.classes.map((row) => row.expected_code)
  const duplicateCodes = codes.filter((code, index) => codes.indexOf(code) !== index)
  return [
    check(
      "matrix-coverage",
      missing.length === 0 && duplicates.length === 0 ? "PASS" : "MATRIX_CLASS_COVERAGE",
      missing.length === 0 && duplicates.length === 0
        ? undefined
        : `missing=${missing.join(",") || "-"}; duplicates=${duplicates.join(",") || "-"}`,
    ),
    check(
      "matrix-distinct-verdicts",
      duplicateCodes.length === 0 ? "PASS" : "MATRIX_DUPLICATE_VERDICT",
      duplicateCodes.length === 0 ? undefined : `duplicate codes=${duplicateCodes.join(",")}`,
    ),
  ]
}

export async function runFaultMatrix(options: { matrix?: FaultMatrix } = {}): Promise<FaultMatrixReport> {
  const matrix = options.matrix ?? (await loadFaultMatrix())
  const matrixChecks = checkMatrixShape(matrix)
  const controls = new Map<string, FaultCheck>()
  const results: FaultCheck[] = []

  for (const row of matrix.classes) {
    let fixture: FaultFixture
    try {
      fixture = await loadFaultFixture(row.fixture)
    } catch (error) {
      results.push({
        id: row.id,
        fault_class: row.fault_class,
        base_golden: row.base_golden,
        expected_code: row.expected_code,
        actual_code: "FIXTURE_LOAD_FAILED",
        status: "fail",
        detail: errorMessage(error),
      })
      continue
    }

    const mismatch = fixtureMismatch(row, fixture)
    if (mismatch) {
      results.push({
        id: row.id,
        fault_class: row.fault_class,
        base_golden: row.base_golden,
        expected_code: row.expected_code,
        actual_code: "MATRIX_FIXTURE_MISMATCH",
        status: "fail",
        detail: mismatch,
      })
      continue
    }

    let baseline: RunArtifact
    try {
      baseline = await loadGoldenArtifact(row.base_golden)
    } catch (error) {
      results.push({
        id: row.id,
        fault_class: row.fault_class,
        base_golden: row.base_golden,
        expected_code: row.expected_code,
        actual_code: "GOLDEN_LOAD_FAILED",
        status: "fail",
        detail: errorMessage(error),
      })
      continue
    }
    if (!controls.has(row.base_golden)) {
      try {
        compareArtifact(baseline, baseline)
        controls.set(row.base_golden, {
          id: `control:${row.base_golden}`,
          fault_class: "control",
          base_golden: row.base_golden,
          expected_code: "PASS",
          actual_code: "PASS",
          status: "pass",
        })
      } catch (error) {
        controls.set(row.base_golden, {
          id: `control:${row.base_golden}`,
          fault_class: "control",
          base_golden: row.base_golden,
          expected_code: "PASS",
          actual_code: errorCode(error),
          status: "fail",
          detail: errorMessage(error),
        })
      }
    }

    let candidate: RunArtifact
    try {
      candidate = buildInjectedArtifact(fixture, baseline)
    } catch (error) {
      results.push({
        id: row.id,
        fault_class: row.fault_class,
        base_golden: row.base_golden,
        expected_code: row.expected_code,
        actual_code: "INJECTION_FAILED",
        status: "fail",
        detail: errorMessage(error),
      })
      continue
    }
    try {
      compareArtifact(baseline, candidate)
      results.push({
        id: row.id,
        fault_class: row.fault_class,
        base_golden: row.base_golden,
        expected_code: row.expected_code,
        actual_code: "COMPARATOR_MISSED_FAULT",
        status: "fail",
        detail: "injected candidate passed the comparator",
      })
    } catch (error) {
      const actual = errorCode(error)
      results.push({
        id: row.id,
        fault_class: row.fault_class,
        base_golden: row.base_golden,
        expected_code: row.expected_code,
        actual_code: actual,
        status: actual === row.expected_code ? "pass" : "fail",
        detail: errorMessage(error),
      })
    }
  }

  const passed =
    matrixChecks.every((item) => item.status === "pass") &&
    controls.size > 0 &&
    [...controls.values()].every((item) => item.status === "pass") &&
    results.every((item) => item.status === "pass")

  return {
    matrix,
    matrix_checks: matrixChecks,
    controls: [...controls.values()],
    results,
    passed,
  }
}