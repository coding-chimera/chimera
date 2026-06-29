import fs from "node:fs/promises"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Hono } from "hono"
import { csp, cspForHtml } from "../shared/ui"
import { embeddedNewWebUI, resolveNewWebUIFile, MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE } from "../shared/newweb-ui"

export async function serveNewWebUI(request: Request) {
  const embeddedWebUI = await embeddedNewWebUI()
  const path = new URL(request.url).pathname

  if (embeddedWebUI) {
    const match = resolveNewWebUIFile(path, embeddedWebUI)
    if (!match) return Response.json({ error: "Not Found" }, { status: 404 })

    if (await fs.exists(match)) {
      const mime = AppFileSystem.mimeType(match)
      const headers = new Headers({ "content-type": mime })
      const body = new Uint8Array(await fs.readFile(match))
      if (mime.startsWith("text/html")) {
        headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
      }
      return new Response(body, { headers })
    }

    return Response.json({ error: "Not Found" }, { status: 404 })
  }

  return new Response(MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": csp(),
    },
  })
}

export const NewWebUIRoutes = (): Hono => new Hono().all("/*", (c) => serveNewWebUI(c.req.raw))
