import { describe, expect, test } from "bun:test"
import { parseTranscript } from "../transcript/format"
import { loadFaultFixture, loadFaultMatrix } from "../faults/matrix"
import { buildInjectedArtifact } from "../faults/inject"
import { compareArtifact, CompareRejection } from "./compare"
import { loadGoldenArtifact, runFaultMatrix } from "./suite"
import { FAULT_CLASSES, type RunArtifact } from "./types"

const matrix = await loadFaultMatrix()
const cases = await Promise.all(
  matrix.classes.map(async (row) => {
    const fixture = await loadFaultFixture(row.fixture)
    const baseline = await loadGoldenArtifact(row.base_golden)
    return { row, fixture, baseline }
  }),
)

const goldens = new Map<string, RunArtifact>()
for (const item of cases) goldens.set(item.row.base_golden, item.baseline)

function rejectionCode(run: () => void): string {
  try {
    run()
    return "PASS"
  } catch (error) {
    if (error instanceof CompareRejection) return error.code
    if (error instanceof Error) return error.name
    return "UNKNOWN"
  }
}

describe("fault matrix shape", () => {
  test("covers the eight fault classes exactly once", () => {
    expect(matrix.classes.map((row) => row.fault_class)).toEqual([...FAULT_CLASSES])
  })

  test("uses a distinct expected verdict per class", () => {
    const codes = matrix.classes.map((row) => row.expected_code)
    expect(new Set(codes).size).toBe(FAULT_CLASSES.length)
  })

  test("every fixture agrees with its matrix row", () => {
    for (const { row, fixture } of cases) {
      expect(fixture.id).toBe(row.id)
      expect(fixture.fault_class).toBe(row.fault_class)
      expect(fixture.base_golden).toBe(row.base_golden)
      expect(fixture.expected.code).toBe(row.expected_code)
    }
  })
})

describe("comparator meta-test: injected fixtures must fail", () => {
  for (const { row, fixture, baseline } of cases) {
    test(`${row.fault_class}: ${row.id} is rejected with ${row.expected_code}`, () => {
      const candidate = buildInjectedArtifact(fixture, baseline)
      expect(() => parseTranscript(candidate.transcript)).not.toThrow()
      expect(rejectionCode(() => compareArtifact(baseline, candidate))).toBe(row.expected_code)
    })
  }
})

describe("comparator positive controls: un-injected goldens must pass", () => {
  for (const [golden, baseline] of goldens) {
    test(`${golden} passes against itself`, () => {
      const result = compareArtifact(baseline, baseline)
      expect(result.status).toBe("pass")
      expect(result.checks.every((check) => check.status === "pass")).toBe(true)
    })
  }
})

describe("comparator secondary rejections", () => {
  test("malformed candidate transcript is rejected as FAULT_INTEGRITY", () => {
    const baseline = goldens.get("determinism.jsonl")!
    const candidate = { ...baseline, transcript: "not-json\n" }
    expect(rejectionCode(() => compareArtifact(baseline, candidate))).toBe("FAULT_INTEGRITY")
  })

  test("non-complete baseline is rejected as COMPARE_BASELINE_NOT_COMPLETE", () => {
    const baseline = goldens.get("determinism.jsonl")!
    const interrupted = {
      ...baseline,
      envelope: { ...baseline.envelope, status: "interrupted" as const },
    }
    expect(rejectionCode(() => compareArtifact(interrupted, baseline))).toBe("COMPARE_BASELINE_NOT_COMPLETE")
  })
})

describe("transcript-level terminal evidence", () => {
  test("timeout fixture leaves an in-flight tool call without a result", () => {
    const item = cases.find((entry) => entry.row.fault_class === "timeout")!
    const candidate = buildInjectedArtifact(item.fixture, item.baseline)
    const parsed = parseTranscript(candidate.transcript)
    const calls = parsed.events.flatMap((event) => (event.kind === "tool.call" ? [event.call_id] : []))
    const results = new Set(
      parsed.events.flatMap((event) => (event.kind === "tool.result" ? [event.call_id] : [])),
    )
    expect(candidate.envelope.status).toBe("timed_out")
    expect(calls.filter((callID) => !results.has(callID))).toEqual(["call-0001"])
  })

  test("cancel fixture keeps events after the cancel marker and is rejected without the envelope", () => {
    const item = cases.find((entry) => entry.row.fault_class === "cancel")!
    const candidate = buildInjectedArtifact(item.fixture, item.baseline)
    const parsed = parseTranscript(candidate.transcript)
    const cancelIndex = parsed.events.findIndex(
      (event) => event.kind === "sse.event" && event.stream_id === "control" && event.event === "cancel",
    )
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(parsed.events.length - cancelIndex - 1).toBeGreaterThan(0)
    const complete = { ...candidate, envelope: { ...candidate.envelope, status: "complete" as const } }
    expect(rejectionCode(() => compareArtifact(item.baseline, complete))).toBe("FAULT_CANCEL")
  })
})

describe("fault matrix report", () => {
  test("full report passes with the committed matrix", async () => {
    const report = await runFaultMatrix({ matrix })
    const failures = [...report.matrix_checks, ...report.controls, ...report.results].filter(
      (item) => item.status === "fail",
    )
    expect(failures).toEqual([])
    expect(report.passed).toBe(true)
  })
})