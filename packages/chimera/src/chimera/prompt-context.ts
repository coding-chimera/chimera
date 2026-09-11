import path from "path"
import { Context, Effect, Layer, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { readAuditRuns, readOracleResults, readPersistentObligationStore, readPredesignRuns, readRecentProvenanceRecords, type AuditRunRecord, type OracleRecord, type PredesignRunRecord } from "./store"
import type { ToolMutationRecord } from "./provenance"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { getGraphDataRootInfo } from "@/graph"

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

function closeoutSignals(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[], oracles: OracleRecord[], audits: AuditRunRecord[], drift: string | undefined) {
  const frontendGap = frontendVerificationGap(recent, oracles)
  return [
    ...(recent.length && !latestAudit(audits, recent[0])
      ? ["- Recent mutation present but no audit evidence was recorded (graph degraded during the edit?): run `chimera_audit_recent` before claiming completion."]
      : []),
    ...(drift ? [drift] : []),
    ...(frontendGap ? [frontendGap] : []),
    ...(predesigns.length && recent.length === 0
      ? ["- Pre-design evidence recorded; mutations are audited automatically when they land."]
      : []),
    ...(obligations.length ? ["- Active obligations remain: review, resolve, or ignore each relevant obligation before closeout."] : []),
    ...(recent.length || obligations.length || predesigns.length || drift ? [] : ["- No Chimera closeout signals recorded."]),
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
    latest && !audit ? "latest mutation has no recorded audit evidence (auto-record degraded); run chimera_audit_recent" : undefined,
    obligations.length ? "active obligations remain; review, resolve, ignore, or explicitly justify ordinary closeout" : undefined,
    linkedOracles.length ? "failing/unknown oracle evidence is linked to the latest mutation; review the Linked Verification Evidence lines and address or dismiss each before closeout" : undefined,
  ].filter((item): item is string => Boolean(item))
  const apocalypseReasons = [
    latest && !audit ? "latest mutation has no recorded audit run (auto-record degraded); run chimera_audit_recent" : undefined,
    obligations.length ? "all active obligations must be resolved or ignored" : undefined,
    linkedOracles.length ? "linked failing/unknown oracle evidence must be addressed; summaries are inlined above, chimera_oracle_get fetches full output" : undefined,
    latest && audit ? undefined : !latest ? undefined : "verification evidence or not-applicable rationale must be explicit",
  ].filter((item): item is string => Boolean(item))

  return [
    gateLine("ordinary", ordinaryReasons.length ? "warn" : "pass", ordinaryReasons),
    gateLine("apocalypse", apocalypseReasons.length ? "block" : "pass", apocalypseReasons),
    audit ? `- latest audit evidence: ${audit.id} at ${audit.createdAt}` : "- latest audit evidence: none recorded for latest mutation",
  ]
}

const MAX_INLINE_ORACLES = 5

function oracleSummaryLine(oracle: OracleRecord) {
  const payload = oracle.payload as
    | { shell?: { command?: string; exit?: number | null; output?: string }; lsp?: { diagnosticCount?: number; files?: string[] } }
    | undefined
  if (oracle.kind === "shell" && payload?.shell) {
    const command = (payload.shell.command ?? "").split("\n")[0].trim().slice(0, 80)
    const detail = (payload.shell.output ?? "").split("\n").map((line) => line.trim()).filter(Boolean).pop()?.slice(0, 120)
    return {
      key: `shell:${command}:${payload.shell.exit}`,
      line: `- [${oracle.status}] shell exit ${payload.shell.exit ?? "?"}: ${command || "(no command)"}${detail ? ` — ${detail}` : ""} (oracle:${oracle.id})`,
    }
  }
  if (oracle.kind === "lsp") {
    const file = payload?.lsp?.files?.[0] ?? "unknown file"
    return {
      key: `lsp:${file}`,
      line: `- [${oracle.status}] lsp: ${payload?.lsp?.diagnosticCount ?? "?"} diagnostic(s) in ${file} (oracle:${oracle.id})`,
    }
  }
  return { key: `${oracle.kind}:${oracle.id}`, line: `- [${oracle.status}] ${oracle.kind} evidence (oracle:${oracle.id})` }
}

/**
 * One-line summaries of failing/unknown oracles linked to recent mutations.
 * The closeout gate no longer asks the model to recall this evidence with a
 * tool call (bench: 14 recalls, 11.2KB each, action rate 1/14); the evidence
 * rides the runtime block instead and chimera_oracle_get stays for deep dives.
 */
function linkedOracleLines(recent: ToolMutationRecord[], oracles: OracleRecord[]) {
  const seen = new Set<string>()
  return oracles
    .filter((oracle) => oracle.linkedChanges.some((change) => recent.some((record) => record.id === change.id)))
    .map(oracleSummaryLine)
    .flatMap((summary) => (seen.has(summary.key) ? [] : (seen.add(summary.key), [summary])))
    .slice(0, MAX_INLINE_ORACLES)
    .map((summary) => summary.line)
}

const MAX_SCOPE_DRIFT_DISPLAY = 5
const SCOPE_REACHES_MARKER = "Scope check: propagation reaches"
const SCOPE_LIST_END = ", outside the scope declared in"

/**
 * Files named by propagation scope checks in this session's tool outputs.
 * Weak models reliably ignore these post-edit reminders (TB6 bench: flash
 * acted on 0/4 post-edit scope lines while acting on 100% of surfaces it
 * discovered pre-edit), so unreconciled flags resurface as a closeout
 * signal — the zone where checklist compliance is observed.
 */
type ScopeFlag = { file: string; depth: number }

function scopeFlaggedFiles(messages: readonly MessageV2.WithParts[]): ScopeFlag[] {
  const flagged: ScopeFlag[] = []
  let scanned = 0
  outer: for (const message of messages) {
    for (const part of message.parts) {
      if (scanned >= MAX_SCAN_PARTS) break outer
      scanned += 1
      if (part.type !== "tool") continue
      const output = (part.state as { output?: unknown }).output
      if (typeof output !== "string" || !output.includes(SCOPE_REACHES_MARKER)) continue
      for (const line of output.split("\n")) {
        const start = line.indexOf(SCOPE_REACHES_MARKER)
        if (start < 0) continue
        // Normalize annotations before splitting: the via group contains a
        // ", " separator, so fold it into a NUL-delimited depth marker.
        const list = line.slice(start + SCOPE_REACHES_MARKER.length).split(SCOPE_LIST_END)[0]
          .replace(/ \(\+\d+ more\)/g, "")
          .replace(/ \(via [^)]*?, (\d+) hops\)/g, "\u0000$1")
          .replace(/ \(via [^)]*\)/g, "\u00002")
        for (const item of list.split(", ")) {
          const [raw, rawDepth] = item.split("\u0000")
          const file = (raw ?? "").trim()
          if (!file || file.startsWith("(") || flagged.some((entry) => entry.file === file)) continue
          const parsed = Number.parseInt(rawDepth ?? "1", 10)
          flagged.push({ file, depth: Number.isFinite(parsed) && parsed >= 1 ? parsed : 2 })
        }
      }
    }
  }
  return flagged
}

function scopeDriftSignal(flagged: ScopeFlag[], records: readonly ToolMutationRecord[], sessionID: SessionID, predesigns: PredesignRunRecord[]) {
  if (flagged.length === 0) return undefined
  const touched = new Set(
    records
      .filter((record) => record.tool.sessionID === sessionID)
      .flatMap((record) => record.files.map((file) => file.graphPath ?? file.absolutePath)),
  )
  const declared = new Set(predesigns.flatMap((record) => record.files))
  // Deep entries only: 1-hop dependents are trivially checkable by the model,
  // and a bench drift list dominated by pass-through intermediates read as
  // noise — the weak model dismissed the whole signal (1/4 signal-to-noise),
  // while a precise deep list is exactly what it acted on.
  const open = flagged
    .filter((entry) => entry.depth >= 2 && !touched.has(entry.file) && !declared.has(entry.file))
    .map((entry) => entry.file)
  if (open.length === 0) return undefined
  const shown = open.slice(0, MAX_SCOPE_DRIFT_DISPLAY).join(", ") + (open.length > MAX_SCOPE_DRIFT_DISPLAY ? ` (+${open.length - MAX_SCOPE_DRIFT_DISPLAY} more)` : "")
  return `- Unreconciled scope drift: ${shown} — named by propagation scope checks during this session but never edited or declared in a predesign since. Reconcile each one before closeout: reading alone misses cross-encoding drift (a stale decimal 1 vs a new 0x02), so where feasible RUN each named file's exported functions once against the new behavior — stale hardcodes throw. Then edit it (record a predesign first if the gate asks) or explicitly state why it needs no change.`
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

const graphDiscoveryHint = Effect.fnUntraced(function* (root: string, messages: Option.Option<readonly MessageV2.WithParts[]>) {
  if (getGraphDataRootInfo(root).dataRootStatus === "uninitialized") return undefined
  if (Option.isNone(messages)) return undefined
  const counts = discoveryCounts(messages.value)
  if (counts.graphCalls > 0 || counts.textCalls < MIN_TEXT_EXPLORATION_CALLS || counts.markerSeen) return undefined
  return [GRAPH_DISCOVERY_HINT_HEADER, GRAPH_DISCOVERY_HINT_BODY]
})

function renderContext(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[], audits: AuditRunRecord[], oracles: OracleRecord[], hint: readonly string[] | undefined, drift: string | undefined) {
  const nonPassingOracles = oracles.filter((oracle) => oracle.status !== "pass")
  const oracleLines = linkedOracleLines(recent, nonPassingOracles)
  if (recent.length === 0 && obligations.length === 0 && predesigns.length === 0 && audits.length === 0 && nonPassingOracles.length === 0 && !hint && !drift) return undefined
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
    ...(oracleLines.length
      ? [
          "",
          "Linked Verification Evidence (failing/unknown results linked to recent mutations; full output via chimera_oracle_get with ref oracle:<id>):",
          ...oracleLines,
        ]
      : []),
    "",
    "Closeout Gate:",
    ...closeoutGate(recent, obligations, audits, nonPassingOracles),
    "",
    "Closeout Signals:",
    ...closeoutSignals(recent, obligations, predesigns, oracles, audits, drift),
    ...(hint ? ["", ...hint] : []),
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
      const messages = yield* sessions.messages({ sessionID, limit: MAX_SCAN_MESSAGES }).pipe(Effect.option)
      const hint = yield* graphDiscoveryHint(root, messages)
      const sessionPredesigns = recentPredesigns(predesigns, sessionID)
      const drift = scopeDriftSignal(
        scopeFlaggedFiles(Option.isSome(messages) ? messages.value : []),
        records,
        sessionID,
        sessionPredesigns,
      )
      return renderContext(recentMutations(records, sessionID), activeObligations(store), sessionPredesigns, audits, oracles, hint, drift)
    })

    return Service.of({ render })
  }),
)

export const defaultLayer = layer

export * as ChimeraPromptContext from "./prompt-context"
