import { createHash, randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigProvider, Effect, Layer } from "effect"
import {
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpRouter,
} from "effect/unstable/http"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { serveEmbeddedUIEffect, serveUIEffect } from "../../src/server/shared/ui"
import { serveEmbeddedNewWebUIEffect } from "../../src/server/shared/newweb-ui"
import { Server } from "../../src/server/server"

void Log.init({ print: false })

const original = {
  OPENCODE_EXPERIMENTAL_HTTPAPI: Flag.OPENCODE_EXPERIMENTAL_HTTPAPI,
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI,
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original.OPENCODE_EXPERIMENTAL_HTTPAPI
  Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = original.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  restoreEnv("OPENCODE_SERVER_PASSWORD", original.envPassword)
  restoreEnv("OPENCODE_SERVER_USERNAME", original.envUsername)
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function app(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    ExperimentalHttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        ExperimentalHttpApiServer.context,
      )
    },
  }
}

function uiApp(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) => router.add("*", "/*", serveUIEffect)).pipe(
      Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))),
      Layer.provide([
        HttpServer.layerServices,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        ExperimentalHttpApiServer.context,
      )
    },
  }
}

function embeddedNewWebResponse(requestPath: string, embeddedWebUI: Record<string, string>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return yield* serveEmbeddedNewWebUIEffect(requestPath, fs, embeddedWebUI).pipe(Effect.map(HttpServerResponse.toWeb))
    }).pipe(Effect.provide(AppFileSystem.defaultLayer)),
  )
}


describe("HttpApi UI fallback", () => {
  test("returns a local unavailable response when embedded UI assets are disabled", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    const response = await uiApp().request("/")

    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(await response.text()).toContain("Chimera WebUI assets are not embedded")
  })

  test("serves embedded UI assets from Bun-readable file paths", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    const file = path.join(tmpdir(), `chimera-ui-${randomUUID()}.js`)
    await Bun.write(file, "console.log('embedded')")

    try {
      const response = await Effect.runPromise(
        serveEmbeddedUIEffect("/assets/app.js", { "assets/app.js": file }).pipe(Effect.map(HttpServerResponse.toWeb)),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(await response.text()).toBe("console.log('embedded')")
    } finally {
      await rm(file, { force: true })
    }
  })

  test("allows embedded UI terminal wasm and theme preload CSP", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    const script = 'document.documentElement.dataset.theme = "dark"'
    const file = path.join(tmpdir(), `chimera-ui-${randomUUID()}.html`)
    await Bun.write(file, `<html><head><script id="oc-theme-preload-script">${script}</script></head></html>`)

    try {
      const response = await Effect.runPromise(
        serveEmbeddedUIEffect("/", { "index.html": file }).pipe(Effect.map(HttpServerResponse.toWeb)),
      )
      const csp = response.headers.get("content-security-policy") ?? ""

      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
      expect(csp).toContain("connect-src * data:")
    } finally {
      await rm(file, { force: true })
    }
  })


  test("serves embedded NewWeb assets from Bun-readable file paths", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    const file = path.join(tmpdir(), `chimera-newweb-${randomUUID()}.js`)
    await Bun.write(file, "console.log('newweb')")

    try {
      const response = await embeddedNewWebResponse("/assets/app.js", { "assets/app.js": file })

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(await response.text()).toBe("console.log('newweb')")
    } finally {
      await rm(file, { force: true })
    }
  })

  test("keeps missing NewWeb static assets from falling back to the app document", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    const file = path.join(tmpdir(), `chimera-newweb-${randomUUID()}.html`)
    await Bun.write(file, "<html>newweb</html>")

    try {
      const appRoute = await embeddedNewWebResponse("/projects/demo", { "index.html": file })
      const asset = await embeddedNewWebResponse("/assets/missing.js", { "index.html": file })

      expect(appRoute.status).toBe(200)
      expect(await appRoute.text()).toContain("newweb")
      expect(asset.status).toBe(404)
      expect(await asset.json()).toEqual({ error: "Not Found" })
    } finally {
      await rm(file, { force: true })
    }
  })

  test("routes / to the lightweight UI before the legacy WebUI fallback", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    const response = await Server.Default().app.request("/")

    expect(response.status).toBe(503)
    expect(await response.text()).toContain("Chimera NewWeb assets are not embedded")
  })

  test("routes / to the lightweight UI on the Hono backend", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    const response = await Server.Legacy().app.request("/")

    expect(response.status).toBe(503)
    expect(await response.text()).toContain("Chimera NewWeb assets are not embedded")
  })

  test("serves NewWeb public assets without auth when a server password is set", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true
    const httpApi = app({ password: "secret", username: "chimera" })

    for (const path of ["/manifest.json", "/opencode.svg", "/notification-sw.js", "/material-icons/folder.svg"]) {
      const response = await httpApi.request(path)
      expect(response.status).not.toBe(401)
    }
  })

  test("serves NewWeb public assets without auth on the Hono backend", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "chimera"
    const server = Server.Legacy()

    for (const path of ["/manifest.json", "/opencode.svg", "/notification-sw.js", "/material-icons/folder.svg"]) {
      const response = await server.app.request(path)
      expect(response.status).not.toBe(401)
    }
  })

  test("keeps legacy UI as an authenticated internal route", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true
    const httpApi = app({ password: "secret", username: "chimera" })

    const response = await httpApi.request("/legacy/")
    expect(response.status).toBe(401)

    const authorized = await httpApi.request("/legacy/", {
      headers: { authorization: `Basic ${btoa("chimera:secret")}` },
    })
    expect(authorized.status).toBe(503)
    expect(await authorized.text()).toContain("Chimera WebUI assets are not embedded")
  })

  test("keeps matched API routes ahead of the UI fallback", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true

    const response = await Server.Default().app.request("/session/nope")

    expect(response.status).toBe(404)
  })

  test("serves web UI document and module assets without auth when a server password is set", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    for (const path of ["/", "/index.html", "/assets/session.js"]) {
      const response = await uiApp({ password: "secret", username: "opencode" }).request(path)
      expect(response.status).not.toBe(401)
    }
  })

  test("accepts auth token for the web UI", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    const response = await uiApp({
      password: "secret",
      username: "chimera",
    }).request(`/?auth_token=${btoa("chimera:secret")}`)

    expect(response.status).toBe(503)
    expect(await response.text()).toContain("Chimera WebUI assets are not embedded")
  })

  test("accepts basic auth for the web UI", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    const response = await uiApp({ password: "secret", username: "chimera" }).request("/", {
      headers: { authorization: `Basic ${btoa("chimera:secret")}` },
    })

    expect(response.status).toBe(503)
  })

  // Regression for #25698 (Ope): the browser fetches the PWA manifest and
  // its icons via flows that don't carry app-managed credentials (the
  // `<link rel="manifest">` request is not under page-auth control), so the
  // server returning 401 breaks PWA install. These specific public assets
  // should bypass auth.
  test("serves the PWA manifest without auth even when a server password is set", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI = true

    for (const path of ["/site.webmanifest", "/web-app-manifest-192x192.png", "/web-app-manifest-512x512.png"]) {
      const response = await uiApp({
        password: "secret",
        username: "chimera",
      }).request(path)
      expect(response.status).not.toBe(401)
    }
  })

  test("allows web UI preflight without auth", async () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true

    const response = await app({ password: "secret", username: "chimera" }).request("/", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
  })
})
