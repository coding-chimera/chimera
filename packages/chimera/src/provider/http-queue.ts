/**
 * Queue primitives for the provider HTTP gate: an intrusive doubly-linked
 * list (O(1) append / pop-head / arbitrary removal for abort), body byte
 * accounting, the pre-send error vocabulary and small timer/signal helpers.
 * No scheduling policy lives here — see http-cfs.ts.
 */

/** A queued request exceeded a count/bytes ceiling; rejected before send. */
export class QueueOverflowError extends Error {
  kind: "count" | "bytes" | "flow-bytes"
  limit: number
  attempted: number
  constructor(kind: "count" | "bytes" | "flow-bytes", limit: number, attempted: number) {
    super(`http queue overflow (${kind}): limit ${limit}, attempted ${attempted}`)
    this.name = "QueueOverflowError"
    this.kind = kind
    this.limit = limit
    this.attempted = attempted
  }
}

/** A queued request waited past queueWaitTimeoutMs; rejected before send. */
export class QueueWaitTimeoutError extends Error {
  waitedMs: number
  constructor(waitedMs: number) {
    super(`http queue wait timed out after ${waitedMs}ms`)
    this.name = "QueueWaitTimeoutError"
    this.waitedMs = waitedMs
  }
}

/** A granted permit outlived permitLeaseMs; upstream cancelled, permit freed. */
export class PermitLeaseExpiredError extends Error {
  leaseMs: number
  constructor(leaseMs: number) {
    super(`http permit lease expired after ${leaseMs}ms`)
    this.name = "PermitLeaseExpiredError"
    this.leaseMs = leaseMs
  }
}

/** The gate was disposed while a request was queued or submitting. */
export class GateDisposedError extends Error {
  constructor() {
    super("http gate disposed")
    this.name = "GateDisposedError"
  }
}

export type LinkedNode = {
  prev: LinkedNode | null
  next: LinkedNode | null
}

/** Intrusive FIFO list: the node carries its own links, so abort removal is
 *  O(1) and never scans. remove() is idempotent via the head/link check. */
export class IntrusiveList<T extends LinkedNode> {
  head: T | null = null
  tail: T | null = null
  length = 0

  push(node: T): void {
    node.prev = this.tail
    node.next = null
    if (this.tail) this.tail.next = node
    else this.head = node
    this.tail = node
    this.length++
  }

  popHead(): T | null {
    const node = this.head
    if (node) this.remove(node)
    return node
  }

  remove(node: T): void {
    if (node.prev === null && node.next === null && this.head !== node) return
    // All linked nodes are T (push only accepts T), so the base-typed links are
    // safely narrowed to T for head/tail; runtime semantics are unchanged.
    if (node.prev) node.prev.next = node.next
    else this.head = node.next as T | null
    if (node.next) node.next.prev = node.prev
    else this.tail = node.prev as T | null
    node.prev = null
    node.next = null
    this.length--
  }
}

/** Queue byte weight of a request body: strings count UTF-8 bytes (Chinese
 *  included) via Buffer.byteLength — no full encode allocation; Uint8Array
 *  counts byteLength, everything else counts 0. */
export function bodyBytes(body: unknown): number {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8")
  if (body instanceof Uint8Array) return body.byteLength
  return 0
}

/** The caller's abort reason, identity intact — including an explicit null.
 *  Only an undefined reason gets the standard AbortError DOMException. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new DOMException("The operation was aborted.", "AbortError") : signal.reason
}

/** Timers must never keep the process (or a test runner) alive. */
export function unrefTimer(timer: unknown): void {
  ;(timer as { unref?: () => void }).unref?.()
}

export * as HttpQueue from "./http-queue"