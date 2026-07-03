import * as Tool from "./tool"
import DESCRIPTION from "./swarm.txt"
import { TaskTool } from "./task"
import { Agent } from "../agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { getCodeGraphDir } from "@/graph/directory"
import { readOracleResults, readPersistentObligationStore, type OracleRecord, type ObligationStoreLike } from "@/chimera/store"
import path from "path"
import { Cause, Effect, Schema } from "effect"
import * as Truncate from "./truncate"

const id = "chimera_swarm"

const Preset = Schema.Literals(["audit-followup", "audit-review", "oracle-followup", "file-review"])
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
    description: "Optional worker prompt shape for audit follow-up, audit review, oracle follow-up, or file review.",
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

type SwarmSummary = {
  status?: string
  changedFiles?: string
  verification?: string
  remainingRisk?: string
  parentFollowUp?: string
}

type SwarmResult = {
  index: number
  status: "success" | "failure"
  title: string
  sessionId?: string
  outputPath?: string
  summary?: SwarmSummary
  error?: string
}
type ScopeWarning = {
  file: string
  itemIndexes: number[]
  message: string
}

const RETURN_CONTRACT = [
  "Return a concise structured report with these labels:",
  "Status: actionable | covered | irrelevant | duplicate | blocked | no-issue",
  "Changed files: <paths or none>",
  "Verification: <commands/results or not run>",
  "Remaining risk: <risk or none>",
  "Parent follow-up: <recommended parent action or none>",
]

const DEFAULT_TEMPLATES: Record<PresetName, string> = {
  "audit-followup": [
    "You are a Chimera audit-followup subagent. Handle exactly one audit or obligation item.",
    "Presets are worker prompt shapes, not workflow engines or permission switches; use the tools available to your subagent normally.",
    "If the item has a clear, narrow fix and you have edit tools, make scoped edits only for this item, run focused verification when you edit, and report changed files.",
    "Do not broaden into unrelated refactors, do not take over other swarm items, and surface already-covered, irrelevant, duplicate, out-of-scope, or blocked items explicitly.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "audit-review": [
    "You are a Chimera audit-review subagent. Review exactly one audit or obligation item.",
    "Classify it as actionable, already covered, irrelevant, duplicate, stale, or out of scope.",
    "Do not edit unless the parent prompt explicitly tells you to. Return concise evidence and next action.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "oracle-followup": [
    "You are a Chimera oracle-followup subagent. Investigate exactly one failing or unknown verification oracle.",
    "Explain the likely cause, whether it is linked to recent changes, and the next focused check or fix.",
    "Do not rerun broad checks unless clearly necessary.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "file-review": [
    "You are a Chimera file-review subagent. Review exactly one file or work item.",
    "Report concrete risks, missing tests, or follow-up edits. Keep the result concise and evidence-backed.",
    ...RETURN_CONTRACT,
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
  if (source === "stale_obligations") return "audit-review"
  return "audit-followup"
}

function inferSubagent(preset: PresetName | undefined): string {
  if (preset === "file-review") return "explore"
  return "general"
}

function renderItem(item: ExplicitItem) {
  if (typeof item === "string") return item
  return JSON.stringify(item, null, 2) ?? "{}"
}

function objectRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input))
}

function stringValues(input: unknown) {
  if (typeof input === "string" && input.length > 0) return [input]
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function itemScopeFiles(item: ExplicitItem) {
  if (!objectRecord(item)) return []
  return [
    ...stringValues(item.files),
    ...stringValues(item.file),
    ...stringValues(item.path),
    ...stringValues(item.target),
    ...(objectRecord(item.scope)
      ? [...stringValues(item.scope.files), ...stringValues(item.scope.file), ...stringValues(item.scope.path), ...stringValues(item.scope.target)]
      : []),
  ]
}

function collectScopeWarnings(items: ReadonlyArray<ExplicitItem>) {
  const byFile = new Map<string, number[]>()
  items.forEach((item, index) => itemScopeFiles(item).forEach((file) => byFile.set(file, [...(byFile.get(file) ?? []), index + 1])))
  return Array.from(byFile.entries())
    .filter(([, itemIndexes]) => itemIndexes.length > 1)
    .map(([file, itemIndexes]): ScopeWarning => ({
      file,
      itemIndexes,
      message: `Possible scope conflict: ${file} appears in items ${itemIndexes.join(", ")}; keep edits scoped, resolve conflicts in the parent, or lower concurrency.`,
    }))
}

function scopeWarningPrompt(index: number, warnings: ScopeWarning[]) {
  return warnings
    .filter((warning) => warning.itemIndexes.includes(index))
    .map((warning) => `Scope warning: ${warning.message}`)
    .join("\n")
}

function renderTemplate(template: string, item: ExplicitItem, index: number, total: number, warnings: ScopeWarning[]) {
  return [scopeWarningPrompt(index, warnings), template.replaceAll("{{item}}", renderItem(item)).replaceAll("{{index}}", String(index)).replaceAll("{{total}}", String(total))]
    .filter(Boolean)
    .join("\n\n")
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

function clamp(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, max) + "..."
}

const SUMMARY_LABELS = [
  ["status", "Status:"],
  ["changedFiles", "Changed files:"],
  ["verification", "Verification:"],
  ["remainingRisk", "Remaining risk:"],
  ["parentFollowUp", "Parent follow-up:"],
] as const

type SummaryKey = (typeof SUMMARY_LABELS)[number][0]

function extractSummary(output: string): { [K in SummaryKey]?: string } {
  const text = output.replace(/<task_result>|<\/task_result>/g, "")
  const positions = SUMMARY_LABELS.map(([key, label]) => ({
    key,
    label,
    index: text.indexOf(label),
  }))
    .filter((item) => item.index !== -1)
    .sort((a, b) => a.index - b.index)

  const summary: { [K in SummaryKey]?: string } = {}
  for (let i = 0; i < positions.length; i++) {
    const current = positions[i]
    const next = positions[i + 1]
    const start = current.index + current.label.length
    const end = next ? next.index : text.length
    const value = text
      .slice(start, end)
      .replace(/\n+/g, " ")
      .trim()
    if (value.length > 0) summary[current.key] = clamp(value, 1000)
  }
  return summary
}

function writeChildOutput(result: Tool.ExecuteResult, truncate: Truncate.Interface) {
  return Effect.gen(function* () {
    const existing = (result.metadata as { outputPath?: unknown }).outputPath
    if (typeof existing === "string") return existing
    if (typeof result.output !== "string" || result.output.length === 0) return undefined
    return yield* truncate.write(result.output)
  })
}

export const ChimeraSwarmTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const taskInfo = yield* TaskTool
    const task = yield* taskInfo.init()
    const run = Effect.fn("ChimeraSwarmTool.execute")(function* (params: Params, ctx: Tool.Context) {
      if (params.items && params.from) return yield* Effect.fail(new Error("Provide either explicit items or from, not both."))
      const sourceLimit = bounded(params.limit, 20, 100)
      const sourceItems = params.from ? yield* materializeSource(params.from, sourceLimit) : undefined
      const items = params.items ?? sourceItems
      if (!items?.length) return yield* Effect.fail(new Error(params.from ? `No swarm items found from source: ${params.from}` : "Provide at least one swarm item."))
      const scopeWarnings = params.items ? collectScopeWarnings(items) : []

      const preset = params.preset ?? inferPreset(params.from)
      const template = params.prompt_template ?? (preset ? DEFAULT_TEMPLATES[preset] : undefined)
      if (!template) return yield* Effect.fail(new Error("Provide prompt_template or choose a preset."))
      if (!template.includes("{{item}}")) return yield* Effect.fail(new Error("prompt_template must include the {{item}} placeholder."))

      const subagent = params.subagent_type ?? inferSubagent(preset)
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
          scopeWarningCount: scopeWarnings.length,
          scopeWarnings: scopeWarnings.map((warning) => ({
            file: warning.file,
            itemIndexes: warning.itemIndexes,
            message: warning.message,
          })),
        },
      })

      const results: SwarmResult[] = yield* Effect.forEach(
        items.map((item, index) => ({
          item,
          index: index + 1,
          title: `${params.description ?? preset ?? "swarm item"} ${index + 1}/${items.length}`,
          prompt: renderTemplate(template, item, index + 1, items.length, scopeWarnings),
        })),
        (item) =>
          Effect.gen(function* () {
            const result = yield* task.execute(
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
            const outputPath = yield* writeChildOutput(result, truncate)
            const summary = extractSummary(result.output)
            return {
              index: item.index,
              status: "success" as const,
              title: item.title,
              sessionId: typeof result.metadata.sessionId === "string" ? result.metadata.sessionId : undefined,
              outputPath,
              summary,
            } satisfies SwarmResult
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const error = Cause.pretty(cause)
                const outputPath = error.length > 0 ? yield* truncate.write(error) : undefined
                return {
                  index: item.index,
                  status: "failure" as const,
                  title: item.title,
                  sessionId: undefined,
                  outputPath,
                  error,
                } satisfies SwarmResult
              }),
            ),
          ),
        { concurrency },
      )

      const successes = results.filter((result) => result.status === "success").length
      const failures = results.length - successes
      const outputObject = {
        preset: preset ?? "custom",
        source: params.from ?? "items",
        subagent_type: subagent,
        items: items.length,
        concurrency,
        success: successes,
        failure: failures,
        scopeWarnings: scopeWarnings.map((warning) => ({
          file: warning.file,
          itemIndexes: warning.itemIndexes,
          message: warning.message,
        })),
        parentCloseout: [
          "Inspect each worker's Status, Changed files, Verification, Remaining risk, and Parent follow-up labels.",
          "If any worker changed files or reports actionable follow-up, resolve conflicts, run `chimera_audit_recent`, and run focused verification before closeout.",
          "Recall `chimera_oracle_recent` after verification when failures or unknown oracle evidence may be linked to the swarm work.",
        ],
        results: results.map((result) => ({
          index: result.index,
          status: result.status,
          title: result.title,
          sessionId: result.sessionId,
          outputFile: result.outputPath,
          summary: result.summary ?? {},
          error: result.error ? clamp(result.error, 500) : undefined,
        })),
        note: "Each child result was saved to its own file. Use Read with the outputFile path to view the full output.",
      }

      return {
        title: params.description ?? `chimera swarm (${items.length})`,
        metadata: {
          preset,
          source: params.from,
          itemCount: items.length,
          concurrency,
          subagent_type: subagent,
          scopeWarningCount: scopeWarnings.length,
          scopeWarnings: scopeWarnings.map((warning) => ({
            file: warning.file,
            itemIndexes: warning.itemIndexes,
            message: warning.message,
          })),
          successCount: successes,
          failureCount: failures,
          results: results.map((result) => ({
            index: result.index,
            status: result.status,
            title: result.title,
            sessionId: result.sessionId,
            outputPath: result.outputPath,
            summary: result.summary,
            error: result.error,
          })),
        },
        output: JSON.stringify(outputObject, null, 2),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
