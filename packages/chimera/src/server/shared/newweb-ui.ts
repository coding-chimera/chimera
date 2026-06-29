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

export function embeddedNewWebUI() {
  if (Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI) return Promise.resolve(null)
  return embeddedNewWebUIPromise
}

export function newWebAssetPath(path: string) {
  const stripped = path.replace(/^\/newweb\/?/, "")
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

function embeddedNewWebUIResponse(file: string, body: Uint8Array) {
  const mime = AppFileSystem.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedNewWebUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = resolveNewWebUIFile(requestPath, embeddedWebUI)
  if (!file) return Effect.succeed(notFound())
  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedNewWebUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveNewWebUIEffect(request: { url: string }, services: { fs: AppFileSystem.Interface }) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedNewWebUI())
    const path = new URL(request.url, "http://localhost").pathname
    if (embeddedWebUI) return yield* serveEmbeddedNewWebUIEffect(path, services.fs, embeddedWebUI)
    return missingEmbeddedNewWebUI()
  })
}

export { MISSING_EMBEDDED_NEW_WEB_UI_MESSAGE }
