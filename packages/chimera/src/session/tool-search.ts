import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { SessionID } from "@/contracts/session-ids"
import { ToolRevealTable } from "@/storage/tables/session.sql"

// Progressive tool disclosure (inspired by OpenAI Codex `tool_search`): the
// tools below stay registered but are omitted from the model-facing tool list
// until the model discovers them through the `tool_search` tool and reveals
// them for its session. This cuts per-request tool-schema tokens; the
// permission system stays the kill switch for each tool.
//
// Phase 2: revealing no longer appends the tool to the request tool array.
// The revealed set rides the tail `revealedTools` runtime-context section
// (id + compact signature + summary) and the model calls revealed tools
// directly by name; the repair path executes them. Reveals older than the
// newest completed compaction summary are "promoted" back into the array
// (the provider cache is rebuilt there anyway).
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
  {
    id: "chimera_obligations_sync",
    summary: "Persist Chimera audit findings as tracked obligations for durable cross-turn follow-up.",
  },
  {
    id: "chimera_obligation_claim",
    summary: "Claim one tracked Chimera obligation before editing its target.",
  },
  {
    id: "chimera_obligation_resolve",
    summary: "Resolve one tracked Chimera obligation with a note stating the evidence that closed it.",
  },
  {
    id: "chimera_obligation_ignore",
    summary: "Ignore one tracked Chimera obligation with a required reason (skipped, not completed).",
  },
  {
    id: "chimera_oracle_recent",
    summary: "List recent Chimera oracle results captured from shell commands and LSP diagnostics.",
  },
  {
    id: "chimera_oracle_get",
    summary: "Retrieve one captured Chimera oracle result by typed ref for its full shell or LSP evidence.",
  },
] as const

export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set(DEFERRED_TOOLS.map((tool) => tool.id))

// Pure membership check for consumers that cannot (or should not) reach the
// service: the unknown-tool error sites in llm.ts / codex-responses.ts.
export function isDeferredTool(id: string) {
  return DEFERRED_TOOL_IDS.has(id)
}

export const DEFERRED_TOOL_HINT =
  " It is registered but deferred — reveal it with `tool_search`, then call it directly by name."

// tool_search is the gateway to the deferred catalog: it must never be
// deferred itself, it must never leave the model-visible tool set (llm.ts
// resolveTools re-includes it unconditionally), and its unknown-tool guidance
// must never be self-referential. Observed self-lock: the model calls a
// deferred tool, is told "reveal it with tool_search", then calls tool_search
// under an alias (`tool-search`, `ToolSearch`) which misses the registered
// name — the intercept guidance for the miss pointed back at tool_search and
// the model could never reach it. Alias normalization folds separator/case
// variants so the repair paths can canonicalize them into a real call.
export const TOOL_SEARCH_ID = "tool_search"

export function isToolSearchAlias(id: string) {
  return id.toLowerCase().replace(/[-\s]+/g, "_") === TOOL_SEARCH_ID
}

// Message for the unknown-tool intercept sites (AI SDK repair, Codex Responses
// executor, workflow executor): deferred ids keep the reveal guidance, a
// misnamed tool_search call gets the exact invocation contract instead of a
// pointer back at itself.
export function unknownToolGuidance(id: string) {
  if (isToolSearchAlias(id))
    return `Unknown tool: ${id}. The tool-discovery gateway is named exactly \`${TOOL_SEARCH_ID}\` — call it as \`${TOOL_SEARCH_ID}\` with { "query": "<keywords>" } to search and reveal deferred tools. It is always in your tool list; it is never deferred and cannot be revealed.`
  return `Unknown tool: ${id}${isDeferredTool(id) ? DEFERRED_TOOL_HINT : ""}`
}

export function deferredSummary(id: string) {
  return DEFERRED_TOOLS.find((tool) => tool.id === id)?.summary
}

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

// Keyword scoring over the human-curated deferred catalog: lowercase the query,
// split on whitespace, drop glob characters, then per candidate score
// 3×(term in id) + 1×(term in description) + a 1-point bonus when the id
// starts with the term. Zero-score candidates are dropped; results sort by
// score descending with id ascending as tie-break and cap at limit.
// Deliberately not BM25: with a curated catalog there is no
// corpus statistics to exploit (no IDF signal, no length normalization worth
// paying for); substring scoring is deterministic and test-stable.
export function scoreDeferred(query: string, limit: number, candidates: readonly Candidate[]): Match[] {
  const terms = Array.from(new Set(query.toLowerCase().replace(/[*?]+/g, " ").split(/\s+/).filter(Boolean)))
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
  return scored.toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, cap)
}

const MAX_SIGNATURE_PARAMS = 8

// Renders a compact formal-parameter list from a tool's JSON-schema view,
// e.g. `(filePath: string, line: integer, character?: integer)`. The
// revealedTools tail section carries this per revealed tool so the model can
// call the tool by name with plausible arguments while its full schema is off
// the wire (bench-verified: models call name-not-in-array tools correctly when
// given signature hints). Required params first would reorder schema keys and
// churn hashes, so schema order is kept; only optionality and a coarse type
// are shown. Long schemas are capped with a trailing `…`.
type SchemaProp = {
  type?: unknown
  anyOf?: unknown
  enum?: unknown
  items?: unknown
}
export function compactSignature(parameters: unknown): string {
  if (!parameters || typeof parameters !== "object") return ""
  const root = parameters as { properties?: unknown; required?: unknown }
  if (!root.properties || typeof root.properties !== "object") return ""
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : [],
  )
  const names = Object.keys(root.properties as Record<string, unknown>)
  if (names.length === 0) return ""
  const parts = names.slice(0, MAX_SIGNATURE_PARAMS).map((name) => {
    const type = shortType((root.properties as Record<string, unknown>)[name])
    return `${name}${required.has(name) ? "" : "?"}${type ? `: ${type}` : ""}`
  })
  if (names.length > MAX_SIGNATURE_PARAMS) parts.push("…")
  return `(${parts.join(", ")})`
}

function shortType(prop: unknown): string | undefined {
  if (!prop || typeof prop !== "object") return undefined
  const p = prop as SchemaProp
  if (typeof p.type === "string") return p.type === "integer" ? "integer" : p.type
  if (Array.isArray(p.anyOf)) {
    const first = p.anyOf.map((entry) => shortType(entry)).find((entry) => entry !== undefined && entry !== "null")
    if (first) return first
  }
  if (p.enum) return "enum"
  return undefined
}

// Reveal state is database-backed (`tool_reveal` rows keyed by session) so a
// resumed session keeps its revealed tools across process restarts, with a
// module-level cache on top. The cache stays module-level rather than layer-
// closure state: several default layer sites (SessionPrompt, ToolRegistry,
// app-runtime, test harnesses) can materialize more than one Service instance
// in a process, and a reveal made through one must be visible to resolveTools
// through another. Rows are cascade-deleted with their session; loading drops
// ids that are no longer in the deferred catalog so stale reveals from older
// versions never resurface.
//
// Each reveal also records a timestamp in the JSON payload (`data.revealedAt`)
// — no new column, no migration — so promotion is derived, never stored: a
// revealed tool whose reveal time is at or before the newest completed
// compaction summary message time enters the tool array again. Ids persisted
// before per-reveal timestamps existed fall back to the row's last-write time,
// an upper bound on every id's true reveal time, so promotion never fires
// early.
type RevealedState = {
  readonly ids: Set<string>
  readonly times: Map<string, number>
}

const revealCache = new Map<string, RevealedState>()

/** Test seam: drop the in-memory cache so the next read reloads from the database. */
export function resetRevealCache() {
  revealCache.clear()
}

function loadRevealed(sessionID: SessionID) {
  const cached = revealCache.get(sessionID)
  if (cached) return cached
  const row = Database.use((db) =>
    db.select().from(ToolRevealTable).where(eq(ToolRevealTable.session_id, sessionID)).limit(1).get(),
  )
  const ids = new Set(row?.data.revealed.filter((id) => isDeferredTool(id)) ?? [])
  const legacyTime = row?.time_updated ?? row?.time_created ?? Date.now()
  const times = new Map<string, number>(
    [...ids].map((id) => [id, row?.data.revealedAt?.[id] ?? legacyTime] as [string, number]),
  )
  const loaded = { ids, times }
  revealCache.set(sessionID, loaded)
  return loaded
}

function persistRevealed(sessionID: SessionID, state: RevealedState, additions: readonly string[]) {
  const data = {
    revealed: [...state.ids, ...additions],
    revealedAt: Object.fromEntries(state.times),
  }
  Database.use((db) =>
    db
      .insert(ToolRevealTable)
      .values({ session_id: sessionID, data })
      .onConflictDoUpdate({
        target: ToolRevealTable.session_id,
        set: { data },
      })
      .run(),
  )
}

export interface Interface {
  readonly isDeferred: (id: string) => boolean
  readonly revealed: (sessionID: SessionID) => Effect.Effect<ReadonlySet<string>>
  readonly revealTimes: (sessionID: SessionID) => Effect.Effect<ReadonlyMap<string, number>>
  readonly reveal: (sessionID: SessionID, ids: readonly string[]) => Effect.Effect<void>
  readonly search: (input: { query: string; limit: number; candidates: readonly Candidate[] }) => Match[]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionToolSearch") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const revealed = Effect.fn("ToolSearch.revealed")(function* (sessionID: SessionID) {
      return yield* Effect.sync(() => loadRevealed(sessionID).ids)
    })

    const revealTimes = Effect.fn("ToolSearch.revealTimes")(function* (sessionID: SessionID) {
      return yield* Effect.sync(() => loadRevealed(sessionID).times)
    })

    const reveal = Effect.fn("ToolSearch.reveal")(function* (sessionID: SessionID, ids: readonly string[]) {
      const state = yield* Effect.sync(() => loadRevealed(sessionID))
      const additions = ids.filter((id) => isDeferredTool(id) && !state.ids.has(id))
      if (additions.length === 0) return
      const revealedAt = Date.now()
      for (const id of additions) state.times.set(id, revealedAt)
      yield* Effect.sync(() => persistRevealed(sessionID, state, additions))
      for (const id of additions) state.ids.add(id)
    })

    return Service.of({
      isDeferred: isDeferredTool,
      revealed,
      revealTimes,
      reveal,
      search: (input) => scoreDeferred(input.query, input.limit, input.candidates),
    })
  }),
)

export const defaultLayer = layer

export * as ToolSearch from "./tool-search"
