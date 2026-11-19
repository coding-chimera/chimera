import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { CodeGraph } from "../../src/graph"
import { DiscoveryNudge } from "../../src/chimera/discovery-nudge"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/contracts/session-ids"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const limitedIt = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    TestConfig.layer({ get: () => Effect.succeed({ tool_output: { max_bytes: 1200, max_lines: 100000 } }) }),
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const limitedCtx = { ...ctx, sessionID: SessionID.make("ses_grep_output_limit") }

// The unified output limit adds these fields in the Tool.define wrapper, so they
// are not part of grep's own metadata type.
const outputMeta = (metadata: unknown) =>
  metadata as { outputTruncated?: boolean; outputPath?: string }

const root = path.join(__dirname, "../..")

describe("tool.grep", () => {
  it.live("basic search", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* provideInstance(root)(
        grep.execute(
          {
            pattern: "export",
            path: path.join(root, "src/tool"),
            include: "*.ts",
          },
          ctx,
        ),
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.instance("no matches returns correct output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "hello world"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "xyznonexistentpatternxyz123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  it.instance("finds matches in tmp instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
    }),
  )

  it.instance("appends the graph discovery hint to the 4th search result on an indexed project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "needle.txt"), "needle one\nneedle two\nneedle three\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const nudgeCtx = { ...ctx, sessionID: SessionID.make("ses_grep_nudge") }
      const info = yield* GrepTool
      const grep = yield* info.init()
      const search = () => grep.execute({ pattern: "needle", path: test.directory }, nudgeCtx)
      const first = yield* search()
      const second = yield* search()
      const third = yield* search()
      expect(first.metadata.matches).toBeGreaterThan(0)
      expect(first.output).not.toContain(DiscoveryNudge.GRAPH_DISCOVERY_HINT)
      expect(second.output).not.toContain(DiscoveryNudge.GRAPH_DISCOVERY_HINT)
      expect(third.output).not.toContain(DiscoveryNudge.GRAPH_DISCOVERY_HINT)
      const fourth = yield* search()
      expect(fourth.output).toContain(DiscoveryNudge.GRAPH_DISCOVERY_HINT)
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => Bun.write(file, "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line2",
          path: file,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
    }),
  )

  it.instance("asks for external_directory permission when a symlink aliases an allowed external directory", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      const test = yield* TestInstance
      const external = yield* tmpdirScoped()
      const alias = path.join(test.directory, "alias")
      yield* Effect.promise(() => fs.symlink(external, alias, "dir"))
      yield* Effect.promise(() => Bun.write(path.join(external, "test.txt"), "needle"))

      const ruleset = Permission.fromConfig({
        grep: "allow",
        external_directory: {
          [path.join(external, "*")]: "allow",
        },
      })
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            const needsAsk = req.patterns.some(
              (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action !== "allow",
            )
            if (needsAsk) requests.push(req)
          }),
      }

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: alias,
          include: "*.txt",
        },
        next,
      )

      expect(result.metadata.matches).toBe(1)
      const ext = requests.find((req) => req.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toEqual([path.join(alias, "*")])
    }),
  )

  it.instance("caps long matching lines while keeping the total count", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const long = "a".repeat(5000)
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "long.txt"), `${long} needle\n`))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
      expect(result.metadata.matches).toBe(1)
      expect(result.metadata.truncated).toBe(false)
      expect(outputMeta(result.metadata).outputTruncated).toBeUndefined()
      const line = result.output.split("\n").find((entry) => entry.includes("Line 1:"))
      expect(line).toBeDefined()
      expect(line!.length).toBeLessThan(2100)
    }),
  )

  it.instance("caps broad result sets to the newest 100 matches by mtime", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = new Date("2024-01-01T00:00:00Z").getTime()
      for (let i = 0; i < 120; i++) {
        const file = path.join(test.directory, `match-${String(i).padStart(3, "0")}.txt`)
        yield* Effect.promise(() => Bun.write(file, "needle\n"))
        const time = new Date(base + i * 1000)
        yield* Effect.promise(() => fs.utimes(file, time, time))
      }
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
      expect(result.metadata.matches).toBe(120)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("showing first 100")
      expect(result.output).toContain("match-119.txt")
      expect(result.output).toContain("match-020.txt")
      expect(result.output).not.toContain("match-019.txt")
      expect(result.output).not.toContain("match-000.txt")
    }),
  )

  it.instance("handles a broad single-file match set without materializing every row", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 500 }, (_, i) => `needle ${i}`)
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "broad.txt"), lines.join("\n")))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
      expect(result.metadata.matches).toBe(500)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Found 500 matches (showing first 100)")
      expect(result.output).toContain("Line 1: needle 0")
      expect(result.output).not.toContain("Line 101:")
      expect(result.output).toContain("(Results truncated: showing 100 of 500 matches (400 hidden)")
    }),
  )

  limitedIt.instance("applies the configured output byte limit and keeps result-set metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 40 }, (_, i) => `needle-${i} ${"x".repeat(100)}`)
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "wide.txt"), lines.join("\n")))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory }, limitedCtx)
      expect(result.metadata.matches).toBe(40)
      expect(result.metadata.truncated).toBe(false)
      expect(outputMeta(result.metadata).outputTruncated).toBe(true)
      expect(typeof outputMeta(result.metadata).outputPath).toBe("string")
      expect(result.output).toContain("bytes truncated")
      const saved = yield* Effect.promise(() => Bun.file(outputMeta(result.metadata).outputPath!).text())
      expect(saved).toContain("Line 40:")
    }),
  )

  limitedIt.instance("still applies the unified output limit when the result set is self-truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 300 }, (_, i) => `needle-${i} ${"x".repeat(120)}`)
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "many.txt"), lines.join("\n")))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory }, limitedCtx)
      expect(result.metadata.matches).toBe(300)
      // grep's own `truncated` only reports the result set; the oversized output
      // must still go through the unified byte limit.
      expect(result.metadata.truncated).toBe(true)
      expect(outputMeta(result.metadata).outputTruncated).toBe(true)
      expect(typeof outputMeta(result.metadata).outputPath).toBe("string")
      expect(result.output).toContain("bytes truncated")
      const saved = yield* Effect.promise(() => Bun.file(outputMeta(result.metadata).outputPath!).text())
      expect(saved).toContain("(Results truncated: showing 100 of 300 matches")
    }),
  )

  it.instance("fails when the search is aborted", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "needle"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const controller = new AbortController()
      controller.abort()
      const exit = yield* Effect.exit(
        grep.execute({ pattern: "needle", path: test.directory }, { ...ctx, abort: controller.signal }),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
})
