import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Chimera } from "@/chimera"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import {
  ChimeraAuditRecentTool,
  ChimeraAuditTool,
  ChimeraContextTool,
  ChimeraFileSymbolsTool,
  ChimeraImpactTool,
  ChimeraObligationClaimTool,
  ChimeraObligationResolveTool,
  ChimeraObligationsListTool,
  ChimeraObligationsSyncTool,
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

const it = testEffect(Layer.mergeAll(Bus.layer, Agent.defaultLayer, Truncate.defaultLayer))

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

const runFileSymbols = Effect.fn("ChimeraToolTest.runFileSymbols")(function* (
  args: Tool.InferParameters<typeof ChimeraFileSymbolsTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraFileSymbolsTool
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

const runContext = Effect.fn("ChimeraToolTest.runContext")(function* (
  args: Tool.InferParameters<typeof ChimeraContextTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraContextTool
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
}) {
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
  it.instance("reports graph status and initializes CodeGraph", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "tracked.ts"), "export const tracked = 1\n"))

      const result = yield* runStatus({ refresh: true })

      expect(result.title).toBe("Chimera status")
      expect(result.output).toContain("Chimera graph surface is ready.")
      expect(result.output).toContain("Pending obligations: 0")
      expect(result.metadata.snapshot.fileCount).toBeGreaterThan(0)
      expect(result.metadata.snapshot.nodeCount).toBeGreaterThan(0)
      expect(result.metadata.snapshot.revision).toEqual(expect.any(String))
      expect(result.metadata.pendingObligations).toBe(0)

      const marker = yield* Effect.promise(() => fs.stat(path.join(test.directory, ".codegraph", "codegraph.db")))
      expect(marker.isFile()).toBe(true)
    }),
  )

  it.instance("searches indexed symbols", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "search.ts"), "export function trackedSearch() { return 1 }\n"),
      )

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

      const result = yield* runFileSymbols({ filePath: "symbols.ts" })

      expect(result.title).toBe("Chimera file symbols")
      expect(result.output).toContain("trackedFileSymbol")
      expect(result.metadata.results.some((item) => item.node.name === "trackedFileSymbol")).toBe(true)
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

      const result = yield* runImpact({ symbol: "source", depth: 2 })

      expect(result.title).toBe("Chimera impact")
      expect(result.output).toContain("Seed symbols")
      expect(result.output).toContain("Impact evidence")
      expect(result.output).toContain("cause_chain")
      expect(result.metadata.seeds.length).toBeGreaterThan(0)
    }),
  )

  it.instance("builds compact graph context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "context.ts"), "export function trackedContext() { return 1 }\n"),
      )

      const result = yield* runContext({ query: "trackedContext", maxNodes: 5, maxCodeBlocks: 2 })

      expect(result.title).toBe("Chimera context")
      expect(result.output).toContain("trackedContext")
      expect(result.output).toContain("Chimera Overlay")
      expect(result.output).toContain("Selected impact")
      expect(result.output).toContain("Future obligations")
      expect(result.metadata.query).toBe("trackedContext")
      expect(result.metadata.overlay.selectedImpact.seeds.length).toBeGreaterThan(0)
    }),
  )

  it.instance("audits changed files into candidate obligations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 1 }\n"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "consumer.ts"),
          "import { base } from './base'\nexport function consumer() { return base() }\n",
        ),
      )

      const result = yield* runAudit({ filePath: "base.ts", depth: 2 })

      expect(result.title).toBe("Chimera audit")
      expect(result.output).toContain("Candidate obligations")
      expect(result.output).toContain("Change classification")
      expect(result.output).toContain("Behavior-boundary evidence")
      expect(result.output).toContain("cause_chain")
      expect(result.metadata.changedFiles).toContain("base.ts")
      expect(result.metadata.classifications[0].classification).toBe("source")
      expect(result.metadata.obligations.length).toBeGreaterThan(0)
      expect(result.metadata.obligations[0].causeChain.length).toBeGreaterThan(0)
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
        yield* runStatus({ refresh: true })
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.ts"), "export function base() { return 2 }\n"))

        const result = yield* runAuditRecent({})

        expect(result.title).toBe("Chimera audit")
        expect(result.output).toContain("Source: git_diff")
        expect(result.metadata.source).toBe("git_diff")
        expect(result.metadata.changedFiles).toContain("base.ts")
        expect(result.metadata.changedFiles.some((file) => file.startsWith(".codegraph/"))).toBe(false)
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

      const context = yield* runContext({ filePath: "base.ts", mode: "audit", maxNodes: 10, maxCodeBlocks: 2 })
      expect(context.output).toContain("Future obligations")
      expect(context.output).toContain(obligation.id)
      expect(context.metadata.overlay.obligations.counts.pending).toBe(synced.metadata.obligations.length)

      const claimed = yield* runObligationClaim({ obligationID: obligation.id })
      expect(claimed.metadata.obligations[0].status).toBe("claimed")

      const resolved = yield* runObligationResolve({ obligationID: obligation.id, note: "reviewed caller" })
      expect(resolved.metadata.obligations[0].status).toBe("resolved")

      const listed = yield* runObligationsList({ status: "resolved" })
      expect(listed.metadata.obligations.some((item) => item.id === obligation.id)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph", "codegraph.db")).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph", "chimera", "obligations.json")).exists())).toBe(false)
    }),
  )
})
