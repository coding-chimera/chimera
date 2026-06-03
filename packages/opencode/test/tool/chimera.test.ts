import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import {
  ChimeraAuditTool,
  ChimeraContextTool,
  ChimeraImpactTool,
  ChimeraObligationsTool,
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

const runObligations = Effect.fn("ChimeraToolTest.runObligations")(function* (
  args: Tool.InferParameters<typeof ChimeraObligationsTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraObligationsTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
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

        const result = yield* runAudit({})

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

      const synced = yield* runObligations({ action: "sync", filePath: "base.ts", depth: 2 })
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

      const claimed = yield* runObligations({ action: "claim", obligationID: obligation.id })
      expect(claimed.metadata.obligations[0].status).toBe("claimed")

      const resolved = yield* runObligations({ action: "resolve", obligationID: obligation.id, note: "reviewed caller" })
      expect(resolved.metadata.obligations[0].status).toBe("resolved")

      const listed = yield* runObligations({ action: "list", status: "resolved" })
      expect(listed.metadata.obligations.some((item) => item.id === obligation.id)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".codegraph", "chimera", "obligations.json")).exists())).toBe(
        true,
      )
    }),
  )
})
