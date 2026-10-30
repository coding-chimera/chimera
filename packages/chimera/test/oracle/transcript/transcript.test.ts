import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { canonicalJson, parseTranscript, TranscriptFormatError } from "./format"
import { NEGATIVE_CASES, applyNegativeCase } from "./fixtures/negative-cases"
import { cleanupSuite, runSuite, type SuiteResult } from "./harness"
import { checkCausality, checkDeterminism, OracleCheckError, verifyReplay } from "./verify"

let suite: SuiteResult

beforeAll(async () => {
  suite = await runSuite()
})

afterAll(async () => {
  if (suite) await cleanupSuite(suite)
})

describe("dual-arm determinism", () => {
  test("both arms produce byte-identical transcripts in isolated directories", () => {
    const run = suite.scenarios.find((item) => item.scenario.id === "deterministic-four-classes")
    expect(run).toBeDefined()
    if (!run) return

    expect(run.armA.dir).not.toBe(run.armB.dir)
    expect(run.armA.dbPath).not.toBe(run.armB.dbPath)
    expect(run.armA.text).toBe(run.armB.text)
    expect(run.armA.eventCount).toBeGreaterThan(0)
  })

  test("transcript is byte-stable after parse and re-encode", () => {
    const run = suite.scenarios.find((item) => item.scenario.id === "deterministic-four-classes")
    expect(run).toBeDefined()
    if (!run) return

    const parsed = parseTranscript(run.armA.text)
    expect(() => verifyReplay(parsed)).not.toThrow()
    expect(parsed.text).toBe(run.armA.text)
  })

  test("transcript contains no host paths or file URLs", () => {
    for (const run of suite.scenarios) {
      expect(run.armA.text.includes(run.armA.dir)).toBe(false)
      expect(run.armA.text.includes("file://")).toBe(false)
    }
  })
})

describe("golden transcripts", () => {
  test("every scenario has a golden that matches the recorded arm", () => {
    for (const run of suite.scenarios) {
      expect(run.goldenText.length).toBeGreaterThan(0)
      expect(run.goldenText).toBe(run.armA.text)
    }
  })

  test("goldens pass causality and replay checks", () => {
    for (const run of suite.scenarios) {
      const parsed = parseTranscript(run.goldenText)
      expect(() => checkCausality(parsed)).not.toThrow()
      expect(() => verifyReplay(parsed)).not.toThrow()
    }
  })
})

describe("negative fixtures", () => {
  for (const negative of NEGATIVE_CASES) {
    test(`${negative.id} is rejected with ${negative.expected_code}`, () => {
      const run = suite.scenarios.find((item) => item.scenario.id === negative.base)
      expect(run).toBeDefined()
      if (!run) return

      const mutated = applyNegativeCase(run.armA.transcript, negative)

      if (negative.layer === "determinism") {
        expect(() => checkDeterminism(run.armA.text, mutated.text, negative.id)).toThrow(negative.expected_code)
        return
      }

      if (negative.layer === "causality") {
        const parsed = parseTranscript(mutated.text)
        expect(() => checkCausality(parsed)).toThrow(negative.expected_code)
        return
      }

      expect(() => parseTranscript(mutated.text)).toThrow(negative.expected_code)
    })
  }
})

describe("suite closeout", () => {
  test("all harness checks pass", () => {
    const failures = suite.checks.filter((item) => item.status === "fail")
    expect(failures).toEqual([])
  })

  test("error codes are stable classes", () => {
    expect(() => checkDeterminism("a\n", "b\n", "unit")).toThrow(OracleCheckError)
    expect(() => parseTranscript("not-json\n")).toThrow(TranscriptFormatError)
  })
})

describe("canonical JSON contract", () => {
  test("undefined values are rejected instead of silently dropped", () => {
    expect(() => canonicalJson({ kept: 1, dropped: undefined })).toThrow('undefined value at key "dropped"')
    expect(() => canonicalJson({ nested: [{ dropped: undefined }] })).toThrow('undefined value at key "dropped"')
  })
})