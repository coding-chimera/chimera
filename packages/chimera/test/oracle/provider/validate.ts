// WP-08 provider fixture validator.
//
// Pure functions plus a directory suite runner. No network, no provider SDK,
// no Rust build: every fixture is synthetic and every assertion is structural.

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ACCOUNT_PLACEHOLDER,
  ALLOWED_MODELS,
  CONTRACT_REV,
  PROFILE_EXPECTATIONS,
  PROVIDER_FIXTURE_FORMAT,
  PROVIDER_FIXTURE_VERSION,
  PROVIDER_PROFILES,
  PLACEHOLDER,
  PLACEHOLDER_BEARER,
  fixtureDigest,
  isCanonicalEventType,
  isProfile,
  type AuthFixture,
  type AuthKind,
  type CanonicalEvent,
  type ExpectedResult,
  type ExpectedToolCall,
  type ExpectedToolResult,
  type ExpectedTurn,
  type FixtureSummary,
  type GenaiVerdict,
  type ProviderCapabilities,
  type ProviderFixture,
  type ProviderProfileID,
  type ProviderTurn,
  type StreamFixture,
  type StreamFrame,
  type SuiteResult,
  type Terminal,
  type Transport,
  type ValidationIssue,
  type ValidationResult,
  type WireRequest,
} from "./format"

const FIXTURE_DIR = join(import.meta.dir, "fixtures")
const AUTH_KINDS: ReadonlyArray<AuthKind> = ["api-key", "oauth", "none"]
const TRANSPORTS: ReadonlyArray<Transport> = ["sse", "websocket-json", "json"]
const TERMINALS: ReadonlyArray<Terminal> = ["completed", "incomplete", "failed", "error"]
const GENAI_VERDICTS: ReadonlyArray<GenaiVerdict> = ["takeover", "compat", "uncovered"]
const SECRET_KEYS = new Set(["authorization", "api_key", "apikey", "access_token", "refresh_token", "secret", "password", "credential"])

const FORBIDDEN_STRINGS: ReadonlyArray<{ readonly code: string; readonly pattern: RegExp; readonly message: string }> = [
  { code: "PROVIDER_ENDPOINT", pattern: /\b(?:https?|wss?|ftp|file):\/\//i, message: "real URL scheme is forbidden" },
  { code: "PROVIDER_ENDPOINT", pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/, message: "IPv4 address is forbidden" },
  { code: "PROVIDER_ENDPOINT", pattern: /\blocalhost\b/i, message: "localhost is forbidden" },
  {
    code: "PROVIDER_ENDPOINT",
    pattern: /\b(?:intranet|internal|corp|home\.arpa)\b/i,
    message: "internal domain token is forbidden",
  },
  { code: "PROVIDER_ENDPOINT", pattern: /\.local\b/i, message: ".local domain is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /(?:^|\s)\/(?:Users|home)\/[^/\s]+/, message: "home absolute path is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /[A-Za-z]:\\Users\\/i, message: "Windows home path is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /\bsk-[A-Za-z0-9_-]{8,}/, message: "API key material is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/, message: "GitHub token material is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/, message: "Slack token material is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /-----BEGIN [A-Z ]+-----/, message: "PEM block is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /\bAKIA[0-9A-Z]{16}\b/, message: "AWS key material is forbidden" },
  { code: "PROVIDER_SECRET", pattern: /\bBearer\s+(?!<REDACTED)/, message: "unredacted bearer token is forbidden" },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function add(issues: ValidationIssue[], code: string, path: string, message: string) {
  issues.push({ code, path, message })
}

function readString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    add(issues, "PROVIDER_SHAPE", path, "expected non-empty string")
    return undefined
  }
  return value
}

function readNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    add(issues, "PROVIDER_SHAPE", path, "expected integer")
    return undefined
  }
  return value
}

function readBoolean(value: unknown, path: string, issues: ValidationIssue[]): boolean | undefined {
  if (typeof value !== "boolean") {
    add(issues, "PROVIDER_SHAPE", path, "expected boolean")
    return undefined
  }
  return value
}

function readRecord(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    add(issues, "PROVIDER_SHAPE", path, "expected object")
    return undefined
  }
  return value
}

function readArray(value: unknown, path: string, issues: ValidationIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    add(issues, "PROVIDER_SHAPE", path, "expected array")
    return undefined
  }
  return value
}

function readStringArray(value: unknown, path: string, issues: ValidationIssue[]): string[] {
  const raw = readArray(value, path, issues)
  if (!raw) return []
  const strings: string[] = []
  raw.forEach((item, index) => {
    const parsed = readString(item, `${path}[${index}]`, issues)
    if (parsed) strings.push(parsed)
  })
  return strings
}

function readEnum<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  path: string,
  issues: ValidationIssue[],
): T | undefined {
  if (typeof value !== "string" || !(allowed as ReadonlyArray<string>).includes(value)) {
    add(issues, "PROVIDER_ENUM", path, `expected one of ${allowed.join(", ")}`)
    return undefined
  }
  return value as T
}

function validateRequest(value: unknown, path: string, issues: ValidationIssue[]): WireRequest | undefined {
  const record = readRecord(value, path, issues)
  if (!record) return undefined
  if (record.method !== "POST") add(issues, "PROVIDER_SHAPE", `${path}.method`, "expected POST")
  const endpoint = readString(record.endpoint, `${path}.endpoint`, issues)
  if (endpoint && !endpoint.startsWith("synthetic://")) {
    add(issues, "PROVIDER_ENDPOINT", `${path}.endpoint`, "endpoint must use synthetic://")
  }
  const headersRecord = readRecord(record.headers, `${path}.headers`, issues)
  const headers: Record<string, string> = {}
  if (headersRecord) {
    for (const [name, headerValue] of Object.entries(headersRecord)) {
      const parsed = readString(headerValue, `${path}.headers.${name}`, issues)
      if (parsed) headers[name.toLowerCase()] = parsed
    }
  }
  const body = readRecord(record.body, `${path}.body`, issues)
  if (body?.model === undefined) {
    add(issues, "PROVIDER_MODEL", `${path}.body.model`, "model is required")
  } else if (typeof body.model !== "string" || !(ALLOWED_MODELS as ReadonlyArray<string>).includes(body.model)) {
    add(issues, "PROVIDER_MODEL", `${path}.body.model`, `model must be one of ${ALLOWED_MODELS.join(", ")}`)
  }
  return {
    method: "POST",
    endpoint: endpoint ?? "",
    headers,
    body: body ?? {},
  }
}

function validateAuth(value: unknown, path: string, issues: ValidationIssue[]): AuthFixture | undefined {
  const record = readRecord(value, path, issues)
  if (!record) return undefined
  const kind = readEnum(record.kind, AUTH_KINDS, `${path}.kind`, issues)
  const placement = readEnum(record.placement, ["header", "query", "none"] as const, `${path}.placement`, issues)
  const refreshRecord = readRecord(record.refresh, `${path}.refresh`, issues)
  const strategy = refreshRecord
    ? readEnum(refreshRecord.strategy, ["none", "before-expiry", "on-401-once"] as const, `${path}.refresh.strategy`, issues)
    : undefined
  const dedupeKey = refreshRecord
    ? readEnum(refreshRecord.dedupe_key, ["none", "credential", "credential+session"] as const, `${path}.refresh.dedupe_key`, issues)
    : undefined
  if (refreshRecord && refreshRecord.owner !== "chimera") {
    add(issues, "PROVIDER_AUTH", `${path}.refresh.owner`, "refresh owner must be chimera")
  }
  const name = record.name === undefined ? undefined : readString(record.name, `${path}.name`, issues)
  const authValue = record.value === undefined ? undefined : readString(record.value, `${path}.value`, issues)
  const accountRecord = record.account_header === undefined ? undefined : readRecord(record.account_header, `${path}.account_header`, issues)
  const accountHeader = accountRecord
    ? {
        name: readString(accountRecord.name, `${path}.account_header.name`, issues) ?? "",
        value: readString(accountRecord.value, `${path}.account_header.value`, issues) ?? "",
      }
    : undefined
  if (!kind || !placement || !strategy || !dedupeKey) return undefined
  return {
    kind,
    placement,
    ...(name ? { name } : {}),
    ...(authValue ? { value: authValue } : {}),
    ...(accountHeader ? { account_header: accountHeader } : {}),
    refresh: { owner: "chimera", strategy, dedupe_key: dedupeKey },
  }
}

function validateAuthPlacement(
  auth: AuthFixture,
  request: WireRequest,
  path: string,
  issues: ValidationIssue[],
) {
  if (auth.placement === "header") {
    if (!auth.name || !auth.value) {
      add(issues, "PROVIDER_AUTH", path, "header auth requires name and value")
      return
    }
    if (request.headers[auth.name.toLowerCase()] !== auth.value) {
      add(issues, "PROVIDER_AUTH", path, "request header does not match the auth fixture")
    }
    if (!PLACEHOLDER.test(auth.value) && !PLACEHOLDER_BEARER.test(auth.value)) {
      add(issues, "PROVIDER_SECRET", `${path}.value`, "auth value must be a redacted placeholder")
    }
  }
  if (auth.kind === "oauth") {
    if (!auth.account_header) {
      add(issues, "PROVIDER_AUTH", path, "oauth requires an account_header placeholder")
    } else {
      if (auth.account_header.value !== ACCOUNT_PLACEHOLDER) {
        add(issues, "PROVIDER_AUTH", `${path}.account_header.value`, `expected ${ACCOUNT_PLACEHOLDER}`)
      }
      if (request.headers[auth.account_header.name.toLowerCase()] !== auth.account_header.value) {
        add(issues, "PROVIDER_AUTH", path, "request account header does not match the auth fixture")
      }
    }
    if (auth.refresh.strategy === "none") {
      add(issues, "PROVIDER_AUTH", `${path}.refresh.strategy`, "oauth must declare a refresh strategy")
    }
  }
  if (auth.kind === "api-key" && auth.refresh.strategy !== "none") {
    add(issues, "PROVIDER_AUTH", `${path}.refresh.strategy`, "api-key must not declare oauth refresh")
  }
}

function responsesTerminal(data: Record<string, unknown>): Terminal | undefined {
  if (data.type === "response.completed") return "completed"
  if (data.type === "response.incomplete") return "incomplete"
  if (data.type === "response.failed") return "failed"
  if (data.type === "error") return "error"
  return undefined
}

function terminalForFrame(transport: Transport, data: Record<string, unknown>): Terminal | undefined {
  if (transport === "json") return "completed"
  if (transport === "websocket-json") return responsesTerminal(data)
  const responses = responsesTerminal(data)
  if (responses) return responses
  const choices = data.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0]
    if (isRecord(first) && first.finish_reason !== null && first.finish_reason !== undefined) return "completed"
  }
  return undefined
}

function isUsageOnlyFrame(data: Record<string, unknown>): boolean {
  return Array.isArray(data.choices) && data.choices.length === 0 && isRecord(data.usage)
}

function validateStream(value: unknown, path: string, issues: ValidationIssue[]): StreamFixture | undefined {
  const record = readRecord(value, path, issues)
  if (!record) return undefined
  const transport = readEnum(record.transport, TRANSPORTS, `${path}.transport`, issues)
  const terminal = readEnum(record.terminal, TERMINALS, `${path}.terminal`, issues)
  const rawFrames = readArray(record.frames, `${path}.frames`, issues)
  const frames: StreamFrame[] = []
  if (rawFrames) {
    rawFrames.forEach((raw, index) => {
      const framePath = `${path}.frames[${index}]`
      const frame = readRecord(raw, framePath, issues)
      if (!frame) return
      const seq = readNumber(frame.seq, `${framePath}.seq`, issues)
      if (seq !== index + 1) add(issues, "PROVIDER_STREAM_SEQ", `${framePath}.seq`, `expected ${index + 1}`)
      const data = readRecord(frame.data, `${framePath}.data`, issues)
      if (!data) return
      const event = frame.event === undefined ? undefined : readString(frame.event, `${framePath}.event`, issues)
      frames.push({ seq: seq ?? index + 1, ...(event ? { event } : {}), data })
    })
  }
  if (record.done_marker !== undefined && record.done_marker !== "[DONE]") {
    add(issues, "PROVIDER_STREAM_SEQ", `${path}.done_marker`, 'done_marker must be "[DONE]" when present')
  }
  if (!transport || !terminal || frames.length === 0) return undefined

  const terminalIndex = frames.findIndex((frame) => terminalForFrame(transport, frame.data) !== undefined)
  if (terminalIndex < 0) {
    add(issues, "PROVIDER_TERMINAL", `${path}.frames`, "no terminal frame")
  } else {
    const actual = terminalForFrame(transport, frames[terminalIndex].data)
    if (actual !== terminal) {
      add(issues, "PROVIDER_TERMINAL", `${path}.terminal`, `frame terminal ${actual} does not match ${terminal}`)
    }
    for (let index = terminalIndex + 1; index < frames.length; index++) {
      if (!isUsageOnlyFrame(frames[index].data)) {
        add(issues, "PROVIDER_TERMINAL", `${path}.frames[${index}]`, "non-usage frame after terminal")
      }
    }
  }
  return { transport, frames, ...(record.done_marker === "[DONE]" ? { done_marker: "[DONE]" as const } : {}), terminal }
}

function idOf(event: CanonicalEvent, path: string, issues: ValidationIssue[]): string | undefined {
  const id = event.id
  if (typeof id !== "string" || id.length === 0) {
    add(issues, "PROVIDER_EVENT_ORDER", path, "event requires a non-empty id")
    return undefined
  }
  return id
}

function nameOf(event: CanonicalEvent, path: string, issues: ValidationIssue[]): string | undefined {
  const name = event.name
  if (typeof name !== "string" || name.length === 0) {
    add(issues, "PROVIDER_EVENT_ORDER", path, "event requires a non-empty name")
    return undefined
  }
  return name
}

function validateEventOrder(events: ReadonlyArray<CanonicalEvent>, path: string, issues: ValidationIssue[]) {
  const openText = new Set<string>()
  const openReasoning = new Set<string>()
  const openToolInput = new Set<string>()
  const inputEnded = new Set<string>()
  const calls = new Map<string, { readonly providerExecuted: boolean; hasResult: boolean }>()
  let stepFinishSeen = false
  let terminalSeen = false

  events.forEach((event, index) => {
    const at = `${path}.events[${index}]`
    if (terminalSeen) add(issues, "PROVIDER_EVENT_ORDER", at, "event after terminal")
    switch (event.type) {
      case "text-start": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (openText.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `duplicate text-start ${id}`)
        openText.add(id)
        return
      }
      case "text-delta": {
        const id = idOf(event, at, issues)
        if (id && !openText.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `text-delta without text-start ${id}`)
        return
      }
      case "text-end": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (!openText.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `text-end without text-start ${id}`)
        openText.delete(id)
        return
      }
      case "reasoning-start": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (openReasoning.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `duplicate reasoning-start ${id}`)
        openReasoning.add(id)
        return
      }
      case "reasoning-delta": {
        const id = idOf(event, at, issues)
        if (id && !openReasoning.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `reasoning-delta without reasoning-start ${id}`)
        return
      }
      case "reasoning-end": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (!openReasoning.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `reasoning-end without reasoning-start ${id}`)
        openReasoning.delete(id)
        return
      }
      case "tool-input-start": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (!nameOf(event, at, issues)) return
        if (openToolInput.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `duplicate tool-input-start ${id}`)
        openToolInput.add(id)
        return
      }
      case "tool-input-delta": {
        const id = idOf(event, at, issues)
        if (id && !openToolInput.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `tool-input-delta without tool-input-start ${id}`)
        return
      }
      case "tool-input-end": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (!openToolInput.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `tool-input-end without tool-input-start ${id}`)
        openToolInput.delete(id)
        inputEnded.add(id)
        return
      }
      case "tool-call": {
        const id = idOf(event, at, issues)
        if (!id) return
        if (!nameOf(event, at, issues)) return
        if (calls.has(id)) add(issues, "PROVIDER_EVENT_ORDER", at, `duplicate tool-call ${id}`)
        const providerExecuted = event.providerExecuted === true
        if (!providerExecuted && !inputEnded.has(id)) {
          add(issues, "PROVIDER_EVENT_ORDER", at, `host tool-call ${id} without tool-input-end`)
        }
        calls.set(id, { providerExecuted, hasResult: false })
        return
      }
      case "tool-result":
      case "tool-error": {
        const id = idOf(event, at, issues)
        if (!id) return
        const call = calls.get(id)
        if (!call) {
          add(issues, "PROVIDER_EVENT_ORDER", at, `${event.type} without tool-call ${id}`)
          return
        }
        if (call.hasResult) add(issues, "PROVIDER_EVENT_ORDER", at, `duplicate ${event.type} ${id}`)
        call.hasResult = true
        return
      }
      case "step-finish":
        if (stepFinishSeen) add(issues, "PROVIDER_EVENT_ORDER", at, "duplicate step-finish")
        stepFinishSeen = true
        if (openText.size || openReasoning.size || openToolInput.size) {
          add(issues, "PROVIDER_EVENT_ORDER", at, "step-finish before content blocks closed")
        }
        return
      case "finish":
        if (terminalSeen) add(issues, "PROVIDER_EVENT_ORDER", at, "duplicate terminal event")
        if (!stepFinishSeen) add(issues, "PROVIDER_EVENT_ORDER", at, "finish without step-finish")
        if (openText.size || openReasoning.size || openToolInput.size) {
          add(issues, "PROVIDER_EVENT_ORDER", at, "finish before content blocks closed")
        }
        for (const [id, call] of calls) {
          if (call.providerExecuted && !call.hasResult) {
            add(issues, "PROVIDER_EVENT_ORDER", at, `provider-executed call ${id} has no result`)
          }
        }
        terminalSeen = true
        return
      case "provider-error":
        if (terminalSeen) add(issues, "PROVIDER_EVENT_ORDER", at, "duplicate terminal event")
        terminalSeen = true
        return
    }
  })

  if (!terminalSeen) add(issues, "PROVIDER_TERMINAL", path, "expected events must end with finish or provider-error")
  if (openText.size) add(issues, "PROVIDER_EVENT_ORDER", path, `unclosed text block(s): ${[...openText].join(", ")}`)
  if (openReasoning.size) add(issues, "PROVIDER_EVENT_ORDER", path, `unclosed reasoning block(s): ${[...openReasoning].join(", ")}`)
  if (openToolInput.size) add(issues, "PROVIDER_EVENT_ORDER", path, `unclosed tool input(s): ${[...openToolInput].join(", ")}`)
}

function validateResult(value: unknown, path: string, issues: ValidationIssue[]): ExpectedResult | undefined {
  const record = readRecord(value, path, issues)
  if (!record) return undefined
  const output = record.output === undefined ? undefined : readArray(record.output, `${path}.output`, issues)
  const usageRecord = record.usage === undefined ? undefined : readRecord(record.usage, `${path}.usage`, issues)
  const usage: Record<string, number> = {}
  if (usageRecord) {
    for (const [key, item] of Object.entries(usageRecord)) {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        add(issues, "PROVIDER_SHAPE", `${path}.usage.${key}`, "expected finite number")
        continue
      }
      usage[key] = item
    }
  }
  return {
    ...(output ? { output } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  }
}

function validateExpected(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  stream: StreamFixture | undefined,
): ExpectedTurn | undefined {
  const record = readRecord(value, path, issues)
  if (!record) return undefined
  const rawEvents = readArray(record.events, `${path}.events`, issues)
  const events: CanonicalEvent[] = []
  if (rawEvents) {
    rawEvents.forEach((raw, index) => {
      const at = `${path}.events[${index}]`
      const event = readRecord(raw, at, issues)
      if (!event) return
      const seq = readNumber(event.seq, `${at}.seq`, issues)
      if (seq !== index + 1) add(issues, "PROVIDER_EVENT_SEQ", `${at}.seq`, `expected ${index + 1}`)
      if (!isCanonicalEventType(event.type)) {
        add(issues, "PROVIDER_EVENT_TYPE", `${at}.type`, "unknown canonical event type")
        return
      }
      events.push({ ...event, seq: seq ?? index + 1, type: event.type })
    })
  }
  if (events.length > 0) validateEventOrder(events, path, issues)

  const rawCalls = record.tool_calls === undefined ? undefined : readArray(record.tool_calls, `${path}.tool_calls`, issues)
  const toolCalls: ExpectedToolCall[] = []
  if (rawCalls) {
    rawCalls.forEach((raw, index) => {
      const at = `${path}.tool_calls[${index}]`
      const call = readRecord(raw, at, issues)
      if (!call) return
      const id = readString(call.id, `${at}.id`, issues)
      const name = readString(call.name, `${at}.name`, issues)
      const executedBy = readEnum(call.executed_by, ["host", "provider"] as const, `${at}.executed_by`, issues)
      if (!id || !name || !executedBy) return
      toolCalls.push({ id, name, input: call.input, executed_by: executedBy })
    })
  }

  const rawResults = record.tool_results === undefined ? undefined : readArray(record.tool_results, `${path}.tool_results`, issues)
  const toolResults: ExpectedToolResult[] = []
  if (rawResults) {
    rawResults.forEach((raw, index) => {
      const at = `${path}.tool_results[${index}]`
      const result = readRecord(raw, at, issues)
      if (!result) return
      const id = readString(result.id, `${at}.id`, issues)
      const status = readEnum(result.status, ["ok", "error"] as const, `${at}.status`, issues)
      if (!id || !status) return
      toolResults.push({ id, status })
    })
  }

  const result = record.result === undefined ? undefined : validateResult(record.result, `${path}.result`, issues)
  const terminal = readEnum(record.terminal, TERMINALS, `${path}.terminal`, issues)
  if (terminal && stream && terminal !== stream.terminal) {
    add(issues, "PROVIDER_TERMINAL", `${path}.terminal`, "must match stream.terminal")
  }
  if (events.length === 0 && !result) {
    add(issues, "PROVIDER_EMPTY", `${path}`, "expected events or a non-stream result")
  }

  for (const call of toolCalls) {
    const callEvent = events.find((event) => event.type === "tool-call" && event.id === call.id)
    if (!callEvent) {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_calls`, `missing tool-call event for ${call.id}`)
      continue
    }
    if (callEvent.name !== call.name) {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_calls`, `name mismatch for ${call.id}`)
    }
    const eventInput = callEvent.input === undefined ? null : callEvent.input
    const callInput = call.input === undefined ? null : call.input
    if (fixtureDigest(eventInput) !== fixtureDigest(callInput)) {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_calls`, `input mismatch for ${call.id}`)
    }
    const providerExecuted = callEvent.providerExecuted === true
    if (providerExecuted !== (call.executed_by === "provider")) {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_calls`, `executor mismatch for ${call.id}`)
    }
  }
  for (const resultItem of toolResults) {
    const resultEvent = events.find(
      (event) => (event.type === "tool-result" || event.type === "tool-error") && event.id === resultItem.id,
    )
    if (!resultEvent) {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_results`, `missing result event for ${resultItem.id}`)
      continue
    }
    if (resultItem.status === "ok" && resultEvent.type !== "tool-result") {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_results`, `expected tool-result for ${resultItem.id}`)
    }
    if (resultItem.status === "error" && resultEvent.type !== "tool-error") {
      add(issues, "PROVIDER_EVENT_ORDER", `${path}.tool_results`, `expected tool-error for ${resultItem.id}`)
    }
  }

  return {
    events,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(toolResults.length ? { tool_results: toolResults } : {}),
    ...(result ? { result } : {}),
    terminal: terminal ?? "completed",
  }
}

function validateTurn(value: unknown, path: string, issues: ValidationIssue[], expectedTurn: number): ProviderTurn | undefined {
  const record = readRecord(value, path, issues)
  if (!record) return undefined
  const turn = readNumber(record.turn, `${path}.turn`, issues)
  if (turn !== expectedTurn) add(issues, "PROVIDER_SHAPE", `${path}.turn`, `expected ${expectedTurn}`)
  const request = validateRequest(record.request, `${path}.request`, issues)
  const auth = validateAuth(record.auth, `${path}.auth`, issues)
  const stream = validateStream(record.stream, `${path}.stream`, issues)
  const expected = validateExpected(record.expected, `${path}.expected`, issues, stream)
  if (!request || !auth || !stream || !expected) return undefined
  validateAuthPlacement(auth, request, `${path}.auth`, issues)
  return { turn: turn ?? expectedTurn, request, auth, stream, expected }
}

type RequestToolRefs = {
  readonly outputs: Set<string>
  readonly outputsWithoutCall: string[]
  readonly duplicateOutputs: string[]
}

function collectRequestToolRefs(body: Record<string, unknown>): RequestToolRefs {
  const calls = new Set<string>()
  const outputs = new Set<string>()
  const outputsWithoutCall: string[] = []
  const duplicateOutputs: string[] = []
  const visitOutput = (id: string) => {
    if (!calls.has(id)) outputsWithoutCall.push(id)
    if (outputs.has(id)) duplicateOutputs.push(id)
    outputs.add(id)
  }
  const visit = (item: Record<string, unknown>) => {
    if (item.type === "function_call" || item.type === "tool_search_call") {
      if (typeof item.call_id === "string") calls.add(item.call_id)
      return
    }
    if (item.type === "function_call_output" || item.type === "tool_search_output") {
      if (typeof item.call_id === "string") visitOutput(item.call_id)
      return
    }
    if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        if (isRecord(call) && typeof call.id === "string") calls.add(call.id)
      }
      return
    }
    if (item.role === "tool" && typeof item.tool_call_id === "string") visitOutput(item.tool_call_id)
  }
  for (const key of ["input", "messages"] as const) {
    const items = body[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (isRecord(item)) visit(item)
    }
  }
  return { outputs, outputsWithoutCall, duplicateOutputs }
}

function hostCallsOf(turn: ProviderTurn): Set<string> {
  const calls = new Set(
    (turn.expected.tool_calls ?? []).filter((call) => call.executed_by === "host").map((call) => call.id),
  )
  for (const event of turn.expected.events) {
    if (event.type === "tool-call" && event.providerExecuted !== true && typeof event.id === "string") calls.add(event.id)
  }
  return calls
}

function validateToolClosure(turns: ReadonlyArray<ProviderTurn>, issues: ValidationIssue[]) {
  const priorOutputs = new Set<string>()
  turns.forEach((turn, index) => {
    const refs = collectRequestToolRefs(turn.request.body)
    // Stateless requests must replay the assistant call item before its output
    // (ordering-contract.md §3.1). Incremental WS requests reference the prior
    // assistant item server-side via previous_response_id.
    if (typeof turn.request.body.previous_response_id !== "string") {
      for (const id of refs.outputsWithoutCall) {
        add(
          issues,
          "PROVIDER_TOOL_CLOSURE",
          `turns[${index}].request.body`,
          `tool output for ${id} has no preceding assistant call replay`,
        )
      }
    }
    for (const id of refs.duplicateOutputs) {
      add(issues, "PROVIDER_TOOL_CLOSURE", `turns[${index}].request.body`, `duplicate tool output for ${id}`)
    }
    // A replayed historical output is legal; only an output that first appears
    // in this turn must close a host call from the immediately previous turn.
    if (index > 0) {
      const previousCalls = hostCallsOf(turns[index - 1])
      for (const id of refs.outputs) {
        if (!priorOutputs.has(id) && !previousCalls.has(id)) {
          add(issues, "PROVIDER_TOOL_CLOSURE", `turns[${index}].request.body`, `orphan tool result for ${id}`)
        }
      }
    }
    for (const id of refs.outputs) priorOutputs.add(id)
    const hostCalls = hostCallsOf(turn)
    if (hostCalls.size === 0) return
    const next = turns[index + 1]
    if (!next) {
      add(issues, "PROVIDER_TOOL_CLOSURE", `turns[${index}]`, `host tool call(s) ${[...hostCalls].join(", ")} have no following turn`)
      return
    }
    const nextRefs = collectRequestToolRefs(next.request.body)
    for (const id of hostCalls) {
      if (!nextRefs.outputs.has(id)) {
        add(issues, "PROVIDER_TOOL_CLOSURE", `turns[${index + 1}].request.body`, `missing tool result for ${id}`)
      }
    }
  })
}

function allowedTransports(profile: ProviderProfileID): ReadonlyArray<Transport> {
  if (profile === "responses-websocket") return ["websocket-json"]
  if (profile === "remote-compaction") return ["sse", "json"]
  return ["sse"]
}

function validateCapabilities(
  value: unknown,
  profile: ProviderProfileID | undefined,
  issues: ValidationIssue[],
): ProviderCapabilities | undefined {
  const record = readRecord(value, "capabilities", issues)
  if (!record) return undefined
  const verdict = readEnum(record.genai_verdict, GENAI_VERDICTS, "capabilities.genai_verdict", issues)
  const transport = readEnum(record.transport, TRANSPORTS, "capabilities.transport", issues)
  const auth = readEnum(record.auth, AUTH_KINDS, "capabilities.auth", issues)
  const nativeToolSearch = readBoolean(record.native_tool_search, "capabilities.native_tool_search", issues)
  const remoteCompaction = readBoolean(record.remote_compaction, "capabilities.remote_compaction", issues)
  const hostedTools = readStringArray(record.hosted_tools_exercised, "capabilities.hosted_tools_exercised", issues)
  if (record.retry_owner !== "chimera") add(issues, "PROVIDER_CAPABILITY", "capabilities.retry_owner", "retry owner must be chimera")
  if (record.auth_refresh_owner !== "chimera") {
    add(issues, "PROVIDER_CAPABILITY", "capabilities.auth_refresh_owner", "auth refresh owner must be chimera")
  }
  if (!verdict || !transport || !auth || nativeToolSearch === undefined || remoteCompaction === undefined) return undefined
  if (profile) {
    const expectation = PROFILE_EXPECTATIONS[profile]
    if (verdict !== expectation.verdict) add(issues, "PROVIDER_CAPABILITY", "capabilities.genai_verdict", `expected ${expectation.verdict}`)
    if (transport !== expectation.transport) add(issues, "PROVIDER_CAPABILITY", "capabilities.transport", `expected ${expectation.transport}`)
    if (auth !== expectation.auth) add(issues, "PROVIDER_CAPABILITY", "capabilities.auth", `expected ${expectation.auth}`)
    if (nativeToolSearch !== expectation.nativeToolSearch) {
      add(issues, "PROVIDER_CAPABILITY", "capabilities.native_tool_search", `expected ${expectation.nativeToolSearch}`)
    }
    if (remoteCompaction !== expectation.remoteCompaction) {
      add(issues, "PROVIDER_CAPABILITY", "capabilities.remote_compaction", `expected ${expectation.remoteCompaction}`)
    }
  }
  return {
    genai_verdict: verdict,
    transport,
    auth,
    native_tool_search: nativeToolSearch,
    remote_compaction: remoteCompaction,
    hosted_tools_exercised: hostedTools,
    retry_owner: "chimera",
    auth_refresh_owner: "chimera",
  }
}

function validateProfileShape(
  profile: ProviderProfileID,
  capabilities: ProviderCapabilities,
  turns: ReadonlyArray<ProviderTurn>,
  issues: ValidationIssue[],
) {
  const expectation = PROFILE_EXPECTATIONS[profile]
  if (turns.length < expectation.minTurns) {
    add(issues, "PROVIDER_COVERAGE", "turns", `profile ${profile} requires at least ${expectation.minTurns} turns`)
  }
  const transports = allowedTransports(profile)
  for (const [index, turn] of turns.entries()) {
    if (!transports.includes(turn.stream.transport)) {
      add(issues, "PROVIDER_CAPABILITY", `turns[${index}].stream.transport`, `profile ${profile} does not allow ${turn.stream.transport}`)
    }
    if (turn.auth.kind !== expectation.auth) {
      add(issues, "PROVIDER_AUTH", `turns[${index}].auth.kind`, `profile ${profile} requires ${expectation.auth}`)
    }
  }
  if (expectation.nativeToolSearch) {
    const hasToolSearch = turns.some((turn) => {
      const tools = turn.request.body.tools
      return Array.isArray(tools) && tools.some((tool) => isRecord(tool) && tool.type === "tool_search")
    })
    if (!hasToolSearch) add(issues, "PROVIDER_CAPABILITY", "turns", "native tool_search profile requires a tool_search tool declaration")
  }
  if (expectation.remoteCompaction) {
    const hasTrigger = turns.some((turn) => {
      const input = turn.request.body.input
      return Array.isArray(input) && input.some((item) => isRecord(item) && item.type === "compaction_trigger")
    })
    if (!hasTrigger) add(issues, "PROVIDER_CAPABILITY", "turns", "compaction profile requires a compaction_trigger input item")
    turns.forEach((turn, index) => {
      const output = turn.expected.result?.output
      const item = Array.isArray(output) && output.length === 1 ? output[0] : undefined
      if (!isRecord(item) || item.type !== "compaction" || typeof item.encrypted_content !== "string") {
        add(
          issues,
          "PROVIDER_CAPABILITY",
          `turns[${index}].expected.result`,
          "compaction result must contain exactly one compaction item with encrypted_content",
        )
      }
    })
  }
  if (capabilities.hosted_tools_exercised.includes("tool_search") && !expectation.nativeToolSearch) {
    add(issues, "PROVIDER_CAPABILITY", "capabilities.hosted_tools_exercised", "tool_search listed outside the native profile")
  }
}

function validateForbidden(value: unknown, path: string, issues: ValidationIssue[]) {
  if (typeof value === "string") {
    for (const rule of FORBIDDEN_STRINGS) {
      if (rule.pattern.test(value)) add(issues, rule.code, path, rule.message)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateForbidden(item, `${path}[${index}]`, issues))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase()) && typeof item === "string") {
      if (!PLACEHOLDER.test(item) && !PLACEHOLDER_BEARER.test(item)) {
        add(issues, "PROVIDER_SECRET", `${path}.${key}`, "secret fields must be redacted placeholders")
      }
    }
    validateForbidden(item, `${path}.${key}`, issues)
  }
}

export function validateFixture(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: "PROVIDER_SHAPE", path: "$", message: "fixture must be an object" }] }
  }
  if (value.format !== PROVIDER_FIXTURE_FORMAT) add(issues, "PROVIDER_FORMAT", "format", `expected ${PROVIDER_FIXTURE_FORMAT}`)
  if (value.version !== PROVIDER_FIXTURE_VERSION) add(issues, "PROVIDER_FORMAT", "version", `expected ${PROVIDER_FIXTURE_VERSION}`)
  if (value.contract_rev !== CONTRACT_REV) add(issues, "PROVIDER_FORMAT", "contract_rev", `expected ${CONTRACT_REV}`)
  const profile = isProfile(value.profile) ? value.profile : undefined
  if (!profile) add(issues, "PROVIDER_PROFILE", "profile", "unknown profile")
  const caseName = readString(value.case, "case", issues)
  const description = readString(value.description, "description", issues)
  const capabilities = validateCapabilities(value.capabilities, profile, issues)
  const rawTurns = readArray(value.turns, "turns", issues)
  const turns: ProviderTurn[] = []
  if (rawTurns) {
    rawTurns.forEach((raw, index) => {
      const turn = validateTurn(raw, `turns[${index}]`, issues, index + 1)
      if (turn) turns.push(turn)
    })
  }
  if (turns.length === 0) add(issues, "PROVIDER_SHAPE", "turns", "at least one turn is required")
  if (profile && capabilities) validateProfileShape(profile, capabilities, turns, issues)
  validateToolClosure(turns, issues)
  validateForbidden(value, "$", issues)
  if (issues.length > 0 || !profile || !caseName || !description || !capabilities || turns.length === 0) {
    return { ok: false, issues }
  }
  const fixture: ProviderFixture = {
    format: PROVIDER_FIXTURE_FORMAT,
    version: PROVIDER_FIXTURE_VERSION,
    contract_rev: CONTRACT_REV,
    profile,
    case: caseName,
    description,
    capabilities,
    turns,
  }
  return { ok: true, fixture, digest: fixtureDigest(fixture) }
}

export async function validateFixtureFile(path: string): Promise<ValidationResult> {
  const text = await readFile(path, "utf8")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "PROVIDER_JSON", path: "$", message: error instanceof Error ? error.message : String(error) }],
    }
  }
  return validateFixture(value)
}

export async function runSuite(dir = FIXTURE_DIR): Promise<SuiteResult> {
  const entries = await readdir(dir)
  const files = entries.filter((entry) => entry.endsWith(".json")).sort()
  const fixtures: FixtureSummary[] = []
  const issues: ValidationIssue[] = []
  const coverage = Object.fromEntries(PROVIDER_PROFILES.map((profile) => [profile, 0])) as Record<ProviderProfileID, number>
  for (const file of files) {
    const result = await validateFixtureFile(join(dir, file))
    if (!result.ok) {
      for (const issue of result.issues) issues.push({ ...issue, path: `${file}:${issue.path}` })
      continue
    }
    coverage[result.fixture.profile] += 1
    fixtures.push({
      file,
      profile: result.fixture.profile,
      case: result.fixture.case,
      digest: result.digest,
      turns: result.fixture.turns.length,
      events: result.fixture.turns.reduce((total, turn) => total + turn.expected.events.length, 0),
      frames: result.fixture.turns.reduce((total, turn) => total + turn.stream.frames.length, 0),
    })
  }
  for (const profile of PROVIDER_PROFILES) {
    if (coverage[profile] === 0) {
      issues.push({ code: "PROVIDER_COVERAGE", path: profile, message: "no fixture covers this profile" })
    }
  }
  return { ok: issues.length === 0, root: dir, fixtures, coverage, issues }
}

export function renderSuite(result: SuiteResult): string {
  const lines: string[] = []
  for (const fixture of result.fixtures) {
    lines.push(
      `PASS ${fixture.file} profile=${fixture.profile} turns=${fixture.turns} events=${fixture.events} frames=${fixture.frames} digest=${fixture.digest}`,
    )
  }
  for (const issue of result.issues) lines.push(`FAIL [${issue.code}] ${issue.path}: ${issue.message}`)
  const covered = PROVIDER_PROFILES.filter((profile) => result.coverage[profile] > 0).length
  lines.push(
    `RESULT: ${result.ok ? "PASS" : "FAIL"} (${result.fixtures.length} fixtures, ${covered}/${PROVIDER_PROFILES.length} profiles, ${result.issues.length} issues)`,
  )
  return lines.join("\n")
}