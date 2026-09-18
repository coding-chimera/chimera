import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "@/tool/tool"
import {
  cancelEditIntentWaiters,
  cancelEditIntentWaitersByHostBootID,
  cancelOrphanedEditIntentWaiters,
  currentHostBootID,
  EDIT_INTENT_CLAIM_DEFAULT_TTL_MS,
  listEditIntentWaiterHosts,
  readActiveEditIntentClaims,
  readEditIntentWaiters,
  registerEditIntentClaims,
  registerEditIntentWaiter,
  releaseEditIntentClaims,
  takeWokenEditIntentWaiters,
  type EditIntentClaimRecord,
  type EditIntentClaimReleaseReason,
  type EditIntentWaiterRecord,
} from "./store"
import { TOOL_MUTATION_EDIT_INTENT_BLOCKED } from "./guidance"

const log = Log.create({ service: "chimera.edit-intent" })

const MAX_CONTEXT_FILES = 8
const MAX_INTENT_CHARS = 140

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
 * - the mutation gate blocks edits on files claimed by OTHER sessions and
 *   registers the blocked session as a waiter (first-come-first-served queue);
 * - claims release on explicit signals — the holder's run completing
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
  /** True when the checking session already queued its own claim on the file. */
  ownClaimQueued: boolean
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

/** Earliest active claim per file wins the queue; claims arrive created_at ASC. */
function earliestHolders(claims: EditIntentClaimRecord[]) {
  const earliest = new Map<string, EditIntentClaimRecord>()
  for (const claim of claims) {
    if (!earliest.has(claim.filePath)) earliest.set(claim.filePath, claim)
  }
  return earliest
}

/**
 * First-come-first-served queue fairness: a foreign claim blocks the checking
 * session only when it outranks that session's own earliest claim on the file.
 * The front of the queue (or a session without any foreign competition) never
 * blocks, so a later predesign can not lock out an earlier holder.
 *
 * Claims arrive in registration order (`created_at` ASC, then SQLite `rowid`
 * ASC), so the array index is the authoritative queue rank. A timestamp-only
 * tie must not fall back to the claim id: predesign ids are arbitrary strings,
 * so a later declaration whose id happens to sort lower would otherwise steal
 * the queue front and hide the real holder.
 */
function queueConflicts(claims: EditIntentClaimRecord[], sessionID: string) {
  const arrivalRank = new Map(claims.map((claim, index) => [claim, index]))
  const own = earliestHolders(claims.filter((claim) => claim.sessionID === sessionID))
  const foreign = earliestHolders(claims.filter((claim) => claim.sessionID !== sessionID))
  const conflicts: EditIntentConflict[] = []
  for (const [filePath, holder] of foreign) {
    const mine = own.get(filePath)
    const mineFirst = mine !== undefined && arrivalRank.get(mine)! < arrivalRank.get(holder)!
    if (mineFirst) continue
    conflicts.push(conflictFrom(holder, mine !== undefined))
  }
  return conflicts.sort((a, b) => a.filePath.localeCompare(b.filePath))
}

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
  const registered = yield* Effect.promise(() =>
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
  const active = yield* Effect.promise(() =>
    readActiveEditIntentClaims(input.projectRoot, { files }).catch((error) => {
      log.warn("edit-intent conflict read failed", { error })
      return [] as EditIntentClaimRecord[]
    }),
  )
  const conflicts = queueConflicts(active, input.sessionID)
  // Queue this session behind every holder so the release broadcast (L2 wake)
  // reaches it even if it parks without ever attempting the edit.
  yield* registerWaiters(input.projectRoot, input.sessionID, conflicts, `predesign:${input.predesignID}`)
  return { registered, conflicts }
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
  const conflicts = queueConflicts(claims, input.sessionID)
  yield* registerWaiters(input.projectRoot, input.sessionID, conflicts, `mutation_gate:${input.toolID}`)
  return conflicts
})

export function blockedResult(input: { toolID: string; conflicts: EditIntentConflict[] }): Tool.ExecuteResult {
  const unqueued = input.conflicts.filter((conflict) => !conflict.ownClaimQueued)
  return {
    title: "Chimera edit-intent claim conflict",
    output: [
      TOOL_MUTATION_EDIT_INTENT_BLOCKED,
      "",
      "Conflicting claims:",
      ...input.conflicts.map(
        (conflict) =>
          `- ${conflict.filePath}: held by session ${conflict.holder.sessionID} (agent ${conflict.holder.agent}) since ${heldAge(conflict.holder.createdAt)}; intent: ${compactIntent(conflict.holder.intent)}${conflict.ownClaimQueued ? "; your claim is queued behind it" : ""}`,
      ),
      "",
      "What to do:",
      "- Do not retry this mutation in a loop; the claim stays active until the holder's run completes or its session is removed (a TTL is only a crash fallback).",
      "- Continue with non-conflicting files first; when every conflicting file frees up, a release notice is injected into this session automatically — re-read the files then (they may have changed) and continue the blocked work.",
      ...(unqueued.length > 0
        ? [`- Record chimera_predesign declaring ${unqueued.map((conflict) => conflict.filePath).join(", ")} to queue your own claim behind the holder${unqueued.length > 1 ? "s" : ""}.`]
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

export const releaseForSession = Effect.fn("EditIntentClaims.releaseForSession")(function* (input: {
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
  if (released.length === 0) return [] as EditIntentWakeTarget[]
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
  return groupWakeTargets(woken, input.reason)
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
    reason: Schema.Literal("session_removed"),
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
  // Display order is alphabetical so the line is stable regardless of claim
  // read order (which follows registration order for queue fairness).
  const ownFiles = uniquePaths(own.map((claim) => claim.filePath)).sort()
  const ownShown = ownFiles.slice(0, MAX_CONTEXT_FILES)
  const ownOmitted = ownFiles.length - ownShown.length
  return [
    "Edit Intent Claims:",
    ...(own.length > 0
      ? [
          `- held by you: ${ownShown.join(", ")}${ownOmitted > 0 ? ` (+${ownOmitted} more)` : ""} — other sessions' edits to these files are blocked until this run completes (advisory coordination; a TTL is only a crash fallback).`,
        ]
      : []),
    ...blocked.map((waiter) => {
      const holder = currentHolders.get(waiter.filePath)!
      return `- blocked: ${waiter.filePath} is claimed by session ${holder.sessionID} (agent ${holder.agent}, ${heldAge(holder.createdAt)}); your claim is queued — a release notice is injected automatically when the holder finishes; work on non-conflicting files meanwhile.`
    }),
  ]
})

export * as EditIntentClaims from "./edit-intent"
