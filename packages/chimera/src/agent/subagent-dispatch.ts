import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { EffectBridge } from "@/effect/bridge"
import { Permission } from "@/permission"
import { ModelIdentity } from "@/provider/model-identity"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/contracts/session-ids"
import { LLM } from "@/session/llm"
import { Truncate } from "@/tool/truncate"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { errorMessage } from "@/util/error"
import { Cause, Effect, Exit, Option } from "effect"
import type { SessionPrompt } from "../session/prompt"
import { Agent } from "./agent"
import { BackgroundJob } from "./background-job"
import { DelegationLimiter } from "./delegation-limiter"
import { resolveSubagentExecution, type ResolvedSubagentExecution, type SubagentExecutionMetadata } from "./subagent-execution"
import * as ModelTelemetry from "./model-telemetry"
import { SubagentModelCatalog } from "./subagent-model-catalog"
import { exclusionMatch, resolveArchetypes } from "./subagent-model-scheduling"
import { deriveSubagentSessionPermission } from "./subagent-permissions"

/** Default progress-notification cadence while a dispatch is parked on owned background jobs. */
const PARK_PROGRESS_INTERVAL_MS = 30_000

/** Inline character cap for a structured-output text fallback; the full text is saved when it exceeds this. */
const FALLBACK_TEXT_MAX_CHARS = 8 * 1024

/** Event/UI annotation prepended to a fallback result; the worker still counts as completed. */
const EXHAUSTED_FALLBACK_NOTE = "schema retries exhausted, fell back to text"
const COMPACTION_FALLBACK_NOTE = "schema retries interrupted by compaction, fell back to text"

function lastTextPart(message: MessageV2.WithParts) {
  return message.parts.findLast((part): part is MessageV2.TextPart => part.type === "text")
}

/**
 * Corrective user turn sent to a child session whose previous turn ended
 * without valid structured output. It repeats the schema and the failure so
 * the model can call StructuredOutput immediately instead of redoing the task.
 */
function structuredOutputCorrectionPrompt(schema: Record<string, unknown>, failure: string) {
  return [
    "Your previous turn ended without valid structured output.",
    "",
    `Failure: ${failure}`,
    "",
    "Return the final answer again, but this time call the StructuredOutput tool immediately with a JSON object that conforms to this schema:",
    JSON.stringify(schema, null, 2),
    "",
    "Do not reply with plain text and do not continue the task.",
  ].join("\n")
}

export interface SubagentPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput['parts']>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  /** Session-addressable synthetic injection; provided by the session prompt layer for background completion notifications. */
  injectSynthetic?: (input: { sessionID: SessionID; text: string }) => Effect.Effect<MessageV2.WithParts, InstanceType<typeof NotFoundError>>
}

export type SubagentDispatchStarted = {
  sessionId: SessionID
  model: { providerID: ProviderID; modelID: ModelID; variant?: string }
  execution: SubagentExecutionMetadata
}

export type SubagentDispatchInput = {
  parentSessionID: SessionID
  parentMessageID: MessageID
  description: string
  prompt: string
  subagentType: string
  modelProfile?: string
  model?: string
  modelIdentity?: string
  provider?: string
  variant?: string
  workload?: string
  taskID?: string
  promptOps: SubagentPromptOps
  abort: AbortSignal
  authorizeProfile?: (profile: string) => Effect.Effect<void>
  authorizeModel?: (model: { providerID: ProviderID; modelID: ModelID; variant?: string }) => Effect.Effect<void>
  onStarted?: (input: SubagentDispatchStarted) => Effect.Effect<void>
  telemetry?: ModelTelemetry.ShadowDelegation
}

export type SubagentDispatchPrepared = {
  parentSessionID: SessionID
  parent: Session.Info
  subagent: Agent.Info
  existing?: Session.Info
  config: Config.Info
  resolved: ResolvedSubagentExecution
  workload?: string
}

export type SubagentDispatchPrepareInput = Pick<
  SubagentDispatchInput,
  | "parentSessionID"
  | "parentMessageID"
  | "subagentType"
  | "modelProfile"
  | "model"
  | "modelIdentity"
  | "provider"
  | "variant"
  | "taskID"
  | "workload"
  | "authorizeProfile"
  | "authorizeModel"
>

export type SubagentDispatchRunPreparedInput = Pick<
  SubagentDispatchInput,
  "description" | "prompt" | "promptOps" | "abort" | "onStarted" | "telemetry"
> & {
  prepared: SubagentDispatchPrepared
  materialized?: SubagentDispatchMaterialized
  /** Structured-output request forwarded to the child prompt (result lands on `message.info.structured`). */
  format?: MessageV2.OutputFormat
  /** Periodically invoked while the dispatch waits (parks) for owned background jobs to finish delivering. */
  onParkProgress?: (info: { waiting: number; elapsedMs: number }) => Effect.Effect<void>
  /** Progress-notification cadence while parked; never an abandonment timeout. Defaults to 30s. */
  parkProgressIntervalMs?: number
}

export type SubagentDispatchMaterialized = {
  nextSession: Session.Info
  execution: SubagentExecutionMetadata
  atDepthCap: boolean
}

export const SubagentDispatch = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const provider = yield* Provider.Service
  const routing = yield* ConfigSubagentRouting.Service
  const limiter = yield* DelegationLimiter.Service
  const background = yield* Effect.serviceOption(BackgroundJob.Service)

  const prepare = Effect.fn("SubagentDispatch.prepare")(function* (input: SubagentDispatchPrepareInput) {
    const cfg = yield* config.get()
    const parent = yield* sessions.get(input.parentSessionID)
    const msg = yield* Effect.sync(() =>
      MessageV2.get({ sessionID: input.parentSessionID, messageID: input.parentMessageID }),
    )
    if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

    const subagent = yield* agents.get(input.subagentType)
    if (!subagent) {
      return yield* Effect.fail(new Error(`Unknown agent type: ${input.subagentType} is not a valid agent type`))
    }

    const existing = input.taskID
      ? yield* sessions
          .get(SessionID.make(input.taskID))
          .pipe(Effect.catch((error) => (NotFoundError.isInstance(error) ? Effect.succeed(undefined) : Effect.fail(error))))
      : undefined

    if (existing) {
      if (existing.parentID !== input.parentSessionID) {
        return yield* Effect.fail(
          new Error(`Cannot resume session ${existing.id}: it belongs to a different parent session`),
        )
      }
      if (existing.projectID !== parent.projectID) {
        return yield* Effect.fail(new Error(`Cannot resume session ${existing.id}: it belongs to a different project`))
      }
      if (existing.workspaceID !== parent.workspaceID) {
        return yield* Effect.fail(
          new Error(`Cannot resume session ${existing.id}: it belongs to a different workspace`),
        )
      }
    }

    const catalog =
      input.modelIdentity === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const caller = yield* agents.get(msg.info.agent)
            if (!caller) return yield* Effect.fail(new Error(`Unknown parent agent: ${msg.info.agent}`))
            return yield* SubagentModelCatalog.withPreferences(
              SubagentModelCatalog.visible(
                SubagentModelCatalog.buildSnapshot({
                  providers: yield* provider.list(),
                  configuredProviders: cfg.provider,
                }),
                Permission.merge(caller.permission, parent.permission ?? []),
              ),
              parent.projectID,
              routing,
            )
          })

    const resolved = yield* resolveSubagentExecution({
      subagentType: input.subagentType,
      modelProfile: input.modelProfile,
      model: input.model,
      modelIdentity: input.modelIdentity,
      provider: input.provider,
      variant: input.variant,
      parent: {
        providerID: msg.info.providerID,
        modelID: msg.info.modelID,
        variant: msg.info.variant,
      },
      subagent,
      delegation: cfg.delegation,
      existing,
      validateModel: (providerID, modelID) => provider.getModel(providerID, modelID),
      resolveModelIdentity: catalog
        ? (intent) =>
            SubagentModelCatalog.resolveRoute(catalog, intent).pipe(
              Effect.map((route) => ({
                providerID: ProviderID.make(route.providerID),
                modelID: ModelID.make(route.modelID),
              })),
            )
        : undefined,
    })
    if (input.workload !== undefined && resolved.source !== "resume") {
      const archetype = resolveArchetypes(cfg.delegation?.scheduling).find((item) => item.name === input.workload)
      if (archetype?.excludeModels?.length) {
        const info = yield* provider
          .getModel(resolved.model.providerID, resolved.model.modelID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const identity = ModelIdentity.resolve({
          providerID: resolved.model.providerID,
          modelID: resolved.model.modelID,
          apiID: info?.api.id,
          explicitCapabilityModelID:
            cfg.provider?.[resolved.model.providerID]?.models?.[resolved.model.modelID]?.capability_model_id,
        }).identity
        const matched = exclusionMatch(archetype, {
          model: `${resolved.model.providerID}/${resolved.model.modelID}`,
          providerID: resolved.model.providerID,
          identity,
        })
        if (matched !== undefined) {
          return yield* Effect.fail(
            new Error(
              `Model ${resolved.model.providerID}/${resolved.model.modelID} is excluded from workload "${input.workload}" by delegation.scheduling.archetypes.${input.workload}.excludeModels (matched "${matched}"). Choose another model or omit workload; the model stays eligible for workloads that do not exclude it.`,
            ),
          )
        }
      }
    }
    if (resolved.profile !== undefined) {
      yield* (input.authorizeProfile?.(resolved.profile) ?? Effect.void)
    }
    if (input.model !== undefined || input.modelIdentity !== undefined) {
      yield* (input.authorizeModel?.(resolved.model) ?? Effect.void)
    }
    return { parentSessionID: input.parentSessionID, parent, subagent, existing, config: cfg, resolved, workload: input.workload }
  })

  // Depth of a session in the delegation chain; root sessions have depth 1.
  // A missing ancestor is treated as a root so a corrupted chain fails open.
  const delegationDepth = (info: Session.Info): Effect.Effect<number> =>
    Effect.gen(function* () {
      if (!info.parentID) return 1
      const parent = yield* sessions.get(info.parentID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!parent) return 1
      return (yield* delegationDepth(parent)) + 1
    })

  const materialize = Effect.fn("SubagentDispatch.materialize")(function* (
    prepared: SubagentDispatchPrepared,
    description: string,
  ) {
    const parentAgent = prepared.parent.agent
      ? yield* agents.get(prepared.parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: prepared.parent.permission ?? [],
      parentAgent,
      subagent: prepared.subagent,
    })

    const maxDepth = prepared.config.delegation?.max_depth ?? ConfigDelegation.DEFAULT_MAX_DEPTH
    const childDepth = (yield* delegationDepth(prepared.parent)) + 1
    const atDepthCap = childDepth >= maxDepth
    const nestedDenyRules = atDepthCap
      ? [
          { pattern: "*", action: "deny" as const, permission: "task" as const },
          { pattern: "*", action: "deny" as const, permission: "chimera_swarm" as const },
          { pattern: "*", action: "deny" as const, permission: "orchestrate" as const },
        ]
      : []

    const nextSession =
      prepared.existing ??
      (yield* sessions.create({
        parentID: prepared.parentSessionID,
        title: description + ` (@${prepared.subagent.name} subagent)`,
        agent: prepared.subagent.name,
        model: {
          id: prepared.resolved.model.modelID,
          providerID: prepared.resolved.model.providerID,
          variant: prepared.resolved.model.variant,
        },
        permission: [
          ...derived,
          ...(prepared.config.experimental?.primary_tools?.map((item) => ({
            pattern: "*",
            action: "allow" as const,
            permission: item,
          })) ?? []),
          ...nestedDenyRules,
        ],
      }))

    if (prepared.existing) {
      yield* sessions.updatePermissionSlots({
        sessionID: prepared.existing.id,
        rules: [...derived.filter((rule) => rule.action === "deny"), ...nestedDenyRules],
      })
    }

    const execution: SubagentExecutionMetadata = {
      version: 2,
      parentSessionId: prepared.parentSessionID,
      agent: prepared.subagent.name,
      modelProfile: prepared.resolved.profile,
      workload: prepared.workload,
      source: prepared.resolved.source,
      resumed: Boolean(prepared.existing),
    }

    return { nextSession, atDepthCap, execution }
  })

  const runPreparedCore = Effect.fn("SubagentDispatch.runPreparedCore")(function* (
    prepared: SubagentDispatchPrepared,
    input: SubagentDispatchRunPreparedInput,
    materialized: SubagentDispatchMaterialized,
  ) {
    const { nextSession, atDepthCap, execution } = materialized
    const startedAt = Date.now()
    let firstStreamedDeltaAt: number | undefined
    const firstStreamedDelta = (parts: MessageV2.Part[]): number | undefined => {
      const starts = parts.flatMap((part) => {
        if (part.type === "text") return part.time ? [part.time.start] : []
        if (part.type === "reasoning") return [part.time.start]
        if (part.type === "tool" && "time" in part.state) return [part.state.time.start]
        return []
      })
      return starts.length === 0 ? undefined : Math.min(...starts)
    }
    const boundTelemetry = (() => {
      if (!input.telemetry) return undefined
      try {
        return ModelTelemetry.bindShadowDelegationBestEffort({ delegation: input.telemetry, sessionID: nextSession.id })
      } catch {
        return undefined
      }
    })()
    const telemetry = (
      eventType:
        | "delegation.prepared"
        | "delegation.started"
        | "delegation.finished"
        | "delegation.failed"
        | "delegation.cancelled",
      execution?: ModelTelemetry.Execution,
      usage?: ModelTelemetry.Usage,
    ) =>
      Effect.sync(() => {
        if (!boundTelemetry) return
        void ModelTelemetry.recordShadowLifecycle(boundTelemetry, eventType, execution, usage)
      }).pipe(Effect.ignore)
    yield* telemetry("delegation.prepared")
    const runCancel = yield* EffectBridge.make()
    const cancel = input.promptOps.cancel(nextSession.id)
    function onAbort() {
      runCancel.fork(cancel)
    }

    // Phase 2 park: after the child's turn completes, hold the dispatch until every
    // background job owned by the child has settled AND been delivered (the notify
    // fiber marks delivered only after the wake-up turn finished), then re-read the
    // child's newest assistant message as the final result. Without the park, the
    // wake-up turn is orphaned: the parent already consumed the "waiting" text and
    // the injected result has no consumer. No owned job (or no background service)
    // means the existing fast path runs byte-identical.
    const settleOwnedBackgroundJobs = Effect.fnUntraced(function* (initial: MessageV2.WithParts) {
      const service = Option.getOrUndefined(background)
      if (!service) return initial
      const ownedUnsettled = (jobs: BackgroundJob.Info[]) =>
        jobs.filter(
          (job) =>
            job.ownerSessionId === nextSession.id &&
            (job.status === "running" || job.delivery === "pending"),
        )
      if (ownedUnsettled(yield* service.list()).length === 0) return initial
      const parkedAt = Date.now()
      const interval = input.parkProgressIntervalMs ?? PARK_PROGRESS_INTERVAL_MS
      const progress = (waiting: number, elapsedMs: number) =>
        input.onParkProgress?.({ waiting, elapsedMs }) ?? Effect.void
      // Immediate first tick so the parent sees the parked state right away.
      yield* progress(ownedUnsettled(yield* service.list()).length, 0)
      // Interval bounds only the progress cadence; quiescence is never abandoned.
      for (;;) {
        const quiescent = yield* service.waitOwnerQuiescent(nextSession.id).pipe(Effect.timeoutOption(interval))
        if (Option.isSome(quiescent)) break
        yield* progress(ownedUnsettled(yield* service.list()).length, Date.now() - parkedAt)
      }
      if (input.abort.aborted) return yield* Effect.interrupt
      const latest = yield* sessions.findMessage(nextSession.id, (m) => m.info.role !== "user")
      if (Option.isNone(latest)) return initial
      return latest.value
    })

    // A json_schema turn that ends without structured output is recoverable:
    // the same child session gets a corrective user turn (same format) instead
    // of failing the whole dispatch. A StructuredOutput tool call that failed
    // schema validation leaves the validation text on the tool part; prefer it
    // over the generic "Model did not produce structured output" message.
    // A non-structured assistant error keeps the existing fail-fast semantics.
    const structuredFailure = Effect.fnUntraced(function* (message: MessageV2.WithParts, after: MessageID) {
      if (message.info.role === "assistant" && message.info.structured !== undefined) return undefined
      const error = message.info.role === "assistant" ? message.info.error : undefined
      if (error && !MessageV2.StructuredOutputError.isInstance(error)) return undefined
      const failed = yield* sessions
        .findMessage(
          nextSession.id,
          (candidate) =>
            candidate.info.id > after &&
            candidate.parts.some(
              (part) =>
                part.type === "tool" &&
                part.tool === LLM.STRUCTURED_OUTPUT_TOOL_NAME &&
                part.state.status === "error",
            ),
        )
        .pipe(Effect.map(Option.getOrUndefined))
      const validation = failed?.parts.findLast(
        (part) =>
          part.type === "tool" && part.tool === LLM.STRUCTURED_OUTPUT_TOOL_NAME && part.state.status === "error",
      )
      if (validation?.type === "tool" && validation.state.status === "error") return validation.state.error
      if (error) return errorMessage(error)
      return "The StructuredOutput tool was not called before the turn ended."
    })

    // A schema retry window can be cut short by compaction. The child prompt
    // loop may install an auto compaction between retry rounds (pending) or
    // execute one during a retry round (completed); either way the structured
    // answer we were retrying for is no longer the useful result. Pending
    // compactions are skipped by the corrective user turn's newer message (the
    // loop treats the old compaction task as stale), and completed ones are
    // accepted without rollback — this check only decides to stop retrying and
    // return the text read before the compaction.
    const retryWindowCompaction = Effect.fnUntraced(function* (after: MessageID) {
      const messages = yield* sessions.messages({ sessionID: nextSession.id })
      const summarized = new Set(
        messages.flatMap((message) =>
          message.info.role === "assistant" && message.info.summary === true && message.info.finish && !message.info.error
            ? [message.info.parentID]
            : [],
        ),
      )
      for (const message of messages) {
        if (message.info.id <= after || message.info.role !== "user") continue
        const compaction = message.parts.find(
          (part): part is MessageV2.CompactionPart => part.type === "compaction",
        )
        if (!compaction?.auto) continue
        return summarized.has(message.info.id) ? ("completed" as const) : ("pending" as const)
      }
      return undefined
    })

    const newestMessageID = Effect.fnUntraced(function* (fallback: MessageID) {
      const messages = yield* sessions.messages({ sessionID: nextSession.id })
      return messages.at(-1)?.info.id ?? fallback
    })

    // Text fallback for an exhausted/interrupted schema retry: the inline text
    // is a character-capped head of the body (line-based truncation would drop
    // the body entirely for a single long line); the full text is written
    // through Truncate and the inline tail carries the output path. The
    // annotation part is persisted on the child session so the event/UI stream
    // shows why a completed worker returned text instead of structured output.
    const textFallback = Effect.fnUntraced(function* (message: MessageV2.WithParts, note: string) {
      const text = lastTextPart(message)?.text ?? ""
      const content = text.length === 0 ? note : `${note}\n\n${text}`
      const truncate = Option.getOrUndefined(yield* Effect.serviceOption(Truncate.Service))
      const overflow = content.length > FALLBACK_TEXT_MAX_CHARS
      const outputPath =
        overflow && truncate
          ? yield* truncate.write(content).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      const inline = overflow
        ? [
            content.slice(0, FALLBACK_TEXT_MAX_CHARS),
            `...output truncated (${content.length - FALLBACK_TEXT_MAX_CHARS} chars omitted)...`,
            ...(outputPath ? [`Full output saved to: ${outputPath}`] : []),
          ].join("\n\n")
        : content
      const annotation: MessageV2.TextPart = {
        id: PartID.ascending(),
        messageID: message.info.id,
        sessionID: message.info.sessionID,
        type: "text",
        text: note,
        synthetic: true,
        ignored: true,
        metadata: { schema_fallback: true },
        time: { start: Date.now(), end: Date.now() },
      }
      yield* sessions.updatePart(annotation).pipe(Effect.ignoreCause({ log: true }))
      const parts = [...message.parts]
      const index = parts.findLastIndex((part) => part.type === "text")
      if (index >= 0 && parts[index].type === "text") parts[index] = { ...parts[index], text: inline }
      else parts.push({ ...annotation, text: inline })
      const info =
        message.info.role === "assistant" && message.info.error ? { ...message.info, error: undefined } : message.info
      return { message: { info, parts }, outputPath }
    })

    const runWork = Effect.gen(function* () {
      if (input.abort.aborted) {
        yield* (input.onStarted?.({ sessionId: nextSession.id, model: prepared.resolved.model, execution }) ?? Effect.void)
        yield* cancel
        return yield* Effect.interrupt
      }
      yield* telemetry("delegation.started")
      yield* (input.onStarted?.({ sessionId: nextSession.id, model: prepared.resolved.model, execution }) ?? Effect.void)

      const messageID = MessageID.ascending()
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          input.abort.addEventListener("abort", onAbort, { once: true })
        }),
        () =>
          Effect.gen(function* () {
            if (input.abort.aborted) return yield* Effect.interrupt
            const parts = (yield* input.promptOps.resolvePromptParts(input.prompt)).map((part) =>
              part.type === "text"
                ? { ...part, metadata: { ...part.metadata, memorySource: "delegated" } }
                : part,
            )
            // Each iteration is one full child round (prompt -> park on owned
            // background jobs -> read the final assistant message). A round
            // without structured output re-prompts the SAME child session with
            // a corrective user message carrying the same format, so
            // StructuredOutput is injected again; no new session and no
            // maxTotalAgents slot is consumed. Exhaustion degrades to a text
            // fallback (a completed worker) when the child produced text.
            const structuredFormat = input.format?.type === "json_schema" ? input.format : undefined
            const maxStructuredRetries = structuredFormat?.retryCount ?? 2
            let roundParts: SessionPrompt.PromptInput["parts"] = parts
            let roundMessageID = messageID
            let structuredRetries = 0
            // Baseline is taken after the first failed round so a compaction
            // that belongs to the child's normal work never counts. Only a
            // compaction boundary newer than this baseline falls inside the
            // retry window.
            let retryBaseline: MessageID | undefined
            let retryText: MessageV2.WithParts | undefined
            for (;;) {
              if (input.abort.aborted) return yield* Effect.interrupt
              // Between retry rounds: a pending auto compaction is skipped
              // (the corrective user turn makes its task stale, so the loop
              // never processes it) and the retry round is cancelled.
              if (
                structuredRetries > 0 &&
                retryBaseline !== undefined &&
                retryText !== undefined &&
                (yield* retryWindowCompaction(retryBaseline)) !== undefined
              ) {
                return { message: retryText, fallback: COMPACTION_FALLBACK_NOTE }
              }
              const result = yield* input.promptOps.prompt({
                messageID: roundMessageID,
                sessionID: nextSession.id,
                model: {
                  modelID: prepared.resolved.model.modelID,
                  providerID: prepared.resolved.model.providerID,
                },
                variant: prepared.resolved.model.variant,
                agent: prepared.subagent.name,
                tools: {
                  ...(prepared.subagent.permission.some((rule) => rule.permission === "todowrite")
                    ? {}
                    : { todowrite: false }),
                  ...(prepared.subagent.permission.some((rule) => rule.permission === "task")
                    ? {}
                    : { task: false, chimera_swarm: false }),
                  ...Object.fromEntries(
                    (prepared.config.experimental?.primary_tools ?? []).map((item) => [item, false]),
                  ),
                  ...(atDepthCap ? { task: false, chimera_swarm: false, orchestrate: false } : {}),
                },
                parts: roundParts,
                ...(input.format ? { format: input.format } : {}),
              })
              firstStreamedDeltaAt ??= firstStreamedDelta(result.parts)
              if (input.abort.aborted) return yield* Effect.interrupt
              // The park covers the whole round: delivery can wake the child
              // for another turn that produces the structured answer.
              const finalResult = yield* settleOwnedBackgroundJobs(result)
              const failure = structuredFormat ? yield* structuredFailure(finalResult, roundMessageID) : undefined
              if (failure === undefined || structuredFormat === undefined) {
                if (finalResult.info.role === "assistant" && finalResult.info.error) {
                  const interrupted =
                    retryBaseline === undefined ? undefined : yield* retryWindowCompaction(retryBaseline)
                  if (interrupted !== undefined) {
                    const source =
                      retryText ?? ((lastTextPart(finalResult)?.text ?? "").length > 0 ? finalResult : undefined)
                    if (source) return { message: source, fallback: COMPACTION_FALLBACK_NOTE }
                  }
                  return yield* Effect.fail(
                    new Error(
                      `Subagent ${prepared.subagent.name} (${prepared.resolved.model.providerID}/${prepared.resolved.model.modelID}) failed: ${errorMessage(finalResult.info.error)}`,
                    ),
                  )
                }
                return { message: finalResult }
              }
              // A retry round that completed an auto compaction is discarded
              // (accepted, not rolled back): return the last text read before
              // it instead of continuing to retry against post-compaction state.
              if (retryBaseline !== undefined) {
                const interrupted = yield* retryWindowCompaction(retryBaseline)
                if (interrupted !== undefined) {
                  const source =
                    retryText ?? ((lastTextPart(finalResult)?.text ?? "").length > 0 ? finalResult : undefined)
                  if (source) return { message: source, fallback: COMPACTION_FALLBACK_NOTE }
                }
              }
              if (structuredRetries >= maxStructuredRetries) {
                // Prefer the newest round's text, but fall back to the nearest
                // earlier retry round that produced text: a later round can end
                // without any text even though the work was already answered.
                const source = (lastTextPart(finalResult)?.text ?? "").length > 0 ? finalResult : retryText
                if (source) {
                  return { message: source, fallback: EXHAUSTED_FALLBACK_NOTE }
                }
                return yield* Effect.fail(
                  new Error(
                    `Subagent ${prepared.subagent.name} (${prepared.resolved.model.providerID}/${prepared.resolved.model.modelID}) failed: ${failure} (structured-output retries exhausted after ${structuredRetries})`,
                  ),
                )
              }
              if (retryBaseline === undefined) retryBaseline = yield* newestMessageID(roundMessageID)
              if ((lastTextPart(finalResult)?.text ?? "").length > 0) retryText = finalResult
              structuredRetries += 1
              // Same child session, fresh user turn: the retry consumes no new
              // delegation slot and the persisted child history stays intact.
              roundMessageID = MessageID.ascending()
              roundParts = [{ type: "text", text: structuredOutputCorrectionPrompt(structuredFormat.schema, failure) }]
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                input.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    const result = yield* runWork.pipe(
      Effect.onExit((exit) => {
        const durationMs = Math.max(0, Date.now() - startedAt)
        const ttftMs = firstStreamedDeltaAt === undefined ? undefined : Math.max(0, firstStreamedDeltaAt - startedAt)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.message.info
          const usage =
            info.role === "assistant"
              ? {
                  input: info.tokens.input,
                  output: info.tokens.output,
                  reasoning: info.tokens.reasoning,
                  cacheRead: info.tokens.cache.read,
                  cacheWrite: info.tokens.cache.write,
                }
              : undefined
          const finishedExecution: ModelTelemetry.Execution = {
            status: "completed",
            durationMs,
            ...(ttftMs === undefined ? {} : { ttftMs }),
          }
          return telemetry("delegation.finished", finishedExecution, usage)
        }
        if (input.abort.aborted) {
          return telemetry("delegation.cancelled", {
            status: "cancelled",
            finishReason: "cancelled",
            errorClass: "cancelled",
            durationMs,
            ...(ttftMs === undefined ? {} : { ttftMs }),
          })
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return telemetry("delegation.cancelled", {
            status: "interrupted",
            finishReason: "interrupted",
            durationMs,
            ...(ttftMs === undefined ? {} : { ttftMs }),
          })
        }
        return telemetry("delegation.failed", {
          status: "failed",
          finishReason: "unknown",
          errorClass: "unknown",
          durationMs,
          ...(ttftMs === undefined ? {} : { ttftMs }),
        })
      }),
    )

    // A text fallback is a completed result, not a failure: the child text is
    // returned inline (capped) and any overflow is saved to an output file.
    const degraded = result.fallback === undefined ? undefined : yield* textFallback(result.message, result.fallback)
    const message = degraded?.message ?? result.message

    return {
      title: input.description,
      sessionId: nextSession.id,
      model: prepared.resolved.model,
      profile: prepared.resolved.profile,
      execution,
      metadata: {
        sessionId: nextSession.id,
        model: prepared.resolved.model,
        execution,
        ...(degraded?.outputPath === undefined ? {} : { outputPath: degraded.outputPath }),
      },
      message,
      output: [
        `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        message.parts.findLast((item) => item.type === "text")?.text ?? "",
        "</task_result>",
      ].join("\n"),
    }
  })

  const runPrepared = Effect.fn("SubagentDispatch.runPrepared")(function* (input: SubagentDispatchRunPreparedInput) {
    const prepared = input.prepared
    const materialized = input.materialized ?? (yield* materialize(prepared, input.description))
    return yield* limiter.run({
      parentSessionID: prepared.parentSessionID,
      sessionID: materialized.nextSession.id,
      effect: runPreparedCore(prepared, input, materialized),
    })
  })

  // Background tasks run outside the delegation limiter: the background job
  // engine's background_concurrent cap governs their concurrency instead, so
  // long-running background jobs never borrow permits from the shared
  // max_concurrent pool that foreground delegation depends on.
  const runPreparedBackground = Effect.fn("SubagentDispatch.runPreparedBackground")(function* (
    input: SubagentDispatchRunPreparedInput & { materialized: SubagentDispatchMaterialized },
  ) {
    return yield* runPreparedCore(input.prepared, input, input.materialized)
  })

  const run = Effect.fn("SubagentDispatch.run")(function* (input: SubagentDispatchInput) {
    const prepared = yield* prepare(input)
    return yield* runPrepared({
      prepared,
      description: input.description,
      prompt: input.prompt,
      promptOps: input.promptOps,
      abort: input.abort,
      onStarted: input.onStarted,
      telemetry: input.telemetry,
    })
  })

  return { prepare, materialize, runPrepared, runPreparedBackground, run }
})
