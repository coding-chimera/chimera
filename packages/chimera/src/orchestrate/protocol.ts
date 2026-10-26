/**
 * Stdio JSON-line protocol vocabulary for the orchestrate worker.
 *
 * The host treats the worker as a hostile peer: model-authored program code can
 * write arbitrary bytes to stdout, so every inbound line is re-validated here.
 * Everything in this module is pure (no I/O, no process state) so the host and
 * the worker-side duplication in `child-main.ts` can be reasoned about
 * independently.
 *
 * Frames
 * - worker -> host: ready | log | call | done
 * - host -> worker: boot | reply
 */

export const PROTOCOL_LIMITS = {
  /** Hard cap for a single JSON line in either direction. */
  maxFrameBytes: 4 * 1024 * 1024,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxPendingCalls: 128,
  defaultLogBytes: 64 * 1024,
  defaultResultBytes: 1024 * 1024,
  maxStderrBytes: 8 * 1024,
} as const

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface Budgets {
  readonly timeoutMs: number
  readonly maxPending: number
  readonly maxLogBytes: number
  readonly maxResultBytes: number
  readonly maxFrameBytes: number
}

export interface ReadyFrame {
  readonly type: "ready"
}

export interface LogFrame {
  readonly type: "log"
  readonly text: string
}

export interface CallFrame {
  readonly type: "call"
  readonly id: number
  readonly name: string
  readonly args: JsonValue
}

export interface DoneFrame {
  readonly type: "done"
  readonly value?: JsonValue
  readonly error?: { readonly kind: string; readonly message: string }
}

export type ChildFrame = ReadyFrame | LogFrame | CallFrame | DoneFrame

export interface BootFrame {
  readonly type: "boot"
  readonly program: string
  readonly namespaces: Record<string, readonly string[]>
  readonly budgets: Budgets
}

export type ReplyFrame =
  | { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value?: JsonValue }
  | { readonly type: "reply"; readonly id: number; readonly ok: false; readonly message: string }

export type HostFrame = BootFrame | ReplyFrame

export type ParseResult<A> = { readonly ok: true; readonly frame: A } | { readonly ok: false; readonly message: string }

const encoder = new TextEncoder()

export function utf8ByteLength(text: string) {
  return encoder.encode(text).byteLength
}

export function isCallID(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** Call ids must strictly increase over the life of one worker. */
export function isStrictlyIncreasingCallID(previous: number, next: number) {
  return isCallID(next) && next > previous
}

/** Own-property check; never consults the prototype chain. */
export function hasOwnBinding(bindings: Readonly<Record<string, unknown>>, name: string) {
  return Object.hasOwn(bindings, name)
}

/**
 * Lossless-JSON guard. Returns an error description or `undefined` when the
 * value can be round-tripped through JSON without losing information.
 */
export function checkLosslessJson(value: unknown): string | undefined {
  const seen = new WeakSet<object>()

  const walk = (input: unknown, path: string): string | undefined => {
    if (input === null) return undefined
    switch (typeof input) {
      case "boolean":
      case "string":
        return undefined
      case "number":
        return Number.isFinite(input) ? undefined : `${path}: non-finite number`
      case "object":
        break
      default:
        return `${path}: ${typeof input} is not JSON`
    }

    const object = input as object
    if (seen.has(object)) return `${path}: circular reference`
    seen.add(object)

    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        if (!(index in object)) return `${path}[${index}]: sparse array`
        const problem = walk(object[index], `${path}[${index}]`)
        if (problem) return problem
      }
      seen.delete(object)
      return undefined
    }

    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) return `${path}: non-plain object`
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string") return `${path}: non-string key`
      const problem = walk((object as Record<string, unknown>)[key], `${path}.${key}`)
      if (problem) return problem
    }
    seen.delete(object)
    return undefined
  }

  return walk(value, "$")
}

export function encodeLosslessJson(
  value: unknown,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } {
  const problem = checkLosslessJson(value)
  if (problem) return { ok: false, message: problem }
  try {
    return { ok: true, text: JSON.stringify(value) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function parseLine(
  line: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  if (utf8ByteLength(line) > PROTOCOL_LIMITS.maxFrameBytes) {
    return { ok: false, message: `frame exceeds ${PROTOCOL_LIMITS.maxFrameBytes} bytes` }
  }
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch (error) {
    return { ok: false, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function parseChildFrame(line: string): ParseResult<ChildFrame> {
  const parsed = parseLine(line)
  if (!parsed.ok) return parsed
  const frame = record(parsed.value)
  if (!frame) return { ok: false, message: "frame must be a JSON object" }

  switch (frame.type) {
    case "ready":
      return { ok: true, frame: { type: "ready" } }
    case "log":
      if (typeof frame.text !== "string") return { ok: false, message: "log.text must be a string" }
      return { ok: true, frame: { type: "log", text: frame.text } }
    case "call":
      if (!isCallID(frame.id)) return { ok: false, message: "call.id must be a positive safe integer" }
      if (typeof frame.name !== "string" || frame.name.length === 0) {
        return { ok: false, message: "call.name must be a non-empty string" }
      }
      return { ok: true, frame: { type: "call", id: frame.id, name: frame.name, args: frame.args as JsonValue } }
    case "done": {
      const hasValue = Object.hasOwn(frame, "value")
      const hasError = Object.hasOwn(frame, "error")
      if (hasValue && hasError) return { ok: false, message: "done frame cannot carry both value and error" }
      if (!hasError) {
        return { ok: true, frame: hasValue ? { type: "done", value: frame.value as JsonValue } : { type: "done" } }
      }
      const error = record(frame.error)
      if (!error || typeof error.kind !== "string" || typeof error.message !== "string") {
        return { ok: false, message: "done.error must carry string kind and message" }
      }
      return { ok: true, frame: { type: "done", error: { kind: error.kind, message: error.message } } }
    }
    default:
      return { ok: false, message: `unknown frame type: ${String(frame.type)}` }
  }
}

function parseNamespaces(value: unknown): Record<string, readonly string[]> | undefined {
  const input = record(value)
  if (!input) return undefined
  const namespaces: Record<string, readonly string[]> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return undefined
    const names = input[key]
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) return undefined
    namespaces[key] = [...names]
  }
  return namespaces
}

function parseBudgets(value: unknown): Budgets | undefined {
  const input = record(value)
  if (!input) return undefined
  const fields = ["timeoutMs", "maxPending", "maxLogBytes", "maxResultBytes", "maxFrameBytes"] as const
  if (fields.some((field) => typeof input[field] !== "number" || !Number.isFinite(input[field] as number)))
    return undefined
  return {
    timeoutMs: input.timeoutMs as number,
    maxPending: input.maxPending as number,
    maxLogBytes: input.maxLogBytes as number,
    maxResultBytes: input.maxResultBytes as number,
    maxFrameBytes: input.maxFrameBytes as number,
  }
}

export function parseHostFrame(line: string): ParseResult<HostFrame> {
  const parsed = parseLine(line)
  if (!parsed.ok) return parsed
  const frame = record(parsed.value)
  if (!frame) return { ok: false, message: "frame must be a JSON object" }

  switch (frame.type) {
    case "boot": {
      if (typeof frame.program !== "string") return { ok: false, message: "boot.program must be a string" }
      const namespaces = parseNamespaces(frame.namespaces)
      if (!namespaces) return { ok: false, message: "boot.namespaces must map names to string arrays" }
      const budgets = parseBudgets(frame.budgets)
      if (!budgets) return { ok: false, message: "boot.budgets is malformed" }
      return { ok: true, frame: { type: "boot", program: frame.program, namespaces, budgets } }
    }
    case "reply": {
      if (!isCallID(frame.id)) return { ok: false, message: "reply.id must be a positive safe integer" }
      if (frame.ok === true) {
        if (!Object.hasOwn(frame, "value")) return { ok: true, frame: { type: "reply", id: frame.id, ok: true } }
        return { ok: true, frame: { type: "reply", id: frame.id, ok: true, value: frame.value as JsonValue } }
      }
      if (frame.ok === false) {
        if (typeof frame.message !== "string") return { ok: false, message: "reply.message must be a string" }
        return { ok: true, frame: { type: "reply", id: frame.id, ok: false, message: frame.message } }
      }
      return { ok: false, message: "reply.ok must be a boolean" }
    }
    default:
      return { ok: false, message: `unknown frame type: ${String(frame.type)}` }
  }
}

export * as OrchestrateProtocol from "./protocol"
