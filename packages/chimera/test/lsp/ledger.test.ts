import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import type * as LSPClient from "@/lsp/client"
import { Ledger } from "@/lsp/ledger"
import { SessionID } from "@/contracts/session-ids"
import { renderFileDiagnostics, renderOtherFileDiagnostics } from "@/tool/mutation-diagnostics"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Ledger.defaultLayer)

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

const warning = (message: string, line = 0): LSPClient.Diagnostic => ({ ...error(message, line), severity: 2 })

const file = "/project/src/ledger-fixture.ts"

describe("lsp.ledger", () => {
  it.instance("treats the same error at a different position as unchanged", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-position")
      yield* ledger.markShown({ sessionID, file, diagnostics: [error("boom", 3)] })
      const result = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("boom", 87)] })
      expect(result.fresh).toEqual([])
      expect(result.unchangedCount).toBe(1)
      expect(result.resolvedCount).toBe(0)
    }),
  )

  it.instance("counts fresh, unchanged, and resolved diagnostics", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-counts")
      yield* ledger.markShown({ sessionID, file, diagnostics: [error("old one"), error("old two")] })
      const result = yield* ledger.filterFresh({
        sessionID,
        file,
        diagnostics: [error("old two", 42), error("brand new")],
      })
      expect(result.fresh.map((diagnostic) => diagnostic.message)).toEqual(["brand new"])
      expect(result.unchangedCount).toBe(1)
      expect(result.resolvedCount).toBe(1)
    }),
  )

  it.instance("collapses same-message duplicates with a count", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-duplicates")
      yield* ledger.markShown({ sessionID, file, diagnostics: [error("dup", 1), error("dup", 5)] })
      const shrunk = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("dup", 9)] })
      expect(shrunk.fresh).toEqual([])
      expect(shrunk.unchangedCount).toBe(1)
      expect(shrunk.resolvedCount).toBe(1)
      const grown = yield* ledger.filterFresh({
        sessionID,
        file,
        diagnostics: [error("dup", 1), error("dup", 2), error("dup", 3)],
      })
      expect(grown.fresh).toHaveLength(1)
      expect(grown.unchangedCount).toBe(2)
      expect(grown.resolvedCount).toBe(0)
    }),
  )

  it.instance("does not share shown state across sessions", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const shown = SessionID.make("ses_ledger-session-a")
      const other = SessionID.make("ses_ledger-session-b")
      yield* ledger.markShown({ sessionID: shown, file, diagnostics: [error("boom")] })
      const result = yield* ledger.filterFresh({ sessionID: other, file, diagnostics: [error("boom")] })
      expect(result.fresh).toHaveLength(1)
      expect(result.unchangedCount).toBe(0)
    }),
  )

  it.instance("only markShown records shown state, filterFresh does not", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-mark-shown")
      const first = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("boom")] })
      expect(first.fresh).toHaveLength(1)
      const second = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("boom")] })
      expect(second.fresh).toHaveLength(1)
      yield* ledger.markShown({ sessionID, file, diagnostics: [error("boom")] })
      const third = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("boom")] })
      expect(third.fresh).toEqual([])
      expect(third.unchangedCount).toBe(1)
    }),
  )

  it.instance("reports resolved diagnostics once and clears the entry", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-resolved")
      yield* ledger.markShown({ sessionID, file, diagnostics: [error("one"), error("two")] })
      const cleared = yield* ledger.filterFresh({ sessionID, file, diagnostics: [] })
      expect(cleared.fresh).toEqual([])
      expect(cleared.unchangedCount).toBe(0)
      expect(cleared.resolvedCount).toBe(2)
      yield* ledger.markShown({ sessionID, file, diagnostics: [] })
      const after = yield* ledger.filterFresh({ sessionID, file, diagnostics: [] })
      expect(after.resolvedCount).toBe(0)
      const back = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("one")] })
      expect(back.fresh).toHaveLength(1)
    }),
  )

  it.instance("ignores non-error severities", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-severity")
      yield* ledger.markShown({ sessionID, file, diagnostics: [warning("careful")] })
      const result = yield* ledger.filterFresh({ sessionID, file, diagnostics: [warning("careful", 12)] })
      expect(result.fresh).toEqual([])
      expect(result.unchangedCount).toBe(0)
      expect(result.resolvedCount).toBe(0)
    }),
  )

  it.instance("evicts the oldest session once the session cap is exceeded", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const first = SessionID.make("ses_ledger-evict-first")
      yield* ledger.markShown({ sessionID: first, file, diagnostics: [error("boom")] })
      for (let i = 0; i < 128; i++) {
        yield* ledger.markShown({ sessionID: SessionID.make(`ses_ledger-evict-${i}`), file, diagnostics: [error("boom")] })
      }
      const evicted = yield* ledger.filterFresh({ sessionID: first, file, diagnostics: [error("boom")] })
      expect(evicted.fresh).toHaveLength(1)
    }),
  )

  it.instance(
    "bypasses the ledger when diagnostics.dedupe is false",
    () =>
      Effect.gen(function* () {
        const ledger = yield* Ledger.Service
        const sessionID = SessionID.make("ses_ledger-bypass")
        yield* ledger.markShown({ sessionID, file, diagnostics: [error("boom")] })
        const result = yield* ledger.filterFresh({ sessionID, file, diagnostics: [error("boom")] })
        expect(result.fresh).toHaveLength(1)
        expect(result.unchangedCount).toBe(0)
        expect(result.resolvedCount).toBe(0)
      }),
    { config: { diagnostics: { dedupe: false } } },
  )
})

describe("lsp.ledger.render", () => {
  it.instance("renders fresh details once, then unchanged and resolved lines", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-render")
      const render = (diagnostics: readonly LSPClient.Diagnostic[], label = "this file") =>
        renderFileDiagnostics({ ledger, sessionID, file, label, diagnostics })
      const first = yield* render([error("boom", 2)])
      expect(first).toContain("LSP errors detected in this file, please fix:")
      expect(first).toContain("ERROR [3:1] boom")
      const second = yield* render([error("boom", 9)])
      expect(second).toBe("\n\n本文件 1 条已知诊断未变化")
      const third = yield* render([])
      expect(third).toBe("\n\n此前 1 条诊断已全部消除")
      expect(yield* render([])).toBe("")
    }),
  )

  it.instance("renders only fresh details plus the unchanged tail", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-render-tail")
      yield* ledger.markShown({ sessionID, file, diagnostics: [error("known")] })
      const output = yield* renderFileDiagnostics({
        ledger,
        sessionID,
        file,
        label: "src/ledger-fixture.ts",
        diagnostics: [error("known", 4), error("fresh one", 7)],
      })
      expect(output).toContain("LSP errors detected in src/ledger-fixture.ts, please fix:")
      expect(output).toContain("ERROR [8:1] fresh one")
      expect(output).not.toContain("known")
      expect(output).toContain("(另有 1 条既有诊断未变化)")
    }),
  )

  it.instance("renders cross-file entries only while they are fresh", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-render-other")
      const other = "/project/src/other.ts"
      const render = (diagnostics: Record<string, readonly LSPClient.Diagnostic[]>) =>
        renderOtherFileDiagnostics({ ledger, sessionID, diagnostics, suppressed: new Set() })
      const first = yield* render({ [other]: [error("cross file boom")] })
      expect(first).toContain("LSP errors detected in other files:")
      expect(first).toContain("ERROR [1:1] cross file boom")
      expect(yield* render({ [other]: [error("cross file boom", 30)] })).toBe("")
    }),
  )

  it.instance("suppresses cross-file entries for suppressed files and collapses overflow", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger.Service
      const sessionID = SessionID.make("ses_ledger-render-other-cap")
      const suppressed = "/project/src/suppressed.ts"
      const files = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `/project/src/${name}.ts`)
      const diagnostics = Object.fromEntries([
        [suppressed, [error("suppressed boom")]],
        ...files.map((file) => [file, [error(`boom in ${file}`)]]),
      ])
      const first = yield* renderOtherFileDiagnostics({ ledger, sessionID, diagnostics, suppressed: new Set([suppressed]) })
      expect(first).not.toContain("suppressed boom")
      expect(first).toContain("boom in /project/src/a.ts")
      expect(first).toContain("boom in /project/src/e.ts")
      expect(first).not.toContain("boom in /project/src/f.ts")
      expect(first).toContain("(+2 more files with new errors)")
      // Overflow files were not marked shown: a later mutation still pushes them.
      const second = yield* renderOtherFileDiagnostics({
        ledger,
        sessionID,
        diagnostics: Object.fromEntries(files.slice(5).map((file) => [file, diagnostics[file]!])),
        suppressed: new Set(),
      })
      expect(second).toContain("boom in /project/src/f.ts")
      expect(second).toContain("boom in /project/src/g.ts")
    }),
  )
})
