/**
 * Public surface of the native transport: a fetch-shaped data plane plus a
 * read-only management plane and the immutable TLS-profile registrar. The
 * private ABI (handles, request specs, the addon module itself) stays inside
 * loader/fetch/layout and is never exported here — provider code only ever
 * sees `resolveFetch`, `configureTls`, `capabilities`, and the management
 * functions.
 */

import { NativeTransportFetch } from "./fetch"
import { NativeTransportLoader } from "./loader"
import type { ConfigureTlsProfile, ConfigureTlsResult, ContractInfo, StatsSnapshot } from "./layout"

export type { ConfigureTlsProfile, ConfigureTlsResult, ContractInfo, StatsSnapshot } from "./layout"

export type Fetch = NativeTransportFetch.Fetch

export type ResolveFetchInput = {
  /** Pilot flag; only an explicit true may load the addon (off = zero addon construction). */
  readonly enabled: boolean | undefined
  /** The transport to keep/delegate to — Bun fetch or a provider custom fetch. */
  readonly fallback: Fetch
  /** TLS profile id from configureTls; 0 (default) is platform trust. */
  readonly tlsProfile?: number
  /** Protocol preference: "auto" (ALPN-negotiated h2/http1) or "http1". */
  readonly httpVersion?: "auto" | "http1"
}

/**
 * Select the data-plane fetch. Off, kill-switched (OPENCODE_RUST_TRANSPORT=0),
 * or an unavailable addon returns the fallback function itself (identity, no
 * wrapper); otherwise a native-backed fetch that delegates unsupported
 * requests to the fallback before they are ever started.
 */
export function resolveFetch(input: ResolveFetchInput): Fetch {
  if (input.enabled !== true) return input.fallback
  if (process.env.OPENCODE_RUST_TRANSPORT === "0") return input.fallback
  const addon = NativeTransportLoader.getTransport()
  if (addon === null) return input.fallback
  return NativeTransportFetch.create(addon, input.fallback, {
    tlsProfile: input.tlsProfile,
    httpVersion: input.httpVersion,
  })
}

/**
 * Register an immutable TLS/proxy profile with the loaded addon. Returns null
 * when the addon is unavailable, kill-switched, or too old to expose
 * configureTls — callers then keep profile 0 (platform trust).
 */
export function configureTls(profile: ConfigureTlsProfile): ConfigureTlsResult | null {
  if (process.env.OPENCODE_RUST_TRANSPORT === "0") return null
  const addon = NativeTransportLoader.getTransport()
  if (addon === null || typeof addon.configureTls !== "function") return null
  return addon.configureTls(profile)
}

/** Management plane: the loaded addon's negotiated capabilities, or null. */
export function capabilities(): readonly string[] | null {
  if (process.env.OPENCODE_RUST_TRANSPORT === "0") return null
  return NativeTransportLoader.getTransport()?.contractInfo().capabilities ?? null
}

/** Management plane: the loaded addon's negotiated contract, or null. */
export function contractInfo(): ContractInfo | null {
  if (process.env.OPENCODE_RUST_TRANSPORT === "0") return null
  return NativeTransportLoader.getTransport()?.contractInfo() ?? null
}

/** Management plane: live addon counters/gauges, or null when unavailable. */
export function stats(): StatsSnapshot | null {
  if (process.env.OPENCODE_RUST_TRANSPORT === "0") return null
  return NativeTransportLoader.getTransport()?.stats() ?? null
}

export * as NativeTransport from "."