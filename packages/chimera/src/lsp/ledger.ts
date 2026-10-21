import { createHash } from "crypto"
import { Context, Effect, Layer } from "effect"
import * as LSPClient from "./client"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { ConfigDiagnostics } from "@/config/diagnostics"
import type { SessionID } from "@/contracts/session-ids"

// Bounded soft state with LRU-only cleanup: session IDs are ULIDs and never
// recur, so a stale entry costs only memory until evicted. (A Bus subscription
// for session deletion was considered and dropped: it must subscribe on the
// composition's single ambient Bus instance, which is not reachable from every
// layer composition, and Session.Event.Deleted is a SyncEvent that does not
// flow plainly over Bus.) Both maps are insertion-ordered and touched entries
// move to the end, so eviction from the front is LRU.
const MAX_SESSIONS = 128
const MAX_FILES_PER_SESSION = 512

// Diagnostics rendering (`Diagnostic.report`) only ever shows errors, so the
// ledger tracks exactly that subset: warnings/hints are neither counted as
// unchanged nor block the resolved signal.
const ERROR_SEVERITY = 1

type FileLedger = {
  // Identity set of the diagnostics last shown to the model, keyed by
  // fingerprint with a duplicate count (same-message errors collapse).
  fingerprints: Map<string, number>
  shownAt: number
}

type State = {
  sessions: Map<string, Map<string, FileLedger>>
}

export type FreshResult = {
  fresh: LSPClient.Diagnostic[]
  unchangedCount: number
  resolvedCount: number
}

export interface Interface {
  readonly filterFresh: (input: {
    sessionID: SessionID
    file: string
    diagnostics: readonly LSPClient.Diagnostic[]
  }) => Effect.Effect<FreshResult>
  readonly markShown: (input: {
    sessionID: SessionID
    file: string
    diagnostics: readonly LSPClient.Diagnostic[]
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LspDiagnosticsLedger") {}

// Identity deliberately excludes line/column: edits shift the same error
// across lines, and an IDE would not re-announce a red squiggly just because
// it moved. The cost is that two same-message errors in one file collapse
// into one identity, mitigated by the duplicate count.
function fingerprint(diagnostic: LSPClient.Diagnostic) {
  return createHash("sha256")
    .update(
      [diagnostic.severity ?? ERROR_SEVERITY, diagnostic.source ?? "", diagnostic.code ?? "", diagnostic.message].join(
        "\u0000",
      ),
    )
    .digest("hex")
}

function errorCounts(diagnostics: readonly LSPClient.Diagnostic[]) {
  const counts = new Map<string, number>()
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== ERROR_SEVERITY) continue
    const key = fingerprint(diagnostic)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function evictFront<K, V>(map: Map<K, V>, max: number) {
  for (const key of map.keys()) {
    if (map.size <= max) return
    map.delete(key)
  }
}

function touchSession(state: State, sessionID: string) {
  const existing = state.sessions.get(sessionID)
  if (existing) {
    state.sessions.delete(sessionID)
    state.sessions.set(sessionID, existing)
    return existing
  }
  const created = new Map<string, FileLedger>()
  state.sessions.set(sessionID, created)
  evictFront(state.sessions, MAX_SESSIONS)
  return created
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LspLedger.state")(function* () {
        return { sessions: new Map() }
      }),
    )

    const dedupeEnabled = Effect.fnUntraced(function* () {
      const cfg = yield* config.get()
      return cfg.diagnostics?.dedupe ?? ConfigDiagnostics.DEFAULT_DEDUPE
    })

    const filterFresh = Effect.fn("LspLedger.filterFresh")(function* (input: {
      sessionID: SessionID
      file: string
      diagnostics: readonly LSPClient.Diagnostic[]
    }) {
      const errors = input.diagnostics.filter((diagnostic) => diagnostic.severity === ERROR_SEVERITY)
      // Bypass: every error is "fresh" and nothing is tracked, so callers
      // render the full list exactly as they did before dedupe existed.
      if (!(yield* dedupeEnabled())) return { fresh: errors, unchangedCount: 0, resolvedCount: 0 }

      const s = yield* InstanceState.get(state)
      const prior = s.sessions.get(input.sessionID)?.get(AppFileSystem.normalizePath(input.file))
      const fresh: LSPClient.Diagnostic[] = []
      const seen = new Map<string, number>()
      let unchangedCount = 0
      for (const diagnostic of errors) {
        const key = fingerprint(diagnostic)
        const occurrences = seen.get(key) ?? 0
        seen.set(key, occurrences + 1)
        if (occurrences < (prior?.fingerprints.get(key) ?? 0)) {
          unchangedCount++
          continue
        }
        fresh.push(diagnostic)
      }
      let resolvedCount = 0
      for (const [key, count] of prior?.fingerprints ?? []) {
        resolvedCount += Math.max(0, count - (seen.get(key) ?? 0))
      }
      return { fresh, unchangedCount, resolvedCount }
    })

    const markShown = Effect.fn("LspLedger.markShown")(function* (input: {
      sessionID: SessionID
      file: string
      diagnostics: readonly LSPClient.Diagnostic[]
    }) {
      if (!(yield* dedupeEnabled())) return
      const s = yield* InstanceState.get(state)
      const files = touchSession(s, input.sessionID)
      const key = AppFileSystem.normalizePath(input.file)
      const fingerprints = errorCounts(input.diagnostics)
      files.delete(key)
      if (fingerprints.size === 0) {
        evictFront(files, MAX_FILES_PER_SESSION)
        return
      }
      files.set(key, { fingerprints, shownAt: Date.now() })
      evictFront(files, MAX_FILES_PER_SESSION)
    })

    return Service.of({ filterFresh, markShown })
  }),
)

// Config is self-provided (its content is identical app-wide). No Bus
// dependency: cleanup is LRU-only, see the note at the top of this file.
export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Ledger from "./ledger"
