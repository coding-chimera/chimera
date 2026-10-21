import { Cause, Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import * as LSPClient from "@/lsp/client"
import type { LSP } from "@/lsp/lsp"
import { Diagnostic } from "@/lsp/diagnostic"
import type { Ledger } from "@/lsp/ledger"
import type { SessionID } from "@/contracts/session-ids"
import type { Tool } from "@/tool/tool"
import { Config } from "@/config/config"
import { ConfigDiagnostics } from "@/config/diagnostics"
import { Chimera } from "@/chimera"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import {
  formatProbeDetailed,
  inlinePropagationProbe,
  predesignDeclaredFiles,
  type ProbeRenderedEntry,
  type ProbeResult,
  type PropagationTarget,
} from "@/chimera/propagation-probe"

// Unified mutation-tail diagnostics rendering (specs/lsp-push-diagnostics.md
// B1+B2): the ledger governs DISPLAY ONLY — tools keep recording the full
// diagnostics into the lsp oracle with unchanged pass/fail semantics. Tail
// order: own-file diagnostics, then the propagation probe block (fresh LSP
// details hang under its rendered entries), then the cross-file block. The
// probe runs FIRST because its rendered entries suppress the cross-file block.

const log = Log.create({ service: "tool.mutation-diagnostics" })

const CURRENT_FILE_LABEL = "this file"
const MAX_PROJECT_DIAGNOSTICS_FILES = 5
const MAX_DETAILS_PER_ENTRY = 3

function unchangedLine(label: string, unchangedCount: number) {
  return label === CURRENT_FILE_LABEL
    ? `本文件 ${unchangedCount} 条已知诊断未变化`
    : `${label}：${unchangedCount} 条已知诊断未变化`
}

function resolvedLine(label: string, resolvedCount: number) {
  return label === CURRENT_FILE_LABEL
    ? `此前 ${resolvedCount} 条诊断已全部消除`
    : `${label}：此前 ${resolvedCount} 条诊断已全部消除`
}

function unchangedTail(unchangedCount: number) {
  return unchangedCount > 0 ? `\n(另有 ${unchangedCount} 条既有诊断未变化)` : ""
}

/**
 * Renders the diagnostics tail for one file touched by a mutation.
 *
 * - fresh errors -> fresh details only, plus a trailing unchanged-count line
 * - no fresh, known errors -> single "unchanged" line
 * - previously shown, now zero -> single "resolved" line (pass evidence)
 * - nothing at all -> empty string
 *
 * `markShown` is only invoked when something was actually rendered for the
 * file (or when a resolved signal clears stale shown-state).
 */
export const renderFileDiagnostics = Effect.fnUntraced(function* (input: {
  ledger: Ledger.Interface
  sessionID: SessionID
  file: string
  label: string
  diagnostics: readonly LSPClient.Diagnostic[]
}) {
  const { fresh, unchangedCount, resolvedCount } = yield* input.ledger.filterFresh({
    sessionID: input.sessionID,
    file: input.file,
    diagnostics: input.diagnostics,
  })
  const markShown = input.ledger.markShown({
    sessionID: input.sessionID,
    file: input.file,
    diagnostics: input.diagnostics,
  })
  if (fresh.length > 0) {
    const block = Diagnostic.report(input.file, fresh)
    if (!block) return ""
    yield* markShown
    return `\n\nLSP errors detected in ${input.label}, please fix:\n${block}${unchangedTail(unchangedCount)}`
  }
  if (unchangedCount > 0) {
    yield* markShown
    return `\n\n${unchangedLine(input.label, unchangedCount)}`
  }
  if (resolvedCount > 0) {
    yield* markShown
    return `\n\n${resolvedLine(input.label, resolvedCount)}`
  }
  return ""
})

/**
 * Fresh-error details for the probe's RENDERED entries, keyed by the entry's
 * absolute normalized file. Details reuse `Diagnostic.pretty`, bounded to
 * `MAX_DETAILS_PER_ENTRY` lines per entry plus a `+N more` overflow line. A
 * file whose details are displayed advances its ledger entry (markShown);
 * the overflow beyond the cap is deliberately marked too — the file surfaces
 * under the probe entry and the compact block keeps the byte cost bounded.
 * Suppression downstream uses only these rendered entries, never the full
 * computed walk set (unrendered entries are unknown to the model).
 */
const probeEntryDetails = Effect.fnUntraced(function* (input: {
  ledger: Ledger.Interface
  sessionID: SessionID
  diagnostics: Record<string, readonly LSPClient.Diagnostic[]>
  renderedEntries: readonly ProbeRenderedEntry[]
}) {
  const details = yield* Effect.forEach(
    input.renderedEntries,
    Effect.fnUntraced(function* (entry: ProbeRenderedEntry) {
      const diagnostics = input.diagnostics[entry.file] ?? []
      if (diagnostics.length === 0) return undefined
      const { fresh } = yield* input.ledger.filterFresh({
        sessionID: input.sessionID,
        file: entry.file,
        diagnostics,
      })
      if (fresh.length === 0) return undefined
      yield* input.ledger.markShown({ sessionID: input.sessionID, file: entry.file, diagnostics })
      return {
        file: entry.file,
        lines: [
          ...fresh.slice(0, MAX_DETAILS_PER_ENTRY).map((diagnostic) => Diagnostic.pretty(diagnostic)),
          ...(fresh.length > MAX_DETAILS_PER_ENTRY ? [`+${fresh.length - MAX_DETAILS_PER_ENTRY} more`] : []),
        ],
      }
    }),
  )
  return new Map(details.flatMap((item) => (item === undefined ? [] : [[item.file, item.lines]])))
})

function renderProbeBlock(probe: ProbeResult, details: ReadonlyMap<string, readonly string[]>) {
  if (details.size === 0) return probe.text
  const head = formatProbeDetailed(
    probe.dependentCount,
    probe.renderedEntries.map((entry) => ({ label: entry.label, details: details.get(entry.file) ?? [] })),
  )
  return probe.scopeText ? `${head}\n${probe.scopeText}` : head
}

/**
 * The cross-file "other files" block: fresh-error details for files the
 * mutation did not touch, minus predesign-declared files (the model already
 * said it intends to change them) and minus files named by the probe's
 * rendered entries (their details hang under the probe entry instead).
 * Bounded: files beyond `MAX_PROJECT_DIAGNOSTICS_FILES` collapse into a
 * `(+N more files with new errors)` line and are NOT marked shown, so a
 * later mutation can still push them. Zero fresh occupies zero bytes; a
 * resolved file silently clears its ledger entry so a later re-occurrence
 * of the same error counts as fresh again.
 */
export const renderOtherFileDiagnostics = Effect.fnUntraced(function* (input: {
  ledger: Ledger.Interface
  sessionID: SessionID
  diagnostics: Record<string, readonly LSPClient.Diagnostic[]>
  suppressed: ReadonlySet<string>
}) {
  const declared = yield* predesignDeclaredFiles(input.sessionID)
  const blocks: string[] = []
  let overflow = 0
  for (const [file, diagnostics] of Object.entries(input.diagnostics)) {
    if (input.suppressed.has(file) || declared.includes(file)) continue
    const { fresh, unchangedCount, resolvedCount } = yield* input.ledger.filterFresh({
      sessionID: input.sessionID,
      file,
      diagnostics,
    })
    if (fresh.length === 0) {
      if (resolvedCount > 0) {
        yield* input.ledger.markShown({ sessionID: input.sessionID, file, diagnostics })
      }
      continue
    }
    if (blocks.length >= MAX_PROJECT_DIAGNOSTICS_FILES) {
      overflow++
      continue
    }
    const block = Diagnostic.report(file, fresh)
    if (!block) continue
    yield* input.ledger.markShown({ sessionID: input.sessionID, file, diagnostics })
    blocks.push(`${block}${unchangedTail(unchangedCount)}`)
  }
  if (blocks.length === 0) return ""
  const collapsed = overflow > 0 ? `\n(+${overflow} more files with new errors)` : ""
  return `\n\nLSP errors detected in other files:\n${blocks.join("\n")}${collapsed}`
})

/**
 * The unified mutation tail shared by edit/write/apply_patch/ast_edit:
 * own-file ledger rendering, the propagation probe block with inline LSP
 * details under its rendered entries, and the bounded cross-file block.
 * `diagnostics` is the full LSP diagnostics map (absolute normalized paths),
 * which the oracle already recorded untouched before this helper runs.
 * `config` is the define-level captured Config service (execute bodies must
 * stay requirement-free). `diagnostics.crossFile: false` keeps the own-file
 * and probe rendering and drops both cross-file surfaces.
 */
export const renderMutationTail = Effect.fnUntraced(function* (input: {
  ledger: Ledger.Interface
  config: Config.Interface
  sessionID: SessionID
  files: Array<{ file: string; label: string }>
  diagnostics: Record<string, readonly LSPClient.Diagnostic[]>
  probeTargets: PropagationTarget[]
}) {
  // Probe first: a degraded probe (500ms budget, silent) leaves
  // renderedEntries empty and the cross-file filter falls back to
  // predesign-declared files only.
  const probe = yield* inlinePropagationProbe(input.probeTargets, input.sessionID)
  const crossFile = (yield* input.config.get()).diagnostics?.crossFile ?? ConfigDiagnostics.DEFAULT_CROSS_FILE
  const own = yield* Effect.forEach(input.files, (entry) =>
    renderFileDiagnostics({
      ledger: input.ledger,
      sessionID: input.sessionID,
      file: entry.file,
      label: entry.label,
      diagnostics: input.diagnostics[AppFileSystem.normalizePath(entry.file)] ?? [],
    }),
  )
  const probeBlock = crossFile
    ? renderProbeBlock(
        probe,
        yield* probeEntryDetails({
          ledger: input.ledger,
          sessionID: input.sessionID,
          diagnostics: input.diagnostics,
          renderedEntries: probe.renderedEntries,
        }),
      )
    : probe.text
  const otherFiles = crossFile
    ? yield* renderOtherFileDiagnostics({
        ledger: input.ledger,
        sessionID: input.sessionID,
        diagnostics: input.diagnostics,
        suppressed: new Set([
          ...input.files.map((entry) => AppFileSystem.normalizePath(entry.file)),
          ...probe.renderedEntries.map((entry) => entry.file),
        ]),
      })
    : ""
  return `${own.join("")}${probeBlock ? `\n\n${probeBlock}` : ""}${otherFiles}`
})

// Total budget for the detached late-diagnostics wait (B3, spec section 6),
// measured from the start of the mutation tail. The inline phase consumes its
// own small budget first; the late fiber resumes with whatever remains.
const LATE_TOTAL_BUDGET_MS = 12_000

// Bounded LRU of per-file mutation generations: every mutation tail bumps the
// files it touched, and a detached late fiber drops its result entirely when
// the captured generation no longer matches (stale data never enters the
// session). Keys are normalized absolute paths; entries are tiny integers and
// the map evicts its oldest entry past the cap.
const MAX_VERSION_ENTRIES = 1024
const mutationVersions = new Map<string, number>()

/** Bumps and returns the mutation generation for one file. */
export function bumpMutationVersion(file: string) {
  const key = AppFileSystem.normalizePath(file)
  const next = (mutationVersions.get(key) ?? 0) + 1
  mutationVersions.delete(key)
  mutationVersions.set(key, next)
  if (mutationVersions.size > MAX_VERSION_ENTRIES) {
    const oldest = mutationVersions.keys().next().value
    if (oldest !== undefined) mutationVersions.delete(oldest)
  }
  return next
}

function currentMutationVersion(file: string) {
  return mutationVersions.get(AppFileSystem.normalizePath(file))
}

export type MutationDiagnosticsResult = {
  /** Full LSP diagnostics map; empty when the wait detached to the late phase. */
  diagnostics: Record<string, LSPClient.Diagnostic[]>
  /** True when a detached fiber is still waiting and will record the oracle late. */
  deferred: boolean
}

/**
 * The unified mutation-tail diagnostics COLLECTION shared by
 * edit/write/apply_patch/ast_edit (B3, specs/lsp-push-diagnostics.md section
 * 6): syncs the touched documents, waits for fresh diagnostics under the
 * inline budget, and records the lsp oracle. The document-mode wait completes
 * when the edited file's diagnostics turn fresh OR when any cross-file
 * publishDiagnostics arrived and settled (client.ts waitForCrossFileSettle),
 * so a cross-file break surfaces inline even when the edited file itself is
 * clean; the late-phase `waitDiagnostics` resume shares the same criterion.
 * Two phases:
 *
 * - Fresh results within `diagnostics.inlineBudgetMs` -> the diagnostics map
 *   is returned and the oracle is recorded inline, exactly as before B3.
 * - Budget expired and `diagnostics.late` enabled -> `{ diagnostics: {},
 *   deferred: true }` is returned immediately (the caller renders no
 *   diagnostics block; the probe block keeps its own budget) and a fiber
 *   detached fiber keeps waiting up to LATE_TOTAL_BUDGET_MS. On completion it
 *   records the same oracle late — dropped entirely when any touched file was
 *   mutated again meanwhile. No oracle is recorded at detach time: the
 *   terminal record at completion is the sanctioned pattern (see
 *   packages/chimera/AGENTS.md "Detached tool work vs. oracle recording").
 * - Budget expired and `diagnostics.late` disabled -> no diagnostics and no
 *   oracle for that mutation (same visible outcome as an absent server).
 *
 * `files` is the oracle payload's file list and the version-counter domain;
 * `touchFiles` (default: `files`) is the subset to didOpen/didChange and wait
 * on (edit passes the pre-rename path set minus deletes). The late fiber is
 * forked with `Effect.forkDetach` (the codebase's detached-work pattern:
 * config.ts, v2/session.ts): tool execute bodies run inside a per-call
 * `run.promise`, so any call-scoped fork would die with the tool return, and
 * threading a define-level `Scope.Scope` through `Tool.define` would widen
 * the four tools' requirement types and break existing harnesses. The fiber is
 * bounded by the ~12s total budget and catches every cause, so it always
 * self-terminates.
 */
export const collectMutationDiagnostics = Effect.fnUntraced(function* (input: {
  lsp: LSP.Interface
  config: Config.Interface
  ctx: Tool.Context
  toolID: string
  files: string[]
  touchFiles?: string[]
}) {
  const startedAt = Date.now()
  const cfg = yield* input.config.get()
  const inlineBudgetMs = cfg.diagnostics?.inlineBudgetMs ?? ConfigDiagnostics.DEFAULT_INLINE_BUDGET_MS
  const late = cfg.diagnostics?.late ?? ConfigDiagnostics.DEFAULT_LATE
  const touchFiles = input.touchFiles ?? input.files
  // Bump generations up front so any still-pending late fiber for these files
  // (from a previous mutation) drops its result when it completes.
  const capturedVersions = new Map(touchFiles.map((file) => [AppFileSystem.normalizePath(file), bumpMutationVersion(file)]))

  const recordOracle = Effect.fnUntraced(function* (diagnostics: Record<string, LSPClient.Diagnostic[]>) {
    const diagnosticCount = Chimera.countOracleDiagnostics(diagnostics)
    yield* Chimera.recordToolOracle({
      kind: "lsp",
      toolID: input.toolID,
      ctx: input.ctx,
      status: diagnosticCount === 0 ? "pass" : "fail",
      payload: {
        lsp: {
          diagnostics,
          files: input.files,
          diagnosticCount,
        },
      },
    }).pipe(Effect.ignore)
  })

  const arrived =
    touchFiles.length === 0 ||
    (yield* Effect.forEach(touchFiles, (file) => input.lsp.touchFile(file, "document", { waitBudgetMs: inlineBudgetMs }), {
      concurrency: "unbounded",
    }).pipe(Effect.map((results) => results.every(Boolean))))
  if (arrived) {
    const diagnostics = yield* input.lsp.diagnostics()
    yield* recordOracle(diagnostics)
    return { diagnostics, deferred: false }
  }
  if (!late || capturedVersions.size === 0) return { diagnostics: {}, deferred: false }

  const lateWait = Effect.gen(function* () {
    const budgetMs = Math.max(0, LATE_TOTAL_BUDGET_MS - (Date.now() - startedAt))
    yield* Effect.forEach(
      touchFiles,
      (file) => input.lsp.waitDiagnostics({ file, mode: "document", budgetMs }),
      { concurrency: "unbounded" },
    )
    const stale = [...capturedVersions].some(([file, version]) => currentMutationVersion(file) !== version)
    if (stale) {
      log.info("dropping stale late diagnostics", { toolID: input.toolID, files: touchFiles })
      return
    }
    yield* recordOracle(yield* input.lsp.diagnostics())
  })
  yield* lateWait.pipe(
    // The fiber must never fail uncaught; defects (e.g. a torn-down instance)
    // land here and are logged instead.
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.sync(() => log.error("late diagnostics fiber failed", { toolID: input.toolID, cause: Cause.pretty(cause) })),
    ),
    Effect.forkDetach,
  )
  return { diagnostics: {}, deferred: true }
})
