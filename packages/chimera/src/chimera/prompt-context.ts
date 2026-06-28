import path from "path"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { readAuditRuns, readOracleResults, readPersistentObligationStore, readPredesignRuns, readRecentProvenanceRecords, type AuditRunRecord, type OracleRecord, type PredesignRunRecord } from "./store"
import type { ToolMutationRecord } from "./provenance"
import type { SessionID } from "@/session/schema"
import { getGraphDataRootInfo } from "@/graph"

const MAX_RECENT_MUTATIONS = 3
const MAX_RECENT_PREDESIGNS = 3
const MAX_ACTIVE_OBLIGATIONS = 8
const MAX_ITEM_CHARS = 300

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
  readonly render: (sessionID: SessionID) => Effect.Effect<string | undefined>
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
  for (const artifact of artifactPaths(root, "oracle-results.jsonl")) records = await readOracleResults(root, artifact, { sessionID, limit: 20, includePassing: false })
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

function closeoutSignals(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[]) {
  return [
    ...(recent.length ? ["- Recent mutation present: run `chimera_audit_recent` before claiming completion if not already done."] : []),
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

function renderContext(recent: ToolMutationRecord[], obligations: PromptObligation[], predesigns: PredesignRunRecord[], audits: AuditRunRecord[], oracles: OracleRecord[]) {
  if (recent.length === 0 && obligations.length === 0 && predesigns.length === 0 && audits.length === 0 && oracles.length === 0) return undefined
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
    ...closeoutGate(recent, obligations, audits, oracles),
    "",
    "Closeout Signals:",
    ...closeoutSignals(recent, obligations, predesigns),
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const render = Effect.fn("ChimeraPromptContext.render")(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = projectRoot(instance)
      const records = yield* Effect.promise(() => readProvenanceWithFallback(root))
      const predesigns = yield* Effect.promise(() => readPredesignsWithFallback(root, sessionID))
      const store = yield* Effect.promise(() => readObligationsWithFallback(root))
      const audits = yield* Effect.promise(() => readAuditRuns(root, { limit: 20 }))
      const oracles = yield* Effect.promise(() => readOraclesWithFallback(root, sessionID))
      return renderContext(recentMutations(records, sessionID), activeObligations(store), recentPredesigns(predesigns, sessionID), audits, oracles)
    })

    return Service.of({ render })
  }),
)

export const defaultLayer = layer

export * as ChimeraPromptContext from "./prompt-context"
