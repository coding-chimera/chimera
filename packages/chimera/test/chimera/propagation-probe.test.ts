import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as fs from "fs/promises"
import { inlinePropagationCheck, scopeDriftLines } from "../../src/chimera/propagation-probe"
import { recordPredesignRun } from "../../src/chimera/store"
import { SessionID } from "../../src/session/schema"
import { CodeGraph, getGraphDataRootInfo } from "../../src/graph"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(Layer.empty)

describe("chimera.propagation-probe", () => {
  it.instance("degrades silently when the graph is not initialized", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "file.ts")
      yield* Effect.promise(() => fs.writeFile(file, "export const value = 1\n"))
      const line = yield* inlinePropagationCheck([file])
      expect(line).toBe("")
    }),
  )

  it.instance("reports no dependents for an indexed file with no importers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "solo.ts"), "export const solo = 1\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const line = yield* inlinePropagationCheck([path.join(test.directory, "solo.ts")])
      expect(line).toBe("Propagation check: no dependents found for the changed file(s).")
      expect(line).not.toContain("chimera_audit_recent")
    }),
  )

  it.instance("lists dependent files for an indexed file with an importer", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "lib.ts"), "export const helper = 1\n"))
      yield* Effect.promise(() =>
          fs.writeFile(path.join(test.directory, "use.ts"), 'import { helper } from "./lib.ts"\nconsole.log(helper)\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const line = yield* inlinePropagationCheck([path.join(test.directory, "lib.ts")])
      expect(line).toBe("Propagation check: 1 dependent file(s) may be affected: use.ts.")
      expect(line).not.toContain("chimera_audit_recent")
    }),
  )
})

describe("chimera.propagation-probe scope drift lines", () => {
  test("stays silent when targets and propagation are declared", () => {
    expect(scopeDriftLines("predesign_1", ["a.ts", "b.ts"], ["a.ts"], ["b.ts"])).toEqual([])
  })

  test("flags undeclared edit targets", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts", "x.ts"], [])
    expect(lines.length).toBe(1)
    expect(lines[0]!).toContain("x.ts")
    expect(lines[0]!).toContain("not declared in predesign_1")
  })

  test("flags propagation leaving the declared scope", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts"], ["b.ts", "c.ts"])
    expect(lines.length).toBe(1)
    expect(lines[0]!).toContain("propagation reaches b.ts, c.ts")
  })

  test("caps displayed files and counts the overflow", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts"], ["d1.ts", "d2.ts", "d3.ts", "d4.ts", "d5.ts"])
    expect(lines[0]!).toContain("d1.ts, d2.ts, d3.ts (+2 more)")
  })
})

describe("chimera.propagation-probe predesign scope reconciliation", () => {
  it.instance("appends a scope reminder when propagation leaves the declared scope", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "lib.ts"), "export const helper = 1\n"))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "use.ts"), 'import { helper } from "./lib.ts"\nconsole.log(helper)\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_scope-drift",
          messageID: "msg_scope-drift",
          agent: "build",
          intent: "scope reconciliation drift test",
          files: ["lib.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )

      const out = yield* inlinePropagationCheck([path.join(test.directory, "lib.ts")], SessionID.make("ses_scope-drift"))

      expect(out).toContain("Propagation check: 1 dependent file(s)")
      expect(out).toContain("Scope check: propagation reaches use.ts")
    }),
  )

  it.instance("stays silent when the edit and propagation match the declared scope", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "lib.ts"), "export const helper = 1\n"))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "use.ts"), 'import { helper } from "./lib.ts"\nconsole.log(helper)\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_scope-clean",
          messageID: "msg_scope-clean",
          agent: "build",
          intent: "scope reconciliation clean test",
          files: ["lib.ts", "use.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )

      const out = yield* inlinePropagationCheck([path.join(test.directory, "lib.ts")], SessionID.make("ses_scope-clean"))

      expect(out).toBe("Propagation check: 1 dependent file(s) may be affected: use.ts.")
    }),
  )
})