import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Chimera } from "@/chimera"
import { ChimeraPromptContext } from "@/chimera/prompt-context"
import { readAuditRuns, readPredesignRuns } from "@/chimera/store"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import {
  ChimeraAuditRecentTool,
  ChimeraAuditTool,
  ChimeraFileSymbolsTool,
  ChimeraImpactTool,
  ChimeraOracleGetTool,
  ChimeraOracleRecentTool,
  ChimeraObligationClaimTool,
  ChimeraObligationResolveTool,
  ChimeraObligationsListTool,
  ChimeraObligationsSyncTool,
  ChimeraPredesignTool,
  ChimeraSearchTool,
  ChimeraStatusTool,
} from "@/tool/chimera"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-chimera-session"),
  messageID: MessageID.make("msg_test-chimera-message"),
  callID: "call_chimera",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(Layer.mergeAll(Bus.layer, Agent.defaultLayer, Truncate.defaultLayer, ChimeraPromptContext.layer))

afterEach(async () => {
  await disposeAllInstances()
})

const runStatus = Effect.fn("ChimeraToolTest.runStatus")(function* (
  args: Tool.InferParameters<typeof ChimeraStatusTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraStatusTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runSearch = Effect.fn("ChimeraToolTest.runSearch")(function* (
  args: Tool.InferParameters<typeof ChimeraSearchTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraSearchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const initGraph = Effect.fn("ChimeraToolTest.initGraph")(function* () {
  return yield* Chimera.initProjectGraph({ watch: false })
})

const runFileSymbols = Effect.fn("ChimeraToolTest.runFileSymbols")(function* (
  args: Tool.InferParameters<typeof ChimeraFileSymbolsTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraFileSymbolsTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runPredesign = Effect.fn("ChimeraToolTest.runPredesign")(function* (
  args: Tool.InferParameters<typeof ChimeraPredesignTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraPredesignTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runImpact = Effect.fn("ChimeraToolTest.runImpact")(function* (
  args: Tool.InferParameters<typeof ChimeraImpactTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraImpactTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runAudit = Effect.fn("ChimeraToolTest.runAudit")(function* (
  args: Tool.InferParameters<typeof ChimeraAuditTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraAuditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runAuditRecent = Effect.fn("ChimeraToolTest.runAuditRecent")(function* (
  args: Tool.InferParameters<typeof ChimeraAuditRecentTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraAuditRecentTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runOracleRecent = Effect.fn("ChimeraToolTest.runOracleRecent")(function* (
  args: Tool.InferParameters<typeof ChimeraOracleRecentTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraOracleRecentTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runOracleGet = Effect.fn("ChimeraToolTest.runOracleGet")(function* (
  args: Tool.InferParameters<typeof ChimeraOracleGetTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraOracleGetTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runObligationsSync = Effect.fn("ChimeraToolTest.runObligationsSync")(function* (
  args: Tool.InferParameters<typeof ChimeraObligationsSyncTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraObligationsSyncTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runObligationsList = Effect.fn("ChimeraToolTest.runObligationsList")(function* (
  args: Tool.InferParameters<typeof ChimeraObligationsListTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraObligationsListTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runObligationClaim = Effect.fn("ChimeraToolTest.runObligationClaim")(function* (
  args: Tool.InferParameters<typeof ChimeraObligationClaimTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraObligationClaimTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const runObligationResolve = Effect.fn("ChimeraToolTest.runObligationResolve")(function* (
  args: Tool.InferParameters<typeof ChimeraObligationResolveTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraObligationResolveTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const trackWrite = Effect.fn("ChimeraToolTest.trackWrite")(function* (input: {
  filePath: string
  content: string
  patch: string
  callID: string
  init?: boolean
}) {
  if (input.init !== false) yield* initGraph()
  yield* Chimera.trackToolMutation(
    {
      toolID: "write",
      ctx: { ...ctx, callID: input.callID },
      files: [input.filePath],
      metadata: {
        exists: true,
        filePath: input.filePath,
        diff: input.patch,
      },
    },
    Effect.promise(() => fs.writeFile(input.filePath, input.content)),
  )
})

describe("tool.chimera", () => {
  it.instance("documents CodePlan atomic label glossary for audit workflows", () =>
    Effect.gen(function* () {
      const audit = yield* ChimeraAuditTool.pipe(Effect.flatMap((info) => info.init()))
      const auditRecent = yield* ChimeraAuditRecentTool.pipe(Effect.flatMap((info) => info.init()))
      const obligationsSync = yield* ChimeraObligationsSyncTool.pipe(Effect.flatMap((info) => info.init()))

      for (const description of [audit.description, auditRecent.description, obligationsSync.description]) {
        expect(description).toContain("CodePlan atomic label glossary")
        expect(description).toContain("`MMS` modified method signature")
        expect(description).toContain("`MMB` modified method body")
        expect(description).toContain("`DI` deleted import/using statement")
      }
    }),
  )
  it.instance("reports uninitialized status without creating graph data", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "tracked.ts"), "export const tracked = 1\n"))

      const result = yield* runStatus({ refresh: true })

      expect(result.title).toBe("Chimera status")
      expect(result.output).toContain("Chimera graph surface is not initialized.")
      expect(result.metadata.initialized).toBe(false)
      expect(result.metadata.dataRootStatus).toBe("uninitialized")
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".chimera")).exists())).toBe(false)
    }),
  )

  it.instance("runs tool mutations without initializing graph data", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "mutation.ts")
      const content = "export const mutation = 1\n"

      yield* trackWrite({
        filePath,
        content,
        callID: "call_chimera_mutation_without_init",
        init: false,
        patch: `--- mutation.ts
+++ mutation.ts
@@ -0,0 +1,1 @@
+export const mutation = 1
`,
      })

      expect(yield* Effect.promise(() => Bun.file(filePath).text())).toBe(content)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".chimera", "codegraph.db")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph", "codegraph.db")).exists())).toBe(false)
    }),
  )

  it.instance("reports ready status after explicit graph init", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "tracked.ts"), "export const tracked = 1\n"))
      yield* initGraph()

      const result = yield* runStatus({ refresh: true })

      expect(result.title).toBe("Chimera status")
      expect(result.output).toContain("Chimera graph surface is ready.")
      expect(result.output).toContain("Pending obligations: 0")
      expect(result.metadata.initialized).toBe(true)
      expect(result.metadata.snapshot?.fileCount).toBeGreaterThan(0)
      expect(result.metadata.snapshot?.nodeCount).toBeGreaterThan(0)
      expect(result.metadata.snapshot?.revision).toEqual(expect.any(String))
      expect(result.metadata.pendingObligations).toBe(0)
      expect(result.metadata.dataRootStatus).toBe("current")

      const marker = yield* Effect.promise(() => fs.stat(path.join(test.directory, ".chimera", "codegraph.db")))
      expect(marker.isFile()).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph", "codegraph.db")).exists())).toBe(false)
    }),
  )


  it.instance("closes read-only scoped graph state without closing cached graph state", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "scoped.ts"), "export const scoped = 1\n"))
      yield* initGraph()

      const readOnlyState = yield* Chimera.withProjectGraph(
        { readOnly: true, watch: false, sync: false },
        (state) => Effect.succeed(state),
      )
      expect(() => readOnlyState.graph.snapshot()).toThrow()

      const cachedState = yield* Chimera.withProjectGraph(
        { watch: false, sync: false },
        (state) => Effect.succeed(state),
      )
      expect(cachedState.graph.snapshot().fileCount).toBeGreaterThan(0)
    }),
  )

  it.instance("searches indexed symbols", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "search.ts"), "export function trackedSearch() { return 1 }\n"),
      )
      yield* initGraph()

      const result = yield* runSearch({ query: "trackedSearch" })

      expect(result.title).toBe("Chimera search")
      expect(result.output).toContain("trackedSearch")
      expect(result.metadata.results.some((item) => item.node.name === "trackedSearch")).toBe(true)
    }),
  )

  it.instance("lists indexed symbols for a known file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "symbols.ts"), "export function trackedFileSymbol() { return 1 }\n"),
      )
      yield* initGraph()

      const result = yield* runFileSymbols({ filePath: "symbols.ts" })

      expect(result.title).toBe("Chimera file symbols")
      expect(result.output).toContain("trackedFileSymbol")
      expect(result.metadata.results.some((item) => item.node.name === "trackedFileSymbol")).toBe(true)
    }),
  )

  it.instance("syncs an existing explicit file path before listing symbols", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "baseline.ts"), "export const baseline = 1\n"))
      yield* initGraph()
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "late-symbol.ts"), "export function lateSymbol() { return 1 }\n"))

      const result = yield* runFileSymbols({ filePath: "late-symbol.ts", refresh: false })

      expect(result.title).toBe("Chimera file symbols")
      expect(result.metadata.results.some((item) => item.node.name === "lateSymbol")).toBe(true)
    }),
  )

  it.instance("records pre-design evidence for a risky mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "source.ts"), "export function source() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "caller.ts"),
          "import { source } from './source'\nexport function caller() { return source() }\n",
        ),
      )
      yield* initGraph()

      const stages: string[] = []
      const result = yield* runPredesign(
        { intent: "change source behavior", files: ["source.ts"], symbols: ["source"] },
        {
          ...ctx,
          metadata: (value: { metadata?: Record<string, any> }) =>
            Effect.sync(() => {
              const stage = value.metadata?.chimeraPredesignStage
              if (stage?.status === "running") stages.push(stage.stage)
            }),
        },
      )
      const runs = yield* Effect.promise(() =>
        readPredesignRuns(test.directory, path.join(test.directory, ".chimera", "chimera", "predesign-runs.jsonl"), {
          sessionID: ctx.sessionID,
        }),
      )

      expect(result.title).toBe("Chimera pre-design")
      expect(result.output).toContain("Chimera pre-design evidence recorded.")
      expect(result.output).not.toContain("Mutation gate guidance")
      expect(result.metadata.runID).toEqual(expect.stringMatching(/^predesign_/))
      expect(runs[0]?.id).toBe(result.metadata.runID)
      expect(runs[0]?.intent).toBe("change source behavior")
      expect(runs[0]?.files).toContain("source.ts")
      expect(stages).toEqual(["permission", "open graph", "sync files", "build impact", "record run", "return result"])
    }),
  )

  it.instance("caps pre-design output while preserving full metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const symbols = Array.from({ length: 15 }, (_, i) => `capSeed${i.toString().padStart(2, "0")}`)
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "source.ts"),
          symbols.map((symbol) => `export function ${symbol}() { return "${symbol}" }`).join("\n"),
        ),
      )
      yield* initGraph()

      const result = yield* runPredesign({ intent: "review many seeds", files: ["source.ts"], symbols })

      expect(result.metadata.seeds.length).toBeGreaterThan(12)
      expect(result.output).toContain("detailed sections show up to 12 items each")
      expect(result.output).toContain("more seed symbols omitted from pre-design output")
      expect(result.output).toContain("full data remains in metadata")
    }),
  )

  it.instance("analyzes symbol impact seeds", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "source.ts"), "export function source() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "caller.ts"),
          "import { source } from './source'\nexport function caller() { return source() }\n",
        ),
      )
      yield* initGraph()

      const result = yield* runImpact({ symbol: "source", depth: 2 })

      expect(result.title).toBe("Chimera impact")
      expect(result.output).toContain("Seed symbols")
      expect(result.output).toContain("Impact evidence")
      expect(result.output).toContain("cause_chain")
      expect(result.metadata.seeds.length).toBeGreaterThan(0)
    }),
  )

  it.instance("audits changed files into propagation findings", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "consumer.ts"),
          "import { base } from './base'\nexport function consumer() { return base() }\n",
        ),
      )
      yield* initGraph()

      const result = yield* runAudit({ filePath: "base.ts", depth: 2 })

      expect(result.title).toBe("Chimera audit")
      expect(result.output).toContain("Propagation findings")
      expect(result.output).toContain("Change classification")
      expect(result.output).toContain("Behavior-boundary evidence")
      expect(result.output).not.toContain("Closeout guidance")
      expect(result.output).not.toContain("Lifecycle guidance")
      expect(result.output).toContain("cause_chain")
      expect(result.output).not.toContain("required_action")
      expect(result.output).not.toContain("review_or_update")
      expect(result.metadata.changedFiles).toContain("base.ts")
      expect(result.metadata.classifications[0].classification).toBe("source")
      expect(result.metadata.obligations.length).toBeGreaterThan(0)
      expect(result.metadata.obligations[0].causeChain.length).toBeGreaterThan(0)
    }),
  )

  it.instance("audits dependent test files through usage-edge file projection", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "base.test.ts"),
          "import { base } from './base'\nexport function verifiesBase() { return base() }\n",
        ),
      )
      yield* initGraph()
      const db = DatabaseConnection.open(getDatabasePath(test.directory))
      try {
        db.getDb().prepare("DELETE FROM edges WHERE kind = 'imports'").run()
      } finally {
        db.close()
      }

      const result = yield* runAudit({ filePath: "base.ts", refresh: false, depth: 2 })

      expect(result.metadata.fileDependents).toContain("base.test.ts")
      expect(result.metadata.obligations.some((item) => item.evidence.includes(":file_dependents") && item.target === "base.test.ts")).toBe(true)
    }),
  )

  it.instance("does not reuse recent provenance change facts for explicit audits", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const explicitFile = path.join(test.directory, "explicit.ts")
      const recentFile = path.join(test.directory, "package.json")
      yield* Effect.promise(() => fs.writeFile(explicitFile, "export function explicitAudit() { return 1 }\n"))
      yield* trackWrite({
        filePath: recentFile,
        content: "{\n  \"name\": \"recent\"\n}\n",
        callID: "call_chimera_explicit_audit_recent_isolation",
        patch: `--- package.json
+++ package.json
@@ -0,0 +1,3 @@
+{
+  "name": "recent"
+}
`,
      })

      const result = yield* runAudit({ files: ["explicit.ts"], refresh: false })
      const factFiles = new Set(result.metadata.changeFacts.map((fact) => fact.filePath))

      expect(result.metadata.source).toBe("input")
      expect(result.metadata.changedFiles).toEqual(["explicit.ts"])
      expect(factFiles).toContain("explicit.ts")
      expect(factFiles).not.toContain("package.json")
    }),
  )

  it.instance("recalls oracle results with linked mutation provenance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "oracle.ts")
      yield* trackWrite({
        filePath,
        content: "export function oracleSubject() { return 2 }\n",
        callID: "call_chimera_oracle_mutation",
        patch: `--- oracle.ts
+++ oracle.ts
@@ -0,0 +1,1 @@
+export function oracleSubject() { return 2 }
`,
      })
      yield* Chimera.recordToolOracle({
        kind: "shell",
        toolID: "bash",
        ctx: { ...ctx, callID: "call_chimera_oracle_shell" },
        status: "fail",
        payload: {
          shell: {
            command: "bun typecheck",
            cwd: test.directory,
            description: "typecheck",
            exit: 1,
            output: "type error",
            truncated: false,
          },
        },
      })

      const recent = yield* runOracleRecent({ limit: 5 })
      const oracle = recent.metadata.oracles[0]
      const found = yield* runOracleGet({ oracleID: oracle.id })
      const parsed = JSON.parse(found.output) as { oracle: { payload: { shell: { output: string } } }; linkedChanges: Array<{ files: string[] }> }

      expect(recent.title).toBe("Chimera oracle results")
      expect(recent.output).toContain("\"oracle\"")
      expect(oracle.kind).toBe("shell")
      expect(oracle.status).toBe("fail")
      expect(oracle.linkedChanges[0]?.toolID).toBe("write")
      expect(oracle.linkedChanges[0]?.files).toContain("oracle.ts")
      expect(found.title).toBe("Chimera oracle result")
      expect(parsed.oracle.payload.shell.output).toBe("type error")
      expect(parsed.linkedChanges[0]?.files).toContain("oracle.ts")
    }),
  )


  it.instance("filters passing oracle results and marks old linked changes replayable", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "oracle-matrix.ts")
      yield* trackWrite({
        filePath,
        content: "export function oracleMatrix() { return 2 }\n",
        callID: "call_chimera_oracle_matrix_mutation",
        patch: `--- oracle-matrix.ts
+++ oracle-matrix.ts
@@ -0,0 +1,1 @@
+export function oracleMatrix() { return 2 }
`,
      })
      yield* Chimera.recordToolOracle({
        kind: "shell",
        toolID: "bash",
        ctx: { ...ctx, callID: "call_chimera_oracle_matrix_pass" },
        status: "pass",
        payload: {
          shell: {
            command: "bun test",
            cwd: test.directory,
            description: "passing test",
            exit: 0,
            output: "ok",
            truncated: false,
          },
        },
      })
      yield* trackWrite({
        filePath: path.join(test.directory, "post-oracle.ts"),
        content: "export const postOracle = 1\n",
        callID: "call_chimera_oracle_matrix_followup_mutation",
        patch: `--- post-oracle.ts
+++ post-oracle.ts
@@ -0,0 +1,1 @@
+export const postOracle = 1
`,
      })
      yield* Chimera.recordToolOracle({
        kind: "shell",
        toolID: "bash",
        ctx: { ...ctx, callID: "call_chimera_oracle_matrix_fail" },
        status: "fail",
        payload: {
          shell: {
            command: "bun typecheck",
            cwd: test.directory,
            description: "failing typecheck",
            exit: 1,
            output: "type error",
            truncated: false,
          },
        },
      })
      yield* Chimera.recordToolOracle({
        kind: "lsp",
        toolID: "lsp",
        ctx: { ...ctx, callID: "call_chimera_oracle_matrix_unknown" },
        status: "unknown",
        payload: {
          lsp: {
            diagnostics: { "oracle-matrix.ts": [{ message: "diagnostic" }] },
            diagnosticCount: 1,
          },
        },
      })

      const filtered = yield* runOracleRecent({ limit: 10 })
      const withPassing = yield* runOracleRecent({ limit: 10, includePassing: true })
      const parsed = JSON.parse(withPassing.output) as {
        oracles: Array<{
          oracle: { status: "pass" | "fail" | "unknown" }
          linkedChanges: Array<{ replayLifecycle?: { status: string; reason: string } }>
        }>
      }
      const statuses = new Set(filtered.metadata.oracles.map((oracle) => oracle.status))
      const passing = parsed.oracles.find((oracle) => oracle.oracle.status === "pass")
      const failing = parsed.oracles.find((oracle) => oracle.oracle.status === "fail")

      expect(statuses.has("pass")).toBe(false)
      expect(statuses.has("fail")).toBe(true)
      expect(statuses.has("unknown")).toBe(true)
      expect(withPassing.metadata.oracles.some((oracle) => oracle.status === "pass")).toBe(true)
      expect(passing?.linkedChanges[0]?.replayLifecycle?.status).toBe("replayable")
      expect(failing?.linkedChanges[0]?.replayLifecycle?.status).toBe("replayable")
      expect(failing?.linkedChanges[0]?.replayLifecycle?.reason).toContain("replayable evidence")

      const promptContext = yield* ChimeraPromptContext.Service
      const context = yield* promptContext.render(ctx.sessionID)
      expect(context).toContain("failing/unknown oracle evidence is linked to the latest mutation")
      expect(context).toContain("apocalypse: block")
      expect(context).toContain("ordinary: warn")
      expect(context).not.toContain("ordinary: block")
    }),
  )

  it.instance("keeps ordinary closeout as a warning when latest mutation lacks audit evidence", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "ordinary-closeout.ts")
      yield* trackWrite({
        filePath,
        content: "export function ordinaryCloseout() { return 1 }\n",
        callID: "call_chimera_ordinary_missing_audit",
        patch: `--- ordinary-closeout.ts
+++ ordinary-closeout.ts
@@ -0,0 +1,1 @@
+export function ordinaryCloseout() { return 1 }
`,
      })

      const promptContext = yield* ChimeraPromptContext.Service
      const context = yield* promptContext.render(ctx.sessionID)

      expect(context).toContain("ordinary: warn — latest mutation still needs recorded chimera_audit_recent evidence")
      expect(context).not.toContain("ordinary: block")
      expect(context).toContain("apocalypse: block — latest mutation has no recorded audit run")
      expect(context).toContain("latest audit evidence: none recorded for latest mutation")
    }),
  )
  it.instance("syncs an existing explicit file path before auditing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "baseline.ts"), "export const baseline = 1\n"))
      yield* initGraph()
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "late-audit.ts"), "export function lateAudit() { return 1 }\n"))

      const result = yield* runAudit({ filePath: "late-audit.ts", refresh: false })

      expect(result.title).toBe("Chimera audit")
      expect(result.metadata.changedFiles).toContain("late-audit.ts")
      expect(result.metadata.seedNodes.some((node) => node?.payload.name === "lateAudit")).toBe(true)
    }),
  )

  it.instance("audits callable rename through removed before-graph caller relations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = path.join(test.directory, "base.ts")
      yield* Effect.promise(() => fs.writeFile(base, "export function target() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "consumer.ts"),
          "import { target } from './base'\nexport function consumer() { return target() }\n",
        ),
      )

      yield* trackWrite({
        filePath: base,
        content: "export function renamed() { return 1 }\n",
        callID: "call_chimera_relation_delta_callable",
        patch: `--- base.ts
+++ base.ts
@@ -1,1 +1,1 @@
-export function target() { return 1 }
+export function renamed() { return 1 }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })
      const fact = result.metadata.changeFacts.find((item) =>
        item.evidence.relationDelta?.removedRelations.some((relation) => relation.payload.relation === "CalledBy"),
      )
      const candidate = result.metadata.obligations.find((item) =>
        item.evidence === "codegraph:relation_delta:removed:CalledBy" &&
        item.causeChain.some((link) => link.type === "removed_relation" && link.evidence.includes("CalledBy")),
      )

      expect(result.metadata.source).toBe("recent_provenance")
      expect(fact?.evidence.relationDelta?.removedRelations.some((relation) => relation.payload.otherNode.name === "consumer")).toBe(true)
      expect(candidate?.target).toContain("consumer")
      expect(candidate?.causeChain.map((link) => link.type)).toContain("removed_relation")
      expect(result.output).toContain("codegraph:removed_relation:CalledBy")
    }),
  )

  it.instance("audits export removal through removed before-graph importer relations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const exportsFile = path.join(test.directory, "exports.ts")
      yield* Effect.promise(() => fs.writeFile(exportsFile, "export function value() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "importer.ts"),
          "import { value } from './exports'\nexport function importer() { return value() }\n",
        ),
      )

      yield* trackWrite({
        filePath: exportsFile,
        content: "export function other() { return 1 }\n",
        callID: "call_chimera_relation_delta_importer",
        patch: `--- exports.ts
+++ exports.ts
@@ -1,1 +1,1 @@
-export function value() { return 1 }
+export function other() { return 1 }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })
      const fact = result.metadata.changeFacts.find((item) =>
        item.evidence.relationDelta?.removedRelations.some((relation) =>
          relation.payload.otherNode.filePath === "importer.ts" && relation.payload.relation !== "ContainedBy",
        ),
      )
      const candidate = result.metadata.obligations.find((item) =>
        item.evidence.startsWith("codegraph:relation_delta:removed:") &&
        item.target.includes("importer.ts") &&
        item.causeChain.some((link) => link.type === "removed_relation"),
      )

      expect(result.metadata.source).toBe("recent_provenance")
      expect(fact?.evidence.relationDelta?.removedRelations.some((relation) => relation.payload.otherNode.filePath === "importer.ts")).toBe(true)
      expect(candidate?.target).toContain("importer.ts")
      expect(candidate?.causeChain.map((link) => link.type)).toContain("removed_relation")
      expect(result.output).toContain("codegraph:removed_relation:")
    }),
  )

  it.instance("audits override redirect through added after-graph relation evidence", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const implementation = path.join(test.directory, "implementation.ts")
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "contract.ts"),
          "export class TaskRunner {\n  run() { return 0 }\n}\n",
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          implementation,
          "import { TaskRunner } from './contract'\nexport class Runner extends TaskRunner {\n  other() { return 1 }\n}\n",
        ),
      )

      yield* trackWrite({
        filePath: implementation,
        content: "import { TaskRunner } from './contract'\nexport class Runner extends TaskRunner {\n  run() { return 1 }\n}\n",
        callID: "call_chimera_relation_delta_override_redirect",
        patch: `--- implementation.ts
+++ implementation.ts
@@ -1,4 +1,4 @@
 import { TaskRunner } from './contract'
 export class Runner extends TaskRunner {
-  other() { return 1 }
+  run() { return 1 }
 }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })
      const fact = result.metadata.changeFacts.find((item) =>
        item.evidence.relationDelta?.addedRelations.some((relation) =>
          relation.payload.relation === "CalledBy" && relation.payload.otherNode.qualifiedName.includes("TaskRunner"),
        ),
      )
      const candidate = result.metadata.obligations.find((item) =>
        item.evidence === "codegraph:relation_delta:added:CalledBy" &&
        item.causeChain.some((link) => link.type === "added_relation" && link.evidence.includes("CalledBy")),
      )

      expect(result.metadata.source).toBe("recent_provenance")
      expect(fact?.evidence.relationDelta?.addedRelations.some((relation) => relation.payload.focalNode.qualifiedName.includes("Runner"))).toBe(true)
      expect(candidate?.target).toContain("TaskRunner")
      expect(candidate?.causeChain.map((link) => link.type)).toContain("added_relation")
      expect(result.output).toContain("codegraph:added_relation:CalledBy")
    }),
  )

  it.instance("preserves caller relation evidence for signature deltas", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = path.join(test.directory, "base.ts")
      yield* Effect.promise(() => fs.writeFile(base, "export function format(value: string) { return value.trim() }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "consumer.ts"),
          "import { format } from './base'\nexport function render() { return format('x') }\n",
        ),
      )

      yield* trackWrite({
        filePath: base,
        content: "export function format(value: string, fallback = '') { return (value || fallback).trim() }\n",
        callID: "call_chimera_relation_delta_signature",
        patch: `--- base.ts
+++ base.ts
@@ -1,1 +1,1 @@
-export function format(value: string) { return value.trim() }
+export function format(value: string, fallback = '') { return (value || fallback).trim() }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })
      const fact = result.metadata.changeFacts.find((item) =>
        item.subjectKind === "signature" &&
        item.evidence.semanticDiff?.changedFields.includes("signature") &&
        item.evidence.relationDelta?.beforeRelations.some((relation) => relation.payload.relation === "CalledBy") &&
        item.evidence.relationDelta?.afterRelations.some((relation) => relation.payload.relation === "CalledBy"),
      )

      expect(result.metadata.source).toBe("recent_provenance")
      expect(fact?.evidence.relationDelta?.beforeRelations.some((relation) => relation.payload.otherNode.name === "render")).toBe(true)
      expect(fact?.evidence.relationDelta?.afterRelations.some((relation) => relation.payload.otherNode.name === "render")).toBe(true)
      expect(result.output).toContain("relation_delta:")
      expect(result.output).toContain("codeplan_atomic_label: MMS")
      expect(result.output).not.toContain("codeplan_atomic_label: MMS (modified method signature)")
      expect(result.output).toContain("chimera:impact_label:method_signature:codeplan_atomic:MMS")
    }),
  )

  it.instance("keeps local-only TS body signal details out of default audit output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = path.join(test.directory, "body-local.ts")
      yield* Effect.promise(() => fs.writeFile(base, "export function calculate(value: number) {\n  const local = value + 1\n  return value\n}\n"))

      yield* trackWrite({
        filePath: base,
        content: "export function calculate(value: number) {\n  const local = value + 2\n  return value\n}\n",
        callID: "call_chimera_language_signal_local_only",
        patch: `--- body-local.ts
+++ body-local.ts
@@ -1,4 +1,4 @@
 export function calculate(value: number) {
-  const local = value + 1
+  const local = value + 2
   return value
 }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })
      const fact = result.metadata.changeFacts.find((item) => item.subjectKind === "body" && item.filePath === "body-local.ts")

      expect(result.metadata.source).toBe("recent_provenance")
      expect(fact?.confidence).toBeLessThan(0.5)
      expect(fact?.evidence.rule).toBe("method_body.self_review")
      expect(fact?.evidence.languageSignals?.some((signal) => signal.kind === "local_only_change")).toBe(true)
      expect(result.output).not.toContain("codegraph_language_signal:local_only_change")
      expect(result.output).not.toContain("codegraph.language.body.local_only")
      expect(result.output).toContain("codeplan_atomic_label: MMB")
      expect(result.output).toContain("statement_effect: local_only")
      expect(result.output).not.toContain("codeplan_atomic_label: MMB (modified method body)")
    }),
  )

  it.instance("keeps local-only body audit findings at self review", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = path.join(test.directory, "body-local-dependent.ts")
      yield* Effect.promise(() => fs.writeFile(base, "export function calculate(value: number) {\n  const local = value + 1\n  return value\n}\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "body-local-consumer.ts"),
          "import { calculate } from './body-local-dependent'\nexport function consumer() { return calculate(1) }\n",
        ),
      )

      yield* trackWrite({
        filePath: base,
        content: "export function calculate(value: number) {\n  const local = value + 2\n  return value\n}\n",
        callID: "call_chimera_language_signal_local_only_self_review",
        patch: `--- body-local-dependent.ts
+++ body-local-dependent.ts
@@ -1,4 +1,4 @@
 export function calculate(value: number) {
-  const local = value + 1
+  const local = value + 2
   return value
 }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })

      expect(result.metadata.fileDependents).toHaveLength(0)
      expect(result.metadata.obligations.some((item) => item.evidence === "chimera:may_impact_rule:codeplan.MMB.self_review:self_review")).toBe(true)
      expect(result.metadata.obligations.some((item) => item.target.includes("body-local-consumer"))).toBe(false)
      expect(result.output).toContain("chimera:impact_label:method_body")
      expect(result.output).toContain("chimera:impact_label:method_body:codeplan_atomic:MMB")
      expect(result.output).toContain("codeplan.MMB.self_review")
      expect(result.output).not.toContain("method_body.local_self_review")
    }),
  )

  it.instance("keeps caller-visible TS body signal details out of default audit output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = path.join(test.directory, "body-visible.ts")
      yield* Effect.promise(() => fs.writeFile(base, "export function calculate(value: number) {\n  return value + 1\n}\n"))

      yield* trackWrite({
        filePath: base,
        content: "export function calculate(value: number) {\n  return value + 2\n}\n",
        callID: "call_chimera_language_signal_return_value",
        patch: `--- body-visible.ts
+++ body-visible.ts
@@ -1,3 +1,3 @@
 export function calculate(value: number) {
-  return value + 1
+  return value + 2
 }
`,
      })

      const result = yield* runAuditRecent({ refresh: false })
      const fact = result.metadata.changeFacts.find((item) => item.subjectKind === "body" && item.filePath === "body-visible.ts")

      expect(result.metadata.source).toBe("recent_provenance")
      expect(result.metadata.auditRunID).toEqual(expect.any(String))
      expect(result.output).toContain(`Audit run: ${result.metadata.auditRunID}`)
      expect(fact?.confidence).toBeGreaterThanOrEqual(0.8)
      expect(fact?.evidence.rule).toBe("method_body.statement_effect")
      expect(fact?.evidence.statementEffect?.effect).toBe("return_value_change")
      expect(fact?.evidence.languageSignals?.some((signal) => signal.kind === "return_value_changed")).toBe(true)
      expect(result.output).toContain("statement_effect: return_value_change")
      expect(result.output).not.toContain("codegraph_language_signal:return_value_changed")
      expect(result.output).not.toContain("codegraph.language.body.caller_visible")
      expect((yield* Effect.promise(() => readAuditRuns(test.directory, { provenanceID: result.metadata.provenance?.id }))).some((item) => item.id === result.metadata.auditRunID)).toBe(true)
    }),
  )

  it.instance(
    "falls back to git diff changes when no recent provenance exists",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 1 }\n"))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(test.directory, "consumer.ts"),
            "import { base } from './base'\nexport function consumer() { return base() }\n",
          ),
        )
        yield* Effect.promise(() => Bun.$`git add base.ts consumer.ts`.cwd(test.directory).quiet())
        yield* Effect.promise(() => Bun.$`git commit -m baseline`.cwd(test.directory).quiet())
        yield* initGraph()
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 2 }\n"))

        const result = yield* runAuditRecent({})

        expect(result.title).toBe("Chimera audit")
        expect(result.output).toContain("Source: git_diff")
        expect(result.metadata.source).toBe("git_diff")
        expect(result.metadata.changedFiles).toContain("base.ts")
        expect(result.metadata.changedFiles.some((file) => file.startsWith(".chimera/") || file.startsWith(".codegraph/"))).toBe(false)
      }),
    { git: true },
  )

  it.instance("syncs and updates persistent obligations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "consumer.ts"),
          "import { base } from './base'\nexport function consumer() { return base() }\n",
        ),
      )
      yield* initGraph()

      const synced = yield* runObligationsSync({ filePath: "base.ts", depth: 2 })
      const obligation = synced.metadata.obligations[0]

      expect(synced.title).toBe("Chimera obligations")
      expect(synced.output).toContain("Chimera obligations synced")
      expect(synced.metadata.synced).toBeGreaterThan(0)
      expect(obligation.status).toBe("pending")
      expect(obligation.classification).toBe("source")
      expect(obligation.causeChain?.length).toBeGreaterThan(0)

      const status = yield* runStatus({ refresh: false })
      expect(status.output).toContain(`Pending obligations: ${synced.metadata.obligations.length}`)
      expect(status.metadata.pendingObligations).toBe(synced.metadata.obligations.length)

      const promptContext = yield* ChimeraPromptContext.Service
      const context = yield* promptContext.render(ctx.sessionID)
      expect(context).toContain("## Chimera Execution Context")
      expect(context).toContain("Active Obligations")
      expect(context).toContain("Closeout Gate")
      expect(context).toContain("ordinary:")
      expect(context).toContain("apocalypse:")
      expect(context).toContain("ordinary: warn — active obligations remain; review, resolve, ignore, or explicitly justify ordinary closeout")
      expect(context).not.toContain("ordinary: block")
      expect(context).toContain("apocalypse: block — all active obligations must be resolved or ignored")
      expect(context).toContain(obligation.id)

      const claimed = yield* runObligationClaim({ obligationID: obligation.id })
      expect(claimed.metadata.obligations[0].status).toBe("claimed")

      const resolved = yield* runObligationResolve({ obligationID: obligation.id, note: "reviewed caller" })
      expect(resolved.metadata.obligations[0].status).toBe("resolved")

      const listed = yield* runObligationsList({ status: "resolved" })
      expect(listed.metadata.obligations.some((item) => item.id === obligation.id)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".chimera", "codegraph.db")).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".chimera", "chimera", "obligations.json")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph", "codegraph.db")).exists())).toBe(false)
    }),
  )
})
