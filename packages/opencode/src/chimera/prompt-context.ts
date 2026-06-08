import path from "path"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { readPersistentObligationStore, readProvenanceRecords } from "./store"
import type { ToolMutationRecord } from "./provenance"
import type { SessionID } from "@/session/schema"

const MAX_RECENT_MUTATIONS = 3
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

function focus(recent: ToolMutationRecord[], obligations: PromptObligation[]) {
  const claimed = obligations.find((item) => item.status === "claimed")
  if (claimed) return `obligation ${claimed.id}: ${claimed.target}`
  if (recent[0]) return `latest mutation ${recent[0].id}: ${files(recent[0])}`
  if (obligations.length) return `${obligations.length} active obligation(s)`
  return "none"
}

function graphSnapshot(recent: ToolMutationRecord[]) {
  const record = recent[0]
  if (!record) return ["- revision: unknown", "- freshness: no session mutation snapshot available"]
  return [
    `- revision: ${record.graph.after.revision}`,
    `- freshness: latest session mutation ${record.graph.before.revision.slice(0, 8)} -> ${record.graph.after.revision.slice(0, 8)}`,
  ]
}

function closeoutSignals(recent: ToolMutationRecord[], obligations: PromptObligation[]) {
  return [
    ...(recent.length ? ["- Recent mutation present: run `chimera_audit_recent` before claiming completion if not already done."] : []),
    ...(obligations.length ? ["- Active obligations remain: review, resolve, or ignore each relevant obligation before closeout."] : []),
    ...(recent.length || obligations.length ? [] : ["- No Chimera closeout signals recorded."]),
  ]
}

function renderContext(recent: ToolMutationRecord[], obligations: PromptObligation[]) {
  if (recent.length === 0 && obligations.length === 0) return undefined
  return [
    "## Chimera Execution Context",
    "",
    "Graph Snapshot:",
    ...graphSnapshot(recent),
    "",
    "Current Focus:",
    `- ${focus(recent, obligations)}`,
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
            `- ${item.id} [${item.status}] ${item.target}; risk: ${item.risk}; evidence: ${item.evidence}; reason: ${compact(item.reason)}`,
        )
      : ["- None active."]),
    "",
    "Closeout Signals:",
    ...closeoutSignals(recent, obligations),
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const render = Effect.fn("ChimeraPromptContext.render")(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = projectRoot(instance)
      const dir = path.join(root, ".codegraph", "chimera")
      const records = yield* Effect.promise(() => readProvenanceRecords(root, path.join(dir, "tool-provenance.jsonl")))
      const store = yield* Effect.promise(() =>
        readPersistentObligationStore<PromptObligation>(root, path.join(dir, "obligations.json"), {
          schemaVersion: 1,
          obligations: [],
        }),
      )
      return renderContext(recentMutations(records, sessionID), activeObligations(store))
    })

    return Service.of({ render })
  }),
)

export const defaultLayer = layer

export * as ChimeraPromptContext from "./prompt-context"
