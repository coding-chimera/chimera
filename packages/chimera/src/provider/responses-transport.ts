export type Target = "responses" | "responses/compact"
export type Feature = "remote-compaction-v2"

export type Identity = {
  providerID: string
  modelID: string
  wireModelID: string
  wireAPI: "responses"
  auth: "configured" | "provider-bearer" | "missing"
  ready: boolean
  compatibilityKey: string
  replay: { eligible: true } | { eligible: false; reason: "custom_fetch" | "routing_headers" }
}

export type ExecuteInput = {
  body: BodyInit
  signal?: AbortSignal
  feature?: Feature
  timeout?: number
}

export type ExecuteResult = {
  status: number
  body: string
}

export type Transport = {
  readonly identity: Identity
  readonly execute: (target: Target, input: ExecuteInput) => Promise<ExecuteResult>
}

type Options = {
  providerID: string
  modelID: string
  wireModelID: string
  baseURL: unknown
  apiKey: unknown
  headers: unknown
  fetch: unknown
  timeout: unknown
  chunkTimeout: unknown
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576

export class Error extends globalThis.Error {
  override readonly name = "ResponsesTransportError"
  constructor(
    readonly kind: "configuration" | "timeout" | "network" | "redirect" | "body_limit",
    message: string,
  ) {
    super(message)
  }
}

const rejectedHeaders = new Set([
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "x-codex-beta-features",
])
const replaySafeHeaders = new Set(["accept", "content-type", "user-agent", "authorization"])

function fail(message: string): never {
  throw new Error("configuration", `Responses transport ${message}`)
}

function parseBaseURL(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return fail("requires a base URL")
  const url = (() => {
    try {
      return new URL(value)
    } catch {
      return fail("requires a valid base URL")
    }
  })()
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("requires an HTTP(S) base URL")
  if (url.username || url.password) return fail("base URL cannot contain userinfo")
  if (url.search || url.hash) return fail("base URL cannot contain query or fragment")
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url
}

function endpoints(base: URL) {
  const path = base.pathname === "/" ? "" : base.pathname
  const compact = path.endsWith("/responses/compact")
  const responsesPath = compact
    ? path.slice(0, -"/compact".length)
    : path.endsWith("/responses")
      ? path
      : `${path}/responses`
  const legacyPath = compact
    ? path
    : path.endsWith("/responses")
      ? `${path}/compact`
      : `${path}/responses/compact`
  const make = (pathname: string) => {
    const url = new URL(base)
    url.pathname = pathname
    return url
  }
  return { responses: make(responsesPath), "responses/compact": make(legacyPath) }
}

function configuredHeaders(value: unknown) {
  const headers = new Headers(value instanceof Headers ? value : (value as HeadersInit | undefined))
  for (const name of rejectedHeaders) if (headers.has(name)) fail(`configured header ${name} is not allowed`)
  return headers
}

function fingerprint(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError")
}

async function readBody(response: Response, signal: AbortSignal, chunkTimeout: number | undefined) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const abort = () => {
          cleanup()
          reject(abortError(signal))
        }
        const idle = chunkTimeout
          ? setTimeout(() => {
              cleanup()
              reject(new Error("timeout", "Responses transport stream idle timeout"))
            }, chunkTimeout)
          : undefined
        const cleanup = () => {
          if (idle) clearTimeout(idle)
          signal.removeEventListener("abort", abort)
        }
        if (signal.aborted) return abort()
        signal.addEventListener("abort", abort, { once: true })
        reader.read().then(
          (value) => {
            cleanup()
            resolve(value)
          },
          (error) => {
            cleanup()
            reject(error)
          },
        )
      })
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > DEFAULT_MAX_BODY_BYTES)
        throw new Error("body_limit", "Responses transport response body exceeded the size limit")
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

export function make(options: Options): Transport {
  const baseURL = parseBaseURL(options.baseURL)
  const urls = endpoints(baseURL)
  const headers = configuredHeaders(options.headers)
  const configuredAuthorization = headers.get("authorization")
  const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : undefined
  const auth = configuredAuthorization ? "configured" : apiKey ? "provider-bearer" : "missing"
  const customFetch = typeof options.fetch === "function" ? (options.fetch as typeof fetch) : undefined
  const routingHeaders = [...headers.keys()].filter((name) => !replaySafeHeaders.has(name))
  const replay = customFetch
    ? ({ eligible: false, reason: "custom_fetch" } as const)
    : routingHeaders.length
      ? ({ eligible: false, reason: "routing_headers" } as const)
      : ({ eligible: true } as const)
  const identity: Identity = {
    providerID: options.providerID,
    modelID: options.modelID,
    wireModelID: options.wireModelID,
    wireAPI: "responses",
    auth,
    ready: auth !== "missing",
    compatibilityKey: fingerprint(
      JSON.stringify({
        providerID: options.providerID,
        modelID: options.modelID,
        wireModelID: options.wireModelID,
        wireAPI: "responses",
        endpoint: {
          protocol: baseURL.protocol,
          hostname: baseURL.hostname,
          port: baseURL.port,
          pathname: baseURL.pathname,
        },
      }),
    ),
    replay,
  }

  return {
    identity,
    async execute(target, input) {
      if (target !== "responses" && target !== "responses/compact") return fail("target is not allowed")
      if (!identity.ready) return fail("is not ready")
      if (input.feature && (input.feature !== "remote-compaction-v2" || target !== "responses"))
        return fail("feature is not allowed for this target")

      const url = urls[target]
      if (url.origin !== baseURL.origin) return fail("target origin is not allowed")
      if (baseURL.protocol === "https:" && url.protocol !== "https:") return fail("HTTPS downgrade is not allowed")

      const controller = new AbortController()
      const configuredTimeout = typeof options.timeout === "number" && options.timeout > 0 ? options.timeout : undefined
      const timeout = configuredTimeout && input.timeout ? Math.min(configuredTimeout, input.timeout) : configuredTimeout ?? input.timeout
      const chunkTimeout =
        target === "responses" && typeof options.chunkTimeout === "number" && options.chunkTimeout > 0
          ? options.chunkTimeout
          : undefined
      const timer = timeout
        ? setTimeout(
            () => controller.abort(new Error("timeout", "Responses transport total timeout")),
            timeout,
          )
        : undefined
      const callerAbort = () => controller.abort(abortError(input.signal!))
      if (input.signal?.aborted) callerAbort()
      else input.signal?.addEventListener("abort", callerAbort, { once: true })

      const requestHeaders = new Headers(headers)
      if (!configuredAuthorization && apiKey) requestHeaders.set("authorization", `Bearer ${apiKey}`)
      if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json")
      if (input.feature === "remote-compaction-v2")
        requestHeaders.set("x-codex-beta-features", "remote_compaction_v2")

      try {
        const fetchFn = customFetch ?? fetch
        const response = await new Promise<Response>((resolve, reject) => {
          const abort = () => {
            cleanup()
            reject(abortError(controller.signal))
          }
          const cleanup = () => controller.signal.removeEventListener("abort", abort)
          if (controller.signal.aborted) return abort()
          controller.signal.addEventListener("abort", abort, { once: true })
          fetchFn(url, {
            method: "POST",
            headers: requestHeaders,
            body: input.body,
            redirect: "manual",
            signal: controller.signal,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          }).then(
            (value) => {
              cleanup()
              resolve(value)
            },
            (error) => {
              cleanup()
              reject(error)
            },
          )
        })
        if (response.status >= 300 && response.status < 400)
          throw new Error("redirect", "Responses transport redirect was rejected")
        if (response.redirected) throw new Error("redirect", "Responses transport redirected response was rejected")
        if (!response.url) {
          if (!customFetch) return fail("response origin could not be verified")
        } else {
          const observed = (() => {
            try {
              return new URL(response.url)
            } catch {
              return fail("response origin could not be verified")
            }
          })()
          if (observed.origin !== url.origin) return fail("response origin changed")
          if (url.protocol === "https:" && observed.protocol !== "https:") return fail("response downgraded HTTPS")
        }
        return { status: response.status, body: await readBody(response, controller.signal, chunkTimeout) }
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause
            : controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("network", "Responses transport network request failed")
        controller.abort(error)
        throw error
      } finally {
        if (timer) clearTimeout(timer)
        input.signal?.removeEventListener("abort", callerAbort)
      }
    },
  }
}

export * as ResponsesTransport from "./responses-transport"
