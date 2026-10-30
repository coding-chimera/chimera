// WP-08 provider fixture format v1.
//
// The format is intentionally transport-shaped: one fixture describes one
// profile and one or more turns. A turn carries the synthetic wire request,
// the auth placement, the transport frames, and the canonical provider-event
// ledger the adapter must produce. The validator in ./validate.ts enforces
// the schema, the ordering contract, and the no-secrets rules.
//
// The canonical event vocabulary mirrors packages/llm/src/schema/events.ts
// (step-start .. provider-error). It is deliberately not the AI SDK event
// spelling used inside packages/chimera/src/session/llm.ts; the mapping is
// documented in specs/rust-host/provider/ordering-contract.md.

import { canonicalJson, sha256 } from "../transcript/format"

export const PROVIDER_FIXTURE_FORMAT = "chimera.oracle.provider-fixture" as const
export const PROVIDER_FIXTURE_VERSION = 1 as const
export const CONTRACT_REV = "cr-2026-10-30-r1" as const

export const PROVIDER_PROFILES = [
  "chat-api-key",
  "responses-api-key",
  "responses-oauth",
  "responses-websocket",
  "native-tool-search",
  "remote-compaction",
] as const

export type ProviderProfileID = (typeof PROVIDER_PROFILES)[number]

/** 可接管 = takeover, 需兼容 = compat, 未覆盖 = uncovered. */
export type GenaiVerdict = "takeover" | "compat" | "uncovered"
export type AuthKind = "api-key" | "oauth" | "none"
export type Transport = "sse" | "websocket-json" | "json"
export type Terminal = "completed" | "incomplete" | "failed" | "error"
export type ToolExecutor = "host" | "provider"

export type ProfileExpectation = {
  readonly verdict: GenaiVerdict
  readonly auth: AuthKind
  readonly transport: Transport
  readonly minTurns: number
  readonly nativeToolSearch: boolean
  readonly remoteCompaction: boolean
}

export const PROFILE_EXPECTATIONS: Record<ProviderProfileID, ProfileExpectation> = {
  "chat-api-key": {
    verdict: "takeover",
    auth: "api-key",
    transport: "sse",
    minTurns: 2,
    nativeToolSearch: false,
    remoteCompaction: false,
  },
  "responses-api-key": {
    verdict: "takeover",
    auth: "api-key",
    transport: "sse",
    minTurns: 2,
    nativeToolSearch: false,
    remoteCompaction: false,
  },
  "responses-oauth": {
    verdict: "compat",
    auth: "oauth",
    transport: "sse",
    minTurns: 2,
    nativeToolSearch: false,
    remoteCompaction: false,
  },
  "responses-websocket": {
    verdict: "uncovered",
    auth: "oauth",
    transport: "websocket-json",
    minTurns: 2,
    nativeToolSearch: false,
    remoteCompaction: false,
  },
  "native-tool-search": {
    verdict: "uncovered",
    auth: "api-key",
    transport: "sse",
    minTurns: 3,
    nativeToolSearch: true,
    remoteCompaction: false,
  },
  "remote-compaction": {
    verdict: "uncovered",
    auth: "oauth",
    transport: "sse",
    minTurns: 2,
    nativeToolSearch: false,
    remoteCompaction: true,
  },
}

export const CANONICAL_EVENT_TYPES = [
  "step-start",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "tool-result",
  "tool-error",
  "step-finish",
  "finish",
  "provider-error",
] as const

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number]

export const TERMINAL_EVENT_TYPES = new Set<CanonicalEventType>(["finish", "provider-error"])

/** Public generic model names only; Codex-related fixtures use the placeholder. */
export const ALLOWED_MODELS = ["gpt-4o-mini", "gpt-5.6", "codex 后端"] as const

export const PLACEHOLDER = /^<REDACTED(?::[A-Z0-9_]+)?>$/
export const PLACEHOLDER_BEARER = /^Bearer <REDACTED(?::[A-Z0-9_]+)?>$/
export const ACCOUNT_PLACEHOLDER = "acct-placeholder"
export const SESSION_PLACEHOLDER = "session-placeholder"

export type AuthRefresh = {
  readonly owner: "chimera"
  readonly strategy: "none" | "before-expiry" | "on-401-once"
  readonly dedupe_key: "none" | "credential" | "credential+session"
}

export type AuthFixture = {
  readonly kind: AuthKind
  readonly placement: "header" | "query" | "none"
  readonly name?: string
  readonly value?: string
  readonly account_header?: {
    readonly name: string
    readonly value: string
  }
  readonly refresh: AuthRefresh
}

export type WireRequest = {
  readonly method: "POST"
  readonly endpoint: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

export type StreamFrame = {
  readonly seq: number
  readonly event?: string
  readonly data: Record<string, unknown>
}

export type StreamFixture = {
  readonly transport: Transport
  readonly frames: ReadonlyArray<StreamFrame>
  readonly done_marker?: string
  readonly terminal: Terminal
}

export type ExpectedToolCall = {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly executed_by: ToolExecutor
}

export type ExpectedToolResult = {
  readonly id: string
  readonly status: "ok" | "error"
}

export type ExpectedResult = {
  readonly output?: ReadonlyArray<unknown>
  readonly usage?: Record<string, number>
}

export type CanonicalEvent = {
  readonly seq: number
  readonly type: CanonicalEventType
  readonly [key: string]: unknown
}

export type ExpectedTurn = {
  readonly events: ReadonlyArray<CanonicalEvent>
  readonly tool_calls?: ReadonlyArray<ExpectedToolCall>
  readonly tool_results?: ReadonlyArray<ExpectedToolResult>
  readonly result?: ExpectedResult
  readonly terminal: Terminal
}

export type ProviderTurn = {
  readonly turn: number
  readonly request: WireRequest
  readonly auth: AuthFixture
  readonly stream: StreamFixture
  readonly expected: ExpectedTurn
}

export type ProviderCapabilities = {
  readonly genai_verdict: GenaiVerdict
  readonly transport: Transport
  readonly auth: AuthKind
  readonly native_tool_search: boolean
  readonly remote_compaction: boolean
  readonly hosted_tools_exercised: ReadonlyArray<string>
  readonly retry_owner: "chimera"
  readonly auth_refresh_owner: "chimera"
}

export type ProviderFixture = {
  readonly format: typeof PROVIDER_FIXTURE_FORMAT
  readonly version: typeof PROVIDER_FIXTURE_VERSION
  readonly contract_rev: typeof CONTRACT_REV
  readonly profile: ProviderProfileID
  readonly case: string
  readonly description: string
  readonly capabilities: ProviderCapabilities
  readonly turns: ReadonlyArray<ProviderTurn>
}

export type FixtureSummary = {
  readonly file: string
  readonly profile: ProviderProfileID
  readonly case: string
  readonly digest: string
  readonly turns: number
  readonly events: number
  readonly frames: number
}

export type ValidationIssue = {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type ValidationResult =
  | {
      readonly ok: true
      readonly fixture: ProviderFixture
      readonly digest: string
    }
  | {
      readonly ok: false
      readonly issues: ReadonlyArray<ValidationIssue>
    }

export type SuiteResult = {
  readonly ok: boolean
  readonly root: string
  readonly fixtures: ReadonlyArray<FixtureSummary>
  readonly coverage: Record<ProviderProfileID, number>
  readonly issues: ReadonlyArray<ValidationIssue>
}

/**
 * Digest of the fixture as canonical JSON. The validator does not require a
 * stored digest; it prints this value so two runs (or two arms) can compare
 * fixture bytes without committing a generated golden.
 */
export function fixtureDigest(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function isProfile(value: unknown): value is ProviderProfileID {
  return typeof value === "string" && (PROVIDER_PROFILES as ReadonlyArray<string>).includes(value)
}

export function isCanonicalEventType(value: unknown): value is CanonicalEventType {
  return typeof value === "string" && (CANONICAL_EVENT_TYPES as ReadonlyArray<string>).includes(value)
}