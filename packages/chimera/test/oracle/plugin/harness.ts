// WP-09 suite runner: golden bytes, replay, six-class order, mutation chain,
// auth refresh, cancellation, failure policy, privacy, and negative fixtures.
//
// The suite never imports production `src/` code and never executes a plugin.
// It is a contract/fixture oracle, not a recorder.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  HOOK_CLASSES,
  HookTraceError,
  canonicalTraceJson,
  encodeHookTrace,
  parseHookTrace,
  verifyHookTrace,
  type HookTrace,
  type HookTraceReport,
} from "./trajectory"
import { EVENTS, EXPECTATION, GOLDEN_FILE, HEADER } from "./fixtures/session-trajectory"
import { NEGATIVE_CASES, applyNegativeCase, type NegativeCase } from "./fixtures/negative-cases"

export type CheckResult = {
  id: string
  kind: "encode" | "golden" | "parse" | "verify" | "coverage" | "negative" | "privacy"
  status: "pass" | "fail"
  code: string
  detail?: string
}

export type SuiteResult = {
  passed: boolean
  checks: CheckResult[]
  report?: HookTraceReport
  traceText: string
  goldenPath: string
  outDir?: string
}

export function goldenPath(): string {
  return path.join(import.meta.dir, "golden", GOLDEN_FILE)
}

function errorCode(error: unknown): string {
  if (error instanceof HookTraceError) return error.code
  if (error instanceof Error) return error.name
  return "UNKNOWN"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function check(
  checks: CheckResult[],
  id: string,
  kind: CheckResult["kind"],
  body: () => void | Promise<void>,
): Promise<void> {
  try {
    await body()
    checks.push({ id, kind, status: "pass", code: "PASS" })
  } catch (error) {
    checks.push({ id, kind, status: "fail", code: errorCode(error), detail: errorMessage(error) })
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HookTraceError("CHECK_FAILED", message)
}

async function readGolden(): Promise<string> {
  const file = Bun.file(goldenPath())
  if (!(await file.exists())) throw new HookTraceError("GOLDEN_MISSING", `missing ${GOLDEN_FILE}`)
  return file.text()
}

function assertNoSecrets(text: string): void {
  for (const needle of [os.homedir(), "/Users/", "/home/", "/Volumes/", "file://", "http://", "https://"]) {
    if (needle.length > 1 && text.includes(needle)) {
      throw new HookTraceError("PRIVACY_LEAK", `trace contains forbidden fragment ${JSON.stringify(needle)}`)
    }
  }
}

function expectedNegativeCode(negative: NegativeCase, trace: HookTrace): string {
  const mutated = applyNegativeCase(trace, negative)
  if (negative.layer === "integrity") {
    try {
      parseHookTrace(mutated)
    } catch (error) {
      return errorCode(error)
    }
    throw new HookTraceError("NEGATIVE_NOT_REJECTED", `${negative.id} passed the integrity layer`)
  }
  const parsed = parseHookTrace(mutated)
  try {
    verifyHookTrace(parsed, EXPECTATION)
  } catch (error) {
    return errorCode(error)
  }
  throw new HookTraceError("NEGATIVE_NOT_REJECTED", `${negative.id} passed the semantic layer`)
}

export async function runHookTraceSuite(options: { outDir?: string } = {}): Promise<SuiteResult> {
  const checks: CheckResult[] = []
  const encoded = encodeHookTrace(HEADER, EVENTS)
  const golden = await readGolden()
  const trace = parseHookTrace(golden)

  await check(checks, "encode-fixture", "encode", () => {
    assert(encoded.endsWith("\n"), "encoded trace must end with a newline")
    assert(traceByteCount(encoded) > 0, "encoded trace must not be empty")
  })

  await check(checks, "golden-bytes", "golden", () => {
    if (encoded !== golden) {
      throw new HookTraceError(
        "GOLDEN_DIFF",
        `fixture bytes differ from ${GOLDEN_FILE}; run run.ts --write-golden only for intentional fixture changes`,
      )
    }
  })

  await check(checks, "parse-golden", "parse", () => {
    assert(trace.events.length === EVENTS.length, `golden has ${trace.events.length} events, fixture has ${EVENTS.length}`)
  })

  let report: HookTraceReport | undefined
  await check(checks, "verify-trace", "verify", () => {
    report = verifyHookTrace(trace, EXPECTATION)
  })

  await check(checks, "six-class-coverage", "coverage", () => {
    if (!report) throw new HookTraceError("CHECK_FAILED", "verify step did not produce a report")
    const classes = new Set(report.hooks.filter((item) => item.count > 0).map((item) => item.hook_class))
    for (const hookClass of HOOK_CLASSES) {
      assert(classes.has(hookClass), `hook class ${hookClass} has no invocation in the trajectory`)
    }
  })

  await check(checks, "order-matches-expectation", "coverage", () => {
    if (!report) throw new HookTraceError("CHECK_FAILED", "verify step did not produce a report")
    assert(
      canonicalTraceJson(report.order) === canonicalTraceJson(EXPECTATION.order),
      "observed order does not match EXPECTED_ORDER",
    )
  })

  await check(checks, "snapshots-match-expectation", "coverage", () => {
    if (!report) throw new HookTraceError("CHECK_FAILED", "verify step did not produce a report")
    assert(
      canonicalTraceJson(report.snapshots) === canonicalTraceJson(EXPECTATION.snapshots),
      "observed snapshots do not match EXPECTED_SNAPSHOTS",
    )
  })

  await check(checks, "auth-single-flight", "coverage", () => {
    if (!report) throw new HookTraceError("CHECK_FAILED", "verify step did not produce a report")
    assert(report.auth.loader_calls === 1, `expected one auth.loader, got ${report.auth.loader_calls}`)
    assert(report.auth.refresh_calls === 1, `expected one auth.refresh, got ${report.auth.refresh_calls}`)
    assert(report.auth.single_flight, "auth refresh must be single-flight")
  })

  await check(checks, "cancel-observable", "coverage", () => {
    if (!report) throw new HookTraceError("CHECK_FAILED", "verify step did not produce a report")
    assert(report.cancelled.includes("before:call-2"), "cancelled call-2 must expose the in-flight before hook")
  })

  await check(checks, "failure-policy-complete", "coverage", () => {
    if (!report) throw new HookTraceError("CHECK_FAILED", "verify step did not produce a report")
    assert(report.failure_policy.length === 8, `expected 8 policy rows, got ${report.failure_policy.length}`)
  })

  await check(checks, "privacy", "privacy", () => {
    assertNoSecrets(golden)
  })

  for (const negative of NEGATIVE_CASES) {
    await check(checks, `negative:${negative.id}`, "negative", () => {
      const actual = expectedNegativeCode(negative, trace)
      if (actual !== negative.expected_code) {
        throw new HookTraceError(
          "NEGATIVE_WRONG_CODE",
          `${negative.id}: expected ${negative.expected_code}, got ${actual}`,
        )
      }
    })
  }

  const passed = checks.every((item) => item.status === "pass")
  let outDir = options.outDir
  if (outDir) {
    await fs.mkdir(outDir, { recursive: true })
    await Bun.write(
      path.join(outDir, "summary.json"),
      canonicalTraceJson({
        contract_rev: "cr-2026-10-30-r1",
        work_id: "WP-09",
        trajectory: HEADER.trajectory,
        passed,
        checks: checks.map((item) => ({
          id: item.id,
          kind: item.kind,
          status: item.status,
          code: item.code,
        })),
        coverage: report
          ? {
              plugins: report.plugins.map((item) => item.plugin_id),
              hooks: report.hooks.map((item) => ({ hook: item.hook, count: item.count })),
              cancelled: report.cancelled,
              auth: report.auth,
            }
          : null,
      }) + "\n",
    )
  }

  return { passed, checks, report, traceText: golden, goldenPath: goldenPath(), outDir }
}

function traceByteCount(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export async function writeGoldens(): Promise<{ path: string; eventCount: number }> {
  const encoded = encodeHookTrace(HEADER, EVENTS)
  const target = goldenPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, encoded)
  return { path: target, eventCount: EVENTS.length }
}

export async function defaultOutDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "chimera-oracle-plugin-"))
}