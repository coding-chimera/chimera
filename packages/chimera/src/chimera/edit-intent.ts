import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "@/tool/tool"
import {
  cancelEditIntentWaiters,
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
 *   claims block is the L1 pull path for sessions between turns.
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
 * blocks, so a later predesign can not lock out an earlier holder. Claims
 * arrive created_at ASC; same-millisecond ties break deterministically on id.
 */
function queueConflicts(claims: EditIntentClaimRecord[], sessionID: string) {
  const own = earliestHolders(claims.filter((claim) => claim.sessionID === sessionID))
  const foreign = earliestHolders(claims.filter((claim) => claim.sessionID !== sessionID))
  const conflicts: EditIntentConflict[] = []
  for (const [filePath, holder] of foreign) {
    const mine = own.get(filePath)
    const mineFirst = mine !== undefined && (mine.createdAt < holder.createdAt || (mine.createdAt === holder.createdAt && mine.id < holder.id))
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
  const woken = yield* Effect.promise(() =>
    takeWokenEditIntentWaiters(
      input.projectRoot,
      released.map((claim) => claim.filePath),
    ).catch((error) => {
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
  const woken = yield* Effect.promise(() =>
    takeWokenEditIntentWaiters(
      input.projectRoot,
      pending.map((waiter) => waiter.filePath),
    ).catch((error) => {
      log.warn("edit-intent wake collection failed", { error })
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
  const ownFiles = uniquePaths(own.map((claim) => claim.filePath))
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
