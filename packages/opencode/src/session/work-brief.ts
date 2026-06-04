import path from "path"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { eq } from "drizzle-orm"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Database } from "@/storage/db"
import { InstanceState } from "@/effect/instance-state"
import { readPersistentObligationStore, readProvenanceRecords } from "@/chimera/store"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { SessionID } from "./schema"
import { WorkBriefTable } from "./session.sql"

const MAX_ITEMS = 12
const MAX_ITEM_CHARS = 300
const DEFAULT_CLOSEOUT = "Run `chimera_audit recent=true` after successful code mutation."

export const Info = Schema.Struct({
  intent: Schema.optional(Schema.String),
  confirmedDecisions: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  relevantEvidence: Schema.Array(Schema.String),
  closeout: Schema.Array(Schema.String),
})
  .annotate({ identifier: "WorkBrief" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

type ToolMutationRecord = {
  id: string
  status: "success" | "failure"
  finishedAt: string
  actor?: { sessionID: string }
  tool: { id: string; sessionID: string; messageID: string; callID?: string }
  graph: { before: { revision: string }; after: { revision: string } }
  files: Array<{ absolutePath: string; graphPath?: string; insideGraph: boolean }>
}

type TemporalObligation = {
  id: string
  fingerprint: string
  status: string
  target: string
  reason: string
  risk: string
  evidence: string
  createdAt: string
  updatedAt: string
}

type ObligationStore = {
  schemaVersion: 1
  obligations: TemporalObligation[]
}

export const Event = {
  Updated: BusEvent.define(
    "work_brief.updated",
    Schema.Struct({
      sessionID: SessionID,
      brief: Info,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly update: (input: { sessionID: SessionID; brief: Info }) => Effect.Effect<void>
  readonly render: (sessionID: SessionID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWorkBrief") {}

const empty = (): Info => ({
  confirmedDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  openQuestions: [],
  relevantEvidence: [],
  closeout: [],
})

function compact(input: string) {
  const value = input.replace(/\s+/g, " ").trim()
  return value.length > MAX_ITEM_CHARS ? `${value.slice(0, MAX_ITEM_CHARS - 3)}...` : value
}

function compactItems(items: ReadonlyArray<string> | undefined) {
  return [...new Set((items ?? []).map(compact).filter(Boolean))].slice(0, MAX_ITEMS)
}

export function normalize(input: Partial<Info> | undefined): Info {
  return {
    ...(input?.intent ? { intent: compact(input.intent) } : {}),
    confirmedDecisions: compactItems(input?.confirmedDecisions),
    constraints: compactItems(input?.constraints),
    acceptanceCriteria: compactItems(input?.acceptanceCriteria),
    openQuestions: compactItems(input?.openQuestions),
    relevantEvidence: compactItems(input?.relevantEvidence),
    closeout: compactItems(input?.closeout),
  }
}

function isEmpty(brief: Info) {
  return (
    !brief.intent &&
    brief.confirmedDecisions.length === 0 &&
    brief.constraints.length === 0 &&
    brief.acceptanceCriteria.length === 0 &&
    brief.openQuestions.length === 0 &&
    brief.relevantEvidence.length === 0 &&
    brief.closeout.length === 0
  )
}

function list(items: ReadonlyArray<string>, fallback = "None") {
  return items.length ? items.map((item) => `- ${item}`) : [`- ${fallback}`]
}

export function format(brief: Info) {
  if (isEmpty(brief)) return undefined
  return [
    "## Current Work Brief",
    "",
    "Intent:",
    ...(brief.intent ? [`- ${brief.intent}`] : ["- None recorded"]),
    "",
    "Confirmed Decisions:",
    ...list(brief.confirmedDecisions),
    "",
    "Constraints:",
    ...list(brief.constraints),
    "",
    "Acceptance Criteria:",
    ...list(brief.acceptanceCriteria),
    "",
    "Open Questions:",
    ...list(brief.openQuestions),
    "",
    "Relevant Evidence:",
    ...list(brief.relevantEvidence),
    "",
    "Closeout:",
    ...list(brief.closeout.length ? brief.closeout : [DEFAULT_CLOSEOUT]),
  ].join("\n")
}

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

const temporalContext = Effect.fn("WorkBrief.temporalContext")(function* (sessionID: SessionID) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const dir = path.join(root, ".codegraph", "chimera")
  const records = yield* Effect.promise(() => readProvenanceRecords(root, path.join(dir, "tool-provenance.jsonl")) as Promise<ToolMutationRecord[]>)
  const recent = records
    .filter((record) => (record.actor?.sessionID ?? record.tool.sessionID) === sessionID && record.status === "success")
    .slice(-3)
    .toReversed()
  const store = yield* Effect.promise(() =>
    readPersistentObligationStore<TemporalObligation>(root, path.join(dir, "obligations.json"), { schemaVersion: 1, obligations: [] }),
  )
  const obligations = store.obligations
    .filter((item) => item.status === "pending" || item.status === "claimed" || item.status === "stale")
    .slice(0, 8)

  if (recent.length === 0 && obligations.length === 0) return undefined

  return [
    "## Chimera Temporal Context",
    "",
    "Recent Mutations:",
    ...(recent.length
      ? recent.map((record) => {
          const files = record.files.map((file) => file.graphPath ?? file.absolutePath).slice(0, 5).join(", ") || "none"
          return `- ${record.tool.id} ${record.status} at ${record.finishedAt}; files: ${files}; graph: ${record.graph.before.revision.slice(0, 8)} -> ${record.graph.after.revision.slice(0, 8)}`
        })
      : ["- None recorded for this session."]),
    "",
    "Active Obligations:",
    ...(obligations.length
      ? obligations.map((item) => `- ${item.id} [${item.status}] ${item.target}; risk: ${item.risk}; evidence: ${item.evidence}; reason: ${compact(item.reason)}`)
      : ["- None active."]),
  ].join("\n")
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const get = Effect.fn("WorkBrief.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(WorkBriefTable).where(eq(WorkBriefTable.session_id, sessionID)).limit(1).all()),
      )
      return normalize(rows[0]?.data)
    })

    const update = Effect.fn("WorkBrief.update")(function* (input: { sessionID: SessionID; brief: Info }) {
      const brief = normalize(input.brief)
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(WorkBriefTable).where(eq(WorkBriefTable.session_id, input.sessionID)).run()
          if (isEmpty(brief)) return
          db.insert(WorkBriefTable)
            .values([{ session_id: input.sessionID, data: brief }])
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, brief })
    })

    const render = Effect.fn("WorkBrief.render")(function* (sessionID: SessionID) {
      return [format(yield* get(sessionID)), yield* temporalContext(sessionID)].filter(Boolean).join("\n\n") || undefined
    })

    return Service.of({ get, update, render })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as WorkBrief from "./work-brief"
