import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { createGlobalEventStream } from "../global-event-stream"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { lazy } from "../../util/lazy"
import { Config } from "@/config/config"
import { errors } from "../error"
import { disposeAllInstancesAndEmitGlobalDisposed } from "../global-lifecycle"
import { WebUIPreferences } from "@/server/webui-preferences"
import "@/server/event"

const log = Log.create({ service: "server" })

async function streamEvents(c: Context) {
  return streamSSE(c, async (stream) => {
    const subscription = createGlobalEventStream()
    stream.onAbort(subscription.close)

    try {
      for await (const event of subscription.events) {
        await stream.writeSSE({ data: JSON.stringify(event) })
      }
    } finally {
      subscription.close()
      log.info("global event disconnected")
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: InstallationVersion })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: z.union([...BusEvent.payloads(), ...SyncEvent.payloads()]),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamEvents(c)
      },
    )
    .get(
      "/preferences",
      describeRoute({
        summary: "Get WebUI preferences",
        description: "Retrieve the server-global shared WebUI preferences snapshot.",
        operationId: "global.preferences.get",
        responses: {
          200: {
            description: "WebUI preferences snapshot",
            content: {
              "application/json": {
                schema: resolver(WebUIPreferences.Snapshot.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        c.json(await AppRuntime.runPromise(WebUIPreferences.Service.use((preferences) => preferences.get()))),
    )
    .put(
      "/preferences",
      describeRoute({
        summary: "Update WebUI preferences",
        description: "Replace the server-global shared WebUI preferences using revision compare-and-swap.",
        operationId: "global.preferences.update",
        responses: {
          200: {
            description: "Updated WebUI preferences snapshot",
            content: {
              "application/json": {
                schema: resolver(WebUIPreferences.Snapshot.zod),
              },
            },
          },
          409: {
            description: "WebUI preferences revision conflict",
            content: {
              "application/json": {
                schema: resolver(WebUIPreferences.RevisionConflictError.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", WebUIPreferences.Update.zod),
      async (c) => {
        const result = await AppRuntime.runPromise(
          WebUIPreferences.Service.use((preferences) => preferences.update(c.req.valid("json"))).pipe(
            Effect.map((snapshot) => ({ success: true as const, snapshot })),
            Effect.catchIf(
              (error) => error instanceof WebUIPreferences.RevisionConflictError,
              (error) => Effect.succeed({ success: false as const, error }),
            ),
          ),
        )
        if (!result.success) return c.json(result.error, 409)
        return c.json(result.snapshot)
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        const result = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.updateGlobal(config)))
        if (result.changed) {
          void AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })).catch(
            () => undefined,
          )
        }
        return c.json(result.info)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed())
        return c.json(true)
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade opencode",
        description: "Upgrade opencode to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const result = await AppRuntime.runPromise(
          Installation.Service.use((svc) =>
            Effect.gen(function* () {
              const method = yield* svc.method()
              if (method === "unknown") {
                return { success: false as const, status: 400 as const, error: "Unknown installation method" }
              }

              const target = c.req.valid("json").target || (yield* svc.latest(method))
              const result = yield* Effect.catch(
                svc.upgrade(method, target).pipe(Effect.as({ success: true as const, version: target })),
                (err) =>
                  Effect.succeed({
                    success: false as const,
                    status: 500 as const,
                    error: err instanceof Error ? err.message : String(err),
                  }),
              )
              if (!result.success) return result
              return { ...result, status: 200 as const }
            }),
          ),
        )
        if (!result.success) {
          return c.json({ success: false, error: result.error }, result.status)
        }
        const target = result.version
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: target },
          },
        })
        return c.json({ success: true, version: target })
      },
    ),
)
