import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ConfigModelSelection } from "@/config/model-selection"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { RemoteCompaction } from "@/session/remote-compaction"
import { Session } from "@/session/session"
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
      "/remote-compaction/eligibility",
      describeRoute({
        summary: "List remote compaction eligibility",
        description: "List redacted provider and model eligibility for project-level remote compaction overrides.",
        operationId: "config.remoteCompaction.eligibility.list",
        responses: {
          200: {
            description: "Redacted remote compaction eligibility",
            content: { "application/json": { schema: resolver(RemoteCompaction.EligibilityList.zod) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.remoteCompaction.eligibility.list", c, function* () {
          const provider = yield* Provider.Service
          const config = yield* Config.Service
          return yield* RemoteCompaction.eligibilityList(yield* provider.list(), config)
        }),
    )
    .patch(
      "/remote-compaction/eligibility",
      describeRoute({
        summary: "Update remote compaction eligibility",
        description: "Persist a narrow provider and model remote compaction override for this project.",
        operationId: "config.remoteCompaction.eligibility.update",
        requestBody: { required: true, content: {} },
        responses: {
          200: {
            description: "Persisted redacted remote compaction eligibility",
            content: { "application/json": { schema: resolver(RemoteCompaction.Eligibility.zod) } },
          },
          400: {
            description: "Remote compaction eligibility request rejected",
            content: { "application/json": { schema: resolver(RemoteCompaction.EligibilityErrorResponse.zod) } },
          },
        },
      }),
      validator("json", RemoteCompaction.EligibilityPatch.zod),
      async (c) => {
        const result = await runRequest(
          "ConfigRoutes.remoteCompaction.eligibility.update",
          c,
          Effect.gen(function* () {
            const payload = c.req.valid("json")
            const rejected = (reason: RemoteCompaction.EligibilityErrorReason) => ({
              ok: false as const,
              error: RemoteCompaction.eligibilityError({
                providerID: payload.providerID,
                modelID: payload.modelID,
                reason,
              }),
            })
            if (Object.keys(payload).some((key) => !["providerID", "modelID", "enabled", "protocols"].includes(key)))
              return rejected("unknown_field")
            const providerSvc = yield* Provider.Service
            const providers = yield* providerSvc.list()
            const provider = providers[payload.providerID]
            if (!provider) return rejected("unknown_provider")
            const model = provider.models[payload.modelID]
            if (!model) return rejected("unknown_model")
            const config = yield* Config.Service
            if (!RemoteCompaction.eligibility(provider, model).configurable) return rejected("not_configurable")
            if (payload.enabled === null) {
              yield* config.remove([["provider", payload.providerID, "models", payload.modelID, "remote_compaction"]])
            } else {
              yield* config.update(RemoteCompaction.eligibilityConfigPatch(payload))
            }
            const instance = yield* InstanceState.context
            const store = yield* InstanceStore.Service
            yield* store.reload({
              directory: instance.directory,
              worktree: instance.directory,
              project: instance.project,
            })
            const refreshedProviders = yield* providerSvc.list()
            const refreshedProvider = refreshedProviders[payload.providerID] ?? provider
            const refreshedModel = refreshedProvider.models[payload.modelID] ?? model
            const context = yield* RemoteCompaction.eligibilityContext(config, payload)
            return {
              ok: true as const,
              eligibility: RemoteCompaction.eligibility(refreshedProvider, refreshedModel, context),
            }
          }),
        )
        if (!result.ok) return c.json(result.error, 400)
        return c.json(result.eligibility)
      },
    )
    .get(
      "/remote-compaction/status",
      describeRoute({
        summary: "Get remote compaction status",
        description: "Resolve remote compaction production eligibility and installed replay disposition.",
        operationId: "config.remoteCompaction.status",
        responses: {
          200: {
            description: "Remote compaction status",
            content: {
              "application/json": {
                schema: resolver(RemoteCompaction.Resolution.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", RemoteCompaction.StatusQuery.zod),
      async (c) =>
        jsonRequest("ConfigRoutes.remoteCompaction.status", c, function* () {
          const query = c.req.valid("query")
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(query.providerID, query.modelID)
          if (!query.sessionID) return yield* Effect.promise(() => RemoteCompaction.resolve({ model }))
          const sessions = yield* Session.Service
          const lock = yield* sessions.remoteCompactionLock(query.sessionID)
          return yield* Effect.promise(() =>
            RemoteCompaction.resolve({
              model,
              session: { sessionID: query.sessionID, lock },
            }),
          )
        }),
    )
    .get(
      "/remote-compaction",
      describeRoute({
        summary: "Get remote compaction policy",
        description: "Get effective remote compaction policy with redacted provenance and write-target metadata.",
        operationId: "config.remoteCompaction.get",
        responses: {
          200: {
            description: "Effective remote compaction policy",
            content: { "application/json": { schema: resolver(RemoteCompaction.Policy.zod) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.remoteCompaction.get", c, function* () {
          return yield* RemoteCompaction.policy(yield* Config.Service)
        }),
    )
    .patch(
      "/remote-compaction",
      describeRoute({
        summary: "Update remote compaction policy",
        description: "Update only the requested remote compaction policy and protocol.",
        operationId: "config.remoteCompaction.update",
        responses: {
          200: {
            description: "Resulting remote compaction policy",
            content: {
              "application/json": {
                schema: resolver(RemoteCompaction.Policy.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", RemoteCompaction.PolicyPatch.zod),
      async (c) => {
        const result = await runRequest(
          "ConfigRoutes.remoteCompaction.update",
          c,
          Effect.gen(function* () {
            const payload = c.req.valid("json")
            const config = yield* Config.Service
            const patch = Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] !== null))
            if (Object.keys(patch).length) yield* config.update({ compaction: patch } as Config.Info)
            yield* config.remove(
              Object.entries(payload)
                .filter((entry) => entry[1] === null)
                .map(([key]) => ["compaction", key]),
            )
            const instance = yield* InstanceState.context
            const store = yield* InstanceStore.Service
            yield* store.reload({
              directory: instance.directory,
              worktree: instance.directory,
              project: instance.project,
            })
            return yield* RemoteCompaction.policy(config)
          }),
        )
        return c.json(result)
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
