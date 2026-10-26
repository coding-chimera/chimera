import * as Tool from "./tool"
import DESCRIPTION from "./swarm.txt"
import { SubagentDispatch, type SubagentDispatchStarted, type SubagentPromptOps } from "../agent/subagent-dispatch"
import { BackgroundJob } from "../agent/background-job"
import * as ModelTelemetry from "../agent/model-telemetry"
import { normalizeSubagentModelSelection, validateSubagentModelSelection } from "../agent/subagent-execution"
import { SubagentModelSchedulingRuntime } from "../agent/subagent-model-scheduling-runtime"
import { Agent } from "../agent/agent"
import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { InstanceState } from "@/effect/instance-state"
import { getCodeGraphDir } from "@/graph/directory"
import { readOracleResults, readPersistentObligationStore, type OracleRecord, type ObligationStoreLike } from "@/chimera/store"
import { Session } from "@/session/session"
import { SessionID } from "@/contracts/session-ids"
import path from "path"
import { Cause, Clock, Effect, Fiber, Option, Ref, Schema, Scope, Semaphore } from "effect"
import * as Truncate from "./truncate"

const id = "chimera_swarm"
const DEFAULT_CONCURRENCY = 16
const MAX_CONCURRENCY = 16

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

const BaseParameterFields = {
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
  workload: Schema.optional(Schema.String).annotate({
    description:
      "Delegation workload archetype; omit to let the scheduler pick a route, or declare it for attribution and validation when a model selector is given.",
  }),
  model_profile: Schema.optional(Schema.String).annotate({
    description: "Name of a delegation.model_profiles entry to run every worker with.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Exact provider/model route to run every worker with.",
  }),
  model_identity: Schema.optional(Schema.String).annotate({
    description: "Current runtime model identity to resolve before starting workers.",
  }),
  provider: Schema.optional(Schema.String).annotate({
    description: "Current provider ID used only to narrow model_identity.",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description: "Model variant to use with model or model_identity, when the resolved model advertises one.",
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "Short base description for child task titles.",
  }),
  concurrency: Schema.optional(Schema.Number).annotate({
    description: `Maximum child tasks to run at once. Defaults to ${DEFAULT_CONCURRENCY} and is capped at ${MAX_CONCURRENCY}.`,
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum items to read from a Chimera evidence source. Defaults to 20 and is capped at 100.",
  }),
}

// Narrow parameter set exposed when the background kill-switch is off: the JSON
// schema derived from `parameters` must not advertise `background` at all.
const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the swarm workers in the background and return a startup receipt immediately. Each worker completion is injected into this session automatically. DO NOT sleep, poll, or proactively check on progress",
  }),
  block_reason: Schema.optional(Schema.String).annotate({
    description:
      "Required when dispatching without background=true (a blocking/foreground swarm): state the concrete dependency that forces the parent to wait for every worker result inline. Omit for background swarms.",
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
type ChildSession = {
  index: number
  title: string
  sessionId: string
  model?: unknown
  model_profile?: string
}

type SwarmChildRun = {
  index: number
  title: string
  subagentType: string
  status: "queued" | "running" | "completed" | "error" | "cancelled"
  sessionId?: string
  model?: unknown
  model_profile?: string
  execution?: unknown
  outputPath?: string
  summary?: SwarmSummary
  error?: string
}

/** Throttled tool-part metadata publishing (Phase 4 scale fix). */
type PublishState = {
  dirty: boolean
  scheduled: boolean
  lastPublishedAt: number
  /** Child-run statuses the tool part has already shown; a new one publishes immediately. */
  statuses: ReadonlySet<string>
}
type PublishDecision = "now" | "scheduled" | "coalesced"

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

function renderSummary(summary: { [K in SummaryKey]?: string } | undefined) {
  if (!summary) return "(none)"
  const parts = SUMMARY_LABELS.flatMap(([key, label]) => (summary[key] ? [`${label} ${summary[key]}`] : []))
  return parts.length > 0 ? parts.join(" | ") : "(none)"
}

// Per-worker background notification injected into the dispatching session. Mirrors
// task's background result shape but keeps swarm-specific index/title/output_file.
function swarmWorkerResultText(input: {
  index: number
  title: string
  sessionId?: string
  state: "completed" | "error"
  summary?: { [K in SummaryKey]?: string }
  outputPath?: string
  error?: string
}) {
  return [
    `task_id: ${input.sessionId ?? "not-started"} (swarm worker ${input.state})`,
    "<swarm_worker_result>",
    `index: ${input.index}`,
    `title: ${input.title}`,
    `status: ${input.state}`,
    ...(input.state === "completed" ? [`summary: ${renderSummary(input.summary)}`] : []),
    ...(input.outputPath ? [`output_file: ${input.outputPath}`] : []),
    ...(input.error ? [`error: ${clamp(input.error, 2000)}`] : []),
    "</swarm_worker_result>",
  ].join("\n")
}

export const ChimeraSwarmTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const dispatch = yield* SubagentDispatch
    const routing = yield* ConfigSubagentRouting.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
    const scheduling = yield* SubagentModelSchedulingRuntime.make
    const scope = yield* Scope.Scope
    const run = Effect.fn("ChimeraSwarmTool.execute")(function* (params: Params, ctx: Tool.Context) {
      const selectors = normalizeSubagentModelSelection({
        modelProfile: params.model_profile,
        model: params.model,
        modelIdentity: params.model_identity,
        provider: params.provider,
        variant: params.variant,
      })
      yield* validateSubagentModelSelection(selectors)
      if (params.items?.length && params.from) return yield* Effect.fail(new Error("Provide either explicit items or from, not both."))
      const sourceLimit = bounded(params.limit, 20, 100)
      const sourceItems = params.from ? yield* materializeSource(params.from, sourceLimit) : undefined
      const items = params.items ?? sourceItems
      if (!items?.length)
        return yield* Effect.fail(
          new Error(
            params.from
              ? `No swarm items found from source: ${params.from}. Run \`chimera_audit_recent\` / \`chimera_obligations_list\` first to confirm pending evidence.`
              : "Provide at least one swarm item.\n\nExample: { prompt_template: \"Item {{index}}/{{total}}: {{item}}\", items: [\"Review src/auth.ts\", { file: \"src/api.ts\", scope: \"route handlers\", questions: [\"callers?\"] }] }",
          ),
        )
      const scopeWarnings = params.items ? collectScopeWarnings(items) : []

      const preset = params.preset ?? inferPreset(params.from)
      const template = params.prompt_template ?? (preset ? DEFAULT_TEMPLATES[preset] : undefined)
      if (!template) return yield* Effect.fail(new Error("Provide prompt_template or choose a preset.\n\nExample: { preset: \"audit-followup\", from: \"pending_obligations\", concurrency: 8 }"))
      if (!template.includes("{{item}}")) return yield* Effect.fail(new Error("prompt_template must include the {{item}} placeholder.\n\nExample: prompt_template: \"Item {{index}}/{{total}}: {{item}}\""))

      const subagent = params.subagent_type ?? inferSubagent(preset)
      const subagentInfo = yield* agents.get(subagent)
      if (!subagentInfo) {
        const validTypes = (yield* agents.list()).map((agent) => agent.name).join(", ")
        return yield* Effect.fail(new Error(`Unknown agent type: ${subagent} is not a valid agent type. Valid types: ${validTypes}`))
      }
      const parent = yield* sessions.get(ctx.sessionID)
      const caller = yield* agents.get(ctx.agent)
      const workload = params.workload
        ? yield* scheduling.resolveWorkload({
            workload: params.workload,
            select:
              selectors.modelProfile === undefined && selectors.model === undefined && selectors.modelIdentity === undefined,
            ruleset: Permission.merge(caller.permission, parent.permission ?? []),
            projectID: parent.projectID,
          })
        : undefined
      const model = workload?.selection?.model ?? selectors.model
      const variant = workload?.selection?.variant ?? selectors.variant
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: "task",
          patterns: [subagent],
          always: ["*"],
          metadata: {
            description: params.description ?? `chimera swarm ${items.length} items`,
            subagent_type: subagent,
            item_count: items.length,
            ...(params.workload ? { workload: params.workload } : {}),
          },
        })
      }

      const promptOps = ctx.extra?.promptOps as SubagentPromptOps | undefined
      if (!promptOps) return yield* Effect.fail(new Error("ChimeraSwarmTool requires promptOps in ctx.extra"))
      const prepared = yield* dispatch.prepare({
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        subagentType: subagent,
        modelProfile: selectors.modelProfile,
        model,
        modelIdentity: selectors.modelIdentity,
        provider: selectors.provider,
        variant,
        workload: params.workload,
        authorizeProfile: (profile) =>
          ctx.ask({
            permission: "task_profile",
            patterns: [profile],
            always: [profile],
            metadata: {
              description: params.description ?? `chimera swarm ${items.length} items`,
              model_profile: profile,
            },
          }),
        authorizeModel: ({ providerID, modelID }) =>
          ctx.ask({
            permission: "task_model",
            patterns: [`${providerID}/${modelID}`],
            always: [`${providerID}/${modelID}`],
            metadata: {
              description: params.description ?? `chimera swarm ${items.length} items`,
              model: `${providerID}/${modelID}`,
            },
          }),
      })
      const concurrency = bounded(params.concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY)
      const title = params.description ?? `chimera swarm (${items.length})`
      const fanout = {
        fanoutID: ModelTelemetry.createFanoutID(),
        size: items.length,
        concurrency,
        templateKind: "swarm" as const,
      }
      const selectionSource = prepared.resolved.source === "resume" ? "resume" : workload?.selection ? "scheduler" : "explicit"
      const action = ModelTelemetry.actionForRoute({
        route: `${prepared.resolved.model.providerID}/${prepared.resolved.model.modelID}`,
        identity: workload?.selection?.recommendation?.identity ?? selectors.modelIdentity,
        variant: prepared.resolved.model.variant,
        selectionSource,
        resolutionSource: prepared.resolved.source,
      })
      const decision = ModelTelemetry.createShadowDecision({
        projectID: parent.projectID,
        workload: params.workload ?? "unknown",
        action,
        fanout,
        ...(selectionSource === "scheduler"
          ? {
              candidates: ModelTelemetry.candidatesFromRecommendations({
                selected: action,
                recommendations: workload?.view?.recommendations[params.workload ?? ""] ?? [],
                resolutionSource: prepared.resolved.source,
              }),
            }
          : {}),
      })
      void ModelTelemetry.recordShadowDecision(decision)
      const workItems = items.map((item, index) => ({
        item,
        index: index + 1,
        title: `${params.description ?? preset ?? "swarm item"} ${index + 1}/${items.length}`,
        prompt: renderTemplate(template, item, index + 1, items.length, scopeWarnings),
        telemetry: ModelTelemetry.createShadowDelegation(decision, {
          attemptIndex: 0,
          fanout: { ...fanout, itemIndex: index },
        }),
      }))
      const childRuns = new Map<number, SwarmChildRun>(
        workItems.map((item) => [
          item.index,
          {
            index: item.index,
            title: item.title,
            subagentType: subagent,
            status: "queued" as const,
          },
        ]),
      )
      const baseMetadata = {
        preset,
        source: params.from,
        itemCount: items.length,
        concurrency,
        subagent_type: subagent,
        model_profile: selectors.modelProfile,
        model,
        workload: params.workload,
        model_identity: selectors.modelIdentity,
        provider: selectors.provider,
        scopeWarningCount: scopeWarnings.length,
        scopeWarnings: scopeWarnings.map((warning) => ({
          file: warning.file,
          itemIndexes: warning.itemIndexes,
          message: warning.message,
        })),
      }
      const childRunList = () => Array.from(childRuns.values()).sort((a, b) => a.index - b.index)
      const childSessionList = (): ChildSession[] =>
        childRunList().flatMap((run) =>
          run.sessionId
            ? [
                {
                  index: run.index,
                  title: run.title,
                  sessionId: run.sessionId,
                  model: run.model,
                  model_profile: run.model_profile,
                },
              ]
            : [],
        )
      // (Phase 4) Progressive observability without O(N²) write amplification.
      // Every child-run transition used to serialize the full childRuns/
      // childSessions snapshot into the tool part, so N workers × transitions
      // cost O(N²) bytes and DB writes. Transitions now coalesce into one
      // publish per window; a status phase the part has never shown yet
      // (queued → running → completed → cancelled) still publishes immediately
      // so the progressive-observability contract holds, a trailing timer
      // flushes coalesced transitions, and the run's final flush pins the
      // terminal snapshot before the tool part settles.
      const METADATA_PUBLISH_INTERVAL_MS = 250
      const publishState = yield* Ref.make<PublishState>({
        dirty: false,
        scheduled: false,
        lastPublishedAt: 0,
        statuses: new Set<string>(),
      })
      const publishTimer = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
      const publishSnapshot = Effect.fnUntraced(function* () {
        const publishedAt = yield* Clock.currentTimeMillis
        const runs = childRunList()
        // Clear the pending flag BEFORE the write: a transition that lands while
        // ctx.metadata is in flight re-marks dirty and schedules its own flush,
        // so no update can be swallowed by this publish.
        yield* Ref.set(publishState, {
          dirty: false,
          scheduled: false,
          lastPublishedAt: publishedAt,
          statuses: new Set(runs.map((run) => run.status)),
        })
        yield* ctx.metadata({
          title,
          metadata: {
            ...baseMetadata,
            childRuns: runs,
            childSessions: childSessionList(),
          },
        })
      })
      const flushPendingPublish = Effect.fnUntraced(function* () {
        const dirty = yield* Ref.modify(publishState, (state) => [
          state.dirty,
          { ...state, dirty: false, scheduled: false },
        ])
        if (dirty) yield* publishSnapshot()
      })
      const requestPublish = Effect.fnUntraced(function* (status: string) {
        const now = yield* Clock.currentTimeMillis
        const decision = yield* Ref.modify(publishState, (state): readonly [PublishDecision, PublishState] => {
          if (!state.statuses.has(status) || now - state.lastPublishedAt >= METADATA_PUBLISH_INTERVAL_MS)
            return ["now", state]
          if (state.scheduled) return ["coalesced", { ...state, dirty: true }]
          return ["scheduled", { ...state, dirty: true, scheduled: true }]
        })
        if (decision === "coalesced") return
        if (decision === "now") return yield* publishSnapshot()
        const fiber = yield* Effect.sleep(`${METADATA_PUBLISH_INTERVAL_MS} millis`).pipe(
          Effect.andThen(flushPendingPublish()),
          Effect.forkIn(scope, { startImmediately: true }),
        )
        yield* Ref.set(publishTimer, fiber)
      })
      // Forced publish of the latest snapshot: run start, cancellation, and the
      // final result. A still-pending trailing timer is interrupted first so it
      // cannot publish a stale snapshot after the tool part settles.
      const flushPublish = Effect.fnUntraced(function* () {
        const timer = yield* Ref.getAndSet(publishTimer, undefined)
        if (timer) yield* Fiber.interrupt(timer).pipe(Effect.ignore)
        yield* publishSnapshot()
      })
      const updateChildRun = Effect.fn("ChimeraSwarmTool.updateChildRun")(function* (
        index: number,
        update: Partial<SwarmChildRun>,
      ) {
        const current = childRuns.get(index)
        if (!current) return
        const next = { ...current, ...update }
        childRuns.set(index, next)
        yield* requestPublish(next.status)
      })
      // Metadata-free mutation used by the background path: after the tool part
      // reaches its terminal state ctx.metadata is silently dropped, so the
      // background dispatcher updates its in-memory childRuns without publishing.
      const setChildRun = (index: number, update: Partial<SwarmChildRun>) => {
        const current = childRuns.get(index)
        if (!current) return
        childRuns.set(index, { ...current, ...update })
      }
      const cancelChildren = Effect.fn("ChimeraSwarmTool.cancelChildren")(function* () {
        let metadataChanged = false
        childRuns.forEach((run, index) => {
          if (run.status !== "queued" && run.status !== "running") return
          childRuns.set(index, { ...run, status: "cancelled" })
          metadataChanged = true
        })
        if (metadataChanged) yield* flushPublish()
        // (F4-P2) Engine-backed workers are cancelled through their durable job handles:
        // jobs.cancel fires the job's onInterrupt hook (which cancels the bound child
        // session exactly once) and interrupts the run fiber. Calling promptOps.cancel
        // here as well would double-cancel the same child. The legacy no-engine path
        // keeps the direct promptOps.cancel fan-out.
        yield* Effect.forEach(
          childSessionList(),
          (child) =>
            engine
              ? engine.cancel(child.sessionId).pipe(Effect.ignore)
              : promptOps.cancel(SessionID.make(child.sessionId)).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        )
      })

      yield* flushPublish()
      let activityRecorded = false

      // (F4-P2) Swarm workers ride the background-job engine as foreground jobs so their
      // lifecycle is unified with task dispatches: the run-state cancel cascade and
      // session.remove cleanup reach them through the typed ownerSessionId, cancelChildren
      // binds to durable job handles, and a worker that dispatches its own background
      // tasks parks inside runPreparedCore like any nested dispatch. Foreground jobs
      // (metadata.background === false) are exempt from background_concurrent, and each
      // worker still acquires its DelegationLimiter permit through runPrepared, so the
      // swarm's concurrency cap and both budget pools keep their pre-integration
      // semantics. Kill-switch off or no engine in this runtime: legacy direct dispatch,
      // byte-identical to the pre-integration path.
      const engine = yield* Effect.gen(function* () {
        if (!background) return undefined
        const cfg = yield* config.get()
        const enabled = cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
        return enabled ? background : undefined
      })

      // Background mode: start up to `concurrency` workers synchronously so the
      // receipt carries real child session ids, then hand the rest to a scoped
      // dispatcher that refills slots as workers settle. Workers are registered
      // as engine jobs with metadata.background === true and therefore consume
      // the shared background_concurrent pool. The tool fiber never binds
      // onInterrupt here: a parent abort must not cascade to detached workers
      // (session.remove / task_cancel reach them through the engine instead).
      if (params.background === true && engine) {
        const jobs = engine
        const cfg = yield* config.get()
        const poolLimit = cfg.delegation?.background_concurrent ?? ConfigDelegation.DEFAULT_BACKGROUND_CONCURRENT
        const slots = Semaphore.makeUnsafe(concurrency)
        const workerAbort = new AbortController().signal
        // Every worker completion (and every start failure) injects exactly one
        // notification into the dispatching session. ctx.metadata is dead after
        // the tool part reaches its terminal state, so these fibers never touch it.
        const inject = (text: string) =>
          (promptOps.injectSynthetic?.({ sessionID: ctx.sessionID, text }) ?? Effect.void).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        const notifySettled = Effect.fn("ChimeraSwarmTool.notifyBackgroundWorker")(function* (
          item: (typeof workItems)[number],
          workerSessionID: SessionID,
          generation: number,
        ) {
          yield* jobs.wait({ id: workerSessionID }).pipe(
            Effect.flatMap((waited) => {
              const info = waited.info
              if (!info) return Effect.void
              const completed = info.status === "completed"
              const text = completed ? (info.output ?? "") : (info.error ?? `worker ${info.status}`)
              return Effect.gen(function* () {
                const outputPath = text.length > 0 ? yield* truncate.write(text) : undefined
                yield* inject(
                  swarmWorkerResultText({
                    index: item.index,
                    title: item.title,
                    sessionId: workerSessionID,
                    state: completed ? "completed" : "error",
                    summary: completed ? extractSummary(text) : undefined,
                    outputPath,
                    error: completed ? undefined : text,
                  }),
                )
              })
            }),
            // Delivery is final once the notify fiber finishes, and the mark is
            // generation-bound so a same-id restart is never falsely delivered.
            // The slot is released only after the worker settled, preserving the
            // swarm concurrency cap for queued items.
            Effect.ensuring(jobs.markDelivered(workerSessionID, generation).pipe(Effect.ignore)),
            Effect.ensuring(slots.release(1)),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        })
        const notifyStartError = (item: (typeof workItems)[number], error: string) =>
          inject(
            swarmWorkerResultText({
              index: item.index,
              title: item.title,
              state: "error",
              error,
            }),
          )
        const startWorker = Effect.fn("ChimeraSwarmTool.startBackgroundWorker")(function* (
          item: (typeof workItems)[number],
        ) {
          // Precheck the background pool before materialize (which creates the
          // child session as a side effect), so an over-cap worker never leaves
          // an orphan empty session behind. The engine re-checks atomically.
          const runningCount = (yield* jobs.list()).filter(
            (job) => job.status === "running" && job.metadata?.background !== false,
          ).length
          if (runningCount >= poolLimit) {
            const error = `Cannot start swarm worker ${item.index}: concurrency limit reached (${runningCount} running >= background_concurrent ${poolLimit}). Complete or cancel a running background task before starting another.`
            setChildRun(item.index, { status: "error", error })
            yield* notifyStartError(item, error)
            return false
          }
          const materialized = yield* dispatch.materialize(prepared, item.title).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.pretty(cause)
              setChildRun(item.index, { status: "error", error })
              return notifyStartError(item, error).pipe(Effect.as(undefined))
            }),
          )
          if (!materialized) return false
          const workerSessionID = materialized.nextSession.id
          // onStarted is deliberately omitted: it fires inside the detached job
          // after the tool returned, when ctx.metadata is no longer accepted.
          setChildRun(item.index, {
            status: "running",
            sessionId: workerSessionID,
            model: prepared.resolved.model,
            model_profile: materialized.execution.modelProfile,
            execution: materialized.execution,
          })
          const started = yield* jobs
            .start({
              id: workerSessionID,
              type: "swarm",
              title: item.title,
              ownerSessionId: ctx.sessionID,
              metadata: {
                model: prepared.resolved.model,
                background: true,
              },
              onInterrupt: promptOps.cancel(workerSessionID).pipe(Effect.ignore),
              run: dispatch.runPreparedBackground({
                  prepared,
                  materialized,
                  description: item.title,
                  prompt: item.prompt,
                  promptOps,
                  abort: workerAbort,
                  telemetry: item.telemetry,
                })
                .pipe(Effect.map((result) => result.output)),
            })
            .pipe(
              Effect.map((info) => ({ info })),
              Effect.catchTag("BackgroundJobLimitError", (error) => {
                setChildRun(item.index, { status: "error", error: error.message })
                return notifyStartError(item, error.message).pipe(Effect.as(undefined))
              }),
            )
          if (!started) return false
          yield* notifySettled(item, workerSessionID, started.info.generation)
          return true
        })
        const startWithSlot = Effect.fn("ChimeraSwarmTool.startBackgroundWorkerWithSlot")(function* (
          item: (typeof workItems)[number],
        ) {
          yield* slots.take(1)
          const started = yield* startWorker(item)
          // A rejected start never owns a notify fiber, so release the slot here.
          if (!started) yield* slots.release(1)
        })
        if (!parent.parentID) {
          yield* routing.recordDelegation(parent.projectID).pipe(
            Effect.catchTag("SubagentRoutingStateFileError", (error) =>
              Effect.logWarning("failed to record subagent routing activity", { operation: error.operation }),
            ),
          )
        }
        yield* Effect.forEach(workItems.slice(0, concurrency), startWithSlot, { discard: true })
        const remaining = workItems.slice(concurrency)
        if (remaining.length > 0) {
          yield* Effect.forEach(remaining, startWithSlot, { discard: true }).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }
        const outputObject = {
          preset: preset ?? "custom",
          source: params.from ?? "items",
          subagent_type: subagent,
          model_profile: selectors.modelProfile,
          model,
          workload: params.workload,
          model_identity: selectors.modelIdentity,
          provider: selectors.provider,
          items: items.length,
          concurrency,
          background: true,
          childRuns: childRunList(),
          childSessions: childSessionList(),
          scopeWarnings: scopeWarnings.map((warning) => ({
            file: warning.file,
            itemIndexes: warning.itemIndexes,
            message: warning.message,
          })),
          note: "Swarm workers are running in the background. Each worker completion injects a <swarm_worker_result> notification into this session; do not sleep, poll, or proactively check on progress. Cancel a single worker with task_cancel using its task_id (the worker child session id). This receipt's childRuns metadata is frozen at return time; frontends derive live status from the child sessions.",
        }
        return {
          title,
          metadata: {
            ...baseMetadata,
            // Frontends key live-status derivation off this flag: the part is
            // terminal once the receipt lands, so childRuns below is a frozen
            // snapshot and real progress must be derived from child sessions.
            background: true,
            childRuns: childRunList(),
            childSessions: childSessionList(),
          },
          output: JSON.stringify(outputObject, null, 2),
        }
      }
      type RunPreparedResult = Effect.Success<ReturnType<typeof dispatch.runPrepared>>
      const runWorkerJob = Effect.fn("ChimeraSwarmTool.runWorkerJob")(function* (
        item: (typeof workItems)[number],
        onStarted: (started: SubagentDispatchStarted) => Effect.Effect<void>,
      ) {
        const materialized = yield* dispatch.materialize(prepared, item.title)
        const workerSessionID = materialized.nextSession.id
        let workerResult: RunPreparedResult | undefined
        const started = yield* engine!.start({
          id: workerSessionID,
          type: "swarm",
          title: item.title,
          ownerSessionId: ctx.sessionID,
          metadata: {
            model: prepared.resolved.model,
            background: false,
          },
          onInterrupt: promptOps.cancel(workerSessionID).pipe(Effect.ignore),
          run: dispatch
            .runPrepared({
              prepared,
              materialized,
              description: item.title,
              prompt: item.prompt,
              promptOps,
              abort: ctx.abort,
              telemetry: item.telemetry,
              onStarted,
          }).pipe(
              Effect.map((result) => {
                workerResult = result
                return result.output
              }),
            ),
        })
        const generation = started.generation
        const settled = yield* engine!.wait({ id: workerSessionID }).pipe(
          Effect.map((waited) => waited.info),
          // The tool fiber was interrupted (parent turn aborted): the engine job keeps
          // running in its own scope, so cancel it explicitly — its onInterrupt hook
          // cancels the bound child session (task tool sync-path parity).
          Effect.onInterrupt(() => engine!.cancel(workerSessionID).pipe(Effect.ignore)),
        )
        // The swarm consumes each worker result inline in the tool output, so delivery is
        // complete once the wait resolves — generation-bound so a concurrent same-id
        // restart is never falsely marked delivered. Without this mark the owner's
        // park/quiescence (runPreparedCore, run-mode drain) would wait forever on a job
        // whose result was already consumed here.
        yield* engine!.markDelivered(workerSessionID, generation).pipe(Effect.ignore)
        if (settled?.status === "error") return yield* Effect.fail(new Error(settled.error ?? "Swarm worker failed"))
        if (settled?.status === "cancelled") {
          // Abort-driven cancellation preserves the pre-integration interrupt contract:
          // the worker exits interrupted, not failed, when the parent turn aborted.
          if (ctx.abort.aborted) return yield* Effect.interrupt
          return yield* Effect.fail(new Error(`Swarm worker ${workerSessionID} was cancelled`))
        }
        if (workerResult) return workerResult
        return yield* Effect.fail(new Error(`Swarm worker ${workerSessionID} settled without a result`))
      })

      const results: SwarmResult[] = yield* Effect.forEach(
        workItems,
        (item) =>
          Effect.gen(function* () {
            if (ctx.abort.aborted) return yield* Effect.interrupt
            const onStarted = (started: SubagentDispatchStarted) =>
              Effect.gen(function* () {
                const recordActivity = !activityRecorded && !parent.parentID
                activityRecorded = true
                if (recordActivity) {
                  yield* routing.recordDelegation(parent.projectID).pipe(
                    Effect.catchTag("SubagentRoutingStateFileError", (error) =>
                      Effect.logWarning("failed to record subagent routing activity", { operation: error.operation }),
                    ),
                  )
                }
                yield* updateChildRun(item.index, {
                  status: "running",
                  sessionId: started.sessionId,
                  model: started.model,
                  model_profile: started.execution?.modelProfile,
                  execution: started.execution,
                })
              })
            const result: RunPreparedResult = engine
              ? yield* runWorkerJob(item, onStarted)
              : yield* dispatch.runPrepared({
                  prepared,
                  description: item.title,
                  prompt: item.prompt,
                  promptOps,
                  abort: ctx.abort,
                  telemetry: item.telemetry,
                  onStarted,
                })
            const outputPath = yield* writeChildOutput(result, truncate)
            const summary = extractSummary(result.output)
            yield* updateChildRun(item.index, {
              status: "completed",
              sessionId: result.sessionId,
              model: result.model,
              outputPath,
              summary,
              error: undefined,
              model_profile: result.execution?.modelProfile,
              execution: result.execution,
            })
            return {
              index: item.index,
              status: "success" as const,
              title: item.title,
              sessionId: result.sessionId,
              outputPath,
              summary,
            } satisfies SwarmResult
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const error = Cause.pretty(cause)
                const outputPath = error.length > 0 ? yield* truncate.write(error) : undefined
                const current = childRuns.get(item.index)
                yield* updateChildRun(item.index, {
                  status: ctx.abort.aborted || Cause.hasInterruptsOnly(cause) ? "cancelled" : "error",
                  outputPath,
                  error,
                })
                return {
                  index: item.index,
                  status: "failure" as const,
                  title: item.title,
                  sessionId: current?.sessionId,
                  outputPath,
                  error,
                } satisfies SwarmResult
              }),
            ),
          ),
        { concurrency },
      ).pipe(Effect.onInterrupt(() => cancelChildren()))

      const successes = results.filter((result) => result.status === "success").length
      const failures = results.length - successes
      const outputObject = {
        preset: preset ?? "custom",
        source: params.from ?? "items",
        subagent_type: subagent,
        model_profile: selectors.modelProfile,
        model,
        workload: params.workload,
        model_identity: selectors.modelIdentity,
        provider: selectors.provider,
        items: items.length,
        concurrency,
        childRuns: childRunList(),
        childSessions: childSessionList(),
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

      // Final flush: pin the terminal childRuns snapshot before the tool part
      // settles, and interrupt any pending trailing timer.
      yield* flushPublish()

      return {
        title,
        metadata: {
          ...baseMetadata,
          childRuns: childRunList(),
          childSessions: childSessionList(),
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

    // Tool definitions are resolved lazily at init() time (inside an instance
    // context), so killing the background kill-switch cannot be decided at the
    // registry layer build where config is not yet instance-bound. With the
    // switch off the schema omits `background` entirely and the tool falls back
    // to the pre-background synchronous path.
    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const backgroundEnabled =
          cfg.delegation?.background_subagents ?? ConfigDelegation.DEFAULT_BACKGROUND_SUBAGENTS
        return {
          description: DESCRIPTION,
          parameters: (backgroundEnabled ? Parameters : BaseParameters) as unknown as typeof Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            run(params, ctx).pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult>,
          formatValidationError(error: unknown) {
            return [
              `The ${id} tool was called with invalid arguments: ${error}.`,
              "Expected shape: { prompt_template?: string (must include {{item}}), items?: (string | object)[], preset?: \"audit-followup\" | \"audit-review\" | \"oracle-followup\" | \"file-review\", from?: \"pending_obligations\" | \"claimed_obligations\" | \"stale_obligations\" | \"active_obligations\" | \"failing_oracles\" | \"unknown_oracles\" | \"failing_or_unknown_oracles\", subagent_type?: string, model_profile?: string, model?: string, model_identity?: string, provider?: string, variant?: string, concurrency?: number (1-16), limit?: number (1-100), background?: boolean, block_reason?: string }",
              "Example: { preset: \"audit-followup\", from: \"pending_obligations\", concurrency: 8, background: true }",
            ].join("\n")
          },
        }
      })
  }),
)
