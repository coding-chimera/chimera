import fs from "node:fs/promises"
import { Hono } from "hono"
import { csp } from "../shared/ui"
import {
  cacheNewWebAsset,
  cachedNewWebAsset,
  embeddedNewWebUI,
  resolveNewWebUIFile,
  MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE,
  type NewWebAsset,
} from "../shared/newweb-ui"

function assetResponse(asset: NewWebAsset) {
  // lib.dom pins BodyInit to Uint8Array<ArrayBuffer> while the shared cache
  // stores Uint8Array<ArrayBufferLike>, so the legacy Hono path hands Response a
  // fresh view. The effect-httpapi path stays zero-copy.
  return new Response(asset.body ? new Uint8Array(asset.body) : null, {
    status: asset.status,
    headers: asset.headers,
  })
}

function notFound() {
  return Response.json({ error: "Not Found" }, { status: 404 })
}

/**
 * Legacy Hono WebUI route. Cache policy, ETag/304 handling and the asset byte
 * and gzip caches live in `shared/newweb-ui` so this backend cannot drift from
 * the effect-httpapi one. `embeddedWebUI` is injectable for tests; production
 * reads the embedded manifest.
 */
export async function serveNewWebUI(request: Request, embeddedWebUI?: Record<string, string> | null) {
  const manifest = embeddedWebUI === undefined ? await embeddedNewWebUI() : embeddedWebUI
  if (!manifest) {
    return new Response(MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE, {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": csp(),
      },
    })
  }

  const path = new URL(request.url).pathname
  const headers = Object.fromEntries(request.headers.entries())
  const cached = cachedNewWebAsset(path, manifest, { headers })
  if (cached) return assetResponse(cached)

  const file = resolveNewWebUIFile(path, manifest)
  if (!file) return notFound()
  const body = await fs.readFile(file).catch(() => undefined)
  if (!body) return notFound()
  return assetResponse(cacheNewWebAsset(path, manifest, file, new Uint8Array(body), { headers }))
}

export const NewWebUIRoutes = (): Hono => new Hono().all("/*", (c) => serveNewWebUI(c.req.raw))
