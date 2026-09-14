import { describe, expect, test } from "bun:test"
import { PROPAGATION_PROBE_TIMEOUT_MS, inlinePropagationCheck, scopeDriftLines } from "../../src/chimera/propagation-probe"
import { Effect, Layer } from "effect"
import path from "path"
import * as fs from "fs/promises"
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
      const line = yield* inlinePropagationCheck([{ file }])
      expect(line).toBe("")
    }),
  )

  it.instance("reports no dependents for an indexed file with no importers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "solo.ts"), "export const solo = 1\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const line = yield* inlinePropagationCheck([{ file: path.join(test.directory, "solo.ts") }])
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
      const line = yield* inlinePropagationCheck([{ file: path.join(test.directory, "lib.ts") }])
      expect(line).toBe("Propagation check: 1 dependent file(s) may be affected: use.ts.")
      expect(line).not.toContain("chimera_audit_recent")
    }),
  )
})

describe("chimera.propagation-probe scope drift lines", () => {
  test("stays silent when targets and propagation are declared", () => {
    expect(scopeDriftLines("predesign_1", ["a.ts", "b.ts"], ["a.ts"], [{ file: "b.ts" }])).toEqual([])
  })

  test("flags undeclared edit targets", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts", "x.ts"], [])
    expect(lines.length).toBe(1)
    expect(lines[0]!).toContain("x.ts")
    expect(lines[0]!).toContain("not declared in predesign_1")
  })

  test("flags propagation leaving the declared scope", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts"], [{ file: "b.ts" }, { file: "c.ts" }])
    expect(lines.length).toBe(1)
    expect(lines[0]!).toContain("propagation reaches b.ts, c.ts")
  })

  test("caps displayed files and counts the overflow", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts"], [{ file: "d1.ts" }, { file: "d2.ts" }, { file: "d3.ts" }, { file: "d4.ts" }, { file: "d5.ts" }, { file: "d6.ts" }, { file: "d7.ts" }])
    expect(lines[0]!).toContain("d1.ts, d2.ts, d3.ts, d4.ts, d5.ts (+2 more)")
  })

  test("annotates second-hop propagation with the intermediate file", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts", "b.ts"], ["a.ts"], [{ file: "b.ts" }, { file: "c.ts", via: "b.ts" }])
    expect(lines.length).toBe(1)
    expect(lines[0]!).toContain("propagation reaches c.ts (via b.ts)")
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

      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "lib.ts") }], SessionID.make("ses_scope-drift"))

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

      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "lib.ts") }], SessionID.make("ses_scope-clean"))

      expect(out).toBe("Propagation check: 1 dependent file(s) may be affected: use.ts.")
    }),
  )

  it.instance("names second-hop dependents through a declared pass-through file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "a.ts"), "export const helperA = 1\n"))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "b.ts"), 'import { helperA } from "./a.ts"\nexport function helperB() { return helperA }\n'),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "c.ts"), 'import { helperB } from "./b.ts"\nconsole.log(helperB())\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_scope-twohop",
          messageID: "msg_scope-twohop",
          agent: "build",
          intent: "two-hop scope test",
          files: ["a.ts", "b.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )

      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "a.ts") }], SessionID.make("ses_scope-twohop"))

      expect(out).toContain("Scope check: propagation reaches c.ts (via b.ts, 2 hops)")
    }),
  )
})

describe("chimera.propagation-probe transitive walk", () => {
  test("ranks deep consumers first and warns about hardcoded stale contracts", () => {
    const lines = scopeDriftLines(
      "predesign_1",
      ["a.ts"],
      ["a.ts"],
      [
        { file: "near.ts" },
        { file: "deep.ts", via: "mid.ts", depth: 3 },
        { file: "mid.ts", via: "near.ts", depth: 2 },
      ],
    )
    expect(lines.length).toBe(1)
    expect(lines[0]!).toContain("propagation reaches deep.ts (via mid.ts, 3 hops), mid.ts (via near.ts, 2 hops), near.ts")
    expect(lines[0]!).toContain("hardcode the old contract")
    expect(lines[0]!).toContain("up to 3 hops away")
    expect(lines[0]!).toContain("clean-looking imports do not prove safety")
  })

  it.instance("names consumers beyond two hops through pass-through chains", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "a.ts"), "export const helperA = 1\n"))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "b.ts"), 'import { helperA } from "./a.ts"\nexport function helperB() { return helperA }\n'),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "c.ts"), 'import { helperB } from "./b.ts"\nexport function helperC() { return helperB() }\n'),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "d.ts"), 'import { helperC } from "./c.ts"\nconsole.log(helperC())\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_scope-deep",
          messageID: "msg_scope-deep",
          agent: "build",
          intent: "deep walk test",
          files: ["a.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )

      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "a.ts") }], SessionID.make("ses_scope-deep"))

      expect(out).toContain("d.ts (via c.ts, 3 hops)")
      expect(out).toContain("hardcode the old contract")
    }),
  )

  it.instance("terminates on dependency cycles and names each file once", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "a.ts"), 'export const helperA = 1\nimport { helperC } from "./c.ts"\nconsole.log(helperC)\n'),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "b.ts"), 'import { helperA } from "./a.ts"\nexport const helperB = helperA\n'),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "c.ts"), 'import { helperB } from "./b.ts"\nexport const helperC = helperB\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_scope-cycle",
          messageID: "msg_scope-cycle",
          agent: "build",
          intent: "cycle walk test",
          files: ["a.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )

      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "a.ts") }], SessionID.make("ses_scope-cycle"))

      // The walk visits b then c, the cycle back to the seed terminates it,
      // and deep-first ranking puts c (2 hops) before b (1 hop).
      expect(out).toContain("propagation reaches c.ts (via b.ts, 2 hops), b.ts, outside")
    }),
  )

  it.instance("stops the walk at large files instead of expanding their consumers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "a.ts"), "export const helperA = 1\n"))
      const filler = Array.from({ length: 45 }, (_, index) => `export const fill${index} = ${index}`).join("\n")
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "big.ts"), `import { helperA } from "./a.ts"\nexport const seeded = helperA\n${filler}\n`),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "hidden.ts"), 'import { seeded } from "./big.ts"\nconsole.log(seeded)\n'),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_scope-bigstop",
          messageID: "msg_scope-bigstop",
          agent: "build",
          intent: "big-file stop test",
          files: ["a.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )

      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "a.ts") }], SessionID.make("ses_scope-bigstop"))

      expect(out).toContain("big.ts")
      expect(out).not.toContain("hidden.ts")
    }),
  )

describe("chimera.propagation-probe symbol-level seeds", () => {
  const noiseFixture = (directory: string) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "lib.ts"), "export const helper = 1\nexport const unused = 2\n"),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "use.ts"),
          'import { helper } from "./lib.ts"\nexport function consumer() { return helper }\n',
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "noise.ts"),
          'import { unused } from "./lib.ts"\nconsole.log(unused)\n',
        ),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(directory, { index: true }))
      graph.close()
    })
  const recordScope = (directory: string, sessionID: string, files: string[], seedNodes: unknown[]) =>
    Effect.promise(() =>
      recordPredesignRun(directory, path.join(getGraphDataRootInfo(directory).dataRoot, "chimera", "predesign-runs.jsonl"), {
        sessionID,
        messageID: `msg_${sessionID}`,
        agent: "build",
        intent: "symbol seed test",
        files,
        seedNodes,
        impactedNodes: [],
        fileDependents: [],
        evidence: [],
        snapshotRevision: "test-revision",
        payload: {},
      }),
    )

  it.instance("names consumer symbols for ranged targets and skips files that import only untouched symbols", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* noiseFixture(test.directory)
      const line = yield* inlinePropagationCheck([{ file: path.join(test.directory, "lib.ts"), ranges: [{ startLine: 1, endLine: 1 }] }])
      expect(line).toContain("consumer (use.ts:2)")
      expect(line).not.toContain("noise.ts")
    }),
  )

  it.instance("falls back to file-level naming when ranges resolve no symbols (apply_patch / unresolvable hunks)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* noiseFixture(test.directory)
      const line = yield* inlinePropagationCheck([{ file: path.join(test.directory, "lib.ts"), ranges: [{ startLine: 99, endLine: 99 }] }])
      expect(line).toContain("use.ts")
      expect(line).toContain("noise.ts")
      expect(line).not.toMatch(/\((use|noise)\.ts:/)
    }),
  )

  it.instance("renders the walk intermediate as symbol@file for symbol-level propagation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "a.ts"), "export const helperA = 1\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "b.ts"),
          'import { helperA } from "./a.ts"\nexport function helperB() { return helperA }\n',
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "c.ts"),
          'import { helperB } from "./b.ts"\nexport function helperC() { return helperB() }\n',
        ),
      )
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      yield* recordScope(test.directory, "ses_symbol-via", ["a.ts"], [])
      const out = yield* inlinePropagationCheck(
        [{ file: path.join(test.directory, "a.ts"), ranges: [{ startLine: 1, endLine: 1 }] }],
        SessionID.make("ses_symbol-via"),
      )
      expect(out).toContain("helperC (c.ts:2) (via helperB@b.ts, 2 hops)")
      expect(out).toContain("helperB (b.ts:2)")
    }),
  )

  it.instance("re-seeds a range-less target from the predesign's persisted seedNodes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* noiseFixture(test.directory)
      yield* recordScope(test.directory, "ses_seednodes", ["lib.ts"], [
        { payload: { filePath: "lib.ts", range: { startLine: 1, endLine: 1 } } },
      ])
      const out = yield* inlinePropagationCheck([{ file: path.join(test.directory, "lib.ts") }], SessionID.make("ses_seednodes"))
      // seedNodes carry the touched-symbol fact: noise.ts (imports only
      // `unused`) must not be named, and the consumer is named symbol-first.
      expect(out).toContain("1 dependent file(s)")
      expect(out).toContain("consumer (use.ts:2)")
      expect(out).not.toContain("noise.ts")
    }),
  )

  test("keeps the 500ms budget constant", () => {
    expect(PROPAGATION_PROBE_TIMEOUT_MS).toBe(500)
  })

  test("renders merged symbol lists for one dependent file", () => {
    const lines = scopeDriftLines("predesign_1", ["a.ts"], ["a.ts"], [
      { file: "b.ts", symbols: ["topUse", "init"], line: 3, via: "helper@a.ts", depth: 2 },
      { file: "c.ts" },
    ])
    expect(lines[0]).toContain("propagation reaches topUse init (b.ts:3) (via helper@a.ts, 2 hops), c.ts")
  })
})

})