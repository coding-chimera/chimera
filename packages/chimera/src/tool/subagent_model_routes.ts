import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { ProjectID } from "@/project/schema"
import { NotFoundError } from "@/storage/storage"
import { SubagentModelCatalog } from "../agent/subagent-model-catalog"
import * as Tool from "./tool"
import DESCRIPTION from "./subagent_model_routes.txt"
export { DESCRIPTION }

export const Parameters = Schema.Struct({
  model_identity: Schema.String.annotate({
    description: "Model identity to inspect current visible concrete routes for.",
  }),
  provider: Schema.optional(Schema.String).annotate({
    description: "Optional provider ID to narrow the route listing to one provider.",
  }),
})

export interface RouteQuery {
  modelIdentity: string
  provider?: string
}

export interface ProjectedRoute {
  providerID: string
  model: string
  variants: string[]
  source: SubagentModelCatalog.ModelRoute["source"]
  preferred: boolean
  dormant: boolean
  suppressed: boolean
}

export interface RouteToolMetadata {
  modelIdentity: string
  routes: ProjectedRoute[]
  suggestions: SubagentModelCatalog.IdentitySummary[]
}

function formatHit(modelIdentity: string, routes: SubagentModelCatalog.ModelRoute[]) {
  const lines = routes.map(
    (route) =>
      `- ${route.model} (provider: ${route.providerID}, variants: ${
        route.variants.length > 0 ? route.variants.join(", ") : "none"
      }, source: ${route.source}, preferred: ${route.preferred}, dormant: ${route.dormant}, suppressed: ${route.suppressed})`,
  )
  const suppressed = routes.some((route) => route.suppressed)
    ? "\nA suppressed route is shown only because provider narrowing was explicit. Use subagent_model_prefer only after the user explicitly confirms restoration."
    : ""
  return `identity: ${modelIdentity}\n${lines.join("\n")}${suppressed}`
}

function formatMiss(modelIdentity: string, suggestions: SubagentModelCatalog.IdentitySummary[]) {
  const suggestionText =
    suggestions.length > 0
      ? `Current identity suggestions (up to 3): ${suggestions.map((item) => item.identity).join(", ")}`
      : "No current identity suggestions."
  return `No visible current route for model identity ${JSON.stringify(modelIdentity)}.\n${suggestionText}`
}

export function queryRoutes(
  snap: SubagentModelCatalog.Snapshot,
  query: RouteQuery,
): { output: string; metadata: RouteToolMetadata } {
  const matches = SubagentModelCatalog.routes(snap, {
    ...query,
    includeSuppressed: query.provider !== undefined,
  })
  const suggestions = SubagentModelCatalog.suggest(snap, query.modelIdentity, 3)
  if (matches.length === 0) {
    return {
      output: formatMiss(query.modelIdentity, suggestions),
      metadata: { modelIdentity: query.modelIdentity, routes: [], suggestions },
    }
  }
  return {
    output: formatHit(query.modelIdentity, matches),
    metadata: {
      modelIdentity: query.modelIdentity,
      routes: matches.map((route) => ({
        providerID: route.providerID,
        model: route.model,
        variants: [...route.variants],
        source: route.source,
        preferred: route.preferred,
        dormant: route.dormant,
        suppressed: route.suppressed,
      })),
      suggestions: [],
    },
  }
}

export const SubagentModelRoutesTool = Tool.define(
  "subagent_model_routes",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const routing = yield* ConfigSubagentRouting.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          const sessionInfo = yield* session
            .get(ctx.sessionID)
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
          const providers = yield* provider.list()
          const cfg = yield* config.get()
          const snap = yield* SubagentModelCatalog.withPreferences(
            SubagentModelCatalog.visible(
              SubagentModelCatalog.buildSnapshot({ providers, configuredProviders: cfg.provider }),
              Permission.merge(agent.permission, sessionInfo?.permission ?? []),
            ),
            sessionInfo?.projectID ?? ProjectID.global,
            routing,
          )
          const result = queryRoutes(snap, { modelIdentity: params.model_identity, provider: params.provider })
          return { ...result, title: `subagent_model_routes: ${params.model_identity}` }
        }).pipe(Effect.orDie),
    }
  }),
)
