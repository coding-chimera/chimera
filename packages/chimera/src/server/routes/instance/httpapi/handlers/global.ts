import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Installation } from "@/installation"
import { sharedGlobalEventStream } from "@/server/global-event-stream"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { WebUIPreferences } from "@/server/webui-preferences"
import { InstanceStore } from "@/project/instance-store"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Global } from "@opencode-ai/core/global"
import { BrowserArtifact } from "@/browser/artifact"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { GlobalPresenceInput, GlobalUpgradeInput } from "../groups/global"

const log = Log.create({ service: "server" })

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  const subscription = sharedGlobalEventStream().subscribe()
  if (!subscription) {
    log.warn("global event connection rejected: connection limit reached")
    return HttpServerResponse.jsonUnsafe(
      { ok: false, error: "Too many global event connections" },
      { status: 429 },
    )
  }
  log.info("global event connected")

  return HttpServerResponse.stream(
    Stream.fromAsyncIterable(subscription.frames, (error) =>
      error instanceof Error ? error : new Error(String(error)),
    ).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          subscription.close()
          log.info("global event disconnected")
        }),
      ),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const preferences = yield* WebUIPreferences.Service
    const instances = yield* InstanceStore.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse()
    })

    const preferencesGet = Effect.fn("GlobalHttpApi.preferencesGet")(function* () {
      return yield* preferences.get()
    })

    const preferencesUpdateRaw = Effect.fn("GlobalHttpApi.preferencesUpdateRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const contentType = ctx.request.headers["content-type"]
      const json = contentType?.includes("application/json")
        ? parseBody(yield* Effect.orDie(ctx.request.text))
        : {}
      if (json === undefined) return HttpServerResponse.text("Malformed JSON in request body", { status: 400 })
      const payload = WebUIPreferences.Update.zod.safeParse(json)
      if (!payload.success) {
        return HttpServerResponse.jsonUnsafe(
          { data: json, error: payload.error.issues, success: false },
          { status: 400 },
        )
      }
      const result = yield* preferences.update(payload.data).pipe(
        Effect.map((snapshot) => ({ success: true as const, snapshot })),
        Effect.catchIf(
          (error) => error instanceof WebUIPreferences.RevisionConflictError,
          (error) => Effect.succeed({ success: false as const, error }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result.error, { status: 409 })
      return HttpServerResponse.jsonUnsafe(result.snapshot)
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    // Raw handler (house pattern for validated POST/PUT in this group, matching
    // preferencesUpdateRaw/upgradeRaw): keeps malformed and schema-invalid bodies at 400
    // instead of transport-level decode defects, aligned with the Hono zod validator.
    const presenceRaw = Effect.fn("GlobalHttpApi.presenceRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ ok: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalPresenceInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ ok: false, error: "Invalid request body" }, { status: 400 })
      }
      yield* instances.presence(payload.payload.directories)
      return HttpServerResponse.jsonUnsafe({ ok: true })
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    // Raw handler: serves binary artifact bytes and traversal-safe 404s, which
    // the request/response HttpApi serialization model cannot express. handleRaw
    // exposes no decoded path params, so the trailing segments are taken from the
    // request URL (filenames and hashes are URL-safe by construction).
    const browserArtifactRaw = Effect.fn("GlobalHttpApi.browserArtifactRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const parts = new URL(ctx.request.url, "http://localhost").pathname.split("/").filter(Boolean).slice(-3)
      const decoded = parts.length === 3 ? parts.map(decodeURIComponentSafe) : undefined
      const resolved = decoded
        ? BrowserArtifact.resolveArtifactFile(Global.Path.data, decoded[0]!, decoded[1]!, decoded[2]!)
        : undefined
      if (!resolved) return HttpServerResponse.text("Not found", { status: 404 })
      const bytes = yield* Effect.promise(() => Bun.file(resolved.path).arrayBuffer()).pipe(Effect.orDie)
      return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
        contentType: resolved.mime,
        headers: {
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        },
      })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("preferencesGet", preferencesGet)
      .handleRaw("preferencesUpdate", preferencesUpdateRaw)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("presence", presenceRaw)
      .handleRaw("upgrade", upgradeRaw)
      .handleRaw("browserArtifact", browserArtifactRaw)
  }),
)
