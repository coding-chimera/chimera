import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { ProjectID } from "@/project/schema"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SubagentModelCatalog } from "../agent/subagent-model-catalog"
import * as Tool from "./tool"
import DESCRIPTION from "./subagent_model_prefer.txt"

export { DESCRIPTION }

export const Parameters = Schema.Struct({
  scope: Schema.Literals(["global", "project"]).annotate({
    description: "Preference scope: global across projects or only this session's project.",
  }),
  target: Schema.Literals(["provider", "route"]).annotate({
    description: "Preference target: the provider generally or this exact model route.",
  }),
  provider: Schema.String.annotate({
    description: "Exact current provider ID for the validating route.",
  }),
  model_identity: Schema.String.annotate({
    description: "Exact current model identity for the validating route.",
  }),
  model: Schema.String.annotate({
    description: "Exact current provider/model route used for validation and task_model authorization.",
  }),
})

const validationMessage =
  'scope, target, provider, model_identity, and model are required. scope must be "global" or "project"; target must be "provider" or "route".'

type Mutation = "prefer" | "suppress"

export function makePreferenceMutationTool<const ID extends string>(id: ID, description: string, mutation: Mutation) {
  return Tool.define(
    id,
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const config = yield* Config.Service
      const session = yield* Session.Service
      const agents = yield* Agent.Service
      const routing = yield* ConfigSubagentRouting.Service

      return {
        description,
        parameters: Parameters,
        formatValidationError: () => validationMessage,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const agent = yield* agents.get(ctx.agent)
            if (!agent || agent.mode === "subagent") {
              return yield* Effect.fail(new Error(`${id} is available only to root sessions using a primary-capable agent.`))
            }

            const sessionInfo = yield* session.get(ctx.sessionID)
            if (sessionInfo.parentID) {
              return yield* Effect.fail(new Error(`${id} is unavailable in child sessions.`))
            }
            if (params.scope === "project" && sessionInfo.projectID === ProjectID.global) {
              return yield* Effect.fail(new Error("project scope cannot use the global project ID"))
            }
            if (
              params.provider.length === 0 ||
              params.model_identity.length === 0 ||
              params.model.length === 0 ||
              params.provider !== params.provider.trim() ||
              params.model_identity !== params.model_identity.trim() ||
              params.model !== params.model.trim()
            ) {
              return yield* Effect.fail(
                new Error("provider, model_identity, and model must be non-empty exact current values without surrounding whitespace"),
              )
            }

            const cfg = yield* config.get()
            const snap = yield* SubagentModelCatalog.withPreferences(
              SubagentModelCatalog.visible(
                SubagentModelCatalog.buildSnapshot({
                  providers: yield* provider.list(),
                  configuredProviders: cfg.provider,
                }),
                Permission.merge(agent.permission, sessionInfo.permission ?? []),
              ),
              sessionInfo.projectID,
              routing,
            )
            const route = snap.routes.find(
              (item) =>
                item.providerID === params.provider &&
                item.identity === params.model_identity &&
                item.model === params.model,
            )
            if (!route) {
              return yield* Effect.fail(
                new Error(
                  `No visible current route exactly matches provider ${JSON.stringify(params.provider)}, model identity ${JSON.stringify(params.model_identity)}, and model ${JSON.stringify(params.model)}. Inspect the current live routes and retry with one exact route.`,
                ),
              )
            }

            const scope: ConfigSubagentRouting.Scope =
              params.scope === "global"
                ? { type: "global" }
                : { type: "project", projectID: sessionInfo.projectID }
            const target: ConfigSubagentRouting.Target =
              params.target === "provider"
                ? { type: "provider", providerID: route.providerID }
                : {
                    type: "route",
                    identity: route.identity,
                    providerID: route.providerID,
                    model: route.model,
                  }
            const mutationPattern =
              params.target === "provider"
                ? `${params.scope}:provider:${route.providerID}`
                : `${params.scope}:route:${route.model}`
            const metadata = {
              scope: params.scope,
              target: params.target,
              provider: route.providerID,
              model_identity: route.identity,
              model: route.model,
            }

            yield* ctx.ask({
              permission: id,
              patterns: [mutationPattern],
              always: [mutationPattern],
              metadata,
            })
            yield* ctx.ask({
              permission: "task_model",
              patterns: [route.model],
              always: [route.model],
              metadata: { model: route.model },
            })

            yield* (mutation === "prefer" ? routing.prefer({ scope, target }) : routing.suppress({ scope, target }))

            const scopeLabel = params.scope === "global" ? "globally" : "for this project"
            const targetLabel = params.target === "provider" ? `provider ${route.providerID}` : `route ${route.model}`
            return {
              title: `${id}: ${targetLabel}`,
              output:
                mutation === "prefer"
                  ? `Recorded an explicit preference for ${targetLabel} ${scopeLabel}.`
                  : `Suppressed ${targetLabel} ${scopeLabel}.`,
              metadata: { mutation, ...metadata },
            }
          }).pipe(Effect.orDie),
      }
    }),
  )
}

export const SubagentModelPreferTool = makePreferenceMutationTool(
  "subagent_model_prefer",
  DESCRIPTION,
  "prefer",
)
