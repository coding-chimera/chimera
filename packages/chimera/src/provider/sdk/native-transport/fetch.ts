/**
 * Native-transport fetch adapter — turns the private addon ABI into a
 * function with exactly Bun fetch's shape, `(input, init) => Promise<Response>`.
 *
 * Delegation discipline: anything the addon cannot faithfully carry (Request
 * inputs, https when the addon lacks the tls capability, other schemes,
 * unknown init keys, Bun extensions like proxy/tls/unix/verbose,
 * stream/FormData/Blob bodies, numeric timeouts, and environment proxies
 * unless the addon advertises proxy-system) is handed to the fallback
 * UNWRAPPED before startRequest — unknown keys are never silently dropped.
 * Provider-level tls/proxy configuration never rides init: it becomes an
 * immutable configureTls profile whose id travels in the RequestSpec, so a
 * pinned proxy is never bypassed by route fallback. A synchronous startRequest
 * defect provably never started the request, so it counts as a pre-send
 * fallback and delegates too. Once startRequest succeeds the request may be on
 * the wire: every later error propagates to the caller and the fallback is
 * never invoked again for that request (a retried POST would duplicate a
 * model call).
 */

import type { HeaderPair, HeadersResult, RequestSpec, TransportAddon } from "./layout"
import { CAPABILITY } from "./layout"
import { ResponseMetadata } from "../../response-metadata"

export type Fetch = typeof fetch

/** Wrapper-creation configuration (NOT per-request fetch parameters). */
export type CreateOptions = {
  /** TLS profile id from configureTls; 0 (default) is platform trust. */
  readonly tlsProfile?: number
  /** Protocol preference: "auto" (ALPN-negotiated h2/http1) or "http1". */
  readonly httpVersion?: "auto" | "http1"
}

const ALLOWED_INIT_KEYS = new Set(["method", "headers", "signal", "body", "redirect", "timeout"])
const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]

/** JS-side count of requests delegated after a synchronous startRequest defect. */
let preSendFallbacks = 0
export function preSendFallbackCount(): number {
  return preSendFallbacks
}

function abortReason(signal: AbortSignal) {
  return signal.reason === undefined ? new DOMException("The operation was aborted.", "AbortError") : signal.reason
}

function proxyConfigured(): boolean {
  return PROXY_ENV_KEYS.some((key) => (process.env[key] ?? "") !== "")
}

function isNativeBody(body: unknown): body is string | Uint8Array | null | undefined {
  return body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array
}

/** Ordered, duplicate-preserving request headers; null when the shape is not
 *  faithfully representable (delegate rather than coerce or drop). */
function headerPairs(headers: RequestInit["headers"]): HeaderPair[] | null {
  if (headers === undefined || headers === null) return []
  if (headers instanceof Headers) return [...headers].map(([name, value]) => ({ name, value }))
  if (Array.isArray(headers)) {
    const pairs: HeaderPair[] = []
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string")
        return null
      pairs.push({ name: entry[0], value: entry[1] })
    }
    return pairs
  }
  if (typeof headers !== "object") return null
  const proto = Object.getPrototypeOf(headers)
  if (proto !== Object.prototype && proto !== null) return null
  const pairs: HeaderPair[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") return null
    pairs.push({ name, value })
  }
  return pairs
}

/** Negotiated capabilities plus the create-time transport configuration. */
type NativeCapabilities = {
  readonly tls: boolean
  readonly proxySystem: boolean
  readonly tlsProfile: number
  readonly httpVersion: "auto" | "http1"
}

/** The native whitelist: a RequestSpec when the addon can carry the call
 *  faithfully, null when the fallback must take it untouched. */
function nativeSpec(input: RequestInfo | URL, init: RequestInit | undefined, capabilities: NativeCapabilities): RequestSpec | null {
  // An environment proxy changes where the request connects. The crate only
  // discovers it when it advertises proxy-system; without that capability,
  // delegate instead of silently bypassing the proxy.
  if (!capabilities.proxySystem && proxyConfigured()) return null

  const href = typeof input === "string" ? input : input instanceof URL ? input.href : null
  if (href === null) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  // https rides the addon only when it advertises the tls capability; every
  // other scheme (and https without tls) delegates.
  if (url.protocol !== "http:" && !(capabilities.tls && url.protocol === "https:")) return null

  const opts: RequestInit = init ?? {}
  if (typeof opts !== "object") return null
  // Unknown keys must delegate, never be dropped: check own keys (including
  // symbols/non-enumerables) and inherited enumerable keys alike. Bun's
  // per-request tls/proxy/unix/verbose extensions land here and delegate.
  for (const key of Reflect.ownKeys(opts)) {
    if (typeof key !== "string" || !ALLOWED_INIT_KEYS.has(key)) return null
  }
  for (const key in opts) {
    if (!ALLOWED_INIT_KEYS.has(key)) return null
  }

  const method = opts.method ?? "GET"
  if (typeof method !== "string") return null

  const pairs = headerPairs(opts.headers)
  if (pairs === null) return null

  if (opts.signal !== undefined && opts.signal !== null && !(opts.signal instanceof AbortSignal)) return null
  if (!isNativeBody(opts.body)) return null
  if (opts.redirect !== undefined && opts.redirect !== "follow") return null

  // Bun's `timeout: false` disables the deadline the addon also lacks; a
  // numeric timeout is a real deadline the addon cannot honor, so delegate.
  const timeout = (opts as RequestInit & { timeout?: unknown }).timeout
  if (timeout !== undefined && timeout !== false) return null

  return {
    url: href,
    method,
    headers: pairs,
    body: opts.body ?? undefined,
    redirect: "follow",
    httpVersion: capabilities.httpVersion,
    tlsProfile: capabilities.tlsProfile,
  }
}

/** Build the fetch-shaped data plane over one verified addon. */
export function create(addon: TransportAddon, fallback: Fetch, options: CreateOptions = {}): Fetch {
  // Capabilities are negotiated once per created adapter, never per request.
  const capabilities = new Set(addon.contractInfo().capabilities)
  const native: NativeCapabilities = {
    tls: capabilities.has(CAPABILITY.tls),
    proxySystem: capabilities.has(CAPABILITY.proxySystem),
    tlsProfile: options.tlsProfile ?? 0,
    httpVersion: options.httpVersion ?? "auto",
  }
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const spec = nativeSpec(input, init, native)
    if (spec === null) return fallback(input, init)

    const signal = init?.signal ?? null
    if (signal?.aborted) throw abortReason(signal)

    let handle: number
    try {
      handle = addon.startRequest(spec).handle
    } catch {
      // Synchronous defect: the addon provably never started the request.
      preSendFallbacks += 1
      return fallback(input, init)
    }

    // Past this point the request may be on the wire: never delegate again.
    const onAbort = () => addon.cancel(handle)
    signal?.addEventListener("abort", onAbort, { once: true })
    let released = false
    const finish = () => {
      if (released) return
      released = true
      signal?.removeEventListener("abort", onAbort)
      addon.release(handle)
    }

    let head: HeadersResult
    try {
      head = await addon.awaitHeaders(handle)
    } catch (error) {
      finish()
      if (signal?.aborted) throw abortReason(signal)
      throw new TypeError("fetch failed", { cause: error })
    }

    const headers = new Headers()
    for (const pair of head.headers) headers.append(pair.name, pair.value)

    const nullBody =
      head.status === 204 || head.status === 205 || head.status === 304 || spec.method.toUpperCase() === "HEAD"
    if (nullBody) {
      finish()
      return ResponseMetadata.withMetadata(new Response(null, { status: head.status, statusText: head.statusText, headers }), { url: head.url, redirected: head.redirected, type: "basic" })
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // One in-flight readBody per handle: with the default count-based
        // queuing strategy pull only runs again after the previous chunk is
        // consumed, matching the crate's single-reader rule — no extra
        // per-chunk promise layer that could start a second concurrent read.
        let chunk: Uint8Array | null
        try {
          chunk = await addon.readBody(handle)
        } catch (error) {
          finish()
          controller.error(signal?.aborted ? abortReason(signal) : error)
          return
        }
        if (chunk === null) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
      cancel() {
        addon.cancel(handle)
        finish()
      },
    })

    return ResponseMetadata.withMetadata(new Response(body, { status: head.status, statusText: head.statusText, headers }), { url: head.url, redirected: head.redirected, type: "basic" })
  }
  // Bun's typeof fetch carries a `preconnect` namespace member; the data
  // plane is the call signature only (same bridge as cli/cmd/tui/thread.ts).
  // Bun exposes fetch.preconnect; keep the fallback's bound method so the
  // wrapper stays a drop-in typeof fetch.
  const preconnect = (fallback as unknown as { preconnect?: unknown }).preconnect
  if (typeof preconnect === "function") Object.assign(fn, { preconnect: preconnect.bind(fallback) })
  return fn as Fetch
}

export * as NativeTransportFetch from "./fetch"