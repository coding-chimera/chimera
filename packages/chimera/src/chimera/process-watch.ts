import type { ProcessEntry } from "./process-registry"

/**
 * Host-local, per-project exit subscriptions for registered processes. A
 * subscription is one-shot: the first terminal signal (exit/kill/expiry, or a
 * watch timeout) removes it and injects exactly one notice into the subscriber
 * session. This state deliberately lives in host memory, not the shared DB:
 * only the host that holds the session can inject into it, so a subscription
 * made by another process could never be delivered. The watcher in
 * session/prompt.ts bridges the shared registry (the cross-process event
 * source) into these local subscriptions.
 */

export type ProcessExitDetection = "owner-report" | "liveness-poll"

export type ProcessWatchSubscription = {
  sessionID: string
  pid: number
  command: string
  ownerSession: string
  startedAt: string
  /** Absolute epoch ms when the watch times out; null means no timeout. */
  expiresAt: number | null
}

/** projectRoot -> sessionID -> pid -> subscription. */
const subscriptions = new Map<string, Map<string, Map<number, ProcessWatchSubscription>>>()

function byPid(projectRoot: string, sessionID: string) {
  const bySession = subscriptions.get(projectRoot) ?? new Map<string, Map<number, ProcessWatchSubscription>>()
  subscriptions.set(projectRoot, bySession)
  const forSession = bySession.get(sessionID) ?? new Map<number, ProcessWatchSubscription>()
  bySession.set(sessionID, forSession)
  return forSession
}

export function subscribe(input: {
  projectRoot: string
  sessionID: string
  pid: number
  command: string
  ownerSession: string
  startedAt: string
  timeoutMs?: number
}): ProcessWatchSubscription {
  const subscription: ProcessWatchSubscription = {
    sessionID: input.sessionID,
    pid: input.pid,
    command: input.command,
    ownerSession: input.ownerSession,
    startedAt: input.startedAt,
    expiresAt: input.timeoutMs === undefined ? null : Date.now() + input.timeoutMs,
  }
  byPid(input.projectRoot, input.sessionID).set(input.pid, subscription)
  return subscription
}

/**
 * Remove-and-return one session's subscription for a pid. The synchronous
 * delete is the exactly-once gate: the fast (bus) and slow (poll) channels
 * both call it, and only the caller that receives the subscription injects.
 */
export function take(projectRoot: string, sessionID: string, pid: number): ProcessWatchSubscription | undefined {
  const forSession = subscriptions.get(projectRoot)?.get(sessionID)
  if (!forSession) return undefined
  const subscription = forSession.get(pid)
  if (!subscription) return undefined
  forSession.delete(pid)
  return subscription
}

/** Remove-and-return every session's subscription for a pid (cross-session fan-out). */
export function takeByPid(projectRoot: string, pid: number): ProcessWatchSubscription[] {
  const bySession = subscriptions.get(projectRoot)
  if (!bySession) return []
  const taken: ProcessWatchSubscription[] = []
  for (const forSession of bySession.values()) {
    const subscription = forSession.get(pid)
    if (!subscription) continue
    forSession.delete(pid)
    taken.push(subscription)
  }
  return taken
}

export function listForSession(projectRoot: string, sessionID: string): ProcessWatchSubscription[] {
  return [...(subscriptions.get(projectRoot)?.get(sessionID)?.values() ?? [])]
}

export function listForProject(projectRoot: string): ProcessWatchSubscription[] {
  const bySession = subscriptions.get(projectRoot)
  if (!bySession) return []
  return [...bySession.values()].flatMap((forSession) => [...forSession.values()])
}

/** Drop every subscription of a removed session; returns the dropped rows. */
export function releaseForSession(projectRoot: string, sessionID: string): ProcessWatchSubscription[] {
  const bySession = subscriptions.get(projectRoot)
  const forSession = bySession?.get(sessionID)
  if (!bySession || !forSession) return []
  const dropped = [...forSession.values()]
  bySession.delete(sessionID)
  if (bySession.size === 0) subscriptions.delete(projectRoot)
  return dropped
}

/** Test seam: drop all host-local subscription state. */
export function reset() {
  subscriptions.clear()
}

export type ProcessWatchResolution =
  | { kind: "subscribe"; entry: ProcessEntry }
  | { kind: "terminal"; entry: ProcessEntry }
  | { kind: "missing" }

/**
 * pid → registry resolution. The newest running row wins (guards against pid
 * reuse by a later spawn); when no running row exists but a terminal row does,
 * the caller reports the exit synchronously instead of subscribing; no row at
 * all is a miss.
 */
export function resolveWatchTarget(rows: ProcessEntry[]): ProcessWatchResolution {
  const newest = (list: ProcessEntry[]) =>
    list.reduce<ProcessEntry | undefined>((best, row) => (!best || row.startedAt > best.startedAt ? row : best), undefined)
  const running = newest(rows.filter((row) => row.status === "running"))
  if (running) return { kind: "subscribe", entry: running }
  const terminal = newest(rows)
  if (!terminal) return { kind: "missing" }
  return { kind: "terminal", entry: terminal }
}

/** Newest row per pid from a mixed row set (the poll's read shape). */
export function latestPerPid(rows: ProcessEntry[]): ProcessEntry[] {
  const byPidMap = new Map<number, ProcessEntry>()
  for (const row of rows) {
    const current = byPidMap.get(row.pid)
    if (!current || row.startedAt > current.startedAt) byPidMap.set(row.pid, row)
  }
  return [...byPidMap.values()]
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function exitText(
  subscription: ProcessWatchSubscription,
  row: ProcessEntry,
  detected: ProcessExitDetection,
) {
  return `<process_exited pid="${row.pid}" status="${row.status}" exit_code="${row.exitCode ?? "-"}" command="${escapeAttribute(subscription.command)}" owner_session="${subscription.ownerSession}" started_at="${subscription.startedAt}" exited_at="${row.exitedAt ?? "-"}" detected="${detected}">The registered process you subscribed to has exited.</process_exited>`
}

export function timeoutText(subscription: ProcessWatchSubscription) {
  return `<process_watch_timeout pid="${subscription.pid}" command="${escapeAttribute(subscription.command)}">The registered process you subscribed to did not exit within the requested timeout; the watch has been removed. It may still be running.</process_watch_timeout>`
}

export * as ProcessWatch from "./process-watch"