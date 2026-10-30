// Pure reference judges for the WP-10 control-plane fixtures.
//
// These functions model the *documented* control-plane rules over synthetic
// inputs. They never import `packages/chimera/src/**`, never open a DB, never
// spawn a process, and never touch the network. A fixture freezes one input +
// expected verdict; the judge is the executable reading of the contract.
//
// The judges are deliberately small. They are not a second implementation of
// the production runtime: they encode the ordering, selection, and lifecycle
// rules that the control-plane contract docs pin down.

import { isRecord, type Domain, type JudgeResult } from "../format"

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function flag(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string")
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key]
    if (isRecord(value) && isRecord(existing)) {
      next[key] = deepMerge(existing, value)
      continue
    }
    if (Array.isArray(value) && Array.isArray(existing)) {
      next[key] = [...existing, ...value]
      continue
    }
    next[key] = value
  }
  return next
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

// --- config-bootstrap -------------------------------------------------------

function configMerge(input: Record<string, unknown>): JudgeResult {
  const sources = list(input.sources).map(record)
  const bootstrapOrder = strings(input.bootstrapOrder)
  const configIndex = bootstrapOrder.indexOf("config")
  const pluginIndex = bootstrapOrder.indexOf("plugin")
  if (configIndex < 0 || pluginIndex < 0) return { verdict: "error", code: "BOOTSTRAP_ORDER" }
  if (pluginIndex < configIndex) return { verdict: "error", code: "BOOTSTRAP_ORDER" }

  let effective: Record<string, unknown> = {}
  for (const source of sources) effective = deepMerge(effective, record(source.patch))
  if (Array.isArray(effective.plugin)) effective.plugin = dedupe(strings(effective.plugin))
  return {
    verdict: "pass",
    order: sources.map((source) => text(source.category)),
    bootstrapOrder,
    effective,
  }
}

// --- skills ----------------------------------------------------------------

function skillsPrecedence(input: Record<string, unknown>): JudgeResult {
  const skills = list(input.skills).map(record)
  for (const skill of skills) {
    const name = text(skill.name)
    const frontmatterName = text(skill.frontmatterName, name)
    if (frontmatterName !== name) return { verdict: "error", code: "SKILL_NAME_MISMATCH" }
  }

  const resolved = new Map<string, Record<string, unknown>>()
  const warnings: string[] = []
  for (const skill of skills) {
    const name = text(skill.name)
    if (!name) continue
    const existing = resolved.get(name)
    const builtin = flag(skill.builtin)
    if (existing && !flag(existing.builtin) && !builtin) warnings.push(`duplicate skill name: ${name}`)
    resolved.set(name, skill)
  }

  const permission = record(input.permission)
  const denied = text(permission.skill) === "deny"
  const requested = strings(input.requested)
  const available = denied
    ? []
    : requested.filter((name) => resolved.has(name)).map((name) => ({
        name,
        location: text(resolved.get(name)?.location),
      }))
  return {
    verdict: "pass",
    resolved: [...resolved.values()].map((skill) => ({ name: text(skill.name), location: text(skill.location) })),
    available,
    warnings,
  }
}

// --- instructions ----------------------------------------------------------

const INSTRUCTION_FILE_ORDER = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

function instructionsFirstMatch(input: Record<string, unknown>): JudgeResult {
  const configInstructions = list(input.configInstructions).map(record)
  for (const instruction of configInstructions) {
    const kind = text(instruction.kind)
    const target = text(instruction.path, text(instruction.url))
    if (kind === "remote" && !target.startsWith("synthetic://")) return { verdict: "error", code: "INSTRUCTION_REMOTE_AS_FILE" }
    if (kind === "local" && target.startsWith("synthetic://")) return { verdict: "error", code: "INSTRUCTION_REMOTE_AS_FILE" }
  }

  const systemPaths: string[] = []
  const global = list(input.globalFiles).map(record).find((file) => flag(file.exists))
  if (global) systemPaths.push(text(global.path))

  const projectMatches = record(input.projectMatches)
  for (const name of INSTRUCTION_FILE_ORDER) {
    const matches = strings(projectMatches[name])
    if (matches.length === 0) continue
    systemPaths.push(...matches)
    break
  }

  const remote: string[] = []
  for (const instruction of configInstructions) {
    if (text(instruction.kind) === "remote") remote.push(text(instruction.url))
    else systemPaths.push(text(instruction.path))
  }
  return { verdict: "pass", systemPaths: dedupe(systemPaths.filter(Boolean)), remote }
}

// --- workbrief -------------------------------------------------------------

function compactText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact
}

function workbriefNormalize(input: Record<string, unknown>): JudgeResult {
  const brief = record(input.brief)
  const limits = record(input.limits)
  const maxItems = number(limits.maxItems, 12)
  const maxItemChars = number(limits.maxItemChars, 300)
  const compactItems = (value: unknown) =>
    list(value)
      .filter((item): item is string => typeof item === "string")
      .map((item) => compactText(item, maxItemChars))
      .filter(Boolean)
      .slice(0, maxItems)

  const normalized = {
    intent: compactText(text(brief.intent), 800),
    confirmedDecisions: compactItems(brief.confirmedDecisions),
    constraints: compactItems(brief.constraints),
    acceptanceCriteria: compactItems(brief.acceptanceCriteria),
    openQuestions: compactItems(brief.openQuestions),
    relevantEvidence: compactItems(brief.relevantEvidence),
    closeout: compactItems(brief.closeout),
  }
  const empty =
    normalized.intent.length === 0 &&
    Object.values(normalized).every((value) => (Array.isArray(value) ? value.length === 0 : value.length === 0))
  if (empty) return { verdict: "noop", empty: true, rendered: null, itemCount: 0 }

  const sections = [
    "## Current Work Brief",
    "Intent:",
    "Confirmed Decisions:",
    "Constraints:",
    "Acceptance Criteria:",
    "Open Questions:",
    "Relevant Evidence:",
    "Closeout:",
  ]
  return {
    verdict: "pass",
    empty: false,
    normalized,
    itemCount: normalized.confirmedDecisions.length,
    firstItem: normalized.confirmedDecisions[0] ?? null,
    renderSections: sections,
    rendered: sections.join("\n"),
  }
}

// --- goal ------------------------------------------------------------------

function goalTransitions(input: Record<string, unknown>): JudgeResult {
  let goal:
    | {
        status: "active" | "paused" | "blocked" | "budget_limited" | "complete"
        tokensUsed: number
        tokenBudget?: number
        consecutiveContinuations: number
        consecutiveEmptyContinuations: number
        consecutiveToolFailures: number
        blockedReason?: string
      }
    | undefined

  for (const event of list(input.events).map(record)) {
    const type = text(event.type)
    if (type === "create") {
      goal = {
        status: "active",
        tokensUsed: 0,
        tokenBudget: typeof event.tokenBudget === "number" ? event.tokenBudget : undefined,
        consecutiveContinuations: 0,
        consecutiveEmptyContinuations: 0,
        consecutiveToolFailures: 0,
      }
      continue
    }
    if (!goal) return { verdict: "error", code: "GOAL_NOT_CREATED" }
    if (type === "status") {
      const to = text(event.to) as typeof goal.status
      const allowed =
        to === "complete" ||
        (goal.status === "active" && (to === "blocked" || to === "paused")) ||
        (goal.status === "paused" && to === "active")
      if (!allowed) return { verdict: "error", code: "GOAL_TRANSITION" }
      goal.status = to
      continue
    }
    if (type === "outcome") {
      const productive = flag(event.productive)
      goal.consecutiveEmptyContinuations = productive ? 0 : goal.consecutiveEmptyContinuations + 1
      goal.consecutiveContinuations += 1
      const outcomes = list(event.toolOutcomes).filter((item): item is boolean => typeof item === "boolean")
      if (outcomes.length > 0) {
        goal.consecutiveToolFailures = outcomes.reduce((streak, ok) => (ok ? 0 : streak + 1), goal.consecutiveToolFailures)
      }
      if (
        goal.status === "active" &&
        (goal.consecutiveEmptyContinuations >= 3 || goal.consecutiveToolFailures >= 3)
      ) {
        goal.status = "blocked"
        goal.blockedReason = "continuation circuit breaker"
      }
      continue
    }
    if (type === "account") {
      goal.tokensUsed += number(event.tokens)
      if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) goal.status = "budget_limited"
      continue
    }
    if (type === "resume") {
      if (text(event.by) !== "user") return { verdict: "error", code: "GOAL_RESUME_CHANNEL" }
      if (goal.status === "budget_limited") continue
      if (goal.status === "paused" || goal.status === "blocked") goal.status = "active"
      continue
    }
  }

  if (!goal) return { verdict: "error", code: "GOAL_NOT_CREATED" }
  return {
    verdict: "pass",
    status: goal.status,
    blockedReason: goal.blockedReason ?? null,
    canAutoContinue: goal.status === "active" && goal.consecutiveContinuations < 25,
    consecutiveContinuations: goal.consecutiveContinuations,
  }
}

// --- prompt assembly -------------------------------------------------------

function promptAssembly(input: Record<string, unknown>): JudgeResult {
  const agentPrompt = text(input.agentPrompt)
  const tools = record(input.tools)
  const system = list(input.system)
  const keys: string[] = []
  if (agentPrompt) keys.push("agent/system")
  else {
    keys.push("core/default", "core/workflow")
    const modelLayer = text(input.modelLayer)
    if (modelLayer) keys.push(`model/${modelLayer}`)
  }
  const overlay = text(input.overlay)
  if (overlay) keys.push(`overlay/${overlay}`)
  if (!agentPrompt) {
    if (Object.keys(tools).some((name) => name.startsWith("chimera_"))) keys.push("core/chimera")
    if (tools.workbrief) keys.push("core/workbrief")
    if (tools.browser_open) keys.push("core/browser")
  }
  if (text(input.multiAgent)) keys.push("policy/multi-agent")
  if (!flag(input.small) && !text(input.parentSessionID) && text(input.variant) === "ultra") {
    keys.push("variant/ultra")
    const ultraLayer = text(input.ultraLayer)
    if (ultraLayer) keys.push(`variant/ultra-${ultraLayer}`)
  }
  system.forEach((content, index) => {
    if (typeof content === "string" && content.length > 0) keys.push(`input/system/${index}`)
  })
  if (text(input.userSystem)) keys.push("user/system/0")
  return {
    verdict: "pass",
    keys,
    capabilityIncluded: keys.includes("core/chimera") || keys.includes("core/workbrief") || keys.includes("core/browser"),
  }
}

// --- tool search -----------------------------------------------------------

function toolSearchScore(input: Record<string, unknown>): JudgeResult {
  const query = text(input.query).toLowerCase().replace(/[*?]+/g, " ")
  const terms = [...new Set(query.split(/\s+/).filter(Boolean))]
  const denied = new Set(strings(input.denied))
  const hidden = text(input.agentMode) === "subagent" ? new Set(strings(input.subagentHidden)) : new Set<string>()
  const candidates = list(input.candidates)
    .map(record)
    .filter((candidate) => !denied.has(text(candidate.id)) && !hidden.has(text(candidate.id)))

  const matches = candidates
    .map((candidate) => {
      const id = text(candidate.id).toLowerCase()
      const description = text(candidate.description).toLowerCase()
      let score = 0
      for (const term of terms) {
        if (id.includes(term)) score += 3
        if (description.includes(term)) score += 1
        if (id.startsWith(term)) score += 1
      }
      return { id: text(candidate.id), score }
    })
    .filter((match) => match.score > 0)
    .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(number(input.limit, 8), 20)))

  const summaryAt = number(input.compactionSummaryAt, Number.NEGATIVE_INFINITY)
  const times = record(input.revealTimes)
  const promoted = strings(input.revealed).filter((id) => number(times[id], Number.POSITIVE_INFINITY) <= summaryAt)
  return { verdict: "pass", matches, promoted, candidateCount: candidates.length }
}

// --- compaction ------------------------------------------------------------

type CompactMessage = { id: string; role: string; tokens: number; summary: boolean }

function compactionSelect(input: Record<string, unknown>): JudgeResult {
  const messages: CompactMessage[] = list(input.messages).map((item) => {
    const message = record(item)
    return {
      id: text(message.id),
      role: text(message.role),
      tokens: number(message.tokens),
      summary: flag(message.summary),
    }
  })
  const tailTurns = number(input.tailTurns, 2)
  const budget = number(input.preserveRecentTokens, Number.POSITIVE_INFINITY)
  const turns = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role === "user")
    .map((entry) => entry.index)
  const recent = turns.slice(-tailTurns)
  let tailStart: string | undefined
  let total = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const start = recent[i]!
    const end = i + 1 < recent.length ? recent[i + 1]! : messages.length
    const size = messages.slice(start, end).reduce((sum, message) => sum + message.tokens, 0)
    if (total + size <= budget) {
      total += size
      tailStart = messages[start]!.id
      continue
    }
    const remaining = budget - total
    let split: string | undefined
    let splitTotal = 0
    for (let index = start + 1; index < end; index++) {
      splitTotal += messages[index]!.tokens
      if (splitTotal <= remaining) split = messages[index]!.id
      else break
    }
    if (split && !tailStart) tailStart = split
    break
  }

  const toolParts = list(input.toolParts).map(record)
  const protectedTools = new Set(strings(input.protectedTools))
  const pruneProtect = number(input.pruneProtect, 40_000)
  const pruneMinimum = number(input.pruneMinimum, 20_000)
  const toPrune: string[] = []
  let scanned = 0
  let pruned = 0
  let turnsSeen = 0
  let stopped = false
  for (let index = messages.length - 1; index >= 0 && !stopped; index--) {
    const message = messages[index]!
    if (message.role === "user") turnsSeen++
    if (turnsSeen < 2) continue
    if (message.summary) break
    const parts = toolParts.filter((part) => text(part.messageId) === message.id)
    for (const part of parts) {
      if (!flag(part.completed)) continue
      if (protectedTools.has(text(part.tool))) continue
      if (flag(part.compacted)) {
        stopped = true
        break
      }
      const size = number(part.tokens)
      scanned += size
      if (scanned <= pruneProtect) continue
      pruned += size
      toPrune.push(text(part.id))
    }
  }
  const applied = flag(input.prune, true) && pruned > pruneMinimum
  return {
    verdict: "pass",
    tail_start_id: tailStart ?? null,
    pruned: applied ? toPrune : [],
    pruneApplied: applied,
    scanned,
    prunedTokens: pruned,
  }
}

// --- mutation chain --------------------------------------------------------

function mutationChain(input: Record<string, unknown>): JudgeResult {
  if (flag(input.claimConflict)) {
    return { verdict: "blocked", blockedBy: "edit-intent-claim", code: "EDIT_INTENT_CLAIM", closeoutReasons: [] }
  }
  const graphInitialized = flag(input.graphInitialized, true)
  const predesignAvailable = flag(input.predesignToolAvailable, true)
  if (graphInitialized && flag(input.risky) && predesignAvailable && !flag(input.freshPredesign)) {
    return { verdict: "blocked", blockedBy: "predesign", code: "PREDESIGN_REQUIRED", closeoutReasons: [] }
  }

  const reasons: string[] = []
  if (flag(input.mutationSuccess) && !flag(input.auditRecorded)) reasons.push("audit-missing")
  const oracle = record(input.oracle)
  if (flag(oracle.linked) && text(oracle.status) !== "pass") reasons.push("oracle-not-pass")
  const active = list(input.obligations)
    .map(record)
    .filter((obligation) => text(obligation.status) !== "resolved" && text(obligation.status) !== "ignored")
  if (active.length > 0) reasons.push("obligation-pending")
  const code =
    reasons[0] === "audit-missing"
      ? "AUDIT_MISSING"
      : reasons[0] === "oracle-not-pass"
        ? "ORACLE_NOT_PASS"
        : reasons[0] === "obligation-pending"
          ? "OBLIGATION_PENDING"
          : undefined
  return {
    verdict: reasons.length === 0 ? "pass" : "blocked",
    ...(code ? { code } : {}),
    closeoutReasons: reasons,
    activeObligations: active.map((obligation) => text(obligation.id)),
  }
}

// --- MCP transports --------------------------------------------------------

function mcpTransports(input: Record<string, unknown>): JudgeResult {
  const attempts = list(input.remoteAttempts).map(record)
  const servers = list(input.servers).map((item) => {
    const server = record(item)
    const key = text(server.key)
    if (!flag(server.enabled, true)) return { key, transport: null, status: "disabled" }
    if (text(server.type) === "local") return { key, transport: "stdio", status: "connected" }
    const used: string[] = []
    for (const attempt of attempts) {
      const transport = text(attempt.transport)
      const result = text(attempt.result)
      used.push(transport)
      if (result === "ok") return { key, transport, status: "connected", attempts: used }
      if (result === "auth") return { key, transport: null, status: "needs_auth", attempts: used }
    }
    return { key, transport: null, status: "failed", attempts: used }
  })
  return { verdict: "pass", servers }
}

// --- job family ------------------------------------------------------------

function jobFamily(input: Record<string, unknown>): JudgeResult {
  const sessions = list(input.sessions).map(record)
  const byID = new Map(sessions.map((session) => [text(session.id), session]))
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    const parent = text(session.parent)
    if (!parent) continue
    const bucket = children.get(parent) ?? []
    bucket.push(text(session.id))
    children.set(parent, bucket)
  }
  const root = text(input.cancelSession, sessions[0] ? text(sessions[0].id) : "")
  const family: string[] = []
  const queue = [root]
  const cap = number(input.maxFamily, 256)
  while (queue.length > 0 && family.length < cap) {
    const current = queue.shift()!
    if (family.includes(current)) continue
    family.push(current)
    queue.push(...(children.get(current) ?? []))
  }

  const jobs = list(input.jobs).map(record)
  const activeJob = jobs.some((job) => {
    const owner = text(job.owner)
    return family.includes(owner) && (text(job.status) === "running" || text(job.delivery) === "pending")
  })
  const busy = family.some((id) => text(byID.get(id)?.status) !== "idle")
  const mark = record(input.markDelivered)
  const target = jobs.find((job) => text(job.id) === text(mark.id))
  const markApplied = Boolean(target) && number(target?.generation, -1) === number(mark.generation, -2)
  return {
    verdict: "pass",
    family,
    active: activeJob || busy,
    cancelOrder: [...family],
    markApplied,
    delivered: markApplied ? text(mark.id) : null,
    quiescent: !(busy || (activeJob && !markApplied)),
  }
}

// --- retention -------------------------------------------------------------

function retentionSessionPrune(input: Record<string, unknown>): JudgeResult {
  const now = Date.parse(text(input.now))
  const cutoff = now - number(input.cutoffDays, 30) * 86_400_000
  const sessions = list(input.sessions).map(record)
  const byID = new Map(sessions.map((session) => [text(session.id), session]))
  const active = sessions.filter((session) => text(session.status) !== "idle").map((session) => text(session.id))
  const protectedIDs = new Set<string>()
  for (const id of active) {
    let current: string | undefined = id
    while (current) {
      if (protectedIDs.has(current)) break
      protectedIDs.add(current)
      current = text(byID.get(current)?.parent) || undefined
    }
  }
  const selected = new Set(
    sessions
      .filter((session) => Date.parse(text(session.timeUpdated)) < cutoff && !protectedIDs.has(text(session.id)))
      .map((session) => text(session.id)),
  )
  const queue = [...selected]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const session of sessions) {
      if (text(session.parent) !== current) continue
      const id = text(session.id)
      if (protectedIDs.has(id) || selected.has(id)) continue
      selected.add(id)
      queue.push(id)
    }
  }
  return {
    verdict: "pass",
    selected: [...selected],
    protected: [...protectedIDs],
  }
}

function retentionEvidence(input: Record<string, unknown>): JudgeResult {
  const now = Date.parse(text(input.now))
  const cutoff = now - number(input.retentionDays, 30) * 86_400_000
  const activeSession = text(input.activeSession)
  const activeObligations = new Set(strings(input.activeObligationRefs))
  const events = list(input.events).map(record)
  const compacted: string[] = []
  const kept: string[] = []
  const protectedByObligation: string[] = []
  for (const event of events) {
    const refs = strings(event.obligationRefs)
    const obligationProtected = refs.some((ref) => activeObligations.has(ref))
    const oracle = record(event.oracle)
    const candidate =
      flag(event.committed) &&
      Date.parse(text(event.finishedAt)) <= cutoff &&
      text(event.session) !== activeSession &&
      text(oracle.status) === "pass" &&
      flag(oracle.trusted) &&
      !obligationProtected
    if (obligationProtected) protectedByObligation.push(text(event.id))
    if (candidate) compacted.push(text(event.id))
    else kept.push(text(event.id))
  }
  return { verdict: "pass", compacted, kept, protectedByObligation }
}

export const JUDGES: Record<string, (input: Record<string, unknown>) => JudgeResult> = {
  "config.merge": configMerge,
  "skills.precedence": skillsPrecedence,
  "instructions.first-match": instructionsFirstMatch,
  "workbrief.normalize": workbriefNormalize,
  "goal.transitions": goalTransitions,
  "prompt.assembly": promptAssembly,
  "tool-search.score": toolSearchScore,
  "compaction.select": compactionSelect,
  "mutation.chain": mutationChain,
  "mcp.transports": mcpTransports,
  "job.family": jobFamily,
  "retention.session-prune": retentionSessionPrune,
  "retention.evidence": retentionEvidence,
}

export function runJudge(rule: string, input: Record<string, unknown>): JudgeResult | undefined {
  return JUDGES[rule]?.(input)
}

export type { Domain }