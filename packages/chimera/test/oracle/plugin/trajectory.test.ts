import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import {
  HOOK_CLASSES,
  HookTraceError,
  canonicalTraceJson,
  encodeHookTrace,
  parseHookTrace,
  verifyHookTrace,
} from "./trajectory"
import { EVENTS, EXPECTATION, GOLDEN_FILE, HEADER } from "./fixtures/session-trajectory"
import { NEGATIVE_CASES, applyNegativeCase } from "./fixtures/negative-cases"

const goldenPath = path.join(import.meta.dir, "golden", GOLDEN_FILE)
const golden = await Bun.file(goldenPath).text()

function expectCode(body: () => void, code: string): void {
  try {
    body()
  } catch (error) {
    expect(error).toBeInstanceOf(HookTraceError)
    expect((error as HookTraceError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}, but the body did not throw`)
}

describe("WP-09 plugin hook trajectory", () => {
  test("fixture bytes match the committed golden", () => {
    expect(encodeHookTrace(HEADER, EVENTS)).toBe(golden)
  })

  test("golden parses, replays, and re-encodes byte-identically", () => {
    const trace = parseHookTrace(golden)
    expect(trace.header.synthetic).toBe(true)
    expect(trace.header.trajectory).toBe("session-six-hooks")
    expect(trace.events.length).toBe(EVENTS.length)
    expect(encodeHookTrace(trace.header, trace.events.map(({ seq: _seq, ...rest }) => rest))).toBe(golden)
  })

  test("all six hook classes appear in one session", () => {
    const report = verifyHookTrace(parseHookTrace(golden), EXPECTATION)
    const classes = new Set(report.hooks.filter((item) => item.count > 0).map((item) => item.hook_class))
    expect([...classes].sort()).toEqual([...HOOK_CLASSES].sort())
    expect(report.hooks.find((item) => item.hook === "config")?.count).toBe(2)
    expect(report.hooks.find((item) => item.hook === "tool.definition")?.count).toBe(4)
    expect(report.hooks.find((item) => item.hook === "chat.params")?.count).toBe(3)
    expect(report.hooks.find((item) => item.hook === "chat.headers")?.count).toBe(3)
    expect(report.hooks.find((item) => item.hook === "tool.execute.before")?.count).toBe(3)
    expect(report.hooks.find((item) => item.hook === "tool.execute.after")?.count).toBe(2)
    expect(report.hooks.find((item) => item.hook === "auth.loader")?.count).toBe(1)
  })

  test("per-class order follows registration order", () => {
    const report = verifyHookTrace(parseHookTrace(golden), EXPECTATION)
    expect(canonicalTraceJson(report.order)).toBe(canonicalTraceJson(EXPECTATION.order))
    expect(report.plugins.map((item) => item.plugin_id)).toEqual(["builtin.codex-auth", "demo.alpha", "demo.beta"])
    expect(report.plugins.map((item) => item.origin)).toEqual(["internal", "config", "config"])
  })

  test("mutations chain through a shared output object", () => {
    const report = verifyHookTrace(parseHookTrace(golden), EXPECTATION)
    expect(canonicalTraceJson(report.snapshots)).toBe(canonicalTraceJson(EXPECTATION.snapshots))
    expect(report.snapshots["params:op-llm#final"]).toMatchObject({ temperature: 0.5, maxOutputTokens: null })
    expect(report.snapshots["after:call-1#final"]).toMatchObject({ output: "synthetic file contents\n[alpha]" })
  })

  test("auth refresh is lazy, single-flight, and persisted through auth.set", () => {
    const report = verifyHookTrace(parseHookTrace(golden), EXPECTATION)
    expect(report.auth).toEqual({ loader_calls: 1, refresh_calls: 1, single_flight: true })
  })

  test("cancellation exposes exactly one in-flight hook and no after hook", () => {
    const report = verifyHookTrace(parseHookTrace(golden), EXPECTATION)
    expect(report.cancelled).toEqual(["before:call-2"])
  })

  test("failure policy covers every hook with a stable host effect", () => {
    const report = verifyHookTrace(parseHookTrace(golden), EXPECTATION)
    expect(report.failure_policy).toHaveLength(8)
    expect(report.failure_policy.map((item) => item.hook)).toEqual([
      "config",
      "tool.definition",
      "chat.params",
      "chat.headers",
      "tool.execute.before",
      "tool.execute.after",
      "auth.loader",
      "auth.refresh",
    ])
    expect(report.failure_policy.find((item) => item.hook === "config")?.other_plugins).toBe("continue")
    expect(report.failure_policy.find((item) => item.hook === "tool.execute.after")?.other_plugins).toBe("not-run")
  })

  test("golden contains no host paths, URLs, or credentials", () => {
    for (const needle of [os.homedir(), "/Users/", "/home/", "/Volumes/", "file://", "http://", "https://"]) {
      expect(golden.includes(needle)).toBe(false)
    }
  })

  test("every negative fixture is rejected with its stable code", () => {
    const trace = parseHookTrace(golden)
    for (const negative of NEGATIVE_CASES) {
      const mutated = applyNegativeCase(trace, negative)
      if (negative.layer === "integrity") {
        expectCode(() => parseHookTrace(mutated), negative.expected_code)
        continue
      }
      expectCode(() => verifyHookTrace(parseHookTrace(mutated), EXPECTATION), negative.expected_code)
    }
  })
})