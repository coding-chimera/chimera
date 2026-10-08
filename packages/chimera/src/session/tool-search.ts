import { Context, Layer } from "effect"
import { SessionID } from "./schema"

// Progressive tool disclosure (inspired by OpenAI Codex `tool_search`): the
// tools below stay registered but are omitted from the model-facing tool list
// until the model discovers them through the `tool_search` tool and reveals
// them for its session. This cuts per-request tool-schema tokens; the
// permission system stays the kill switch for each tool.
//
// `summary` is the searchable one-line description surfaced by tool_search
// results. It is deliberately separate from the tool's full .txt description:
// the full text is sent over the wire only once the tool is revealed, so
// search must stay cheap and stable.
export type DeferredTool = {
  readonly id: string
  readonly summary: string
}

export const DEFERRED_TOOLS: readonly DeferredTool[] = [
  { id: "browser_open", summary: "Open an absolute HTTP(S) URL in a controlled browser tab and return its tab ID." },
  {
    id: "browser_snapshot",
    summary: "Capture an accessibility snapshot of a browser tab to discover interactive refs before acting.",
  },
  { id: "browser_click", summary: "Click exactly one generation-scoped ref from the latest browser snapshot." },
  { id: "browser_type", summary: "Replace the value of a browser form control identified by a snapshot ref." },
  { id: "browser_screenshot", summary: "Capture a PNG screenshot of the current browser tab as visual evidence." },
  { id: "browser_close", summary: "Close a browser tab, or all browser state for the current agent session." },
  {
    id: "lsp",
    summary:
      "Language-server code intelligence: goToDefinition, typeDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, call hierarchy, incomingCalls, outgoingCalls.",
  },
  {
    id: "subagent_model_routes",
    summary: "Inspect the concrete provider/model routes currently visible for a subagent model identity.",
  },
  {
    id: "subagent_model_schedule",
    summary: "Inspect cost-aware subagent model recommendations by workload before dispatching a subagent.",
  },
  {
    id: "subagent_model_prefer",
    summary: "Record an explicit subagent model-route preference for a workload archetype.",
  },
  {
    id: "subagent_model_suppress",
    summary: "Record a suppressed subagent model route so the scheduler avoids it.",
  },
] as const

export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set(DEFERRED_TOOLS.map((tool) => tool.id))

// Pure membership check for consumers that cannot (or should not) reach the
// service: the unknown-tool error sites in llm.ts / codex-responses.ts.
export function isDeferredTool(id: string) {
  return DEFERRED_TOOL_IDS.has(id)
}

export const DEFERRED_TOOL_HINT =
  " It is registered but deferred — call `tool_search` with a keyword to reveal it."

export type Candidate = {
  readonly id: string
  readonly description: string
}

export type Match = {
  readonly id: string
  readonly score: number
}

export const MAX_REVEAL_LIMIT = 20
export const DEFAULT_REVEAL_LIMIT = 8

// Keyword scoring over the ~11-entry deferred catalog: lowercase the query,
// split on whitespace, drop glob characters, then per candidate score
// 3×(term in id) + 1×(term in description) + a 1-point bonus when the id
// starts with the term. Zero-score candidates are dropped; results sort by
// score descending with id ascending as tie-break and cap at limit.
// Deliberately not BM25: with an 11-tool, human-curated catalog there is no
// corpus statistics to exploit (no IDF signal, no length normalization worth
// paying for); substring scoring is deterministic and test-stable.
export function scoreDeferred(query: string, limit: number, candidates: readonly Candidate[]): Match[] {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[*?]+/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    ),
  )
  if (terms.length === 0) return []
  const cap = Math.max(0, Math.min(Math.floor(limit), MAX_REVEAL_LIMIT))
  const scored = candidates
    .map((candidate) => {
      const id = candidate.id.toLowerCase()
      const description = candidate.description.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (id.includes(term)) score += 3
        if (description.includes(term)) score += 1
        if (id.startsWith(term)) score += 1
      }
      return { id: candidate.id, score }
    })
    .filter((match) => match.score > 0)
  return scored
    .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, cap)
}

// Module-level reveal state rather than layer-closure state: several default
// layer sites (SessionPrompt, ToolRegistry, app-runtime, test harnesses) can
// materialize more than one Service instance in a process, and a reveal made
// through one must be visible to resolveTools through another. Keyed by
// globally-unique SessionID; losing reveals on process restart is accepted v1
// behavior (a fresh session re-discovers via tool_search).
const revealedState = new Map<string, Set<string>>()

export function revealed(sessionID: SessionID): ReadonlySet<string> {
  return revealedState.get(sessionID) ?? EMPTY_SET
}

const EMPTY_SET: ReadonlySet<string> = new Set()

export function reveal(sessionID: SessionID, ids: readonly string[]) {
  const revealedIds = revealedState.get(sessionID) ?? new Set<string>()
  for (const id of ids) {
    if (isDeferredTool(id)) revealedIds.add(id)
  }
  revealedState.set(sessionID, revealedIds)
}

export interface Interface {
  readonly isDeferred: (id: string) => boolean
  readonly revealed: (sessionID: SessionID) => ReadonlySet<string>
  readonly reveal: (sessionID: SessionID, ids: readonly string[]) => void
  readonly search: (input: { query: string; limit: number; candidates: readonly Candidate[] }) => Match[]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionToolSearch") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    isDeferred: isDeferredTool,
    revealed,
    reveal,
    search: (input) => scoreDeferred(input.query, input.limit, input.candidates),
  }),
)

export const defaultLayer = layer

export * as ToolSearch from "./tool-search"
