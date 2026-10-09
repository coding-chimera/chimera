import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import { eq } from "drizzle-orm"
import type { Tool } from "@/tool/tool"
import {
  cancelEditIntentWaiters,
  cancelEditIntentWaitersByHostBootID,
  cancelOrphanedEditIntentWaiters,
  currentHostBootID,
  EDIT_INTENT_CLAIM_DEFAULT_TTL_MS,
  listEditIntentWaiterHosts,
  readActiveEditIntentClaims,
  readEditIntentQueuePositions,
  readEditIntentWaiters,
  readWokenEditIntentWaiters,
  registerEditIntentClaims,
  registerEditIntentWaiter,
  releaseEditIntentClaims,
  releaseEditIntentClaimsForFiles,
  takeWokenEditIntentWaiters,
  type EditIntentClaimRecord,
  type EditIntentClaimReleaseReason,
  type EditIntentQueuePosition,
  type EditIntentWaiterRecord,
} from "./store"
import { TOOL_MUTATION_EDIT_INTENT_BLOCKED } from "./guidance"

const log = Log.create({ service: "chimera.edit-intent" })

const MAX_CONTEXT_FILES = 8
const MAX_INTENT_CHARS = 140

/**
 * Bounded wake-priority window (G1 fairness handoff). After a release wakes
 * queued waiters, the woken sessions hold their files as soft holders for
 * this long so a freshly arriving session cannot win the re-claim race
 * against a first waiter that has not reacted yet (FIFO wake order alone
 * only guarantees notification order, not acquisition order). Window expiry
 * falls back to the free race, so the hold can never deadlock a file — the
 * worst case is one window of waiting. Promote to config if a tunable is
 * ever needed.
 */
export const WAKE_PRIORITY_WINDOW_MS = 10 * 60 * 1000

// Roots with waiters registered by this process; gates the cross-process poll
// so a process without pending waiters does zero DB work per tick.
const pendingPollRoots = new Set<string>()

// Dead-host verdicts are cached with a TTL: a boot id embeds the process start
// time, so even pid reuse produces a different id — a dead host never revives
// while its verdict is cached. (R1 A7) The cache used to be a permanent
// process-level Set with no removal path; it is now a verdict-time Map with a
// 24h TTL and a size cap. Expiry is safe in the conservative direction: a
// re-check after TTL either re-confirms death (pid still gone) or sees a reused
// pid as alive and simply skips sweeping that host's inert waiter rows — it can
// never cancel rows belonging to a live host.
const DEAD_HOST_VERDICT_TTL_MS = 24 * 60 * 60 * 1000
const DEAD_HOST_VERDICT_MAX = 1_024
const deadHostBootIDs = new Map<string, number>()

/** Test seam (R1 A7): record a dead-host verdict; exported for bound/TTL assertions. */
export function rememberDeadHost(hostBootID: string) {
  deadHostBootIDs.set(hostBootID, Date.now())
  // FIFO eviction of the oldest verdicts; the just-added entry sorts last, so
  // the skip guard only matters when the cap is 0-sized (never in practice).
  for (const key of deadHostBootIDs.keys()) {
    if (deadHostBootIDs.size <= DEAD_HOST_VERDICT_MAX) break
    if (key === hostBootID) continue
    deadHostBootIDs.delete(key)
  }
}

/** Test seam (R1 A7): whether a dead-host verdict is cached and unexpired. */
export function isKnownDeadHost(hostBootID: string) {
  const at = deadHostBootIDs.get(hostBootID)
  if (at === undefined) return false
  if (Date.now() - at > DEAD_HOST_VERDICT_TTL_MS) {
    deadHostBootIDs.delete(hostBootID)
    return false
  }
  return true
}

/** Test seam (R1 A7): current dead-host verdict cache size. */
export function deadHostVerdictCount() {
  return deadHostBootIDs.size
}

/** Pre-v6 NULL-host waiter rows are swept only past this grace window so a mixed-version old binary can still wake its own un-stamped waiters. */
const ORPHAN_SWEEP_GRACE_MS = EDIT_INTENT_CLAIM_DEFAULT_TTL_MS

/**
 * Advisory file-level edit-intent claims for cross-session edit coordination.
 *
 * A `chimera_predesign` run that declares files registers one claim per file
 * for the declaring session. Claims are advisory coordination state in the
 * project CodeGraph database — not filesystem locks:
 * - the mutation gate blocks edits on files claimed by sessions from ANOTHER
 *   session family — holders are compared by root ancestor along the session
 *   parent_id chain, so a parent's claims never gate its own subagents — and
 *   registers the blocked session as a waiter (first-come-first-served queue;
 *   queue/waiter bookkeeping still keys the real session id);
 * - claims release on explicit signals — the holder closing its work batch
 *   through `chimera_audit_recent` (explicit), the holder's run completing
 *   with no background/subagent jobs its session family still owns running
 *   (session idle), the holder's session being removed — with a TTL as
 *   crash fallback only;
 * - releases wake registered waiters through the session-addressable
 *   synthetic-message inject channel (the L2 push path); the prompt-context
 *   claims block is the L1 pull path for sessions between turns;
 * - waits are host-scoped: every waiter row records the identity of the
 *   process that registered it, a release only wakes waiters hosted by the
 *   releasing process, and a light conditional poll in each process picks up
 *   cross-process releases for its own parked sessions (poll→inject bridge),
 *   lazily cancelling leftovers whose host process is provably dead.
 *
 * Every function degrades open: claim storage trouble must never block or
 * fail a mutation, so read/write errors collapse to "no claims".
 */

export type EditIntentConflict = {
  filePath: string
  holder: {
    sessionID: string
    agent: string
    intent: string
    predesignID: string
    createdAt: string
    expiresAt: string
  }
  /**
   * Set when the blocker is a woken waiter's soft hold (G1) rather than a
   * real claim; `holder` then carries synthesized display values keyed to
   * the wake, and this field carries the authoritative facts.
   */
  wakePriority?: {
    sessionID: string
    wokenAt: string
    windowExpiresAt: string
  }
  /** True when the checking session already queued its own claim on the file. */
  ownClaimQueued: boolean
  /** True when the session's earlier queued claim was yielded to the wake-priority holder (G1). */
  yieldedOwnClaim?: boolean
  /** G2: this session's rank in the file's still-waiting wake queue (#N of M). */
  queue?: { position: number; depth: number }
}

export type EditIntentWakeFile = {
  filePath: string
  blockerSessionID: string
}

export type EditIntentWakeTarget = {
  sessionID: string
  files: readonly EditIntentWakeFile[]
  reason?: EditIntentClaimReleaseReason
}

function uniquePaths(files: string[]) {
  return [...new Set(files.map((file) => file.replaceAll("\\", "/")).filter(Boolean))]
}

function compactIntent(intent: string) {
  const value = intent.replace(/\s+/g, " ").trim()
  return value.length > MAX_INTENT_CHARS ? `${value.slice(0, MAX_INTENT_CHARS - 3)}...` : value
}

function heldAge(createdAt: string) {
  const ms = Date.now() - Date.parse(createdAt)
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

/** Human remaining time until a wake-priority window closes. */
function windowRemaining(expiresAt: string) {
  const ms = Date.parse(expiresAt) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return "any moment"
  const minutes = Math.ceil(ms / 60_000)
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.ceil(minutes / 60)}h`
}

function conflictFrom(claim: EditIntentClaimRecord, ownClaimQueued: boolean): EditIntentConflict {
  return {
    filePath: claim.filePath,
    holder: {
      sessionID: claim.sessionID,
      agent: claim.agent,
      intent: claim.intent,
      predesignID: claim.id,
      createdAt: claim.createdAt,
      expiresAt: claim.expiresAt,
    },
    ownClaimQueued,
  }
}

/**
 * G1 soft-hold conflict from an in-window woken waiter. The holder shape is
 * synthesized so consumers that render holder.sessionID/agent (for example
 * the predesign receipt) degrade to sensible text; `wakePriority` carries
 * the authoritative soft-hold facts for wake-aware renderers.
 */
function wakePriorityConflict(waiter: EditIntentWaiterRecord, ownClaimQueued: boolean, yieldedOwnClaim: boolean): EditIntentConflict {
  const wokenAt = waiter.wokenAt ?? new Date().toISOString()
  const windowExpiresAt = new Date(Date.parse(wokenAt) + WAKE_PRIORITY_WINDOW_MS).toISOString()
  return {
    filePath: waiter.filePath,
    holder: {
      sessionID: waiter.sessionID,
      agent: "wake-priority",
      intent: "first-woken waiter holds this file in its bounded wake-priority window",
      predesignID: "",
      createdAt: wokenAt,
      expiresAt: windowExpiresAt,
    },
    wakePriority: { sessionID: waiter.sessionID, wokenAt, windowExpiresAt },
    ownClaimQueued,
    ...(yieldedOwnClaim ? { yieldedOwnClaim: true } : {}),
  }
}

/** Earliest active claim per file wins the queue; claims arrive created_at ASC. */
function earliestHolders(claims: EditIntentClaimRecord[]) {
  const earliest = new Map<string, EditIntentClaimRecord>()
  for (const claim of claims) {
    if (!earliest.has(claim.filePath)) earliest.set(claim.filePath, claim)
  }
  return earliest
}

/**
 * Session-family merge for conflict detection: "foreign" is decided by the
 * holder's ROOT ANCESTOR on the session table's parent_id chain, not the raw
 * session id — a parent's claims must never gate its own subagents' edits
 * (the subagent session is a child in the same family), and a subagent's
 * claims must never gate the parent or its siblings.
 *
 * The session table lives in the application database (session ids are
 * globally unique), not the per-project claim store, so the lineage reads go
 * through Database.use. Resolution is conservative: a session whose lineage
 * cannot be read (deleted row, storage trouble, broken or cyclic chain,
 * depth overrun) has no root and every pair involving it stays FOREIGN — the
 * pre-merge blocking behavior. Real nesting depth is ≤3; the cap only
 * guards pathological cycles.
 */
const FAMILY_WALK_MAX_DEPTH = 16

function readSessionParentRow(sessionID: string) {
  try {
    return Database.use((db) =>
      db
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID as SessionID))
        .get(),
    )
  } catch (error) {
    log.warn("edit-intent session lineage read failed", { sessionID, error })
    return undefined
  }
}

function resolveSessionFamilyRoot(sessionID: string): string | undefined {
  const seen = new Set<string>()
  let current = sessionID
  for (let depth = 0; depth < FAMILY_WALK_MAX_DEPTH; depth++) {
    if (!seen.add(current)) return undefined
    const row = readSessionParentRow(current)
    if (!row) return undefined
    if (row.parentID === null || row.parentID === undefined) return current
    current = row.parentID
  }
  return undefined
}

/** Holder ids that share the checking session's family root (conflict-exempt). */
function sameFamilyHolders(sessionID: string, holderIDs: string[]) {
  const roots = new Map<string, string | undefined>()
  const rootOf = (id: string) => {
    if (!roots.has(id)) roots.set(id, resolveSessionFamilyRoot(id))
    return roots.get(id)
  }
  const own = rootOf(sessionID)
  if (own === undefined) return new Set<string>()
  return new Set(holderIDs.filter((id) => rootOf(id) === own))
}

/**
 * First-come-first-served queue fairness: a foreign (other-family) claim
 * blocks the checking session only when it outranks that session's own
 * earliest claim on the file.
 * The front of the queue (or a session without any foreign competition) never
 * blocks, so a later predesign can not lock out an earlier holder.
 *
 * Claims arrive in registration order (`created_at` ASC, then SQLite `rowid`
 * ASC), so the array index is the authoritative queue rank. A timestamp-only
 * tie must not fall back to the claim id: predesign ids are arbitrary strings,
 * so a later declaration whose id happens to sort lower would otherwise steal
 * the queue front and hide the real holder.
 */
const queueConflicts = Effect.fnUntraced(function* (claims: EditIntentClaimRecord[], sessionID: string) {
  const foreignClaims = claims.filter((claim) => claim.sessionID !== sessionID)
  const exempt =
    foreignClaims.length === 0
      ? new Set<string>()
      : yield* Effect.sync(() =>
          sameFamilyHolders(sessionID, [...new Set(foreignClaims.map((claim) => claim.sessionID))]),
        )
  const arrivalRank = new Map(claims.map((claim, index) => [claim, index]))
  const own = earliestHolders(claims.filter((claim) => claim.sessionID === sessionID))
  const foreign = earliestHolders(foreignClaims.filter((claim) => !exempt.has(claim.sessionID)))
  const conflicts: EditIntentConflict[] = []
  for (const [filePath, holder] of foreign) {
    const mine = own.get(filePath)
    const mineFirst = mine !== undefined && arrivalRank.get(mine)! < arrivalRank.get(holder)!
    if (mineFirst) continue
    conflicts.push(conflictFrom(holder, mine !== undefined))
  }
  return conflicts.sort((a, b) => a.filePath.localeCompare(b.filePath))
})

/**
 * G1 wake-priority soft holds: for each file, the earliest woken waiter
 * still inside the priority window and owned by another session. Rows
 * arrive woken_at ASC from the store, so the first row per file is the
 * priority holder; the wake side already guarantees FIFO notification
 * order. Degrades open to no holds on storage trouble.
 */
const readWakePriorityHolds = Effect.fnUntraced(function* (projectRoot: string, sessionID: string, files: string[]) {
  if (files.length === 0) return new Map<string, EditIntentWaiterRecord>()
  const woken = yield* Effect.promise(() =>
    readWokenEditIntentWaiters(projectRoot, {
      files,
      wokenSince: new Date(Date.now() - WAKE_PRIORITY_WINDOW_MS).toISOString(),
      excludeSessionID: sessionID,
    }).catch((error) => {
      log.warn("edit-intent wake-priority read failed", { error })
      return [] as EditIntentWaiterRecord[]
    }),
  )
  const holds = new Map<string, EditIntentWaiterRecord>()
  for (const waiter of woken) {
    if (!holds.has(waiter.filePath)) holds.set(waiter.filePath, waiter)
  }
  return holds
})

const registerWaiters = Effect.fnUntraced(function* (
  projectRoot: string,
  sessionID: string,
  conflicts: EditIntentConflict[],
  reason: string,
) {
  if (conflicts.length > 0) pendingPollRoots.add(projectRoot)
  for (const conflict of conflicts) {
    yield* Effect.promise(() =>
      registerEditIntentWaiter(projectRoot, {
        sessionID,
        filePath: conflict.filePath,
        blockerSessionID: conflict.holder.sessionID,
        reason,
      }).catch((error) => {
        log.warn("edit-intent waiter registration failed", { file: conflict.filePath, error })
        return false
      }),
    )
  }
})

function mergeConflicts(conflicts: EditIntentConflict[]) {
  return conflicts.sort((a, b) => a.filePath.localeCompare(b.filePath))
}

/**
 * G2 queue visibility: annotate each conflict with this session's position
 * in the file's still-waiting queue (#N of M), counted in wake order — the
 * same order the release take selects, so #1 is woken first. Call after
 * waiter registration so the session's own fresh rows are included.
 * Degrades open: storage trouble leaves conflicts unannotated.
 */
const attachQueuePositions = Effect.fnUntraced(function* (projectRoot: string, sessionID: string, conflicts: EditIntentConflict[]) {
  if (conflicts.length === 0) return conflicts
  const positions = yield* Effect.promise(() =>
    readEditIntentQueuePositions(projectRoot, { files: conflicts.map((conflict) => conflict.filePath), sessionID }).catch((error) => {
      log.warn("edit-intent queue position read failed", { error })
      return [] as EditIntentQueuePosition[]
    }),
  )
  const byFile = new Map(positions.map((position) => [position.filePath, position]))
  return conflicts.map((conflict) => {
    const position = byFile.get(conflict.filePath)
    if (position?.position === undefined) return conflict
    return { ...conflict, queue: { position: position.position, depth: position.depth } }
  })
})

export const registerFromPredesign = Effect.fn("EditIntentClaims.registerFromPredesign")(function* (input: {
  projectRoot: string
  sessionID: string
  messageID?: string
  callID?: string
  agent: string
  predesignID: string
  intent: string
  files: string[]
  snapshotRevision?: string
}) {
  const files = uniquePaths(input.files)
  if (files.length === 0) return { registered: [] as EditIntentClaimRecord[], conflicts: [] as EditIntentConflict[] }
  // G1: files soft-held by another session's in-window wake get no claim row
  // here — inserting one would rank ahead of the priority holder's imminent
  // registration (created_at queue) and invert the handoff.
  const holds = yield* readWakePriorityHolds(input.projectRoot, input.sessionID, files)
  const heldActive = holds.size === 0 ? [] : yield* readHeldClaims(input.projectRoot, [...holds.keys()])
  // A still-active foreign real claim on a held file keeps the claim queue
  // authoritative (normally such a claim suppresses the wake — this is the
  // rare re-hold gap): register normally, no soft hold.
  const softHeld = [...holds.keys()].filter(
    (file) => !heldActive.some((claim) => claim.filePath === file && claim.sessionID !== input.sessionID),
  )
  // A claim this session already queued before the holder's wake keeps its
  // FIFO rank — the handoff targets fresh arrivals, not the pre-existing
  // claim queue. Later-queued own claims would block the priority holder's
  // registration, so they are yielded and the session re-queues as a waiter.
  const wakePriorityBlocked = (file: string) => {
    const wokenAt = Date.parse(holds.get(file)?.wokenAt ?? "")
    return !heldActive.some(
      (claim) => claim.filePath === file && claim.sessionID === input.sessionID && Date.parse(claim.createdAt) <= wokenAt,
    )
  }
  const blockedFiles = softHeld.filter(wakePriorityBlocked)
  const yieldFiles = blockedFiles.filter((file) =>
    heldActive.some((claim) => claim.filePath === file && claim.sessionID === input.sessionID),
  )
  const yielded = yieldFiles.length === 0 ? [] : yield* yieldQueuedClaims(input.projectRoot, input.sessionID, yieldFiles)
  // A failed yield falls back to normal registration for those files:
  // keeping the queued claim AND soft-blocking this session would stall
  // both sides until the window expired.
  const blockedSet = new Set(yielded === null ? blockedFiles.filter((file) => !yieldFiles.includes(file)) : blockedFiles)
  const yieldedSet = new Set(yielded === null ? [] : yieldFiles)
  const claimFiles = files.filter((file) => !blockedSet.has(file))
  const registered = claimFiles.length === 0 ? [] : yield* registerClaims(input, claimFiles)
  const active = yield* Effect.promise(() =>
    readActiveEditIntentClaims(input.projectRoot, { files }).catch((error) => {
      log.warn("edit-intent conflict read failed", { error })
      return [] as EditIntentClaimRecord[]
    }),
  )
  const conflicts = mergeConflicts([
    ...(yield* queueConflicts(active, input.sessionID)),
    ...[...blockedSet].map((file) => wakePriorityConflict(holds.get(file)!, false, yieldedSet.has(file))),
  ])
  // Queue this session behind every holder so the release broadcast (L2 wake)
  // reaches it even if it parks without ever attempting the edit.
  yield* registerWaiters(input.projectRoot, input.sessionID, conflicts, `predesign:${input.predesignID}`)
  return { registered, conflicts }
})

const readHeldClaims = Effect.fnUntraced(function* (projectRoot: string, files: string[]) {
  return yield* Effect.promise(() =>
    readActiveEditIntentClaims(projectRoot, { files }).catch((error) => {
      log.warn("edit-intent wake-priority claim read failed", { error })
      return [] as EditIntentClaimRecord[]
    }),
  )
})

const yieldQueuedClaims = Effect.fnUntraced(function* (projectRoot: string, sessionID: string, files: string[]) {
  return yield* Effect.promise(() =>
    releaseEditIntentClaimsForFiles(projectRoot, sessionID, files, "yielded").catch((error) => {
      log.warn("edit-intent wake-priority yield failed", { error })
      return null
    }),
  )
})

const registerClaims = Effect.fnUntraced(function* (
  input: {
    projectRoot: string
    sessionID: string
    messageID?: string
    callID?: string
    agent: string
    predesignID: string
    intent: string
    snapshotRevision?: string
  },
  files: string[],
) {
  return yield* Effect.promise(() =>
    registerEditIntentClaims(input.projectRoot, {
      id: input.predesignID,
      sessionID: input.sessionID,
      ...(input.messageID ? { messageID: input.messageID } : {}),
      ...(input.callID ? { callID: input.callID } : {}),
      agent: input.agent,
      files,
      intent: input.intent,
      ...(input.snapshotRevision ? { snapshotRevision: input.snapshotRevision } : {}),
    }).catch((error) => {
      log.warn("edit-intent claim registration failed", { error })
      return [] as EditIntentClaimRecord[]
    }),
  )
})

export const checkMutation = Effect.fn("EditIntentClaims.checkMutation")(function* (input: {
  projectRoot: string
  sessionID: string
  toolID: string
  files: Array<{ absolutePath: string; graphPath?: string }>
}) {
  const paths = uniquePaths(input.files.map((file) => file.graphPath ?? file.absolutePath))
  if (paths.length === 0) return [] as EditIntentConflict[]
  const claims = yield* Effect.promise(() =>
    readActiveEditIntentClaims(input.projectRoot, { files: paths }).catch((error) => {
      log.warn("edit-intent gate read failed", { error })
      return [] as EditIntentClaimRecord[]
    }),
  )
  const conflicts = yield* queueConflicts(claims, input.sessionID)
  // G1: files without a real claim conflict can still be soft-held by
  // another session's in-window wake — the first waiter gets a bounded
  // head start to re-claim before fresh arrivals race it.
  const open = paths.filter((filePath) => !conflicts.some((conflict) => conflict.filePath === filePath))
  const holds = yield* readWakePriorityHolds(input.projectRoot, input.sessionID, open)
  const softConflicts = [...holds.values()].flatMap((hold) => {
    const wokenAt = Date.parse(hold.wokenAt ?? "")
    // A claim this session queued before the holder's wake keeps its FIFO
    // rank: the handoff targets fresh arrivals, not the pre-existing claim
    // queue (queued claims are yielded at predesign re-registration).
    const queuedBeforeWake = claims.some(
      (claim) => claim.filePath === hold.filePath && claim.sessionID === input.sessionID && Date.parse(claim.createdAt) <= wokenAt,
    )
    if (queuedBeforeWake) return []
    const ownClaimQueued = claims.some((claim) => claim.filePath === hold.filePath && claim.sessionID === input.sessionID)
    return [wakePriorityConflict(hold, ownClaimQueued, false)]
  })
  const all = mergeConflicts([...conflicts, ...softConflicts])
  yield* registerWaiters(input.projectRoot, input.sessionID, all, `mutation_gate:${input.toolID}`)
  // G2: annotate after waiter registration so this session's own fresh
  // queue rows are counted in its reported position.
  return yield* attachQueuePositions(input.projectRoot, input.sessionID, all)
})

export function blockedResult(input: { toolID: string; conflicts: EditIntentConflict[] }): Tool.ExecuteResult {
  const unqueued = input.conflicts.filter((conflict) => !conflict.ownClaimQueued && !conflict.wakePriority)
  const wakePriority = input.conflicts.filter((conflict) => conflict.wakePriority !== undefined)
  return {
    title: "Chimera edit-intent claim conflict",
    output: [
      TOOL_MUTATION_EDIT_INTENT_BLOCKED,
      "",
      "Conflicting claims:",
      ...input.conflicts.map((conflict) => {
        const queueSuffix = conflict.queue ? `; queue: #${conflict.queue.position} of ${conflict.queue.depth} waiting` : ""
        if (!conflict.wakePriority)
          return `- ${conflict.filePath}: held by session ${conflict.holder.sessionID} (agent ${conflict.holder.agent}) since ${heldAge(conflict.holder.createdAt)}; intent: ${compactIntent(conflict.holder.intent)}${conflict.ownClaimQueued ? "; your claim is queued behind it" : ""}${queueSuffix}`
        const yieldedSuffix = conflict.yieldedOwnClaim ? "; your earlier queued claim was yielded to it — you are re-queued as a waiter and will be woken when it releases" : ""
        return `- ${conflict.filePath}: held in wake-priority window by session ${conflict.wakePriority.sessionID} (first waiter, woken ${heldAge(conflict.wakePriority.wokenAt)}, window expires ${windowRemaining(conflict.wakePriority.windowExpiresAt)})${yieldedSuffix}${queueSuffix}`
      }),
      "",
      "What to do:",
      "- Do not retry this mutation in a loop; the claim stays active until the holder releases it explicitly (its chimera_audit_recent closeout), its run completes with no background/subagent jobs its family still owns running, or its session is removed (a TTL is only a crash fallback).",
      "- Continue with non-conflicting files first; when every conflicting file frees up, a release notice is injected into this session automatically — re-read the files then (they may have changed) and continue the blocked work.",
      ...(unqueued.length > 0
        ? [`- Record chimera_predesign declaring ${unqueued.map((conflict) => conflict.filePath).join(", ")} to queue your own claim behind the holder${unqueued.length > 1 ? "s" : ""}.`]
        : []),
      ...(wakePriority.length > 0
        ? [`- A wake-priority hold is time-bounded: if the woken session${wakePriority.length > 1 ? "s do" : " does"} not claim ${wakePriority.map((conflict) => conflict.filePath).join(", ")}, the window expires (at most ${Math.ceil(WAKE_PRIORITY_WINDOW_MS / 60_000)} minutes after the wake) and a retry then proceeds normally.`]
        : []),
      "- If you believe the holder is stale or you must proceed anyway, report the conflict to the user (or your parent agent) instead of forcing the edit.",
    ].join("\n"),
    metadata: {
      chimeraEditIntentBlocked: true,
      toolID: input.toolID,
      conflicts: input.conflicts.map((conflict) => ({
        file: conflict.filePath,
        holderSessionID: conflict.holder.sessionID,
        holderAgent: conflict.holder.agent,
        holderIntent: compactIntent(conflict.holder.intent),
        heldSince: conflict.holder.createdAt,
        expiresAt: conflict.holder.expiresAt,
        ownClaimQueued: conflict.ownClaimQueued,
        ...(conflict.wakePriority
          ? {
              wakePrioritySessionID: conflict.wakePriority.sessionID,
              wakePriorityWokenAt: conflict.wakePriority.wokenAt,
              wakePriorityWindowExpiresAt: conflict.wakePriority.windowExpiresAt,
            }
          : {}),
        ...(conflict.yieldedOwnClaim ? { yieldedOwnClaim: true } : {}),
        ...(conflict.queue ? { queuePosition: conflict.queue.position, queueDepth: conflict.queue.depth } : {}),
      })),
    },
  }
}

function groupWakeTargets(woken: EditIntentWaiterRecord[], reason?: EditIntentClaimReleaseReason): EditIntentWakeTarget[] {
  const bySession = new Map<string, EditIntentWakeFile[]>()
  for (const waiter of woken) {
    const files = bySession.get(waiter.sessionID) ?? []
    files.push({ filePath: waiter.filePath, blockerSessionID: waiter.blockerSessionID })
    bySession.set(waiter.sessionID, files)
  }
  return [...bySession.entries()].map(([sessionID, files]) => ({
    sessionID,
    files,
    ...(reason ? { reason } : {}),
  }))
}

const REASON_TEXT: Record<EditIntentClaimReleaseReason, string> = {
  session_idle: "the holder's run completed",
  session_removed: "the holder's session was removed",
  ttl: "the claim reached its TTL crash fallback",
  explicit: "the holder released it explicitly",
  yielded: "your earlier queued claim was yielded to the first-woken session (wake-priority handoff)",
}

export function wakeText(target: EditIntentWakeTarget) {
  return [
    "<edit_intent_release>",
    `Edit-intent claims blocking files you declared were released (${target.reason ? REASON_TEXT[target.reason] : "the holder finished"}):`,
    ...target.files.map((file) => `- ${file.filePath} (was held by session ${file.blockerSessionID})`),
    "You can proceed with the work these files blocked: re-read each file's current content first (it may have changed while you waited), then continue.",
    "If you no longer need these files or your task is already complete, acknowledge this notice briefly and stop.",
    "</edit_intent_release>",
  ].join("\n")
}

/** Release + host-scoped wake-take, with the released claim rows reported back. */
const releaseWithReport = Effect.fnUntraced(function* (input: {
  projectRoot: string
  sessionID: string
  reason: EditIntentClaimReleaseReason
}) {
  const released = yield* Effect.promise(() =>
    releaseEditIntentClaims(input.projectRoot, input.sessionID, input.reason).catch((error) => {
      log.warn("edit-intent release failed", { error })
      return [] as EditIntentClaimRecord[]
    }),
  )
  if (input.reason === "session_removed") {
    yield* Effect.promise(() =>
      cancelEditIntentWaiters(input.projectRoot, input.sessionID).catch((error) => {
        log.warn("edit-intent waiter cancellation failed", { error })
        return 0
      }),
    )
  }
  if (released.length === 0) return { released, targets: [] as EditIntentWakeTarget[] }
  // Host-scoped take: only waiters registered by this process can be injected
  // into here; foreign-hosted waiters stay 'waiting' for their own process's
  // poll to pick up (flipping them here would strand the wake forever).
  const woken = yield* Effect.promise(() =>
    takeWokenEditIntentWaiters(input.projectRoot, released.map((claim) => claim.filePath), {
      hostBootID: currentHostBootID(),
    }).catch((error) => {
      log.warn("edit-intent wake collection failed", { error })
      return [] as EditIntentWaiterRecord[]
    }),
  )
  return { released, targets: groupWakeTargets(woken, input.reason) }
})

export const releaseForSession = Effect.fn("EditIntentClaims.releaseForSession")(function* (input: {
  projectRoot: string
  sessionID: string
  reason: EditIntentClaimReleaseReason
}) {
  return (yield* releaseWithReport(input)).targets
})

/**
 * Tree-world release broadcast. Sync-published session.deleted rides the
 * module-level Bus runtime while layer-injected subscribers live in the
 * layer tree — one world in production (shared memoMap) but split in test
 * harnesses. session.remove() releases the claims directly and publishes
 * this event with the computed wake targets so delivery to the
 * SessionPrompt watcher (which owns injectSynthetic) is reliable in both.
 */
export const Released = BusEvent.define(
  "chimera.edit_intent.released",
  Schema.Struct({
    projectRoot: Schema.String,
    reason: Schema.Literals(["session_removed", "explicit"]),
    targets: Schema.Array(
      Schema.Struct({
        sessionID: Schema.String,
        files: Schema.Array(Schema.Struct({ filePath: Schema.String, blockerSessionID: Schema.String })),
      }),
    ),
  }),
)

export const publishRemovalRelease = Effect.fn("EditIntentClaims.publishRemovalRelease")(function* (input: {
  bus: BusInterface
  sessionID: string
}) {
  const instance = yield* InstanceState.context
  const root = instance.worktree === "/" ? instance.directory : instance.worktree
  const targets = yield* releaseForSession({ projectRoot: root, sessionID: input.sessionID, reason: "session_removed" })
  if (targets.length === 0) return
  yield* input.bus.publish(Released, {
    projectRoot: root,
    reason: "session_removed",
    targets: targets.map((target) => ({ sessionID: target.sessionID, files: target.files })),
  })
})

/**
 * Explicit closeout release (`chimera_audit_recent`): the holder finished its
 * work batch and frees its claims without waiting for the idle transition.
 * Same tree-world contract as publishRemovalRelease — the release and the
 * host-scoped wake-take happen here, the wake targets ride the Released bus
 * event to the SessionPrompt watcher (which owns injectSynthetic). Returns
 * the release report so the caller can render what was freed; callers must
 * isolate failures — unlock trouble never breaks the invoking tool.
 */
export const releaseExplicitly = Effect.fn("EditIntentClaims.releaseExplicitly")(function* (input: {
  bus: BusInterface
  projectRoot: string
  sessionID: string
}) {
  const { released, targets } = yield* releaseWithReport({
    projectRoot: input.projectRoot,
    sessionID: input.sessionID,
    reason: "explicit",
  })
  if (targets.length === 0) return { released, targets }
  yield* input.bus.publish(Released, {
    projectRoot: input.projectRoot,
    reason: "explicit",
    targets: targets.map((target) => ({ sessionID: target.sessionID, files: target.files })),
  })
  return { released, targets }
})


/**
 * Wake-pull for a session that just became idle: its own still-waiting
 * entries whose files freed up while it was busy are taken here, because the
 * holder's release could not inject a fresh turn into a busy loop.
 */
export const drainForSession = Effect.fn("EditIntentClaims.drainForSession")(function* (input: {
  projectRoot: string
  sessionID: string
}) {
  const pending = yield* Effect.promise(() =>
    readEditIntentWaiters(input.projectRoot, { sessionID: input.sessionID, status: "waiting" }).catch((error) => {
      log.warn("edit-intent waiter read failed", { error })
      return [] as EditIntentWaiterRecord[]
    }),
  )
  if (pending.length === 0) return [] as EditIntentWakeTarget[]
  // Host-scoped like the release take: this session runs in this process, so
  // its own rows carry this host's boot id (upsert re-stamps after restarts).
  const woken = yield* Effect.promise(() =>
    takeWokenEditIntentWaiters(input.projectRoot, pending.map((waiter) => waiter.filePath), {
      hostBootID: currentHostBootID(),
    }).catch((error) => {
      log.warn("edit-intent wake collection failed", { error })
      return [] as EditIntentWaiterRecord[]
    }),
  )
  return groupWakeTargets(woken)
})

/** boot_<process-start-ms>_<pid> — the pid component drives the liveness verdict. */
function hostBootPID(hostBootID: string) {
  const match = /^boot_(\d+)_(\d+)$/.exec(hostBootID)
  if (!match) return undefined
  return Number(match[2])
}

/**
 * Liveness oracle for a recorded host boot id. Answers "dead" only when the
 * pid is provably gone (signal 0 → ESRCH, or an impossible pid → EINVAL);
 * EPERM means the process exists under another user — alive. Unparsable ids
 * cannot belong to a live v6+ process (it only writes the canonical format),
 * so they count as dead garbage. Caveat: the check runs in this process's pid
 * namespace — processes in separate namespaces sharing one project volume can
 * misjudge each other's hosts.
 */
function isHostBootAlive(hostBootID: string) {
  if (hostBootID === currentHostBootID()) return true
  if (isKnownDeadHost(hostBootID)) return false
  const pid = hostBootPID(hostBootID)
  if (pid === undefined) {
    rememberDeadHost(hostBootID)
    return false
  }
  // While this process runs, no other process can hold its pid, so any id
  // naming it counts as alive — never cancel rows we could be racing with.
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const alive = (error as { code?: string }).code === "EPERM"
    if (!alive) rememberDeadHost(hostBootID)
    return alive
  }
}

/**
 * Lazy stale-boot cleanup (same philosophy as the claim TTL): waiters left
 * 'waiting' by a dead process are inert garbage — no inject can ever reach
 * their sessions — so an actively polling process cancels them once the
 * recorded boot id proves the host is gone. NULL-host rows are pre-v6
 * leftovers, cancelled only past ORPHAN_SWEEP_GRACE_MS so a still-live
 * old-binary process keeps its own un-stamped wake path working.
 */
export const sweepStaleHosts = Effect.fn("EditIntentClaims.sweepStaleHosts")(function* (input: { projectRoot: string }) {
  const hosts = yield* Effect.promise(() =>
    listEditIntentWaiterHosts(input.projectRoot).catch((error) => {
      log.warn("edit-intent waiter host listing failed", { error })
      return [] as Array<{ hostPID: number | null; hostBootID: string | null }>
    }),
  )
  let cancelled = 0
  for (const host of hosts) {
    const bootID = host.hostBootID
    if (bootID === null || isHostBootAlive(bootID)) continue
    cancelled += yield* Effect.promise(() =>
      cancelEditIntentWaitersByHostBootID(input.projectRoot, bootID).catch((error) => {
        log.warn("edit-intent stale-host waiter cancellation failed", { hostBootID: bootID, error })
        return 0
      }),
    )
  }
  if (hosts.some((host) => host.hostBootID === null)) {
    cancelled += yield* Effect.promise(() =>
      cancelOrphanedEditIntentWaiters(input.projectRoot, {
        orphanedBefore: new Date(Date.now() - ORPHAN_SWEEP_GRACE_MS).toISOString(),
      }).catch((error) => {
        log.warn("edit-intent orphan waiter cancellation failed", { error })
        return 0
      }),
    )
  }
  if (cancelled > 0) log.info("edit-intent stale-host waiters cancelled", { projectRoot: input.projectRoot, cancelled })
  return cancelled
})

/**
 * Cross-process poll→inject bridge body, run on a light interval by the
 * per-instance edit-intent watcher in session/prompt.ts. A release in another
 * process flips claim rows but cannot inject into this process's parked
 * sessions, so each tick takes the freed files of this host's own waiting
 * waiters (host-filtered take; exactly-once via the conditional UPDATE
 * changes-guard) and returns them as local inject targets. Gated by the
 * pendingPollRoots hint set at waiter registration: zero own waiters means
 * zero DB access for the tick. Stale-boot cleanup piggybacks on active ticks.
 */
export const pollCrossProcessWakes = Effect.fn("EditIntentClaims.pollCrossProcessWakes")(function* (input: { projectRoot: string }) {
  if (!pendingPollRoots.has(input.projectRoot)) return [] as EditIntentWakeTarget[]
  const own = yield* Effect.promise(() =>
    readEditIntentWaiters(input.projectRoot, { status: "waiting", hostBootID: currentHostBootID(), limit: 200 }).catch((error) => {
      log.warn("edit-intent cross-process poll read failed", { error })
      return [] as EditIntentWaiterRecord[]
    }),
  )
  if (own.length === 0) {
    pendingPollRoots.delete(input.projectRoot)
    return [] as EditIntentWakeTarget[]
  }
  yield* sweepStaleHosts({ projectRoot: input.projectRoot })
  const woken = yield* Effect.promise(() =>
    takeWokenEditIntentWaiters(input.projectRoot, own.map((waiter) => waiter.filePath), { hostBootID: currentHostBootID() }).catch((error) => {
      log.warn("edit-intent cross-process wake collection failed", { error })
      return [] as EditIntentWaiterRecord[]
    }),
  )
  return groupWakeTargets(woken)
})

export const contextLines = Effect.fn("EditIntentClaims.contextLines")(function* (input: {
  projectRoot: string
  sessionID: string
}) {
  const [own, waiters] = yield* Effect.promise(() =>
    Promise.all([
      readActiveEditIntentClaims(input.projectRoot, { sessionID: input.sessionID }).catch(() => [] as EditIntentClaimRecord[]),
      readEditIntentWaiters(input.projectRoot, { sessionID: input.sessionID, status: "waiting" }).catch(() => [] as EditIntentWaiterRecord[]),
    ]),
  )
  const waitingFiles = uniquePaths(waiters.map((waiter) => waiter.filePath))
  const holders =
    waitingFiles.length === 0
      ? []
      : yield* Effect.promise(() =>
          readActiveEditIntentClaims(input.projectRoot, { files: waitingFiles, excludeSessionID: input.sessionID }).catch(
            () => [] as EditIntentClaimRecord[],
          ),
        )
  const currentHolders = earliestHolders(holders)
  // Waiters whose file no longer has a current holder are mid-wake (the
  // release inject is in flight) — they render nothing here.
  const blocked = waiters.filter((waiter) => currentHolders.has(waiter.filePath))
  if (own.length === 0 && blocked.length === 0) return [] as string[]
  // G2: same-source queue positions so the runtime context also shows how
  // deep this session sits in each blocked file's wake queue.
  const blockedFiles = uniquePaths(blocked.map((waiter) => waiter.filePath))
  const queuePositions = blockedFiles.length === 0 ? [] : yield* readBlockedQueuePositions(input.projectRoot, input.sessionID, blockedFiles)
  const positionByFile = new Map(queuePositions.map((position) => [position.filePath, position]))
  const queued = queuePositions.filter((position) => position.position !== undefined)
  const deepest = queued.length === 0 ? undefined : queued.reduce((best, position) => (position.position! > best.position! ? position : best))
  // Display order is alphabetical so the line is stable regardless of claim
  // read order (which follows registration order for queue fairness).
  const ownFiles = uniquePaths(own.map((claim) => claim.filePath)).sort()
  const ownShown = ownFiles.slice(0, MAX_CONTEXT_FILES)
  const ownOmitted = ownFiles.length - ownShown.length
  return [
    "Edit Intent Claims:",
    ...(own.length > 0
      ? [
          `- held by you: ${ownShown.join(", ")}${ownOmitted > 0 ? ` (+${ownOmitted} more)` : ""} — other session families' edits to these files are blocked until this batch releases (explicit chimera_audit_recent closeout, or run completion with no family-owned running jobs; a TTL is only a crash fallback).`,
        ]
      : []),
    ...blocked.map((waiter) => {
      const holder = currentHolders.get(waiter.filePath)!
      const position = positionByFile.get(waiter.filePath)
      const queueSuffix = position?.position !== undefined ? `; you are #${position.position} of ${position.depth} in the wake queue` : ""
      return `- blocked: ${waiter.filePath} is claimed by session ${holder.sessionID} (agent ${holder.agent}, ${heldAge(holder.createdAt)}); your claim is queued${queueSuffix} — a release notice is injected automatically when the holder finishes; work on non-conflicting files meanwhile.`
    }),
    ...(deepest
      ? [`- queued: you are waiting on ${blockedFiles.length} file(s) (deepest position #${deepest.position} of ${deepest.depth} on ${deepest.filePath}).`]
      : []),
  ]
})

const readBlockedQueuePositions = Effect.fnUntraced(function* (projectRoot: string, sessionID: string, files: string[]) {
  return yield* Effect.promise(() =>
    readEditIntentQueuePositions(projectRoot, { files, sessionID }).catch((error) => {
      log.warn("edit-intent queue position read failed", { error })
      return [] as EditIntentQueuePosition[]
    }),
  )
})

export * as EditIntentClaims from "./edit-intent"
