import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { csp, cspForHtml } from "./ui"

const embeddedNewWebUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("chimera-newweb-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE = "Chimera NewWeb assets are not embedded in this build. Run the NewWeb dev server separately or rebuild Chimera with embedded WebUI assets."

/**
 * `assets/*` filenames carry a content hash from the WebUI build, so a release
 * can never mutate one; everything else (the SPA document, manifest, service
 * worker, icons) has to revalidate because its name is stable across releases.
 */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
const REVALIDATE_CACHE_CONTROL = "no-cache"
/** Mirrors the server compression middleware threshold. */
const GZIP_MIN_BYTES = 1024
/** Upper bound for cached asset bytes (raw + gzip) per process. */
const CACHE_BYTE_BUDGET = 64 * 1024 * 1024

type CachedAsset = {
  body: Uint8Array
  etag: string
  headers: Headers
  gzip?: Uint8Array
  bytes: number
}

// Keyed by cache policy + embedded file, so a document and an asset can never
// share an entry. Reset wholesale when a different embedded manifest is served,
// which keeps test manifests (fresh temp files per case) from reading a stale
// entry while production reuses the single generated manifest for the process
// lifetime.
const assets = new Map<string, CachedAsset>()
let manifest: Record<string, string> | undefined
let cachedBytes = 0

export function embeddedNewWebUI() {
  if (Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI) return Promise.resolve(null)
  return embeddedNewWebUIPromise
}

export function newWebAssetPath(path: string) {
  const stripped = path.replace(/^\//, "")
  if (!stripped) return "index.html"
  return stripped
}

export function resolveNewWebUIFile(requestPath: string, embeddedWebUI: Record<string, string>) {
  const assetPath = newWebAssetPath(requestPath)
  const file = embeddedWebUI[assetPath]
  if (file) return file
  if (assetPath.startsWith("assets/") || assetPath.split("/").at(-1)?.includes(".")) return null
  return embeddedWebUI["index.html"] ?? null
}

function missingEmbeddedNewWebUI() {
  return HttpServerResponse.text(MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE, {
    status: 503,
    headers: new Headers({
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": csp(),
    }),
  })
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function isCompressible(mime: string) {
  return (
    mime.startsWith("text/") ||
    mime === "application/javascript" ||
    mime === "application/json" ||
    mime === "application/manifest+json" ||
    mime === "image/svg+xml"
  )
}

function evict(needed: number) {
  for (const key of assets.keys()) {
    if (cachedBytes + needed <= CACHE_BYTE_BUDGET) return
    const entry = assets.get(key)
    assets.delete(key)
    if (entry) cachedBytes -= entry.bytes
  }
}

function cacheAsset(key: string, file: string, assetPath: string, body: Uint8Array) {
  const mime = AppFileSystem.mimeType(file)
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 32)}"`
  const headers = new Headers({
    "content-type": mime,
    "cache-control": assetPath.startsWith("assets/") ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
    etag,
  })
  if (isCompressible(mime)) headers.set("vary", "accept-encoding")
  // The CSP hashes the document's inline scripts, so it is derived once per
  // asset instead of on every request.
  if (mime.startsWith("text/html")) headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))

  const entry: CachedAsset = { body, etag, headers, bytes: body.byteLength }
  evict(entry.bytes)
  assets.set(key, entry)
  cachedBytes += entry.bytes
  return entry
}

function gzipOf(entry: CachedAsset) {
  if (entry.gzip) return entry.gzip
  const gzip = gzipSync(entry.body)
  // Serving a larger body than the raw one would be a regression, so only the
  // paying variant is cached.
  if (gzip.byteLength >= entry.body.byteLength) return gzip
  evict(gzip.byteLength)
  entry.gzip = gzip
  entry.bytes += gzip.byteLength
  cachedBytes += gzip.byteLength
  return gzip
}

function matchesEtag(header: string | undefined, etag: string) {
  if (!header) return false
  if (header.trim() === "*") return true
  return header.split(",").some((candidate) => candidate.trim() === etag)
}

function assetResponse(entry: CachedAsset, request?: { headers?: Record<string, string | undefined> }) {
  if (matchesEtag(request?.headers?.["if-none-match"], entry.etag)) {
    return HttpServerResponse.empty({ status: 304, headers: entry.headers })
  }

  const mime = entry.headers.get("content-type") ?? ""
  if (
    entry.body.byteLength >= GZIP_MIN_BYTES &&
    isCompressible(mime) &&
    request?.headers?.["accept-encoding"]?.toLowerCase().includes("gzip")
  ) {
    const gzip = gzipOf(entry)
    if (gzip.byteLength < entry.body.byteLength) {
      // Setting content-encoding here makes the compression middleware skip the
      // response, so a cached asset is never re-gzipped per request.
      const headers = new Headers(entry.headers)
      headers.set("content-encoding", "gzip")
      return HttpServerResponse.raw(gzip, { headers })
    }
  }

  return HttpServerResponse.raw(entry.body, { headers: entry.headers })
}

export function serveEmbeddedNewWebUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
  request?: { headers?: Record<string, string | undefined> },
) {
  if (manifest !== embeddedWebUI) {
    manifest = embeddedWebUI
    assets.clear()
    cachedBytes = 0
  }

  const file = resolveNewWebUIFile(requestPath, embeddedWebUI)
  if (!file) return Effect.succeed(notFound())

  const assetPath = newWebAssetPath(requestPath)
  const key = `${assetPath.startsWith("assets/") ? "immutable" : "revalidate"}\u0000${file}`
  const hit = assets.get(key)
  if (hit) return Effect.succeed(assetResponse(hit, request))

  return fs.readFile(file).pipe(
    Effect.map((body) => assetResponse(cacheAsset(key, file, assetPath, body), request)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveNewWebUIEffect(
  request: { url: string; headers?: Record<string, string | undefined> },
  services: { fs: AppFileSystem.Interface },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedNewWebUI())
    const path = new URL(request.url, "http://localhost").pathname
    if (embeddedWebUI) return yield* serveEmbeddedNewWebUIEffect(path, services.fs, embeddedWebUI, request)
    return missingEmbeddedNewWebUI()
  })
}

export { MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE }
