import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as fs from "fs/promises"
import { inlinePropagationCheck } from "../../src/chimera/propagation-probe"
import { CodeGraph } from "../../src/graph"
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