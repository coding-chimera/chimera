import * as Tool from "./tool"
import DESCRIPTION from "./swarm.txt"
import { TaskTool } from "./task"
import { Agent } from "../agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { getCodeGraphDir } from "@/graph/directory"
import { readOracleResults, readPersistentObligationStore, type OracleRecord, type ObligationStoreLike } from "@/chimera/store"
import path from "path"
import { Cause, Effect, Schema } from "effect"

const id = "chimera_swarm"

const Preset = Schema.Literals(["audit-repair", "audit-review", "oracle-followup", "file-review"])
const Source = Schema.Literals([
  "pending_obligations",
  "claimed_obligations",
  "stale_obligations",
  "active_obligations",
  "failing_oracles",
  "unknown_oracles",
  "failing_or_unknown_oracles",
])
const SwarmItem = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])

export const Parameters = Schema.Struct({
  prompt_template: Schema.optional(Schema.String).annotate({
    description: "Prompt template for each child task. Use {{item}} plus optional {{index}} and {{total}} placeholders.",
  }),
  items: Schema.optional(Schema.Array(SwarmItem)).annotate({
    description: "Explicit work items. Each item is rendered into one child subagent task.",
  }),
  from: Schema.optional(Source).annotate({
    description: "Optional Chimera evidence source to materialize into items instead of passing explicit items.",
  }),
  preset: Schema.optional(Preset).annotate({
    description: "Optional default prompt shape for audit repair, audit review, oracle follow-up, or file review.",
  }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "Subagent type to run for each item. Defaults to general.",
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "Short base description for child task titles.",
  }),
  concurrency: Schema.optional(Schema.Number).annotate({
    description: "Maximum child tasks to run at once. Defaults to 3 and is capped at 10.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum items to read from a Chimera evidence source. Defaults to 20 and is capped at 100.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type PresetName = Schema.Schema.Type<typeof Preset>
type SourceName = Schema.Schema.Type<typeof Source>
type ExplicitItem = Schema.Schema.Type<typeof SwarmItem>

type SwarmObligation = {
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

type SwarmResult = {
  index: number
  status: "success" | "failure"
  title: string
  sessionId?: string
  output?: string
  error?: string
}

const DEFAULT_TEMPLATES: Record<PresetName, string> = {
  "audit-repair": [
    "You are a Chimera audit-repair subagent. Review exactly one audit or obligation item.",
    "If it is actionable and narrowly scoped, make the smallest safe fix. If not, explain why it should be skipped.",
    "Do not run a broad repair loop. Return changed files, verification you ran, and residual risk.",
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "audit-review": [
    "You are a Chimera audit-review subagent. Review exactly one audit or obligation item.",
    "Classify it as actionable, already covered, irrelevant, duplicate, stale, or out of scope.",
    "Do not edit unless the parent prompt explicitly tells you to. Return concise evidence and next action.",
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "oracle-followup": [
    "You are a Chimera oracle-followup subagent. Investigate exactly one failing or unknown verification oracle.",
    "Explain the likely cause, whether it is linked to recent changes, and the next focused check or fix.",
    "Do not rerun broad checks unless clearly necessary.",
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "file-review": [
    "You are a Chimera file-review subagent. Review exactly one file or work item.",
    "Report concrete risks, missing tests, or follow-up edits. Keep the result concise and evidence-backed.",
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
}

function bounded(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value)))
}

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

function chimeraArtifactDir(root: string) {
  return path.join(getCodeGraphDir(root), "chimera")
}

function inferPreset(source: SourceName | undefined): PresetName | undefined {
  if (!source) return undefined
  if (source.includes("oracle")) return "oracle-followup"
  return "audit-review"
}

function renderItem(item: ExplicitItem) {
  if (typeof item === "string") return item
  return JSON.stringify(item, null, 2) ?? "{}"
}

function renderTemplate(template: string, item: ExplicitItem, index: number, total: number) {
  return template
    .replaceAll("{{item}}", renderItem(item))
    .replaceAll("{{index}}", String(index))
    .replaceAll("{{total}}", String(total))
}

function formatObligation(item: SwarmObligation) {
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

function objectRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input))
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
  if (source === "pending_obligations") return (item: SwarmObligation) => item.status === "pending"
  if (source === "claimed_obligations") return (item: SwarmObligation) => item.status === "claimed"
  if (source === "stale_obligations") return (item: SwarmObligation) => item.status === "stale"
  return (item: SwarmObligation) => !["resolved", "ignored"].includes(item.status)
}

function oracleFilter(source: SourceName) {
  if (source === "failing_oracles") return (item: OracleRecord) => item.status === "fail"
  if (source === "unknown_oracles") return (item: OracleRecord) => item.status === "unknown"
  return (item: OracleRecord) => item.status === "fail" || item.status === "unknown"
}

function materializeSource(source: SourceName, limit: number) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance)
    const artifactDir = chimeraArtifactDir(root)
    if (source.includes("obligations")) {
      const store = yield* Effect.promise(() =>
        readPersistentObligationStore<SwarmObligation>(root, path.join(artifactDir, "obligations.json"), {
          schemaVersion: 1,
          obligations: [],
        } satisfies ObligationStoreLike<SwarmObligation>),
      )
      return store.obligations.filter(sourceFilter(source)).slice(0, limit).map(formatObligation)
    }
    const records = yield* Effect.promise(() =>
      readOracleResults(root, path.join(artifactDir, "oracle-results.jsonl"), { sessionID: undefined, limit, includePassing: false }),
    )
    return records.filter(oracleFilter(source)).slice(0, limit).map(formatOracle)
  })
}

function outputResult(result: SwarmResult) {
  return [
    `## Item ${result.index}: ${result.status}`,
    result.sessionId ? `task_id: ${result.sessionId}` : undefined,
    result.error ? `error: ${result.error}` : undefined,
    result.output,
  ]
    .filter(Boolean)
    .join("\n")
}

export const ChimeraSwarmTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const taskInfo = yield* TaskTool
    const task = yield* taskInfo.init()

    const run = Effect.fn("ChimeraSwarmTool.execute")(function* (params: Params, ctx: Tool.Context) {
      if (params.items && params.from) return yield* Effect.fail(new Error("Provide either explicit items or from, not both."))
      const sourceLimit = bounded(params.limit, 20, 100)
      const sourceItems = params.from ? yield* materializeSource(params.from, sourceLimit) : undefined
      const items = params.items ?? sourceItems
      if (!items?.length) return yield* Effect.fail(new Error(params.from ? `No swarm items found from source: ${params.from}` : "Provide at least one swarm item."))

      const preset = params.preset ?? inferPreset(params.from)
      const template = params.prompt_template ?? (preset ? DEFAULT_TEMPLATES[preset] : undefined)
      if (!template) return yield* Effect.fail(new Error("Provide prompt_template or choose a preset."))
      if (!template.includes("{{item}}")) return yield* Effect.fail(new Error("prompt_template must include the {{item}} placeholder."))

      const subagent = params.subagent_type ?? "general"
      if (!(yield* agents.get(subagent))) return yield* Effect.fail(new Error(`Unknown agent type: ${subagent} is not a valid agent type`))

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: "task",
          patterns: [subagent],
          always: ["*"],
          metadata: {
            description: params.description ?? `chimera swarm ${items.length} items`,
            subagent_type: subagent,
            item_count: items.length,
          },
        })
      }

      const concurrency = bounded(params.concurrency, 3, 10)
      yield* ctx.metadata({
        title: params.description ?? `chimera swarm (${items.length})`,
        metadata: {
          preset,
          source: params.from,
          itemCount: items.length,
          concurrency,
          subagent_type: subagent,
        },
      })

      const results = yield* Effect.forEach(
        items.map((item, index) => ({
          item,
          index: index + 1,
          title: `${params.description ?? preset ?? "swarm item"} ${index + 1}/${items.length}`,
          prompt: renderTemplate(template, item, index + 1, items.length),
        })),
        (item) =>
          task
            .execute(
              {
                description: item.title,
                prompt: item.prompt,
                subagent_type: subagent,
                command: id,
              },
              {
                ...ctx,
                extra: {
                  ...ctx.extra,
                  bypassAgentCheck: true,
                },
              },
            )
            .pipe(
              Effect.map((result): SwarmResult => ({
                index: item.index,
                status: "success",
                title: item.title,
                sessionId: typeof result.metadata.sessionId === "string" ? result.metadata.sessionId : undefined,
                output: result.output,
              })),
              Effect.catchCause((cause) =>
                Effect.succeed({
                  index: item.index,
                  status: "failure" as const,
                  title: item.title,
                  sessionId: undefined,
                  error: Cause.pretty(cause),
                } satisfies SwarmResult),
              ),
            ),
        { concurrency },
      )

      const successes = results.filter((result) => result.status === "success").length
      const failures = results.length - successes
      return {
        title: params.description ?? `chimera swarm (${items.length})`,
        metadata: {
          preset,
          source: params.from,
          itemCount: items.length,
          concurrency,
          subagent_type: subagent,
          successCount: successes,
          failureCount: failures,
          results: results.map((result) => ({
            index: result.index,
            status: result.status,
            title: result.title,
            sessionId: result.sessionId,
            error: result.error,
          })),
        },
        output: [
          `preset: ${preset ?? "custom"}`,
          `source: ${params.from ?? "items"}`,
          `subagent_type: ${subagent}`,
          `items: ${items.length}`,
          `concurrency: ${concurrency}`,
          `success: ${successes}`,
          `failure: ${failures}`,
          "",
          ...results.map(outputResult),
        ].join("\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
