// Machine-readable WP-03 fault matrix and fixture loader.
//
// The matrix is the contract: every fault class names exactly one committed
// fixture, the base WP-02 golden, the injection shape, and the expected
// comparator verdict. Fixtures are plain JSON so a Rust test runner can consume
// the same files without importing this implementation.

import { CONTRACT_REV, isRecord } from "../transcript/format"
import { FAULT_CLASSES, RUN_STATUSES, type FaultClass, type RunStatus } from "../compare/types"

export const FAULT_MATRIX_FORMAT = "chimera.oracle.fault-matrix" as const
export const FAULT_MATRIX_VERSION = 1 as const

export type InjectionOp =
  | { op: "drop-event"; kind: string; ordinal: number }
  | { op: "swap-events"; kind: string; ordinals: [number, number] }
  | { op: "duplicate-event"; kind: string; ordinal: number }
  | { op: "truncate-events"; keep: number }
  | { op: "remove-snapshot-row"; table: string; id: number }
  | { op: "set-tool-output"; call_id: string; output: Record<string, unknown> }
  | { op: "insert-cancel-event"; at: number; reason: string }

export type FaultFixture = {
  id: string
  fault_class: FaultClass
  label_zh: string
  base_golden: string
  description: string
  envelope_status: RunStatus
  injections: InjectionOp[]
  expected: {
    status: "fail"
    code: string
  }
}

export type FaultMatrixRow = {
  id: string
  fault_class: FaultClass
  label_zh: string
  fixture: string
  base_golden: string
  injection: string
  expected_code: string
  detection: string
}

export type FaultMatrix = {
  format: typeof FAULT_MATRIX_FORMAT
  version: typeof FAULT_MATRIX_VERSION
  contract_rev: string
  classes: FaultMatrixRow[]
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`fault matrix: ${label} must be an object`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fault matrix: ${label} must be a non-empty string`)
  }
  return value
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`fault matrix: ${label} must be an integer >= ${minimum}`)
  }
  return value
}

function parseInjectionOp(value: unknown, index: number): InjectionOp {
  const op = requireRecord(value, `injections[${index}]`)
  const name = requireString(op.op, `injections[${index}].op`)
  switch (name) {
    case "drop-event":
    case "duplicate-event":
      return {
        op: name,
        kind: requireString(op.kind, `injections[${index}].kind`),
        ordinal: requireInteger(op.ordinal, `injections[${index}].ordinal`, 1),
      }
    case "swap-events": {
      if (!Array.isArray(op.ordinals) || op.ordinals.length !== 2) {
        throw new Error(`fault matrix: injections[${index}].ordinals must contain exactly two ordinals`)
      }
      return {
        op: "swap-events",
        kind: requireString(op.kind, `injections[${index}].kind`),
        ordinals: [
          requireInteger(op.ordinals[0], `injections[${index}].ordinals[0]`, 1),
          requireInteger(op.ordinals[1], `injections[${index}].ordinals[1]`, 1),
        ],
      }
    }
    case "truncate-events":
      return { op: "truncate-events", keep: requireInteger(op.keep, `injections[${index}].keep`, 0) }
    case "remove-snapshot-row":
      return {
        op: "remove-snapshot-row",
        table: requireString(op.table, `injections[${index}].table`),
        id: requireInteger(op.id, `injections[${index}].id`, 0),
      }
    case "set-tool-output":
      return {
        op: "set-tool-output",
        call_id: requireString(op.call_id, `injections[${index}].call_id`),
        output: requireRecord(op.output, `injections[${index}].output`),
      }
    case "insert-cancel-event":
      return {
        op: "insert-cancel-event",
        at: requireInteger(op.at, `injections[${index}].at`, 1),
        reason: requireString(op.reason, `injections[${index}].reason`),
      }
    default:
      throw new Error(`fault matrix: injections[${index}].op ${name} is not supported`)
  }
}

export function parseFaultFixture(value: unknown): FaultFixture {
  const fixture = requireRecord(value, "fixture")
  const faultClass = requireString(fixture.fault_class, "fixture.fault_class")
  if (!FAULT_CLASSES.includes(faultClass as FaultClass)) {
    throw new Error(`fault matrix: unknown fault_class ${faultClass}`)
  }
  const status = requireString(fixture.envelope_status, "fixture.envelope_status")
  if (!RUN_STATUSES.includes(status as RunStatus)) {
    throw new Error(`fault matrix: unknown envelope_status ${status}`)
  }
  if (!Array.isArray(fixture.injections)) {
    throw new Error("fault matrix: fixture.injections must be an array")
  }
  const expected = requireRecord(fixture.expected, "fixture.expected")
  if (expected.status !== "fail") {
    throw new Error("fault matrix: fixture.expected.status must be \"fail\"")
  }
  return {
    id: requireString(fixture.id, "fixture.id"),
    fault_class: faultClass as FaultClass,
    label_zh: requireString(fixture.label_zh, "fixture.label_zh"),
    base_golden: requireString(fixture.base_golden, "fixture.base_golden"),
    description: requireString(fixture.description, "fixture.description"),
    envelope_status: status as RunStatus,
    injections: fixture.injections.map(parseInjectionOp),
    expected: {
      status: "fail",
      code: requireString(expected.code, "fixture.expected.code"),
    },
  }
}

function parseMatrixRow(value: unknown, index: number): FaultMatrixRow {
  const row = requireRecord(value, `classes[${index}]`)
  const faultClass = requireString(row.fault_class, `classes[${index}].fault_class`)
  if (!FAULT_CLASSES.includes(faultClass as FaultClass)) {
    throw new Error(`fault matrix: classes[${index}].fault_class ${faultClass} is unknown`)
  }
  return {
    id: requireString(row.id, `classes[${index}].id`),
    fault_class: faultClass as FaultClass,
    label_zh: requireString(row.label_zh, `classes[${index}].label_zh`),
    fixture: requireString(row.fixture, `classes[${index}].fixture`),
    base_golden: requireString(row.base_golden, `classes[${index}].base_golden`),
    injection: requireString(row.injection, `classes[${index}].injection`),
    expected_code: requireString(row.expected_code, `classes[${index}].expected_code`),
    detection: requireString(row.detection, `classes[${index}].detection`),
  }
}

export function parseFaultMatrix(value: unknown): FaultMatrix {
  const matrix = requireRecord(value, "matrix")
  if (matrix.format !== FAULT_MATRIX_FORMAT) {
    throw new Error(`fault matrix: format must be ${FAULT_MATRIX_FORMAT}`)
  }
  if (matrix.version !== FAULT_MATRIX_VERSION) {
    throw new Error(`fault matrix: version must be ${FAULT_MATRIX_VERSION}`)
  }
  if (!Array.isArray(matrix.classes)) throw new Error("fault matrix: classes must be an array")
  if (matrix.contract_rev !== CONTRACT_REV) {
    throw new Error(`fault matrix: contract_rev must be ${CONTRACT_REV}`)
  }
  return {
    format: FAULT_MATRIX_FORMAT,
    version: FAULT_MATRIX_VERSION,
    contract_rev: requireString(matrix.contract_rev, "matrix.contract_rev"),
    classes: matrix.classes.map(parseMatrixRow),
  }
}

export async function loadFaultMatrix(url = new URL("./matrix.json", import.meta.url)): Promise<FaultMatrix> {
  return parseFaultMatrix(await Bun.file(url).json())
}

export async function loadFaultFixture(relativePath: string): Promise<FaultFixture> {
  return parseFaultFixture(await Bun.file(new URL(relativePath, import.meta.url)).json())
}