import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { getCodeGraphDir } from "@/graph/directory"
import { readOracleResults, readPersistentObligationStore, type OracleRecord, type ObligationStoreLike } from "@/chimera/store"
import { objectRecord } from "./batch-preset"

/** Chimera evidence sources that a batch can materialize into items. */
export const Source = Schema.Literals([
  "pending_obligations",
  "claimed_obligations",
  "stale_obligations",
  "active_obligations",
  "failing_oracles",
  "unknown_oracles",
  "failing_or_unknown_oracles",
])
export type SourceName = Schema.Schema.Type<typeof Source>

export type Obligation = {
  id: string
  fingerprint: string
  status: string
  target: string
  risk: string
  classification?: string
  reason: string
  evidence: string
  atomicLabel?: string
  statementEffect?: string
  relationClause?: string
  impactedBlock?: string
  staleReason?: string
  causeChain?: unknown[]
  createdAt: string
  updatedAt: string
}

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

function chimeraArtifactDir(root: string) {
  return path.join(getCodeGraphDir(root), "chimera")
}

function formatObligation(item: Obligation) {
  return {
    type: "obligation",
    id: item.id,
    ref: `obligation:${item.id}`,
    status: item.status,
    target: item.target,
    risk: item.risk,
    classification: item.classification,
    reason: item.reason,
    evidence: item.evidence,
    atomicLabel: item.atomicLabel,
    statementEffect: item.statementEffect,
    relationClause: item.relationClause,
    impactedBlock: item.impactedBlock,
    staleReason: item.staleReason,
    causeChain: item.causeChain,
  }
}

function compactOraclePayload(input: unknown) {
  if (!objectRecord(input)) return input
  if (!objectRecord(input.shell)) return input
  if (typeof input.shell.output !== "string") return input
  if (input.shell.output.length <= 2000) return input
  return {
    ...input,
    shell: {
      ...input.shell,
      output: input.shell.output.slice(0, 2000),
      outputTruncatedForDisplay: true,
      outputOriginalChars: input.shell.output.length,
    },
  }
}

function formatOracle(record: OracleRecord) {
  return {
    type: "oracle",
    id: record.id,
    ref: `oracle:${record.id}`,
    kind: record.kind,
    status: record.status,
    verificationKind: record.verificationKind,
    tool: record.tool,
    finishedAt: record.finishedAt,
    payload: compactOraclePayload(record.payload),
    linkedChanges: record.linkedChanges.map((change) => ({
      ...change,
      ref: `change:${change.id}`,
      ...(change.changeID ? { changeRef: `change:${change.changeID}` } : {}),
    })),
  }
}

function sourceFilter(source: SourceName) {
  if (source === "pending_obligations") return (item: Obligation) => item.status === "pending"
  if (source === "claimed_obligations") return (item: Obligation) => item.status === "claimed"
  if (source === "stale_obligations") return (item: Obligation) => item.status === "stale"
  return (item: Obligation) => !["resolved", "ignored"].includes(item.status)
}

function oracleFilter(source: SourceName) {
  if (source === "failing_oracles") return (item: OracleRecord) => item.status === "fail"
  if (source === "unknown_oracles") return (item: OracleRecord) => item.status === "unknown"
  return (item: OracleRecord) => item.status === "fail" || item.status === "unknown"
}

export function materializeSource(source: SourceName, limit: number) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance)
    const artifactDir = chimeraArtifactDir(root)
    if (source.includes("obligations")) {
      const store = yield* Effect.promise(() =>
        readPersistentObligationStore<Obligation>(root, path.join(artifactDir, "obligations.json"), {
          schemaVersion: 1,
          obligations: [],
        } satisfies ObligationStoreLike<Obligation>),
      )
      return store.obligations.filter(sourceFilter(source)).slice(0, limit).map(formatObligation)
    }
    const records = yield* Effect.promise(() =>
      readOracleResults(root, path.join(artifactDir, "oracle-results.jsonl"), { sessionID: undefined, limit, includePassing: false }),
    )
    return records.filter(oracleFilter(source)).slice(0, limit).map(formatOracle)
  })
}

export * as BatchSource from "./batch-source"