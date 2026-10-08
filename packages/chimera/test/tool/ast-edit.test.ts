import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Bus } from "@/bus"
import { Agent } from "@/agent/agent"
import { Chimera } from "@/chimera"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { AstEditTool } from "@/tool/ast_edit"
import { Tool } from "@/tool/tool"
import { isInitialized, type Node as CodeGraphNode } from "@/graph"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-ast-edit-session"),
  messageID: MessageID.make("msg_test-ast-edit-message"),
  callID: "call_ast_edit",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  // The predesign gate would block plain .ts fixtures; this exercises the
  // documented degrade path (model cannot see chimera_predesign -> allowed).
  extra: { chimeraPredesignAvailable: false },
}

const it = testEffect(
  Layer.mergeAll(
    Bus.layer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const FIXTURE = `import { stat } from "fs"

export function alpha() {
  return 1
}

export function beta(value: number) {
  return value + 1
}

export class Holder {
  delta() {
    return 3
  }
}
`

const runAstEdit = Effect.fn("AstEditTest.run")(function* (args: Tool.InferParameters<typeof AstEditTool>) {
  const info = yield* AstEditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const setupFixture = Effect.fn("AstEditTest.setup")(function* (content: string = FIXTURE) {
  const test = yield* TestInstance
  const file = path.join(test.directory, "fixture.ts")
  yield* Effect.promise(() => fs.writeFile(file, content))
  yield* Chimera.initProjectGraph({ watch: false })
  return { directory: test.directory, file }
})

const fileNodes = Effect.fn("AstEditTest.fileNodes")(function* () {
  return yield* Chimera.withProjectGraph(
    { watch: false, sync: false },
    (state) => Effect.sync(() => state.graph.nodesInFile("fixture.ts")),
  )
})

const refOf = (nodes: CodeGraphNode[], kind: string, name: string) => {
  const hit = nodes.find((node) => node.kind === kind && node.name === name)
  if (!hit) throw new Error(`fixture has no ${kind} ${name}: ${nodes.map((node) => `${node.kind}:${node.name}`).join(", ")}`)
  return `node:${hit.id}`
}

const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected ast_edit to fail")
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

const readFixture = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))

describe("tool.ast_edit", () => {
  it.instance("replaces a function node by graph ref and reports fresh refs", () =>
    Effect.gen(function* () {
      const { file } = yield* setupFixture()
      const nodes = yield* fileNodes()
      const alphaRef = refOf(nodes, "function", "alpha")

      const result = yield* runAstEdit({
        file: "fixture.ts",
        edits: [
          {
            ref: alphaRef,
            op: "replace",
            content: "export function alpha(): number {\n  return 42\n}",
          },
        ],
      })

      expect(result.output).toContain("AST edit applied successfully.")
      expect(result.output).toContain("replaced function alpha (now lines 3-5)")
      const content = yield* readFixture(file)
      expect(content).toContain("export function alpha(): number {\n  return 42\n}")
      expect(content).toContain("export function beta(value: number) {")
      const results = (result.metadata.astEdit as { results: Array<{ freshRef?: string; kind: string; name: string }> }).results
      expect(results[0]?.kind).toBe("function")
      expect(results[0]?.name).toBe("alpha")
      expect(results[0]?.freshRef).toMatch(/^node:function:/)

      // The fresh ref chains: a follow-up call edits the same node without relocation.
      const second = yield* runAstEdit({
        file: "fixture.ts",
        edits: [{ ref: results[0]!.freshRef!, op: "replace", content: "export function alpha(): number {\n  return 7\n}" }],
      })
      expect(second.output).toContain("replaced function alpha")
      expect(second.output).not.toContain("relocated")
      expect(yield* readFixture(file)).toContain("return 7")
    }),
  )

  it.instance("deletes a class member and inserts a sibling import line", () =>
    Effect.gen(function* () {
      const { file } = yield* setupFixture()
      const nodes = yield* fileNodes()

      const result = yield* runAstEdit({
        file: "fixture.ts",
        edits: [
          { ref: refOf(nodes, "method", "delta"), op: "delete" },
          { ref: refOf(nodes, "import", "fs"), op: "insert_after", content: 'import { statSync } from "fs"' },
        ],
      })

      expect(result.output).toContain("deleted method delta")
      expect(result.output).toContain("inserted after import fs")
      const content = yield* readFixture(file)
      expect(content).toBe(`import { stat } from "fs"
import { statSync } from "fs"

export function alpha() {
  return 1
}

export function beta(value: number) {
  return value + 1
}

export class Holder {
}
`)
    }),
  )

  it.instance("self-heals a shifted ref after an external edit and reports the relocation", () =>
    Effect.gen(function* () {
      const { file } = yield* setupFixture()
      const nodes = yield* fileNodes()
      const alphaRef = refOf(nodes, "function", "alpha")

      yield* Effect.promise(() => fs.writeFile(file, `// shifted\n// up\n// three\n${FIXTURE}`))

      const result = yield* runAstEdit({
        file: "fixture.ts",
        edits: [{ ref: alphaRef, op: "replace", content: "export function alpha() {\n  return 0\n}" }],
      })

      expect(result.output).toContain("Self-healed refs:")
      expect(result.output).toContain("relocated function alpha")
      expect(result.output).toContain("lines 3-5 -> lines 6-8")
      const content = yield* readFixture(file)
      expect(content.startsWith("// shifted\n// up\n// three\nimport { stat } from \"fs\"")).toBe(true)
      expect(content).toContain("export function alpha() {\n  return 0\n}")
      expect(content).not.toContain("return 1")
    }),
  )

  it.instance("fails a removed symbol with the fresh candidate list inline", () =>
    Effect.gen(function* () {
      const { file } = yield* setupFixture()
      const nodes = yield* fileNodes()
      const alphaRef = refOf(nodes, "function", "alpha")

      yield* Effect.promise(() => fs.writeFile(file, 'import { stat } from "fs"\n\nexport function beta(value: number) {\n  return value + 1\n}\n'))

      const exit = yield* runAstEdit({
        file: "fixture.ts",
        edits: [{ ref: alphaRef, op: "replace", content: "export function alpha() {\n  return 1\n}" }],
      }).pipe(Effect.exit)
      const message = failureMessage(exit)

      expect(message).toContain("does not resolve")
      expect(message).toContain("no function named alpha remains")
      expect(message).toContain("Current function candidates in fixture.ts:")
      expect(message).toContain("beta")
      expect(message).toContain("node:function:")
    }),
  )

  it.instance("rejects overlapping edits", () =>
    Effect.gen(function* () {
      yield* setupFixture()
      const nodes = yield* fileNodes()

      const exit = yield* runAstEdit({
        file: "fixture.ts",
        edits: [
          { ref: refOf(nodes, "class", "Holder"), op: "replace", content: "export class Holder {}" },
          { ref: refOf(nodes, "method", "delta"), op: "delete" },
        ],
      }).pipe(Effect.exit)

      expect(failureMessage(exit)).toContain("overlapping edits are rejected")
    }),
  )

  it.instance("validates op/content pairing before applying", () =>
    Effect.gen(function* () {
      yield* setupFixture()
      const nodes = yield* fileNodes()

      const exit = yield* runAstEdit({
        file: "fixture.ts",
        edits: [{ ref: refOf(nodes, "function", "alpha"), op: "delete", content: "not allowed" }],
      }).pipe(Effect.exit)

      expect(failureMessage(exit)).toContain("op delete must not carry content")
    }),
  )

  it.instance("applies multiple edits by reverse-offset splicing regardless of input order", () =>
    Effect.gen(function* () {
      const { file } = yield* setupFixture()
      const nodes = yield* fileNodes()

      yield* runAstEdit({
        file: "fixture.ts",
        edits: [
          { ref: refOf(nodes, "function", "beta"), op: "delete" },
          {
            ref: refOf(nodes, "function", "alpha"),
            op: "replace",
            content: "export function alpha() {\n  return 1\n}\n\nexport function alphaToo() {\n  return 2\n}",
          },
        ],
      })

      expect(yield* readFixture(file)).toBe(`import { stat } from "fs"

export function alpha() {
  return 1
}

export function alphaToo() {
  return 2
}

export class Holder {
  delta() {
    return 3
  }
}
`)
    }),
  )

  it.instance("rejects an empty edit list", () =>
    Effect.gen(function* () {
      yield* setupFixture()
      const exit = yield* runAstEdit({ file: "fixture.ts", edits: [] }).pipe(Effect.exit)
      expect(failureMessage(exit)).toContain("at least one edit")
    }),
  )

  it.instance("fails cleanly when the graph surface is uninitialized", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "fixture.ts"), FIXTURE))

      const exit = yield* runAstEdit({
        file: "fixture.ts",
        edits: [{ ref: "node:function:00000000000000000000000000000000", op: "delete" }],
      }).pipe(Effect.exit)
      const message = failureMessage(exit)

      expect(message).toContain("not initialized")
      expect(message).toContain("edit tool")
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".chimera")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph")).exists())).toBe(false)
    }),
  )
})

type PatternRewriteMeta = {
  pattern: string
  replacement: string
  render: string
  matches: number
  applied: number
}

const patternMeta = (metadata: unknown) =>
  (metadata as { astEdit: { pattern: { language: string; rewrites: PatternRewriteMeta[] } } }).astEdit.pattern

const CODEMOD = `export function record(value: number) {\n  console.log("a", value)\n  if (value > 1) {\n    console.log(1 + 2)\n  }\n}\n`
const RECORDED = `export function record(value: number) {\n  logger.info("a", value)\n  if (value > 1) {\n    logger.info(1 + 2)\n  }\n}\n`
const NESTED = `export function wrap(value: number) {\n  return outer(inner(value))\n}\n`
const KEPT = `export function wrap(value: number) {\n  return keep(inner(value))\n}\n`
const EQUALS = `export function same(x: number, y: number) {\n  if (x == x) {\n    return 1\n  }\n  if (x == y) {\n    return 2\n  }\n}\n`
const DEBUG = `export function alpha() {\n  console.log("debug");\n  return 1;\n}\n`
const CALLS = `notify();\nnotify(1);\nnotify(1, 2, 3);\n`
const ALERTED = `alert();\nalert(1);\nalert(1, 2, 3);\n`
const PYTHON = `def alpha():\n    print(1)\n    print(2)\n`
const LOGGED = `def alpha():\n    log(1)\n    log(2)\n`
const BROKEN = `export function alpha( {\n  return 1\n}\n`
const NOTIFIER = `export function alpha(value: number) {\n  notify(value)\n}\n`

describe("tool.ast_edit pattern mode", () => {
  // Pattern mode never consults the graph: these fixtures live in a bare instance
  // directory with no initProjectGraph call, so every test here also exercises the
  // uninitialized-graph path.
  const setupPattern = Effect.fn("AstEditTest.setupPattern")(function* (name: string, content: string) {
    const test = yield* TestInstance
    const file = path.join(test.directory, name)
    yield* Effect.promise(() => fs.writeFile(file, content))
    return { directory: test.directory, file }
  })

  it.instance("rewrites every structural match in the file", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", CODEMOD)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }],
      })

      expect(result.output).toContain("AST edit applied successfully.")
      expect(result.output).toContain("Applied rewrites:")
      expect(result.output).toContain('- pattern "console.log($$$ARGS)": 2 replacement(s)')
      expect(yield* readFixture(file)).toBe(RECORDED)
      const pattern = patternMeta(result.metadata)
      expect(pattern.language).toBe("typescript")
      expect(pattern.rewrites[0]?.matches).toBe(2)
      expect(pattern.rewrites[0]?.applied).toBe(2)
      expect(pattern.rewrites[0]?.render).toBe("template")
    }),
  )

  it.instance("runs pattern mode with no initialized graph", () =>
    Effect.gen(function* () {
      const { directory, file } = yield* setupPattern("fixture.ts", CODEMOD)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }],
      })

      expect(result.output).toContain('- pattern "console.log($$$ARGS)": 2 replacement(s)')
      expect(yield* readFixture(file)).toContain("logger.info(1 + 2)")
      // the graph surface was never needed, and never created as a side effect
      expect(isInitialized(directory)).toBe(false)
      expect(result.output).not.toContain("Propagation check:")
    }),
  )

  it.instance("rides the shared mutation pipeline when the graph is initialized", () =>
    Effect.gen(function* () {
      const { file } = yield* setupFixture()
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "return $VALUE", replacement: "return 0" }],
      })

      expect(result.output).toContain('- pattern "return $VALUE": 3 replacement(s)')
      const content = yield* readFixture(file)
      expect(content).toContain("return 0")
      expect(content).not.toContain("return value + 1")
      expect(patternMeta(result.metadata).language).toBe("typescript")
      expect(patternMeta(result.metadata).rewrites[0]?.applied).toBe(3)
    }),
  )

  it.instance("requires a repeated metavariable to match identical code", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", EQUALS)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "$A == $A", replacement: "$A === $A" }],
      })

      expect(result.output).toContain('- pattern "$A == $A": 1 replacement(s)')
      const content = yield* readFixture(file)
      expect(content).toContain("if (x === x) {")
      expect(content).toContain("if (x == y) {")
    }),
  )

  it.instance("deletes every match when the replacement is empty", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", DEBUG)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "console.log($$$ARGS);", replacement: "" }],
      })

      expect(result.output).toContain('- pattern "console.log($$$ARGS);": 1 replacement(s)')
      const content = yield* readFixture(file)
      expect(content).not.toContain("console.log")
      expect(content).toContain("return 1;")
      expect(patternMeta(result.metadata).rewrites[0]?.render).toBe("delete")
    }),
  )

  it.instance("matches zero, one, and many arguments with $$$ in a call-arg position", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", CALLS)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "notify($$$ARGS)", replacement: "alert($$$ARGS)" }],
      })

      expect(result.output).toContain('- pattern "notify($$$ARGS)": 3 replacement(s)')
      expect(yield* readFixture(file)).toBe(ALERTED)
    }),
  )

  it.instance("rejects nested matches and same-span rewrites that disagree", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", NESTED)

      const nested = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [
          { pattern: "outer($A)", replacement: "keep($A)" },
          { pattern: "inner($A)", replacement: "deep($A)" },
        ],
      }).pipe(Effect.exit)
      const nestedMessage = failureMessage(nested)
      expect(nestedMessage).toContain("overlapping pattern matches in fixture.ts")
      expect(nestedMessage).toContain('rewrite 1 "outer($A)"')
      expect(nestedMessage).toContain('rewrite 2 "inner($A)"')
      expect(yield* readFixture(file)).toBe(NESTED)

      const divergent = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [
          { pattern: "outer($A)", replacement: "keep($A)" },
          { pattern: "outer($A)", replacement: "drop($A)" },
        ],
      }).pipe(Effect.exit)
      expect(failureMessage(divergent)).toContain("overlapping pattern matches")
      expect(yield* readFixture(file)).toBe(NESTED)
    }),
  )

  it.instance("collapses duplicate rewrites that render the identical span", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", NESTED)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [
          { pattern: "outer($A)", replacement: "keep($A)" },
          { pattern: "outer($A)", replacement: "keep($A)" },
        ],
      })

      expect(result.output).toContain('- pattern "outer($A)": 1 replacement(s)')
      expect(yield* readFixture(file)).toBe(KEPT)
      expect(patternMeta(result.metadata).rewrites.map((rewrite) => rewrite.applied)).toEqual([1, 0])
    }),
  )

  it.instance("rewrites a python file through the expando path", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.py", PYTHON)
      const result = yield* runAstEdit({
        file: "fixture.py",
        rewrites: [{ pattern: "print($A)", replacement: "log($A)" }],
      })

      expect(result.output).toContain('- pattern "print($A)": 2 replacement(s)')
      expect(yield* readFixture(file)).toBe(LOGGED)
      expect(patternMeta(result.metadata).language).toBe("python")
    }),
  )

  it.instance("refuses a file with syntax errors", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", BROKEN)
      const exit = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "return $VALUE", replacement: "return 0" }],
      }).pipe(Effect.exit)
      const message = failureMessage(exit)

      expect(message).toContain("has syntax errors")
      expect(message).toContain("pattern rewriting is unsafe")
      expect(message).toContain("edit tool")
      expect(yield* readFixture(file)).toBe(BROKEN)
    }),
  )

  it.instance("surfaces an uncompilable pattern with the pattern echoed", () =>
    Effect.gen(function* () {
      yield* setupPattern("fixture.ts", CODEMOD)
      const exit = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "function (", replacement: "x" }],
      }).pipe(Effect.exit)
      const message = failureMessage(exit)

      expect(message).toContain("rewrite 1 is not a usable typescript pattern")
      expect(message).toContain("function (")
    }),
  )

  it.instance("reports 0 replacements for a rewrite that matches nothing", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", NOTIFIER)
      const result = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [
          { pattern: "process.exit($CODE)", replacement: "process.exit($CODE)" },
          { pattern: "notify($ARGS)", replacement: "alert($ARGS)" },
        ],
      })

      expect(result.output).toContain('- pattern "process.exit($CODE)": 0 replacement(s)')
      expect(result.output).toContain('- pattern "notify($ARGS)": 1 replacement(s)')
      expect(yield* readFixture(file)).toContain("alert(value)")
      expect(patternMeta(result.metadata).rewrites[0]?.matches).toBe(0)
    }),
  )

  it.instance("throws the no-op error when every rewrite matches nothing", () =>
    Effect.gen(function* () {
      const { file } = yield* setupPattern("fixture.ts", CODEMOD)
      const exit = yield* runAstEdit({
        file: "fixture.ts",
        rewrites: [{ pattern: "process.exit($CODE)", replacement: "process.exit($CODE)" }],
      }).pipe(Effect.exit)

      expect(failureMessage(exit)).toContain("No changes to apply")
      expect(yield* readFixture(file)).toBe(CODEMOD)
    }),
  )

  it.instance("requires exactly one addressing mode per call", () =>
    Effect.gen(function* () {
      yield* setupPattern("fixture.ts", CODEMOD)

      const neither = yield* runAstEdit({ file: "fixture.ts" }).pipe(Effect.exit)
      expect(failureMessage(neither)).toContain("no mode given")

      const both = yield* runAstEdit({
        file: "fixture.ts",
        edits: [{ ref: "node:function:00000000000000000000000000000000", op: "delete" }],
        rewrites: [{ pattern: "notify($ARGS)", replacement: "alert($ARGS)" }],
      }).pipe(Effect.exit)
      expect(failureMessage(both)).toContain("one mode per call")

      const empty = yield* runAstEdit({ file: "fixture.ts", rewrites: [] }).pipe(Effect.exit)
      expect(failureMessage(empty)).toContain("at least one rewrite")
    }),
  )

  it.instance("refuses a file whose language has no grammar", () =>
    Effect.gen(function* () {
      yield* setupPattern("fixture.txt", "notify(1)\n")
      const exit = yield* runAstEdit({
        file: "fixture.txt",
        rewrites: [{ pattern: "notify($ARGS)", replacement: "alert($ARGS)" }],
      }).pipe(Effect.exit)
      const message = failureMessage(exit)

      expect(message).toContain("no tree-sitter grammar")
      expect(message).toContain("typescript, tsx, javascript, python")
      expect(message).toContain("edit tool")
    }),
  )
})
