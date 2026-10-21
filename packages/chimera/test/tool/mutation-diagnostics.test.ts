import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as fs from "fs/promises"
import type * as LSPClient from "@/lsp/client"
import { Ledger } from "@/lsp/ledger"
import { Config } from "@/config/config"
import { SessionID } from "@/contracts/session-ids"
import { renderMutationTail } from "@/tool/mutation-diagnostics"
import { CodeGraph, getGraphDataRootInfo } from "@/graph"
import { recordPredesignRun } from "@/chimera/store"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Ledger.defaultLayer, Config.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const error = (message: string, line = 0): LSPClient.Diagnostic => ({
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
  severity: 1,
  source: "typescript",
  code: "TS2322",
  message,
})

const indexGraph = (directory: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => fs.writeFile(path.join(directory, "lib.ts"), "export const helper = 1\n"))
    yield* Effect.promise(() =>
      fs.writeFile(path.join(directory, "use.ts"), 'import { helper } from "./lib.ts"\nconsole.log(helper)\n'),
    )
    const graph = yield* Effect.promise(() => CodeGraph.init(directory, { index: true }))
    graph.close()
  })

describe("tool.mutation-diagnostics tail", () => {
  it.instance("pushes cross-file fresh errors once when the probe degraded", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ledger = yield* Ledger.Service
      const config = yield* Config.Service
      const sessionID = SessionID.make("ses_mdt-degraded")
      const touched = path.join(test.directory, "src", "touched.ts")
      const other = path.join(test.directory, "src", "other.ts")
      // No graph in this instance: the probe degrades silently, rendered
      // entries are empty, and the cross-file filter falls back to
      // predesign-only (also empty here).
      const tail = (diagnostics: Record<string, readonly LSPClient.Diagnostic[]>) =>
        renderMutationTail({ ledger, config, sessionID,
          files: [{ file: touched, label: "this file" }],
          diagnostics,
        probeTargets: [{ file: touched }], })
      const first = yield* tail({ [other]: [error("cross boom")] })
      expect(first).toContain("LSP errors detected in other files:")
      expect(first).toContain("ERROR [1:1] cross boom")
      const second = yield* tail({ [other]: [error("cross boom", 5)] })
      expect(second).toBe("")
    }),
  )

  it.instance("hangs fresh details under probe entries and keeps them out of the cross-file block", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* indexGraph(test.directory)
      const ledger = yield* Ledger.Service
      const config = yield* Config.Service
      const sessionID = SessionID.make("ses_mdt-inline")
      const lib = path.join(test.directory, "lib.ts")
      const use = path.join(test.directory, "use.ts")
      const bystander = path.join(test.directory, "bystander.ts")
      const tail = (diagnostics: Record<string, readonly LSPClient.Diagnostic[]>) =>
        renderMutationTail({ ledger, config, sessionID,
          files: [{ file: lib, label: "this file" }],
          diagnostics,
        probeTargets: [{ file: lib }], })
      const first = yield* tail({
        [use]: [error("use boom one"), error("use boom two"), error("use boom three"), error("use boom four")],
        [bystander]: [error("bystander boom")],
      })
      // Probe entry list rendering with details indented under the entry.
      expect(first).toContain("Propagation check: 1 dependent file(s) may be affected:")
      expect(first).toContain("- use.ts")
      expect(first).toContain("  \u2937 ERROR [1:1] use boom one")
      expect(first).toContain("  \u2937 +1 more")
      // The probe-covered file never appears in the cross-file block...
      expect(first).toContain("LSP errors detected in other files:")
      expect(first).toContain("bystander boom")
      const otherBlock = first.slice(first.indexOf("LSP errors detected in other files:"))
      expect(otherBlock).not.toContain("use.ts")
      // ...and its details were marked shown: a repeat pushes nothing for it.
      const second = yield* tail({
        [use]: [error("use boom one", 9), error("use boom two", 9), error("use boom three", 9), error("use boom four", 9)],
        [bystander]: [error("bystander boom", 9)],
      })
      expect(second).not.toContain("use boom")
      expect(second).not.toContain("bystander boom")
      expect(second).toContain("Propagation check:")
    }),
  )

  it.instance("filters predesign-declared files out of the cross-file block", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* indexGraph(test.directory)
      const info = getGraphDataRootInfo(test.directory)
      const artifact = path.join(info.dataRoot, "chimera", "predesign-runs.jsonl")
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, artifact, {
          sessionID: "ses_mdt-predesign",
          messageID: "msg_mdt-predesign",
          agent: "build",
          intent: "cross-file predesign filter test",
          files: ["declared.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test-revision",
          payload: {},
        }),
      )
      const ledger = yield* Ledger.Service
      const config = yield* Config.Service
      const sessionID = SessionID.make("ses_mdt-predesign")
      const lib = path.join(test.directory, "lib.ts")
      const declared = path.join(test.directory, "declared.ts")
      const undeclared = path.join(test.directory, "undeclared.ts")
      const output = yield* renderMutationTail({ ledger, config, sessionID,
        files: [{ file: lib, label: "this file" }],
        diagnostics: {
          [declared]: [error("declared boom")],
          [undeclared]: [error("undeclared boom")],
        },
      probeTargets: [{ file: lib }], })
      expect(output).toContain("LSP errors detected in other files:")
      expect(output).toContain("undeclared boom")
      // The predesign Scope check line legitimately names declared.ts; the
      // cross-file block must not carry its diagnostics.
      const otherBlock = output.slice(output.indexOf("LSP errors detected in other files:"))
      expect(otherBlock).not.toContain("/declared.ts")
      expect(output).not.toContain("ERROR [1:1] declared boom")
    }),
  )

  it.instance(
    "keeps own-file rendering and drops both cross-file surfaces when diagnostics.crossFile is false",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ledger = yield* Ledger.Service
        const config = yield* Config.Service
        const sessionID = SessionID.make("ses_mdt-switch")
        const touched = path.join(test.directory, "src", "touched.ts")
        const other = path.join(test.directory, "src", "other.ts")
        const output = yield* renderMutationTail({ ledger, config, sessionID,
          files: [{ file: touched, label: "this file" }],
          diagnostics: {
            [touched]: [error("own boom")],
            [other]: [error("cross boom")],
          },
        probeTargets: [{ file: touched }], })
        expect(output).toContain("LSP errors detected in this file, please fix:")
        expect(output).toContain("ERROR [1:1] own boom")
        expect(output).not.toContain("other files")
        expect(output).not.toContain("cross boom")
      }),
    { config: { diagnostics: { crossFile: false } } },
  )
})
