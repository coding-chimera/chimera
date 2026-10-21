import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import type * as LSPClient from "@/lsp/client"
import { LSP } from "@/lsp/lsp"
import { Config } from "@/config/config"
import { MessageID, SessionID, type SessionID as SessionIDType } from "@/contracts/session-ids"
import { InstanceState } from "@/effect/instance-state"
import { getGraphDataRootInfo } from "@/graph"
import { readOracleResults } from "@/chimera/store"
import type { OracleRecord } from "@/chimera/store"
import { bumpMutationVersion, collectMutationDiagnostics } from "@/tool/mutation-diagnostics"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// B3 two-phase diagnostics wait (specs/lsp-push-diagnostics.md section 6):
// fast servers keep the inline path byte-identical; slow servers detach a
// late fiber that records the oracle on completion, drops stale results when
// the file was mutated again, and stays fully disabled under `late: false`.

const fake = {
  touchArrived: true,
  waitDelayMs: 0,
  waitArrived: true,
  diagnostics: {} as Record<string, LSPClient.Diagnostic[]>,
  touched: [] as string[],
  waits: 0,
}

const resetFake = () => {
  fake.touchArrived = true
  fake.waitDelayMs = 0
  fake.waitArrived = true
  fake.diagnostics = {}
  fake.touched = []
  fake.waits = 0
}

const fakeLsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: (file) =>
      Effect.sync(() => {
        fake.touched.push(file)
        return fake.touchArrived
      }),
    waitDiagnostics: () =>
      Effect.gen(function* () {
        fake.waits++
        if (fake.waitDelayMs > 0) yield* Effect.sleep(fake.waitDelayMs)
        return fake.waitArrived
      }),
    diagnostics: () => Effect.sync(() => fake.diagnostics),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    typeDefinition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const it = testEffect(Layer.mergeAll(Config.defaultLayer, fakeLsp))

afterEach(async () => {
  resetFake()
  await disposeAllInstances()
})

const error = (message: string, line = 0): LSPClient.Diagnostic => ({
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
  severity: 1,
  source: "typescript",
  code: "TS2322",
  message,
})

const makeCtx = (sessionID: SessionIDType): Tool.Context => ({
  sessionID,
  messageID: MessageID.make(""),
  callID: "call_late-diagnostics",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const collect = (sessionID: SessionIDType, file: string, toolID = "write") =>
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const config = yield* Config.Service
    return yield* collectMutationDiagnostics({ lsp, config, ctx: makeCtx(sessionID), toolID, files: [file] })
  })

const readOracles = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = instance.worktree === "/" ? instance.directory : instance.worktree
    const artifact = path.join(getGraphDataRootInfo(root).dataRoot, "chimera", "oracle-results.jsonl")
    return yield* Effect.promise(() => readOracleResults(root, artifact, { sessionID, includePassing: true }))
  })

// Polls until the detached late fiber has produced `count` oracle records for
// the session (or the deadline passes) and returns the records read last.
const waitOracles = (sessionID: SessionIDType, count: number, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    let records: OracleRecord[] = []
    while (Date.now() < deadline) {
      records = yield* readOracles(sessionID)
      if (records.length >= count) return records
      yield* Effect.sleep(50)
    }
    return records
  })

describe("tool.mutation-late-diagnostics", () => {
  it.instance(
    "records the oracle inline and returns diagnostics when fresh results arrive within budget",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionID = SessionID.make("ses_late-fast")
        const file = path.join(test.directory, "fast.ts")
        fake.touchArrived = true
        fake.diagnostics = { [file]: [error("fast boom")] }

        const result = yield* collect(sessionID, file)

        expect(result.deferred).toBe(false)
        expect(result.diagnostics).toEqual(fake.diagnostics)
        expect(fake.touched).toEqual([file])
        expect(fake.waits).toBe(0)
        const oracles = yield* readOracles(sessionID)
        expect(oracles.length).toBe(1)
        expect(oracles[0].kind).toBe("lsp")
        expect(oracles[0].status).toBe("fail")
        expect(oracles[0].tool.id).toBe("write")
        expect((oracles[0].payload as { lsp: { diagnosticCount: number } }).lsp.diagnosticCount).toBe(1)
      }),
    { config: { diagnostics: { inlineBudgetMs: 50 } } },
  )

  it.instance(
    "returns immediately without diagnostics on a slow server and records the oracle from the late fiber",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionID = SessionID.make("ses_late-slow")
        const file = path.join(test.directory, "slow.ts")
        fake.touchArrived = false
        fake.waitDelayMs = 300
        fake.waitArrived = true
        fake.diagnostics = { [file]: [error("slow boom")] }

        const startedAt = Date.now()
        const result = yield* collect(sessionID, file)
        const elapsed = Date.now() - startedAt

        // The tool return path never waits for the slow server.
        expect(result.deferred).toBe(true)
        expect(result.diagnostics).toEqual({})
        expect(elapsed).toBeLessThan(250)
        // No oracle exists at detach time: the terminal record only lands on completion.
        expect(yield* readOracles(sessionID)).toHaveLength(0)

        const oracles = yield* waitOracles(sessionID, 1)
        expect(oracles.length).toBe(1)
        expect(oracles[0].kind).toBe("lsp")
        expect(oracles[0].status).toBe("fail")
        expect(oracles[0].tool.id).toBe("write")
        expect(oracles[0].tool.sessionID).toBe(sessionID)
        expect((oracles[0].payload as { lsp: { diagnosticCount: number } }).lsp.diagnosticCount).toBe(1)
        expect(fake.waits).toBe(1)
      }),
    { config: { diagnostics: { inlineBudgetMs: 50 } } },
  )

  it.instance(
    "drops the late result entirely when the file is mutated again before the wait completes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionID = SessionID.make("ses_late-stale")
        const file = path.join(test.directory, "stale.ts")
        fake.touchArrived = false
        fake.waitDelayMs = 300
        fake.waitArrived = true
        fake.diagnostics = { [file]: [error("stale boom")] }

        const result = yield* collect(sessionID, file)
        expect(result.deferred).toBe(true)
        // A second mutation bumps the generation while the fiber is waiting.
        bumpMutationVersion(file)

        // Give the fiber ample time to finish its wait and (wrongly) record.
        yield* Effect.sleep(900)
        expect(fake.waits).toBe(1)
        expect(yield* readOracles(sessionID)).toHaveLength(0)
      }),
    { config: { diagnostics: { inlineBudgetMs: 50 } } },
  )

  it.instance(
    "skips the late phase entirely when diagnostics.late is false",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionID = SessionID.make("ses_late-disabled")
        const file = path.join(test.directory, "disabled.ts")
        fake.touchArrived = false
        fake.waitDelayMs = 100
        fake.diagnostics = { [file]: [error("disabled boom")] }

        const result = yield* collect(sessionID, file)
        expect(result.deferred).toBe(false)
        expect(result.diagnostics).toEqual({})

        yield* Effect.sleep(400)
        expect(fake.waits).toBe(0)
        expect(yield* readOracles(sessionID)).toHaveLength(0)
      }),
    { config: { diagnostics: { late: false, inlineBudgetMs: 50 } } },
  )
})
