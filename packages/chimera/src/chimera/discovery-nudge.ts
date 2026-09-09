import { Effect } from "effect"
import { isInitialized } from "@/graph"
import type { SessionID } from "@/session/schema"

/**
 * Tool-side graph discovery nudge, appended to text-exploration tool results.
 *
 * Complements (does not replace) the per-turn hint in the runtime-context block
 * (`prompt-context.ts`): that hint only renders at the start of a user turn, so
 * long single-turn runs that cross the exploration threshold mid-turn never see
 * it. This module counts text-exploration and graph-query tool calls per session
 * and emits the hint line once, at the site where the model is actually exploring
 * inefficiently — the result tail of grep/glob/read.
 */
export const GRAPH_DISCOVERY_HINT =
  'Graph discovery hint: this project is indexed. One chimera_search or chimera_impact call can replace several grep/read steps for symbol, caller, reference, and impact questions; chimera_file_symbols answers "what is in this file".'

const MIN_TEXT_EXPLORATION_CALLS = 4
const MAX_SESSION_ENTRIES = 500

type SessionNudgeState = {
  textCalls: number
  graphCalls: number
  hinted: boolean
}

const sessions = new Map<SessionID, SessionNudgeState>()

function stateFor(sessionID: SessionID) {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  if (sessions.size >= MAX_SESSION_ENTRIES) {
    const oldest = sessions.keys().next()
    if (!oldest.done) sessions.delete(oldest.value)
  }
  const state = { textCalls: 0, graphCalls: 0, hinted: false }
  sessions.set(sessionID, state)
  return state
}

/**
 * Records one text-exploration tool call and returns the hint line exactly once
 * per session: when the session has crossed the minimum text-call threshold,
 * has never used a graph-query tool, and the project graph is initialized.
 * Probe failure degrades to "not initialized" (no hint).
 */
export const noteTextTool = Effect.fnUntraced(function* (sessionID: SessionID, rootDir?: string) {
  const state = stateFor(sessionID)
  state.textCalls += 1
  if (state.textCalls < MIN_TEXT_EXPLORATION_CALLS || state.graphCalls > 0 || state.hinted) return undefined
  if (rootDir === undefined) return undefined
  const initialized = yield* Effect.sync(() => isInitialized(rootDir)).pipe(
    Effect.catchDefect(() => Effect.succeed(false)),
  )
  if (!initialized) return undefined
  state.hinted = true
  return GRAPH_DISCOVERY_HINT
})

/**
 * Records one graph-query tool call, permanently suppressing any future hint
 * for the session.
 */
export const noteGraphQuery = Effect.fnUntraced(function* (sessionID: SessionID) {
  stateFor(sessionID).graphCalls += 1
})

export * as DiscoveryNudge from "./discovery-nudge"