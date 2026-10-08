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
import type { Node as CodeGraphNode } from "@/graph"
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
