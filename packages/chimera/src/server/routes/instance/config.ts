import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ConfigModelSelection } from "@/config/model-selection"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest, runRequest } from "./trace"
import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "server.config" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.get", c, function* () {
          const cfg = yield* Config.Service
          return yield* cfg.get()
        }),
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
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
        const result = await runRequest(
          "ConfigRoutes.update",
          c,
          Effect.gen(function* () {
            const config = c.req.valid("json")
            const cfg = yield* Config.Service
            yield* cfg.update(config)
            return { config, ctx: yield* InstanceState.context }
          }),
        )
        const response = c.json(result.config)
        void runRequest(
          "ConfigRoutes.update.dispose",
          c,
          InstanceStore.Service.use((store) => store.dispose(result.ctx)).pipe(
            Effect.uninterruptible,
            Effect.catchCause((cause) => Effect.sync(() => log.warn("instance disposal failed", { cause }))),
          ),
        )
        return response
      },
    )
    .get(
      "/model-selection",
      describeRoute({
        summary: "Get model selection",
        description: "Retrieve shared model selection state used by the Web UI and TUI.",
        operationId: "config.modelSelection.get",
        responses: {
          200: {
            description: "Get model selection",
            content: {
              "application/json": {
                schema: resolver(ConfigModelSelection.Info.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.modelSelection.get", c, function* () {
          return yield* Effect.promise(() => ConfigModelSelection.read())
        }),
    )
    .patch(
      "/model-selection",
      describeRoute({
        summary: "Update model selection",
        description: "Update shared model selection state used by the Web UI and TUI.",
        operationId: "config.modelSelection.update",
        responses: {
          200: {
            description: "Successfully updated model selection",
            content: {
              "application/json": {
                schema: resolver(ConfigModelSelection.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ConfigModelSelection.Patch.zod),
      async (c) =>
        jsonRequest("ConfigRoutes.modelSelection.update", c, function* () {
          const next = yield* Effect.promise(() => ConfigModelSelection.update(c.req.valid("json")))
          const bus = yield* Bus.Service
          yield* bus.publish(ConfigModelSelection.Updated, next)
          return next
        }),
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(Provider.ConfigProvidersResult.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.providers", c, function* () {
          const svc = yield* Provider.Service
          const providers = yield* svc.list()
          return {
            providers: Object.values(providers),
            default: Provider.defaultModelIDs(providers),
          }
        }),
    ),
)
