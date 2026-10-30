// WP-09 plugin hook trajectory v1: codec + verifier.
//
// A trajectory is a canonical JSONL file with the same header/event/footer
// shape as WP-02 transcript v1 (see ../transcript/format.ts). It differs in
// three deliberate ways:
//
//   1. `format` is `chimera.oracle.plugin.hook-trace`, so the WP-02 parser
//      cannot accidentally accept a plugin trace as a session transcript.
//   2. finite decimals are allowed. `chat.params` carries floats
//      (temperature/topP), and WP-02's integer-only canonical JSON would
//      reject them. `JSON.stringify` gives a stable decimal spelling.
//   3. the event vocabulary is hook-specific (plugin.registered, hook.start,
//      hook.mutate, hook.end, sdk.call, auth.refresh, snapshot).
//
// The format is language-independent: a Rust recorder only needs canonical
// JSON with sorted keys, physical seq == 1..N, and a sha256 footer over
// header+events. This module is the TS oracle implementation used by the
// WP-09 fixtures; it is not a production recorder.

import { sha256, utf8ByteLength } from "../transcript/format"

export const HOOK_TRACE_FORMAT = "chimera.oracle.plugin.hook-trace" as const
export const HOOK_TRACE_VERSION = 1 as const
export const CONTRACT_REV = "cr-2026-10-30-r1" as const
export const WORK_ID = "WP-09" as const

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export const HOOK_CLASSES = [
  "config-bootstrap",
  "tool-definition",
  "chat-params-headers",
  "tool-execute-before",
  "tool-execute-after",
  "auth-refresh",
] as const
export type HookClass = (typeof HOOK_CLASSES)[number]

export const HOOK_NAMES = [
  "config",
  "tool.definition",
  "chat.params",
  "chat.headers",
  "tool.execute.before",
  "tool.execute.after",
  "auth.loader",
] as const
export type HookName = (typeof HOOK_NAMES)[number]

// auth.refresh is not a plugin hook; it is the lazy token refresh that the
// auth plugin performs inside its fetch override. It shares the auth-refresh
// class with auth.loader and is covered by the failure-policy table.
export const POLICY_HOOKS = [...HOOK_NAMES, "auth.refresh"] as const
export type PolicyHook = (typeof POLICY_HOOKS)[number]

export const HOOK_CLASS_OF: Record<HookName, HookClass> = {
  config: "config-bootstrap",
  "tool.definition": "tool-definition",
  "chat.params": "chat-params-headers",
  "chat.headers": "chat-params-headers",
  "tool.execute.before": "tool-execute-before",
  "tool.execute.after": "tool-execute-after",
  "auth.loader": "auth-refresh",
}

export const OPERATION_NAMES = [
  "bootstrap",
  "provider.init",
  "tool.list",
  "llm.request",
  "tool.execute",
  "session.dispose",
] as const
export type OperationName = (typeof OPERATION_NAMES)[number]

export type PluginRegisteredEvent = {
  kind: "plugin.registered"
  plugin_id: string
  origin: "internal" | "config"
  order: number
  hooks: HookName[]
}

export type OperationStartEvent = {
  kind: "operation.start"
  op: OperationName
  op_id: string
  detail: Json
}

export type OperationEndEvent = {
  kind: "operation.end"
  op: OperationName
  op_id: string
  status: "ok" | "error" | "cancelled"
  error_code: string | null
}

export type HookStartEvent = {
  kind: "hook.start"
  hook: HookName
  hook_class: HookClass
  scope: string
  plugin_id: string
  input: Json
  output: Json
}

export type HookMutateEvent = {
  kind: "hook.mutate"
  hook: HookName
  scope: string
  plugin_id: string
  path: string
  before: Json
  after: Json
}

export type HookEndEvent = {
  kind: "hook.end"
  hook: HookName
  scope: string
  plugin_id: string
  status: "ok" | "error"
  error_code: string | null
}

export type SdkCallEvent = {
  kind: "sdk.call"
  hook: HookName | "auth.refresh"
  scope: string
  plugin_id: string
  method: string
  status: "ok" | "error"
  error_code: string | null
}

export type AuthRefreshEvent = {
  kind: "auth.refresh"
  scope: string
  provider_id: string
  trigger: "expires_lt_now"
  single_flight: boolean
  concurrent_requests: number
  persist: "auth.set"
  expires_delta_s: number
}

export type SnapshotEvent = {
  kind: "snapshot"
  scope: string
  name: string
  value: Json
}

export type TraceEventInput =
  | PluginRegisteredEvent
  | OperationStartEvent
  | OperationEndEvent
  | HookStartEvent
  | HookMutateEvent
  | HookEndEvent
  | SdkCallEvent
  | AuthRefreshEvent
  | SnapshotEvent

export type WithSeq<T> = T extends unknown ? T & { seq: number } : never
export type TraceEvent = WithSeq<TraceEventInput>

export type HookTraceHeader = {
  record: "header"
  format: typeof HOOK_TRACE_FORMAT
  version: typeof HOOK_TRACE_VERSION
  contract_rev: string
  work_id: typeof WORK_ID
  trajectory: string
  synthetic: true
  description: string
}

export type HookTraceFooter = {
  record: "footer"
  event_count: number
  body_sha256: string
}

export type HookTrace = {
  header: HookTraceHeader
  events: TraceEvent[]
  footer: HookTraceFooter
  text: string
}

export type FailurePolicyRow = {
  hook: PolicyHook
  hook_class: HookClass
  failing_plugin_effect: string
  other_plugins: "continue" | "not-run" | "stop"
  operation_effect: string
  host_effect: string
  stable_code: string
}

export type CancelledExpectation = {
  op_id: string
  scope: string
  in_flight_plugin: string
}

export type HookTraceExpectation = {
  // key = `${hook}|${scope}`; value = plugin ids in invocation order.
  order: Record<string, string[]>
  // key = `${scope}#${name}`; value = the final shared output object.
  snapshots: Record<string, Json>
  cancelled: CancelledExpectation[]
  auth: {
    provider_id: string
    loader_scope: string
    refresh_scope: string
  }
  failure_policy: FailurePolicyRow[]
}

export type HookTraceReport = {
  plugins: { plugin_id: string; order: number; origin: "internal" | "config" }[]
  order: Record<string, string[]>
  snapshots: Record<string, Json>
  hooks: { hook: HookName; hook_class: HookClass; count: number }[]
  auth: { loader_calls: number; refresh_calls: number; single_flight: boolean }
  cancelled: string[]
  failure_policy: FailurePolicyRow[]
}

export class HookTraceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`)
    this.name = "HookTraceError"
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJson(value: unknown): value is Json {
  if (value === null) return true
  if (typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (isRecord(value)) return Object.values(value).every(isJson)
  return false
}

/**
 * Canonical JSON for hook traces.
 *
 * Same key ordering and `undefined` rejection as WP-02's `canonicalJson`, but
 * finite non-integers are allowed because chat.params carries floats. Every
 * finite number uses `JSON.stringify` (shortest round-trippable decimal), so
 * the bytes are stable across engines that follow ECMA-262 number printing.
 */
export function canonicalTraceJson(value: Json): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HookTraceError("TRACE_NUMBER", `non-finite number ${value}`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalTraceJson).join(",")}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const undefinedEntry = entries.find(([, item]) => item === undefined)
    if (undefinedEntry) throw new HookTraceError("TRACE_UNDEFINED", `undefined value at key ${undefinedEntry[0]}`)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalTraceJson(item as Json)}`).join(",")}}`
  }
  throw new HookTraceError("TRACE_VALUE", `unsupported value type ${typeof value}`)
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HookTraceError("TRACE_FIELD", `${field} must be a non-empty string`)
  }
}

function assertNullableString(value: unknown, field: string): asserts value is string | null {
  if (value === null) return
  if (typeof value !== "string") throw new HookTraceError("TRACE_FIELD", `${field} must be a string or null`)
}

function assertHookName(value: unknown, field: string): asserts value is HookName {
  if (typeof value !== "string" || !(HOOK_NAMES as readonly string[]).includes(value)) {
    throw new HookTraceError("TRACE_HOOK", `${field} is not a known hook: ${String(value)}`)
  }
}

function assertPolicyHook(value: unknown, field: string): asserts value is PolicyHook {
  if (typeof value !== "string" || !(POLICY_HOOKS as readonly string[]).includes(value)) {
    throw new HookTraceError("TRACE_HOOK", `${field} is not a known policy hook: ${String(value)}`)
  }
}

function assertHookClass(value: unknown, field: string): asserts value is HookClass {
  if (typeof value !== "string" || !(HOOK_CLASSES as readonly string[]).includes(value)) {
    throw new HookTraceError("TRACE_HOOK_CLASS", `${field} is not a known hook class: ${String(value)}`)
  }
}

function assertOperation(value: unknown, field: string): asserts value is OperationName {
  if (typeof value !== "string" || !(OPERATION_NAMES as readonly string[]).includes(value)) {
    throw new HookTraceError("TRACE_OPERATION", `${field} is not a known operation: ${String(value)}`)
  }
}

function assertJson(value: unknown, field: string): asserts value is Json {
  if (!isJson(value)) throw new HookTraceError("TRACE_JSON", `${field} is not JSON`)
}

function assertHookNameArray(value: unknown, field: string): asserts value is HookName[] {
  if (!Array.isArray(value)) throw new HookTraceError("TRACE_FIELD", `${field} must be an array`)
  for (const [index, item] of value.entries()) assertHookName(item, `${field}[${index}]`)
}

function assertEvent(value: unknown, line: number): asserts value is TraceEventInput {
  if (!isRecord(value)) throw new HookTraceError("TRACE_EVENT", `line ${line} is not an object`)
  assertString(value.kind, `line ${line} kind`)
  switch (value.kind) {
    case "plugin.registered":
      assertString(value.plugin_id, `line ${line} plugin_id`)
      if (value.origin !== "internal" && value.origin !== "config") {
        throw new HookTraceError("TRACE_ORIGIN", `line ${line} origin must be internal|config`)
      }
      if (typeof value.order !== "number" || !Number.isSafeInteger(value.order)) {
        throw new HookTraceError("TRACE_ORDER", `line ${line} order must be an integer`)
      }
      assertHookNameArray(value.hooks, `line ${line} hooks`)
      return
    case "operation.start":
      assertOperation(value.op, `line ${line} op`)
      assertString(value.op_id, `line ${line} op_id`)
      assertJson(value.detail, `line ${line} detail`)
      return
    case "operation.end":
      assertOperation(value.op, `line ${line} op`)
      assertString(value.op_id, `line ${line} op_id`)
      if (value.status !== "ok" && value.status !== "error" && value.status !== "cancelled") {
        throw new HookTraceError("TRACE_STATUS", `line ${line} status must be ok|error|cancelled`)
      }
      assertNullableString(value.error_code, `line ${line} error_code`)
      return
    case "hook.start": {
      assertHookName(value.hook, `line ${line} hook`)
      assertHookClass(value.hook_class, `line ${line} hook_class`)
      if (value.hook_class !== HOOK_CLASS_OF[value.hook]) {
        throw new HookTraceError(
          "TRACE_HOOK_CLASS",
          `line ${line} hook ${value.hook} belongs to ${HOOK_CLASS_OF[value.hook]}, not ${value.hook_class}`,
        )
      }
      assertString(value.scope, `line ${line} scope`)
      assertString(value.plugin_id, `line ${line} plugin_id`)
      assertJson(value.input, `line ${line} input`)
      assertJson(value.output, `line ${line} output`)
      return
    }
    case "hook.mutate":
      assertHookName(value.hook, `line ${line} hook`)
      assertString(value.scope, `line ${line} scope`)
      assertString(value.plugin_id, `line ${line} plugin_id`)
      assertString(value.path, `line ${line} path`)
      assertJson(value.before, `line ${line} before`)
      assertJson(value.after, `line ${line} after`)
      return
    case "hook.end":
      assertHookName(value.hook, `line ${line} hook`)
      assertString(value.scope, `line ${line} scope`)
      assertString(value.plugin_id, `line ${line} plugin_id`)
      if (value.status !== "ok" && value.status !== "error") {
        throw new HookTraceError("TRACE_STATUS", `line ${line} status must be ok|error`)
      }
      assertNullableString(value.error_code, `line ${line} error_code`)
      return
    case "sdk.call":
      assertPolicyHook(value.hook, `line ${line} hook`)
      assertString(value.scope, `line ${line} scope`)
      assertString(value.plugin_id, `line ${line} plugin_id`)
      assertString(value.method, `line ${line} method`)
      if (value.status !== "ok" && value.status !== "error") {
        throw new HookTraceError("TRACE_STATUS", `line ${line} status must be ok|error`)
      }
      assertNullableString(value.error_code, `line ${line} error_code`)
      return
    case "auth.refresh":
      assertString(value.scope, `line ${line} scope`)
      assertString(value.provider_id, `line ${line} provider_id`)
      if (value.trigger !== "expires_lt_now") {
        throw new HookTraceError("TRACE_AUTH", `line ${line} trigger must be expires_lt_now`)
      }
      if (typeof value.single_flight !== "boolean") {
        throw new HookTraceError("TRACE_AUTH", `line ${line} single_flight must be boolean`)
      }
      if (typeof value.concurrent_requests !== "number" || !Number.isSafeInteger(value.concurrent_requests)) {
        throw new HookTraceError("TRACE_AUTH", `line ${line} concurrent_requests must be an integer`)
      }
      if (value.persist !== "auth.set") {
        throw new HookTraceError("TRACE_AUTH", `line ${line} persist must be auth.set`)
      }
      if (typeof value.expires_delta_s !== "number" || !Number.isSafeInteger(value.expires_delta_s)) {
        throw new HookTraceError("TRACE_AUTH", `line ${line} expires_delta_s must be an integer`)
      }
      return
    case "snapshot":
      assertString(value.scope, `line ${line} scope`)
      assertString(value.name, `line ${line} name`)
      assertJson(value.value, `line ${line} value`)
      return
    default:
      throw new HookTraceError("TRACE_EVENT_KIND", `line ${line} has unknown kind ${String(value.kind)}`)
  }
}

export function stripSeq(event: TraceEvent): TraceEventInput {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "seq")) as TraceEventInput
}

export function encodeHookTrace(header: HookTraceHeader, events: TraceEventInput[]): string {
  const lines = [canonicalTraceJson(header)]
  events.forEach((event, index) => {
    assertEvent(event, index + 2)
    lines.push(canonicalTraceJson({ ...event, seq: index + 1 }))
  })
  const body = lines.join("\n") + "\n"
  const footer: HookTraceFooter = {
    record: "footer",
    event_count: events.length,
    body_sha256: sha256(body),
  }
  return body + canonicalTraceJson(footer) + "\n"
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new HookTraceError("TRACE_JSON", `line ${lineNumber} is not valid JSON`)
  }
}

function assertHeader(value: unknown): asserts value is HookTraceHeader {
  if (!isRecord(value)) throw new HookTraceError("TRACE_HEADER", "header is not an object")
  if (value.record !== "header") throw new HookTraceError("TRACE_HEADER", "first line is not a header")
  if (value.format !== HOOK_TRACE_FORMAT) {
    throw new HookTraceError("TRACE_FORMAT", `unexpected format ${String(value.format)}`)
  }
  if (value.version !== HOOK_TRACE_VERSION) {
    throw new HookTraceError("TRACE_VERSION", `unexpected version ${String(value.version)}`)
  }
  if (value.contract_rev !== CONTRACT_REV) {
    throw new HookTraceError("TRACE_CONTRACT_REV", `expected ${CONTRACT_REV}, got ${String(value.contract_rev)}`)
  }
  if (value.work_id !== WORK_ID) throw new HookTraceError("TRACE_WORK_ID", `expected ${WORK_ID}`)
  if (typeof value.trajectory !== "string" || value.trajectory.length === 0) {
    throw new HookTraceError("TRACE_HEADER", "trajectory must be a non-empty string")
  }
  if (value.synthetic !== true) {
    throw new HookTraceError("TRACE_SYNTHETIC", "hook trace fixtures must declare synthetic: true")
  }
  if (typeof value.description !== "string") {
    throw new HookTraceError("TRACE_HEADER", "description must be a string")
  }
}

function assertFooter(value: unknown): asserts value is HookTraceFooter {
  if (!isRecord(value)) throw new HookTraceError("TRACE_FOOTER", "footer is not an object")
  if (value.record !== "footer") throw new HookTraceError("TRACE_FOOTER", "last line is not a footer")
  if (typeof value.event_count !== "number" || !Number.isSafeInteger(value.event_count)) {
    throw new HookTraceError("TRACE_FOOTER", "event_count must be an integer")
  }
  if (typeof value.body_sha256 !== "string") {
    throw new HookTraceError("TRACE_FOOTER", "body_sha256 must be a string")
  }
}

export function parseHookTrace(text: string): HookTrace {
  if (!text.endsWith("\n")) {
    throw new HookTraceError("TRACE_TRAILING_NEWLINE", "trace must end with a newline")
  }
  const lines = text.slice(0, -1).split("\n")
  if (lines.length < 3) throw new HookTraceError("TRACE_SHAPE", "trace needs header, event, and footer lines")
  if (lines.some((line) => line.length === 0)) throw new HookTraceError("TRACE_SHAPE", "blank lines are not allowed")

  const header = parseLine(lines[0]!, 1)
  assertHeader(header)

  const footer = parseLine(lines[lines.length - 1]!, lines.length)
  assertFooter(footer)

  const body = lines.slice(0, -1).join("\n") + "\n"
  if (footer.body_sha256 !== sha256(body)) {
    throw new HookTraceError("TRACE_BODY_DIGEST", "footer body_sha256 does not match header+events body")
  }

  const eventLines = lines.slice(1, -1)
  if (footer.event_count !== eventLines.length) {
    throw new HookTraceError(
      "TRACE_EVENT_COUNT",
      `footer event_count ${footer.event_count} does not match ${eventLines.length} event lines`,
    )
  }

  const events = eventLines.map((line, index) => {
    const value = parseLine(line, index + 2)
    assertEvent(value, index + 2)
    const record = value as unknown as Record<string, unknown>
    if (record.seq !== index + 1) {
      throw new HookTraceError("TRACE_SEQ_ORDER", `line ${index + 2} has seq ${String(record.seq)}, expected ${index + 1}`)
    }
    return value as TraceEvent
  })

  return { header, events, footer, text }
}

function cloneJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item as Json)]))
  }
  return value
}

function deepEqualJson(left: Json | undefined, right: Json | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left === null || right === null) return left === right
  if (typeof left !== typeof right) return false
  if (typeof left !== "object") return left === right
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqualJson(item, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  if (!leftKeys.every((key, index) => key === rightKeys[index])) return false
  return leftKeys.every((key) => deepEqualJson(left[key] as Json, right[key] as Json))
}

function pathParts(path: string): string[] {
  const parts = path.split(".")
  if (parts.some((part) => part.length === 0)) throw new HookTraceError("HOOK_PATH", `invalid mutation path ${path}`)
  return parts
}

function getPath(root: Json, path: string): Json | undefined {
  let current: Json = root
  for (const part of pathParts(path)) {
    if (!isRecord(current)) return undefined
    const next = current[part]
    if (next === undefined) return undefined
    current = next as Json
  }
  return current
}

function setPath(root: Json, path: string, value: Json): void {
  const parts = pathParts(path)
  let current: Json = root
  for (const [index, part] of parts.entries()) {
    if (!isRecord(current)) throw new HookTraceError("HOOK_PATH", `mutation path ${path} crosses a non-object`)
    if (index === parts.length - 1) {
      current[part] = value
      return
    }
    const next = current[part]
    if (!isRecord(next)) throw new HookTraceError("HOOK_PATH", `mutation path ${path} crosses a missing object`)
    current = next as Json
  }
}

function eventKey(event: { hook: HookName; scope: string; plugin_id: string }): string {
  return `${event.hook}|${event.scope}|${event.plugin_id}`
}

function findEnclosingOperation(
  events: TraceEvent[],
  seq: number,
): { op: OperationName; op_id: string; start: number; end: number; detail: Json } | undefined {
  const starts = new Map<string, OperationStartEvent & { seq: number }>()
  const ends = new Map<string, OperationEndEvent & { seq: number }>()
  for (const event of events) {
    if (event.kind === "operation.start") starts.set(event.op_id, event)
    if (event.kind === "operation.end") ends.set(event.op_id, event)
  }
  const candidates = [...starts.values()]
    .filter((start) => start.seq <= seq)
    .filter((start) => {
      const end = ends.get(start.op_id)
      return end !== undefined && end.seq >= seq
    })
    .sort((left, right) => right.seq - left.seq)
  const hit = candidates[0]
  if (!hit) return undefined
  const end = ends.get(hit.op_id)!
  return { op: hit.op, op_id: hit.op_id, start: hit.seq, end: end.seq, detail: hit.detail }
}

function checkRegistration(trace: HookTrace): HookTraceReport["plugins"] {
  const registered = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "plugin.registered" }> => event.kind === "plugin.registered",
  )
  if (registered.length === 0) throw new HookTraceError("PLUGIN_MISSING", "trace has no plugin.registered events")
  const seen = new Set<string>()
  registered.forEach((event, index) => {
    if (seen.has(event.plugin_id)) {
      throw new HookTraceError("PLUGIN_DUPLICATE", `plugin ${event.plugin_id} is registered twice`)
    }
    seen.add(event.plugin_id)
    if (event.order !== index) {
      throw new HookTraceError("PLUGIN_ORDER", `plugin ${event.plugin_id} has order ${event.order}, expected ${index}`)
    }
  })
  const firstConfig = registered.findIndex((event) => event.origin === "config")
  if (firstConfig !== -1 && registered.slice(firstConfig).some((event) => event.origin === "internal")) {
    throw new HookTraceError("PLUGIN_ORDER", "internal plugins must be registered before config plugins")
  }
  const firstHook = trace.events.findIndex((event) => event.kind === "hook.start")
  const lastRegistration = trace.events.findLastIndex((event) => event.kind === "plugin.registered")
  if (firstHook !== -1 && firstHook < lastRegistration) {
    throw new HookTraceError("PLUGIN_ORDER", "a hook started before plugin registration finished")
  }
  return registered.map((event) => ({ plugin_id: event.plugin_id, order: event.order, origin: event.origin }))
}

function checkCancellation(trace: HookTrace, expected: CancelledExpectation[]): string[] {
  const cancelledOps = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "operation.end" }> =>
      event.kind === "operation.end" && event.status === "cancelled",
  )
  const cancelled: string[] = []
  for (const end of cancelledOps) {
    const start = trace.events.find(
      (event): event is Extract<TraceEvent, { kind: "operation.start" }> =>
        event.kind === "operation.start" && event.op_id === end.op_id,
    )
    if (!start) throw new HookTraceError("HOOK_CANCEL_ORDER", `cancelled op ${end.op_id} has no start`)
    const inside = trace.events.filter(
      (event): event is Extract<TraceEvent, { kind: "hook.start" }> =>
        event.kind === "hook.start" && event.seq > start.seq && event.seq < end.seq,
    )
    const unterminated = inside.filter((event) => {
      const closed = trace.events.find(
        (candidate): candidate is Extract<TraceEvent, { kind: "hook.end" }> =>
          candidate.kind === "hook.end" &&
          candidate.seq > event.seq &&
          candidate.seq < end.seq &&
          eventKey(candidate) === eventKey(event),
      )
      return closed === undefined
    })
    if (unterminated.length > 1) {
      throw new HookTraceError(
        "HOOK_CANCEL_ORDER",
        `cancelled op ${end.op_id} has ${unterminated.length} in-flight hooks; at most one is observable`,
      )
    }
    for (const event of unterminated) {
      cancelled.push(event.scope)
      const late = trace.events.find(
        (candidate): candidate is Extract<TraceEvent, { kind: "hook.mutate" | "hook.end" }> =>
          candidate.seq > end.seq &&
          (candidate.kind === "hook.mutate" || candidate.kind === "hook.end") &&
          eventKey(candidate) === eventKey(event),
      )
      if (late) {
        throw new HookTraceError(
          "HOOK_CANCEL_ORDER",
          `hook ${event.hook} on ${event.scope} emitted ${late.kind} after the operation was cancelled`,
        )
      }
    }
    if (end.op === "tool.execute" && isRecord(start.detail)) {
      const callID = start.detail.call_id
      if (typeof callID === "string") {
        const after = trace.events.find(
          (event) =>
            event.kind === "hook.start" &&
            event.hook === "tool.execute.after" &&
            event.scope === `after:${callID}`,
        )
        if (after) {
          throw new HookTraceError(
            "HOOK_AFTER_ON_CANCELLED_CALL",
            `tool call ${callID} was cancelled but still emitted tool.execute.after`,
          )
        }
      }
    }
  }
  for (const item of expected) {
    const end = trace.events.find(
      (event): event is Extract<TraceEvent, { kind: "operation.end" }> =>
        event.kind === "operation.end" && event.op_id === item.op_id,
    )
    if (!end || end.status !== "cancelled") {
      throw new HookTraceError("HOOK_CANCEL_MISSING", `expected cancelled op ${item.op_id}`)
    }
    const start = trace.events.find(
      (event): event is Extract<TraceEvent, { kind: "hook.start" }> =>
        event.kind === "hook.start" && event.scope === item.scope && event.plugin_id === item.in_flight_plugin,
    )
    if (!start) {
      throw new HookTraceError("HOOK_CANCEL_MISSING", `cancelled scope ${item.scope} has no in-flight hook start`)
    }
    const closed = trace.events.find(
      (event) =>
        event.kind === "hook.end" && event.scope === item.scope && event.plugin_id === item.in_flight_plugin,
    )
    if (closed) {
      throw new HookTraceError("HOOK_CANCEL_ORDER", `cancelled scope ${item.scope} still has a hook.end`)
    }
  }
  return cancelled
}

function checkPhases(trace: HookTrace): void {
  const hookStarts = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "hook.start" }> => event.kind === "hook.start",
  )
  const configStarts = hookStarts.filter((event) => event.hook === "config")
  if (configStarts.length > 0) {
    const bootstrap = configStarts.map((event) => findEnclosingOperation(trace.events, event.seq))
    if (bootstrap.some((op) => op?.op !== "bootstrap")) {
      throw new HookTraceError("CONFIG_PHASE_ORDER", "config hook must run inside the bootstrap operation")
    }
  }

  const loaderStarts = hookStarts.filter((event) => event.hook === "auth.loader")
  if (loaderStarts.length > 0) {
    const providerInit = loaderStarts.map((event) => findEnclosingOperation(trace.events, event.seq))
    if (providerInit.some((op) => op?.op !== "provider.init")) {
      throw new HookTraceError("AUTH_LOADER_ORDER", "auth.loader must run inside provider.init")
    }
    const firstRequest = trace.events.find(
      (event) => event.kind === "operation.start" && event.op === "llm.request",
    )
    if (firstRequest && loaderStarts.some((event) => event.seq > firstRequest.seq)) {
      throw new HookTraceError("AUTH_LOADER_ORDER", "auth.loader must run before the first llm.request")
    }
  }

  const definitionStarts = hookStarts.filter((event) => event.hook === "tool.definition")
  if (definitionStarts.some((event) => findEnclosingOperation(trace.events, event.seq)?.op !== "tool.list")) {
    throw new HookTraceError("HOOK_PHASE_ORDER", "tool.definition must run inside tool.list")
  }

  for (const scope of new Set(hookStarts.map((event) => event.scope))) {
    if (!scope.startsWith("params:") && !scope.startsWith("headers:")) continue
    const opID = scope.slice(scope.indexOf(":") + 1)
    const params = hookStarts.find((event) => event.hook === "chat.params" && event.scope === scope)
    const headers = hookStarts.find((event) => event.hook === "chat.headers" && event.scope === `headers:${opID}`)
    if (params && headers && params.seq > headers.seq) {
      throw new HookTraceError("HOOK_PHASE_ORDER", `chat.params for ${opID} must run before chat.headers`)
    }
  }

  for (const before of hookStarts.filter((event) => event.hook === "tool.execute.before")) {
    if (!before.scope.startsWith("before:")) {
      throw new HookTraceError("HOOK_PHASE_ORDER", `tool.execute.before scope must be before:<call_id>, got ${before.scope}`)
    }
    const callID = before.scope.slice("before:".length)
    const after = hookStarts.find((event) => event.hook === "tool.execute.after" && event.scope === `after:${callID}`)
    if (!after) continue
    const beforeEnd = trace.events.find(
      (event): event is Extract<TraceEvent, { kind: "hook.end" }> =>
        event.kind === "hook.end" &&
        event.hook === "tool.execute.before" &&
        event.scope === before.scope &&
        event.plugin_id === before.plugin_id,
    )
    if (!beforeEnd || beforeEnd.seq > after.seq) {
      throw new HookTraceError("HOOK_PHASE_ORDER", `tool.execute.after for ${callID} must run after tool.execute.before`)
    }
  }
}

function checkReentrancy(trace: HookTrace): void {
  for (const call of trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "sdk.call" }> => event.kind === "sdk.call",
  )) {
    if (call.hook === "auth.refresh") {
      const refresh = trace.events.find(
        (event) =>
          event.kind === "auth.refresh" && event.scope === call.scope && event.seq < call.seq,
      )
      if (!refresh) {
        throw new HookTraceError("HOOK_REENTRANCY_ORDER", `sdk.call ${call.method} has no preceding auth.refresh`)
      }
      continue
    }
    const start = trace.events.find(
      (event) =>
        event.kind === "hook.start" &&
        event.hook === call.hook &&
        event.scope === call.scope &&
        event.plugin_id === call.plugin_id &&
        event.seq < call.seq,
    )
    if (!start) {
      throw new HookTraceError(
        "HOOK_REENTRANCY_ORDER",
        `sdk.call ${call.method} is not inside hook ${call.hook}/${call.scope}/${call.plugin_id}`,
      )
    }
    const end = trace.events.find(
      (event) =>
        event.kind === "hook.end" &&
        event.hook === call.hook &&
        event.scope === call.scope &&
        event.plugin_id === call.plugin_id &&
        event.seq > call.seq,
    )
    if (!end) {
      throw new HookTraceError(
        "HOOK_REENTRANCY_ORDER",
        `sdk.call ${call.method} happened after hook ${call.hook}/${call.scope}/${call.plugin_id} returned`,
      )
    }
  }
}

function checkOrder(trace: HookTrace, expected: Record<string, string[]>): Record<string, string[]> {
  const actual: Record<string, string[]> = {}
  for (const event of trace.events) {
    if (event.kind !== "hook.start") continue
    const key = `${event.hook}|${event.scope}`
    const list = actual[key] ?? []
    if (list.includes(event.plugin_id)) {
      throw new HookTraceError("HOOK_DUPLICATE", `${key} invokes ${event.plugin_id} more than once`)
    }
    list.push(event.plugin_id)
    actual[key] = list
  }
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key]
    if (!got) throw new HookTraceError("HOOK_MISSING", `${key} has no hook.start events`)
    if (got.length !== want.length) {
      throw new HookTraceError(
        "HOOK_MISSING",
        `${key} expected ${want.length} plugins, got ${got.length}`,
        { expected: want, actual: got },
      )
    }
    for (const [index, plugin] of want.entries()) {
      if (got[index] !== plugin) {
        throw new HookTraceError("HOOK_ORDER_MISMATCH", `${key} expected ${plugin} at index ${index}, got ${got[index]}`, {
          expected: want,
          actual: got,
        })
      }
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) throw new HookTraceError("HOOK_UNEXPECTED", `${key} is not covered by the expectation`)
  }
  return actual
}

function checkMutationChain(trace: HookTrace, expected: Record<string, Json>): Record<string, Json> {
  const state = new Map<string, Json>()
  const snapshots: Record<string, Json> = {}
  for (const event of trace.events) {
    if (event.kind === "hook.start") {
      const current = state.get(event.scope)
      if (current !== undefined && !deepEqualJson(current, event.output)) {
        throw new HookTraceError(
          "HOOK_MUTATION_CHAIN",
          `hook ${event.hook} on ${event.scope} saw an output snapshot that does not match the shared object`,
          { expected: current, actual: event.output },
        )
      }
      state.set(event.scope, cloneJson(event.output))
      continue
    }
    if (event.kind === "hook.mutate") {
      const current = state.get(event.scope)
      if (current === undefined) {
        throw new HookTraceError("HOOK_MUTATION_CHAIN", `mutation on ${event.scope} has no hook.start`)
      }
      const actual = getPath(current, event.path)
      const matches = event.before === null ? actual === undefined || actual === null : deepEqualJson(actual, event.before)
      if (!matches) {
        throw new HookTraceError(
          "HOOK_MUTATION_CHAIN",
          `mutation ${event.path} on ${event.scope} expected before=${JSON.stringify(event.before)}, got ${JSON.stringify(actual)}`,
        )
      }
      setPath(current, event.path, event.after)
      continue
    }
    if (event.kind === "snapshot") {
      const current = state.get(event.scope)
      if (current === undefined) {
        throw new HookTraceError("HOOK_SNAPSHOT_MISSING", `snapshot ${event.name} on ${event.scope} has no state`)
      }
      if (!deepEqualJson(current, event.value)) {
        throw new HookTraceError(
          "HOOK_SNAPSHOT_MISMATCH",
          `snapshot ${event.name} on ${event.scope} does not match the replayed mutations`,
          { expected: event.value, actual: current },
        )
      }
      snapshots[`${event.scope}#${event.name}`] = cloneJson(event.value)
    }
  }
  for (const [key, want] of Object.entries(expected)) {
    if (!(key in snapshots)) throw new HookTraceError("HOOK_SNAPSHOT_MISSING", `expected snapshot ${key} is absent`)
    if (!deepEqualJson(snapshots[key], want)) {
      throw new HookTraceError("HOOK_SNAPSHOT_MISMATCH", `snapshot ${key} differs from the expectation`)
    }
  }
  return snapshots
}

function checkAuth(
  trace: HookTrace,
  expected: HookTraceExpectation["auth"],
): HookTraceReport["auth"] {
  const loaderStarts = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "hook.start" }> =>
      event.kind === "hook.start" && event.hook === "auth.loader" && event.scope === expected.loader_scope,
  )
  if (loaderStarts.length !== 1) {
    throw new HookTraceError(
      "AUTH_LOADER_ORDER",
      `expected exactly one auth.loader on ${expected.loader_scope}, got ${loaderStarts.length}`,
    )
  }
  const refreshes = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: "auth.refresh" }> => event.kind === "auth.refresh",
  )
  if (refreshes.length === 0) throw new HookTraceError("AUTH_REFRESH_POLICY", "trace has no auth.refresh event")
  for (const refresh of refreshes) {
    if (refresh.provider_id !== expected.provider_id) {
      throw new HookTraceError("AUTH_REFRESH_POLICY", `refresh provider ${refresh.provider_id} is unexpected`)
    }
    if (!refresh.single_flight) {
      throw new HookTraceError("AUTH_REFRESH_POLICY", "auth.refresh must be single-flight")
    }
    if (refresh.persist !== "auth.set") {
      throw new HookTraceError("AUTH_REFRESH_POLICY", "auth.refresh must persist through auth.set")
    }
    if (refresh.concurrent_requests < 2) {
      throw new HookTraceError("AUTH_REFRESH_POLICY", "single-flight evidence needs at least two concurrent requests")
    }
    if (refresh.expires_delta_s <= 0) {
      throw new HookTraceError("AUTH_REFRESH_POLICY", "refreshed token must have a positive lifetime")
    }
    const op = findEnclosingOperation(trace.events, refresh.seq)
    if (!op || op.op !== "llm.request") {
      throw new HookTraceError("AUTH_REFRESH_ORDER", "auth.refresh must happen inside an llm.request")
    }
    const headers = trace.events.find(
      (event) =>
        event.kind === "hook.start" &&
        event.hook === "chat.headers" &&
        event.scope === `headers:${op.op_id}`,
    )
    if (!headers || headers.seq > refresh.seq) {
      throw new HookTraceError("AUTH_REFRESH_ORDER", "auth.refresh must run after chat.headers for the same request")
    }
  }
  const setCalls = trace.events.filter(
    (event) => event.kind === "sdk.call" && event.hook === "auth.refresh" && event.method === "auth.set",
  )
  if (setCalls.length === 0) {
    throw new HookTraceError("AUTH_REFRESH_ORDER", "auth.refresh must record its auth.set round-trip")
  }
  return { loader_calls: loaderStarts.length, refresh_calls: refreshes.length, single_flight: true }
}

function checkFailurePolicyCoverage(rows: FailurePolicyRow[]): FailurePolicyRow[] {
  if (rows.length !== POLICY_HOOKS.length) {
    throw new HookTraceError(
      "HOOK_FAILURE_POLICY",
      `failure policy has ${rows.length} rows, expected ${POLICY_HOOKS.length}`,
    )
  }
  const expected: Record<PolicyHook, string> = {
    config: "HOOK_FAILURE_ISOLATED_CONFIG",
    "tool.definition": "HOOK_FAILURE_FATAL_TOOL_LIST",
    "chat.params": "HOOK_FAILURE_FATAL_LLM",
    "chat.headers": "HOOK_FAILURE_FATAL_LLM",
    "tool.execute.before": "HOOK_FAILURE_SKIP_TOOL",
    "tool.execute.after": "HOOK_FAILURE_DISCARD_RESULT",
    "auth.loader": "HOOK_FAILURE_PROVIDER_INIT",
    "auth.refresh": "HOOK_FAILURE_AUTH_REFRESH",
  }
  const seen = new Set<PolicyHook>()
  for (const row of rows) {
    if (!(POLICY_HOOKS as readonly string[]).includes(row.hook)) {
      throw new HookTraceError("HOOK_FAILURE_POLICY", `unknown policy hook ${String(row.hook)}`)
    }
    if (seen.has(row.hook)) throw new HookTraceError("HOOK_FAILURE_POLICY", `duplicate policy hook ${row.hook}`)
    seen.add(row.hook)
    if (row.host_effect !== expected[row.hook]) {
      throw new HookTraceError(
        "HOOK_FAILURE_POLICY",
        `policy ${row.hook} expected ${expected[row.hook]}, got ${row.host_effect}`,
      )
    }
    if (!row.failing_plugin_effect || !row.operation_effect || !row.stable_code) {
      throw new HookTraceError("HOOK_FAILURE_POLICY", `policy ${row.hook} has an empty field`)
    }
  }
  for (const hook of POLICY_HOOKS) {
    if (!seen.has(hook)) throw new HookTraceError("HOOK_FAILURE_POLICY", `policy hook ${hook} is missing`)
  }
  return rows
}

export function verifyHookTrace(trace: HookTrace, expected: HookTraceExpectation): HookTraceReport {
  const plugins = checkRegistration(trace)
  const cancelled = checkCancellation(trace, expected.cancelled)
  checkPhases(trace)
  checkReentrancy(trace)
  const order = checkOrder(trace, expected.order)
  const snapshots = checkMutationChain(trace, expected.snapshots)
  const auth = checkAuth(trace, expected.auth)
  const failurePolicy = checkFailurePolicyCoverage(expected.failure_policy)
  const reencoded = encodeHookTrace(trace.header, trace.events.map(stripSeq))
  if (reencoded !== trace.text) {
    throw new HookTraceError("TRACE_ENCODING_UNSTABLE", "parse -> encode does not reproduce the source bytes")
  }
  const counts = new Map<HookName, number>()
  for (const event of trace.events) {
    if (event.kind !== "hook.start") continue
    counts.set(event.hook, (counts.get(event.hook) ?? 0) + 1)
  }
  const hooks = HOOK_NAMES.map((hook) => ({
    hook,
    hook_class: HOOK_CLASS_OF[hook],
    count: counts.get(hook) ?? 0,
  }))
  return { plugins, order, snapshots, hooks, auth, cancelled, failure_policy: failurePolicy }
}

export function traceByteLength(text: string): number {
  return utf8ByteLength(text)
}