import path from "path"
import { Context, Effect, Layer, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { readAuditRuns, readOracleResults, readPersistentObligationStore, readPredesignRuns, readRecentProvenanceRecords, type AuditRunRecord, type OracleRecord, type PredesignRunRecord } from "./store"
import type { ToolMutationRecord } from "./provenance"
import { CodeGraphAdapter } from "./codegraph-adapter"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { getGraphDataRootInfo, isInitialized, type Node as CodeGraphNode } from "@/graph"

const MAX_RECENT_MUTATIONS = 3
const MAX_RECENT_PREDESIGNS = 3
const MAX_ACTIVE_OBLIGATIONS = 8
const MAX_ITEM_CHARS = 300
const MAX_SCAN_MESSAGES = 20
const MAX_SCAN_PARTS = 60
const MIN_TEXT_EXPLORATION_CALLS = 4
const GRAPH_DISCOVERY_HINT_HEADER = "## Graph discovery hint"
const GRAPH_DISCOVERY_HINT_BODY =
  'This project is indexed. One chimera_search or chimera_impact call can replace several grep/read steps for symbol, caller, reference, and impact questions; chimera_file_symbols answers "what is in this file".'
const GRAPH_QUERY_TOOLS = new Set<string>(["chimera_search", "chimera_file_symbols", "chimera_impact"])
const TEXT_EXPLORATION_TOOLS = new Set<string>(["grep", "glob", "read", "bash"])

// -- Push-style graph context (experimental, env-flag gated; default off) --
const GRAPH_PUSH_ENV = "CHIMERA_GRAPH_PUSH_CONTEXT"
const GRAPH_PUSH_HEADER = "## Graph context (auto)"
const GRAPH_PUSH_TRAILER = "(auto-generated from your message keywords; query tools available for deeper exploration)"
const GRAPH_PUSH_BUDGET_CHARS = 600
// Covers the once-per-process cold open of large graph DBs; later renders reuse
// the cached read-only handle and finish in milliseconds. Override for experiments.
const GRAPH_PUSH_QUERY_TIMEOUT_MS = 3000
const GRAPH_PUSH_TIMEOUT_ENV = "CHIMERA_GRAPH_PUSH_TIMEOUT_MS"
const GRAPH_PUSH_DEBUG_ENV = "CHIMERA_GRAPH_PUSH_DEBUG"
const GRAPH_PUSH_MAX_TOKENS = 3
const GRAPH_PUSH_HITS_PER_TOKEN = 3
const GRAPH_PUSH_MIN_TEXT_CHARS = 20

type PromptObligation = {
  id: string
  fingerprint: string
  status: string
  target: string
  risk: string
  classification?: string
  reason: string
  evidence: string
  createdAt: string
  updatedAt: string
  staleReason?: string
  replayLifecycle?: {
    version: 1
    status: string
    reason: string
    sourceRevision?: string
    currentRevision?: string
  }
}

type ObligationStore = {
  schemaVersion: 1
  obligations: PromptObligation[]
}

export interface Interface {
  readonly render: (sessionID: SessionID, sessions: Session.Interface) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ChimeraPromptContext") {}

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

function artifactPaths(root: string, file: string) {
  const info = getGraphDataRootInfo(root)
  const active = path.join(info.dataRoot, "chimera", file)
  const legacy = path.join(info.legacyRoot, "chimera", file)
  return active === legacy ? [active] : [active, legacy]
}

async function readProvenanceWithFallback(root: string) {
  let records = [] as ToolMutationRecord[]
  for (const artifact of artifactPaths(root, "tool-provenance.jsonl")) records = await readRecentProvenanceRecords(root, artifact, { limit: MAX_RECENT_MUTATIONS * 20 })
  return records
}

async function readPredesignsWithFallback(root: string, sessionID: SessionID) {
  let records = [] as PredesignRunRecord[]
  for (const artifact of artifactPaths(root, "predesign-runs.jsonl")) records = await readPredesignRuns(root, artifact, { sessionID, limit: MAX_RECENT_PREDESIGNS })
  return records
}

async function readObligationsWithFallback(root: string) {
  let store: ObligationStore = { schemaVersion: 1, obligations: [] }
  for (const artifact of artifactPaths(root, "obligations.json")) store = await readPersistentObligationStore<PromptObligation>(root, artifact, store)
  return store
}

async function readOraclesWithFallback(root: string, sessionID: SessionID) {
  let records = [] as OracleRecord[]
  for (const artifact of artifactPaths(root, "oracle-results.jsonl")) records = await readOracleResults(root, artifact, { sessionID, limit: 50, includePassing: true })
  return records
}

function compact(input: string) {
  const value = input.replace(/\s+/g, " ").trim()
  return value.length > MAX_ITEM_CHARS ? `${value.slice(0, MAX_ITEM_CHARS - 3)}...` : value
}

function matchesSession(sessionID: SessionID, record: ToolMutationRecord) {
  return (record.actor?.sessionID ?? record.tool.sessionID) === sessionID
}

function recentMutations(records: ToolMutationRecord[], sessionID: SessionID) {
  return records
    .filter((record) => matchesSession(sessionID, record) && record.status === "success")
    .slice(-MAX_RECENT_MUTATIONS)
    .toReversed()
}

function recentPredesigns(records: PredesignRunRecord[], sessionID: SessionID) {
  return records
    .filter((record) => record.sessionID === sessionID)
    .slice(0, MAX_RECENT_PREDESIGNS)
}

function activeObligations(store: ObligationStore) {
  return store.obligations
    .filter((item) => item.status === "pending" || item.status === "claimed" || item.status === "stale")
    .slice(0, MAX_ACTIVE_OBLIGATIONS)
}

function files(record: ToolMutationRecord) {
  const shown = record.files.map((file) => file.graphPath ?? file.absolutePath).slice(0, 5)
  const omitted = record.files.length - shown.length
  return `${shown.join(", ") || "none"}${omitted > 0 ? ` (+${omitted} more)` : ""}`
}

function predesignFiles(record: PredesignRunRecord) {
  const shown = record.files.slice(0, 5)
  const omitted = record.files.length - shown.length
  return `${shown.join(", ") || "none"}${omitted > 0 ? ` (+${omitted} more)` : ""}`
}

function focus(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[]) {
  const claimed = obligations.find((item) => item.status === "claimed")
  if (claimed) return `obligation ${claimed.id}: ${claimed.target}`
  if (recent[0]) return `latest mutation ${recent[0].id}: ${files(recent[0])}`
  if (predesigns[0]) return `latest pre-design ${predesigns[0].id}: ${compact(predesigns[0].intent)}`
  if (obligations.length) return `${obligations.length} active obligation(s)`
  return "none"
}

function graphSnapshot(recent: ToolMutationRecord[], predesigns: PredesignRunRecord[]) {
  const record = recent[0]
  if (!record && predesigns[0]) {
    return [
      `- revision: ${predesigns[0].snapshotRevision}`,
      `- freshness: latest pre-design evidence ${predesigns[0].id}`,
    ]
  }
  if (!record) return ["- revision: unknown", "- freshness: no session mutation snapshot available"]
  return [
    `- revision: ${record.graph.after.revision}`,
    `- freshness: latest session mutation ${record.graph.before.revision.slice(0, 8)} -> ${record.graph.after.revision.slice(0, 8)}`,
  ]
}

const FRONTEND_COMPONENT_FILE = /\.(tsx|jsx|vue|svelte)$/

function frontendVerificationGap(recent: ToolMutationRecord[], oracles: OracleRecord[]) {
  const mutation = recent.find((record) => record.files.some((file) => FRONTEND_COMPONENT_FILE.test(file.graphPath ?? file.absolutePath)))
  if (!mutation) return undefined
  const verified = oracles.some((oracle) => oracle.trusted && oracle.finishedAt >= mutation.finishedAt)
  if (verified) return undefined
  return "- Frontend component mutation without trusted verification evidence: run the project's lint/tests before closeout (framework invariants such as React hook ordering are invisible to structural audit); if the project has no lint configuration, report that gap to the user."
}

function closeoutSignals(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[], oracles: OracleRecord[]) {
  const frontendGap = frontendVerificationGap(recent, oracles)
  return [
    ...(recent.length ? ["- Recent mutation present: run `chimera_audit_recent` before claiming completion if not already done."] : []),
    ...(frontendGap ? [frontendGap] : []),
    ...(predesigns.length && recent.length === 0
      ? ["- Pre-design evidence recorded; successful mutations still need `chimera_audit_recent` before closeout."]
      : []),
    ...(obligations.length ? ["- Active obligations remain: review, resolve, or ignore each relevant obligation before closeout."] : []),
    ...(recent.length || obligations.length || predesigns.length ? [] : ["- No Chimera closeout signals recorded."]),
  ]
}

function linkedToLatest(oracle: OracleRecord, latest: ToolMutationRecord | undefined) {
  if (!latest) return false
  return oracle.linkedChanges.some((change) => change.id === latest.id)
}

function latestAudit(audits: AuditRunRecord[], latest: ToolMutationRecord | undefined) {
  if (!latest) return undefined
  return audits.find((audit) => audit.provenanceID === latest.id)
}

function gateLine(mode: "ordinary" | "apocalypse", decision: "pass" | "warn" | "block", reasons: string[]) {
  return `- ${mode}: ${decision}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`
}

function closeoutGate(recent: ToolMutationRecord[], obligations: PromptObligation[], audits: AuditRunRecord[], oracles: OracleRecord[]) {
  const latest = recent[0]
  const audit = latestAudit(audits, latest)
  const linkedOracles = oracles.filter((oracle) => linkedToLatest(oracle, latest))
  const ordinaryReasons = [
    latest && !audit ? "latest mutation still needs recorded chimera_audit_recent evidence" : undefined,
    obligations.length ? "active obligations remain; review, resolve, ignore, or explicitly justify ordinary closeout" : undefined,
    linkedOracles.length ? "failing/unknown oracle evidence is linked to the latest mutation; recall before closeout" : undefined,
  ].filter((item): item is string => Boolean(item))
  const apocalypseReasons = [
    latest && !audit ? "latest mutation has no recorded audit run" : undefined,
    obligations.length ? "all active obligations must be resolved or ignored" : undefined,
    linkedOracles.length ? "linked failing/unknown oracle evidence must be recalled and addressed" : undefined,
    latest && audit ? undefined : !latest ? undefined : "verification evidence or not-applicable rationale must be explicit",
  ].filter((item): item is string => Boolean(item))

  return [
    gateLine("ordinary", ordinaryReasons.length ? "warn" : "pass", ordinaryReasons),
    gateLine("apocalypse", apocalypseReasons.length ? "block" : "pass", apocalypseReasons),
    audit ? `- latest audit evidence: ${audit.id} at ${audit.createdAt}` : "- latest audit evidence: none recorded for latest mutation",
  ]
}

function discoveryCounts(messages: readonly MessageV2.WithParts[]) {
  let graphCalls = 0
  let textCalls = 0
  let markerSeen = false
  let scanned = 0
  outer: for (let index = messages.length - 1; index >= 0; index--) {
    for (const part of messages[index].parts) {
      if (scanned >= MAX_SCAN_PARTS) break outer
      scanned += 1
      if (part.type === "tool") {
        if (GRAPH_QUERY_TOOLS.has(part.tool)) graphCalls += 1
        else if (TEXT_EXPLORATION_TOOLS.has(part.tool)) textCalls += 1
      } else if (part.type === "text" && part.text.includes(GRAPH_DISCOVERY_HINT_HEADER)) {
        markerSeen = true
      }
    }
  }
  return { graphCalls, textCalls, markerSeen }
}

const graphDiscoveryHint = Effect.fnUntraced(function* (root: string, sessionID: SessionID, sessions: Session.Interface) {
  if (getGraphDataRootInfo(root).dataRootStatus === "uninitialized") return undefined
  const messages = yield* sessions.messages({ sessionID, limit: MAX_SCAN_MESSAGES }).pipe(Effect.option)
  if (Option.isNone(messages)) return undefined
  const counts = discoveryCounts(messages.value)
  if (counts.graphCalls > 0 || counts.textCalls < MIN_TEXT_EXPLORATION_CALLS || counts.markerSeen) return undefined
  return [GRAPH_DISCOVERY_HINT_HEADER, GRAPH_DISCOVERY_HINT_BODY]
})

// Path-like tokens require at least one "/" plus a code extension (e.g. src/tool/chimera.ts).
const CODE_TOKEN_PATH = /(?:[A-Za-z0-9_./~-]*\/[A-Za-z0-9_.~-]+)\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|c|cc|cpp|h|hh|rb|php|sql|sh|json|yml|yaml|md)\b/g
// Word-level tokens: identifiers >= 6 chars that look like code (snake_case or)
// camelCase — plain lowercase natural language never matches the camel gate.
const CODE_TOKEN_WORD = /\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g
const CODE_TOKEN_BACKTICK = /`([^`\n]+)`/g

// English filler short enough to slip through the code gates via backticks (e.g. `search`).
const COMMON_ENGLISH_FILLER = new Set([
  "about", "after", "again", "against", "before", "because", "being", "between", "could", "during",
  "every", "first", "great", "might", "never", "often", "other", "really", "right", "should",
  "since", "still", "such", "than", "their", "them", "there", "these", "they", "think",
  "this", "those", "three", "through", "under", "using", "very", "were", "what", "when",
  "where", "which", "while", "will", "would", "your",
])

function graphPushContextEnabled() {
  const value = process.env[GRAPH_PUSH_ENV]?.toLowerCase()
  return value === "1" || value === "true"
}

function graphPushTimeoutMs() {
  const value = Number(process.env[GRAPH_PUSH_TIMEOUT_ENV])
  return Number.isFinite(value) && value > 0 ? value : GRAPH_PUSH_QUERY_TIMEOUT_MS
}

function pushDebug(message: string) {
  if (process.env[GRAPH_PUSH_DEBUG_ENV] === "1") process.stderr.write(`[graph-push] ${message}\n`)
}

/**
 * Extract up to GRAPH_PUSH_MAX_TOKENS code-flavored tokens from the latest user message text.
 * Longest-first, deduped, English filler filtered. Sources: backtick-wrapped words
 * (compound snippets are split into identifier fragments), path-like strings
 * (contain "/" + a code extension), and camelCase/snake_case identifiers (>= 6 chars).
 */
function extractCodeTokens(text: string) {
  const candidates: string[] = []
  for (const match of text.matchAll(CODE_TOKEN_BACKTICK)) {
    const inner = match[1]!.trim()
    if (!inner) continue
    // A single identifier or path stays whole. Compound snippets (call
    // expressions, punctuated code) are split into code-like identifier
    // fragments: searching the raw snippet matches parameter-name noise across
    // the repo instead of the intended symbol (bench-observed).
    if (/^[\w./~-]+$/.test(inner)) {
      candidates.push(inner)
      continue
    }
    for (const part of inner.split(/[^\w./~-]+/)) {
      if (part.length >= 6 && (part.includes("_") || /[a-z][A-Z]/.test(part))) candidates.push(part)
    }
  }
  for (const match of text.matchAll(CODE_TOKEN_PATH)) candidates.push(match[0])
  for (const match of text.matchAll(CODE_TOKEN_WORD)) {
    const word = match[0]
    if (word.includes("_") || /[a-z][A-Z]/.test(word)) candidates.push(word)
  }
  return [...new Set(candidates)]
    .filter((token) => token.length >= 2 && !COMMON_ENGLISH_FILLER.has(token.toLowerCase()))
    .sort((a, b) => b.length - a.length)
    .slice(0, GRAPH_PUSH_MAX_TOKENS)
}

function latestUserText(messages: readonly MessageV2.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.info.role !== "user") continue
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored && !part.metadata?.runtimeContext)
      .map((part) => part.text)
      .join("\n")
      .trim()
    return text.length > 0 ? text : undefined
  }
  return undefined
}

function latestUserCodeTokens(messages: readonly MessageV2.WithParts[]) {
  const text = latestUserText(messages)
  if (text === undefined || text.length < GRAPH_PUSH_MIN_TEXT_CHARS) return []
  return extractCodeTokens(text)
}

function renderGraphPushSection(hits: Array<{ token: string; node: CodeGraphNode }>) {
  if (hits.length === 0) return undefined
  const lineFor = ({ token, node }: { token: string; node: CodeGraphNode }) => {
    const span = node.endLine >= node.startLine ? `${node.startLine}-${node.endLine}` : `${node.startLine}`
    return `- ${token} → ${node.name || node.qualifiedName || "?"} (${node.kind}) ${node.filePath}:${span}`
  }
  let hitLines = hits.map(lineFor)
  while (hitLines.length > 0) {
    const section = [GRAPH_PUSH_HEADER, ...hitLines, "", GRAPH_PUSH_TRAILER].join("\n")
    if (section.length <= GRAPH_PUSH_BUDGET_CHARS) return section
    hitLines = hitLines.slice(0, -1)
  }
  return [GRAPH_PUSH_HEADER, "", GRAPH_PUSH_TRAILER].join("\n")
}

/**
 * Process-lifetime read-only graph handles for the push section.
 * Chimera.withProjectGraph's readOnly path bypasses the shared graphStates cache
 * and closes the handle on release (provenance.ts openGraphState/withProjectGraph),
 * which made every render a full cold open of the graph DB — hundreds of ms on
 * real-size repos, always over a turn-start budget. Open failures evict the entry;
 * a DB replaced under a live handle degrades to search errors and the push silently
 * stops for that root until process restart (acceptable for an experimental flag).
 */
const pushGraphHandles = new Map<string, Promise<CodeGraphAdapter>>()

function openPushGraph(root: string) {
  const cached = pushGraphHandles.get(root)
  if (cached) return cached
  const promise = CodeGraphAdapter.open(root, { readOnly: true })
  promise.catch(() => pushGraphHandles.delete(root))
  pushGraphHandles.set(root, promise)
  return promise
}

/**
 * Query the graph for the extracted tokens and render the "## Graph context (auto)"
 * section. Uses CodeGraphAdapter.searchNodesDetailed (the chimera_search core) on a
 * read-only handle: the push never initializes, syncs, or watches graph data.
 * Timeout and any failure degrade to a silent skip.
 */
const queryGraphPushContext = Effect.fnUntraced(function* (root: string, tokens: string[]) {
  const graph = yield* Effect.promise(() => openPushGraph(root))
  return yield* Effect.sync(() => {
    const hits: Array<{ token: string; node: CodeGraphNode }> = []
    for (const token of tokens) {
      const detailed = graph.searchNodesDetailed(token, { limit: GRAPH_PUSH_HITS_PER_TOKEN })
      for (const result of detailed.results.slice(0, GRAPH_PUSH_HITS_PER_TOKEN)) hits.push({ token, node: result.node })
    }
    return renderGraphPushSection(hits)
  })
})

/**
 * Gate: env flag on, graph initialized (cheap probe), latest user message carries
 * code-flavored tokens. Off by default; every check is cheap and all failures
 * degrades to no section.
 */
const graphPushContextSection = Effect.fnUntraced(function* (sessionID: SessionID, sessions: Session.Interface) {
  pushDebug(`enter: flag=${process.env[GRAPH_PUSH_ENV] ?? "unset"}`)
  if (!graphPushContextEnabled()) return undefined
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  if (!isInitialized(root)) {
    pushDebug(`skip: graph not initialized (root=${root})`)
    return undefined
  }
  const messages = yield* sessions.messages({ sessionID, limit: MAX_SCAN_MESSAGES }).pipe(Effect.option)
  if (Option.isNone(messages)) {
    pushDebug("skip: session messages fetch failed")
    return undefined
  }
  const tokens = latestUserCodeTokens(messages.value)
  if (tokens.length === 0) {
    pushDebug("skip: no code tokens in latest user message")
    return undefined
  }
  const startedAt = Date.now()
  const section = Option.getOrUndefined(
    yield* queryGraphPushContext(root, tokens).pipe(
      Effect.timeout(graphPushTimeoutMs()),
      Effect.option,
      Effect.catchDefect(() => Effect.succeed(Option.none())),
    ),
  )
  pushDebug(
    section === undefined
      ? `miss: tokens=${JSON.stringify(tokens)} elapsed=${Date.now() - startedAt}ms (timeout, query failure, or zero hits)`
      : `hit: tokens=${JSON.stringify(tokens)} chars=${section.length} elapsed=${Date.now() - startedAt}ms`,
  )
  return section
})
function renderContext(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[], audits: AuditRunRecord[], oracles: OracleRecord[], hint: readonly string[] | undefined, graphContext: string | undefined) {
  const nonPassingOracles = oracles.filter((oracle) => oracle.status !== "pass")
  if (recent.length === 0 && obligations.length === 0 && predesigns.length === 0 && audits.length === 0 && nonPassingOracles.length === 0 && !hint && !graphContext) return undefined
  return [
    "## Chimera Execution Context",
    "",
    "Graph Snapshot:",
    ...graphSnapshot(recent, predesigns),
    "",
    "Current Focus:",
    `- ${focus(recent, obligations, predesigns)}`,
    "",
    "Recent Predesign Evidence:",
    ...(predesigns.length
      ? predesigns.map(
          (record) =>
            `- ${record.id} at ${record.createdAt}; intent: ${compact(record.intent)}; files: ${predesignFiles(record)}; graph: ${record.snapshotRevision.slice(0, 8)}; evidence: ${record.evidence.length}`,
        )
      : ["- None recorded for this session."]),
    "",
    "Recent Relevant Changes:",
    ...(recent.length
      ? recent.map(
          (record) =>
            `- ${record.id} ${record.tool.id} ${record.status} at ${record.finishedAt}; files: ${files(record)}; graph: ${record.graph.before.revision.slice(0, 8)} -> ${record.graph.after.revision.slice(0, 8)}`,
        )
      : ["- None recorded for this session."]),
    "",
    "Active Obligations:",
    ...(obligations.length
      ? obligations.map(
        (item) =>
            `- ${item.id} [${item.status}] ${item.target}; risk: ${item.risk}; evidence: ${item.evidence}; lifecycle: ${item.replayLifecycle?.status ?? "unknown"}; reason: ${compact(item.staleReason ?? item.reason)}`,
      )
      : ["- None active."]),
    "",
    "Closeout Gate:",
    ...closeoutGate(recent, obligations, audits, nonPassingOracles),
    "",
    "Closeout Signals:",
    ...closeoutSignals(recent, obligations, predesigns, oracles),
    ...(hint ? ["", ...hint] : []),
    ...(graphContext ? ["", graphContext] : []),
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const render = Effect.fn("ChimeraPromptContext.render")(function* (sessionID: SessionID, sessions: Session.Interface) {
      const instance = yield* InstanceState.context
      const root = projectRoot(instance)
      const records = yield* Effect.promise(() => readProvenanceWithFallback(root))
      const predesigns = yield* Effect.promise(() => readPredesignsWithFallback(root, sessionID))
      const store = yield* Effect.promise(() => readObligationsWithFallback(root))
      const audits = yield* Effect.promise(() => readAuditRuns(root, { limit: 20 }))
      const oracles = yield* Effect.promise(() => readOraclesWithFallback(root, sessionID))
      const hint = yield* graphDiscoveryHint(root, sessionID, sessions)
      const graphContext = yield* graphPushContextSection(sessionID, sessions)
      return renderContext(recentMutations(records, sessionID), activeObligations(store), recentPredesigns(predesigns, sessionID), audits, oracles, hint, graphContext)
    })

    return Service.of({ render })
  }),
)

export const defaultLayer = layer

export * as ChimeraPromptContext from "./prompt-context"
