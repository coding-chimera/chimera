import fs from "node:fs/promises"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Hono } from "hono"
import { csp, cspForHtml, embeddedUI } from "../shared/ui"

const MISSING_EMBEDDED_UI_MESSAGE = "Chimera WebUI assets are not embedded in this build. Run the WebUI dev server separately or rebuild Chimera with embedded WebUI assets."

export async function serveUI(request: Request) {
  const embeddedWebUI = await embeddedUI()
  const path = new URL(request.url).pathname

  if (embeddedWebUI) {
    const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
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

  return new Response(MISSING_EMBEDDED_UI_MESSAGE, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": csp(),
    },
  })
}

export const UIRoutes = (): Hono => new Hono().all("/*", (c) => serveUI(c.req.raw))
