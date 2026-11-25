/**
 * Private native-transport ABI — TS mirror of chimera-transport/src/lib.rs.
 *
 * Internal contract between the loader/fetch adapter and the .node addon;
 * nothing here is part of the public data plane (which is just `typeof
 * fetch`). Within abiMajor 1 the crate may only ADD fields, so newer minors
 * and extra capability strings are tolerated by the loader's negotiation.
 * Handles are opaque u32 integers; no JS-engine private types cross the wire.
 */

/** Major version this TypeScript layer speaks; a different major is refused. */
export const REQUIRED_MAJOR = 1

/** Lowest accepted minor; newer minors stay backward compatible within the major. */
export const MINOR_FLOOR = 0

/** Capabilities the adapter relies on; a binary missing any of them is refused. */
/** Capabilities the adapter relies on; a binary missing any of them is refused.
 *  This floor is deliberately frozen: older no-TLS addons must keep loading,
 *  with https delegated to the fallback unless the addon also advertises
 *  `CAPABILITY.tls`. */
export const REQUIRED_CAPABILITIES: readonly string[] = ["http1", "sse-stream", "cancel", "stats"]

/** Capability strings advertised by the crate beyond the required floor. */
export const CAPABILITY = {
  http1: "http1",
  sseStream: "sse-stream",
  cancel: "cancel",
  stats: "stats",
  tls: "tls",
  tlsPlatform: "tls-platform",
  http2: "http2",
  proxySystem: "proxy-system",
  tlsCustomCa: "tls-custom-ca",
  mtls: "mtls",
  fallbackProtocol: "fallback-protocol",
  fallbackRoute: "fallback-route",
} as const

/** Ordered, duplicate-preserving header pair (crate `HeaderPair`). */
export type HeaderPair = {
  name: string
  value: string
}

/** Crate `RequestSpec` — body is absent/undefined for no body, a string, or bytes (the napi ABI rejects null). */
export type RequestSpec = {
  url: string
  method: string
  headers: HeaderPair[]
  body?: string | Uint8Array
  /** Only "follow" (or absent) is implemented by the crate. */
  redirect?: string | null
  /** Protocol preference: "auto" (ALPN-negotiated h2/http1, default) or "http1". */
  httpVersion?: "auto" | "http1"
  /** TLS profile id from `configureTls`; 0 (default) is platform trust. */
  tlsProfile?: number
}

/** Crate `ConfigureTlsProfile` — immutable TLS profile (ids are monotonic). */
export type ConfigureTlsProfile = {
  caPem?: string | null
  certPem?: string | null
  keyPem?: string | null
  rejectUnauthorized?: boolean | null
  serverName?: string | null
  /** Additive optional field: an explicit proxy URL pinned to this profile.
   *  System/env-discovered proxies stay on the default profile (auto). */
  proxy?: string | null
}

/** Crate `configureTls` result — the id used by later RequestSpecs. */
export type ConfigureTlsResult = {
  profileId: number
}

/** Crate `StartResult` — the opaque handle for every later call. */
export type StartResult = {
  handle: number
}

/** Crate `HeadersResult` — response head with duplicate-preserving headers. */
export type HeadersResult = {
  status: number
  statusText: string
  headers: HeaderPair[]
  url: string
  redirected: boolean
}

/** Crate `ContractInfo` — the negotiation input. */
export type ContractInfo = {
  abiMajor: number
  abiMinor: number
  capabilities: string[]
  build: string
}

/** Crate `StatsSnapshot` — monotonic counters plus live gauges (management plane). */
export type StatsSnapshot = {
  activeHandles: number
  bufferedBytes: number
  cancelledHandles: number
  postSendErrors: number
  /** Handles reclaimed by the crate's idle-reader watchdog. Additive at
   *  abiMinor 1 — optional because a minor-0 addon may not report it. */
  idleReclaimedHandles?: number
  /** Connect-layer protocol fallbacks (h2 -> http1). Additive at abiMinor 2. */
  protocolFallbacks?: number
  /** Connect-layer route fallbacks (system proxy -> direct). Additive at abiMinor 2. */
  routeFallbacks?: number
  workerThreads: number
}

/** The addon export surface (napi camelCase of the crate's snake_case fns). */
export type TransportAddon = {
  contractInfo(): ContractInfo
  startRequest(spec: RequestSpec): StartResult
  awaitHeaders(handle: number): Promise<HeadersResult>
  /** Resolves to the next chunk in order, or null at clean EOF. */
  readBody(handle: number, maxBytes?: number): Promise<Uint8Array | null>
  cancel(handle: number): void
  release(handle: number): void
  stats(): StatsSnapshot
  /** Additive at abiMinor 2 — absent on older addons, which keep platform
   *  trust only and delegate anything needing a custom profile. */
  configureTls?(profile: ConfigureTlsProfile): ConfigureTlsResult
}

export * as NativeTransportLayout from "./layout"