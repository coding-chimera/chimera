import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { AstEditTool } from "../../src/tool/ast_edit"
import { Tool } from "@/tool/tool"
import { LSP } from "@/lsp/lsp"
import { Ledger } from "@/lsp/ledger"
import { Config } from "@/config/config"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Ripgrep } from "@/file/ripgrep"
import { recordPredesignRun } from "@/chimera/store"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/contracts/session-ids"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CodeGraph, getCodeGraphDir } from "../../src/graph"

const ctx = {
  sessionID: SessionID.make("ses_test-blocked-replay-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    Ledger.defaultLayer,
    Config.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Ripgrep.defaultLayer,
  ),
)

const initWrite = Effect.fn("BlockedReplayTest.initWrite")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const initEdit = Effect.fn("BlockedReplayTest.initEdit")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const initAstEdit = Effect.fn("BlockedReplayTest.initAstEdit")(function* () {
  const info = yield* AstEditTool
  return yield* info.init()
})

const runWrite = Effect.fn("BlockedReplayTest.runWrite")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* initWrite()
  return yield* tool.execute(args, next)
})

const predesign = Effect.fn("BlockedReplayTest.predesign")(function* (root: string, files: string[]) {
  yield* Effect.promise(() =>
    recordPredesignRun(root, path.join(getCodeGraphDir(root), "chimera", "predesign-runs.jsonl"), {
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: "call_predesign_blocked_replay_test",
      agent: ctx.agent,
      intent: "blocked replay fixture",
      files,
      seedNodes: [],
      impactedNodes: [],
      fileDependents: [],
      evidence: [],
      snapshotRevision: "test_revision",
      payload: {},
    }),
  )
})

const failureText = (exit: Exit.Exit<unknown, unknown>): string => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

const REPLAY_ERROR = /Unknown, expired, or mismatched replay key/

describe("tool blocked-call replay", () => {
  it.instance("stashes a blocked write and exposes the replay key", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "blocked.ts")
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const result = yield* runWrite({ filePath: filepath, content: "export const blocked = 1\n" })

      expect(result.title).toBe("Chimera pre-design required")
      expect(result.output).toContain("replay key:")
      expect(result.metadata.replayKey).toMatch(/^rpl_/)
      expect(yield* Effect.promise(() => Bun.file(filepath).exists())).toBe(false)
    }),
  )

  it.instance("replays the stashed content after the gate is satisfied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "replay.ts")
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const blocked = yield* runWrite({ filePath: filepath, content: "export const original = 1\n" })
      const key = blocked.metadata.replayKey as string
      expect(typeof key).toBe("string")

      yield* predesign(test.directory, ["replay.ts"])
      const result = yield* runWrite({ filePath: filepath, content: "", replay: key })

      expect(result.title).not.toBe("Chimera pre-design required")
      const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(content).toBe("export const original = 1\n")
    }),
  )

  it.instance("rejects an unknown replay key", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "unknown.ts")

      const exit = yield* runWrite({ filePath: filepath, content: "x", replay: "rpl_does_not_exist" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(failureText(exit)).toMatch(REPLAY_ERROR)
    }),
  )

  it.instance("rejects a replay key issued for a different tool", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "cross.ts")
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const blocked = yield* runWrite({ filePath: filepath, content: "export const cross = 1\n" })
      const key = blocked.metadata.replayKey as string

      const edit = yield* initEdit()
      const exit = yield* edit.execute({ filePath: filepath, edits: [], replay: key }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(failureText(exit)).toMatch(REPLAY_ERROR)
    }),
  )

  it.instance("re-blocks an unsatisfied replay with a fresh key and consumes the old one", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "reblock.ts")
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const first = yield* runWrite({ filePath: filepath, content: "export const reblock = 1\n" })
      const firstKey = first.metadata.replayKey as string
      expect(typeof firstKey).toBe("string")

      const second = yield* runWrite({ filePath: filepath, content: "ignored", replay: firstKey })
      expect(second.title).toBe("Chimera pre-design required")
      expect(second.output).toContain("replay key:")
      const secondKey = second.metadata.replayKey as string
      expect(secondKey).not.toBe(firstKey)

      // The old key was consumed by the replay attempt.
      const again = yield* runWrite({ filePath: filepath, content: "ignored", replay: firstKey }).pipe(Effect.exit)
      expect(Exit.isFailure(again)).toBe(true)
      expect(failureText(again)).toMatch(REPLAY_ERROR)
      expect(yield* Effect.promise(() => Bun.file(filepath).exists())).toBe(false)
    }),
  )
  it.instance("stashes a blocked ast_edit and exposes the replay key", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "ast_target.ts")
      yield* Effect.promise(() => fs.writeFile(filepath, "export const a = 1\ndebugger\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const ast = yield* initAstEdit()
      const result = yield* ast.execute({ file: filepath, rewrites: [{ pattern: "debugger", replacement: "" }] }, ctx)

      expect(result.title).toBe("Chimera pre-design required")
      expect(result.output).toContain("replay key:")
      expect(result.metadata.replayKey).toMatch(/^rpl_/)
      expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toContain("debugger")
    }),
  )

  it.instance("replays a stashed ast_edit rewrites call after the gate is satisfied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "ast_replay.ts")
      yield* Effect.promise(() => fs.writeFile(filepath, "export const a = 1\ndebugger\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const ast = yield* initAstEdit()
      const blocked = yield* ast.execute(
        { file: filepath, rewrites: [{ pattern: "debugger", replacement: "" }] },
        ctx,
      )
      const key = blocked.metadata.replayKey as string
      expect(typeof key).toBe("string")

      yield* predesign(test.directory, ["ast_replay.ts"])
      const result = yield* ast.execute({ file: filepath, replay: key }, ctx)

      expect(result.title).not.toBe("Chimera pre-design required")
      const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(content).not.toContain("debugger")
      expect(content).toContain("export const a = 1")
    }),
  )

  it.instance("re-blocks an unsatisfied ast_edit replay with a fresh key and consumes the old one", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "ast_reblock.ts")
      yield* Effect.promise(() => fs.writeFile(filepath, "export const a = 1\ndebugger\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
      graph.close()

      const ast = yield* initAstEdit()
      const first = yield* ast.execute(
        { file: filepath, rewrites: [{ pattern: "debugger", replacement: "" }] },
        ctx,
      )
      const firstKey = first.metadata.replayKey as string
      expect(typeof firstKey).toBe("string")

      const second = yield* ast.execute({ file: filepath, replay: firstKey }, ctx)
      expect(second.title).toBe("Chimera pre-design required")
      expect(second.output).toContain("replay key:")
      const secondKey = second.metadata.replayKey as string
      expect(secondKey).not.toBe(firstKey)

      // The old key was consumed by the replay attempt.
      const again = yield* ast.execute({ file: filepath, replay: firstKey }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(again)).toBe(true)
      expect(failureText(again)).toMatch(REPLAY_ERROR)
      expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toContain("debugger")
    }),
  )
})