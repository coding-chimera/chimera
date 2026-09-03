import { Effect, Schema } from "effect"
import fuzzysort from "fuzzysort"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { ProjectID } from "@/project/schema"
import { Provider } from "@/provider/provider"
import { ModelIdentity } from "../provider/model-identity"
import { resolveSizeClass, type SizeClass } from "./subagent-model-size"

export interface ModelRoute {
  identity: string
  identityConfidence: ModelIdentity.IdentityConfidence
  providerID: string
  modelID: string
  model: string
  name: string
  variants: string[]
  sizeClass?: SizeClass
  source: Provider.Info["source"]
  dormant: boolean
  preferred: boolean
  suppressed: boolean
}

export interface IdentitySummary {
  identity: string
  identityConfidence: ModelIdentity.IdentityConfidence
  routeCount: number
  providerIDs: string[]
  variants: string[]
  preferredProviderID?: string
}

export interface Snapshot {
  routes: ModelRoute[]
  identities: IdentitySummary[]
}

export interface ModelRouteIntent {
  modelIdentity: string
  provider?: string
}

export const ModelRouteOption = Schema.Struct({
  providerID: Schema.String,
  model: Schema.String,
  variants: Schema.Array(Schema.String),
})
export type ModelRouteOption = Schema.Schema.Type<typeof ModelRouteOption>

export class ModelRouteNotFoundError extends Schema.TaggedErrorClass<ModelRouteNotFoundError>()(
  "SubagentModelRouteNotFoundError",
  {
    identity: Schema.String,
    provider: Schema.optional(Schema.String),
    suggestions: Schema.Array(Schema.String),
  },
) {
  override get message() {
    const provider = this.provider === undefined ? "" : ` for provider ${JSON.stringify(this.provider)}`
    const suggestions = this.suggestions.length === 0 ? "none" : this.suggestions.join(", ")
    return `No visible current route for model identity ${JSON.stringify(this.identity)}${provider}. Current identity suggestions: ${suggestions}.`
  }
}

export class ModelRouteAmbiguousError extends Schema.TaggedErrorClass<ModelRouteAmbiguousError>()(
  "SubagentModelRouteAmbiguousError",
  {
    identity: Schema.String,
    routes: Schema.Array(ModelRouteOption),
    reason: Schema.Literals(["multiple-providers", "multiple-deployments", "provider-required"]),
  },
) {
  override get message() {
    return `Model identity ${JSON.stringify(this.identity)} is ambiguous (${this.reason}). Current concrete routes: ${JSON.stringify(this.routes)}. Use the question tool with these exact current options, or retry with provider/model narrowing.`
  }
}

export interface BuildSnapshotInput {
  providers: Record<string, Provider.Info>
  configuredProviders?: Config.Info["provider"]
}

interface CatalogItem {
  route: ModelRoute
  input: ModelIdentity.ModelIdentityInput
}

const log = Log.create({ service: "subagent-model-catalog" })

const CONFIDENCE_RANK: Record<ModelIdentity.IdentityConfidence, number> = {
  "provider-scoped": 0,
  "api-exact": 1,
  explicit: 2,
}

export const DISCLOSURE_MAX_CHARS = 4000

function summarize(items: ModelRoute[]): IdentitySummary[] {
  const groups = new Map<string, IdentitySummary>()
  for (const route of items) {
    const existing = groups.get(route.identity)
    if (!existing) {
      groups.set(route.identity, {
        identity: route.identity,
        identityConfidence: route.identityConfidence,
        routeCount: 1,
        providerIDs: [route.providerID],
        variants: [...route.variants],
        preferredProviderID: route.preferred ? route.providerID : undefined,
      })
      continue
    }
    existing.routeCount += 1
    if (!existing.providerIDs.includes(route.providerID)) existing.providerIDs.push(route.providerID)
    for (const variant of route.variants) if (!existing.variants.includes(variant)) existing.variants.push(variant)
    if (route.preferred) existing.preferredProviderID = route.providerID
    if (CONFIDENCE_RANK[route.identityConfidence] > CONFIDENCE_RANK[existing.identityConfidence]) {
      existing.identityConfidence = route.identityConfidence
    }
  }
  return [...groups.values()]
    .map((item) => ({ ...item, providerIDs: item.providerIDs.toSorted(), variants: item.variants.toSorted() }))
    .sort((a, b) => a.identity.localeCompare(b.identity) || a.identityConfidence.localeCompare(b.identityConfidence))
}

export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const configured = input.configuredProviders ?? {}
  const items: CatalogItem[] = Object.entries(input.providers).flatMap(([providerID, provider]) =>
    Object.entries(provider.models ?? {}).flatMap(([modelID, model]) => {
      if (
        !(
          model.capabilities?.input?.text === true &&
          model.capabilities?.output?.text === true &&
          model.capabilities?.toolcall === true
        )
      )
        return []
      const modelInput: ModelIdentity.ModelIdentityInput = {
        providerID,
        modelID,
        apiID: model.api?.id,
        explicitCapabilityModelID: configured[providerID]?.models?.[modelID]?.capability_model_id,
      }
      const resolved = ModelIdentity.resolve(modelInput)
      return [
        {
          route: {
            identity: resolved.identity,
            identityConfidence: resolved.identityConfidence,
            providerID,
            modelID,
            model: `${providerID}/${modelID}`,
            name: model.name,
            variants: Object.keys(model.variants ?? {}).sort(),
            sizeClass: resolveSizeClass({
              identity: resolved.identity,
              configured: configured[providerID]?.models?.[modelID]?.size_class,
            }),
            source: provider.source,
            dormant: false,
            preferred: false,
            suppressed: false,
          },
          input: modelInput,
        },
      ]
    }),
  )
  const routes = items
    .map((item) => item.route)
    .sort(
      (a, b) =>
        a.identity.localeCompare(b.identity) ||
        a.identityConfidence.localeCompare(b.identityConfidence) ||
        a.providerID.localeCompare(b.providerID) ||
        a.modelID.localeCompare(b.modelID),
    )
  const identities = summarize(routes)
  return { routes, identities }
}

export const snapshot = Effect.fn("SubagentModelCatalog.snapshot")(function* () {
  const provider = yield* Provider.Service
  const providers = yield* provider.list()
  const config = yield* Config.Service
  const cfg = yield* config.get()
  return buildSnapshot({ providers, configuredProviders: cfg.provider })
})

export function visible(snap: Snapshot, ruleset: Permission.Ruleset): Snapshot {
  const routes = snap.routes
    .filter((route) => Permission.evaluate("task_model", route.model, ruleset).action !== "deny")
    .map((route) => ({ ...route, variants: [...route.variants] }))
  return { routes, identities: summarize(routes) }
}

type PreferenceRank = { tier: number; score: number }

function latestEvent(entry: ConfigSubagentRouting.Entry | undefined) {
  if (!entry) return undefined
  const preference = entry.preference?.revision ?? -1
  const suppression = entry.suppressedRevision ?? -1
  if (preference < 0 && suppression < 0) return undefined
  return suppression >= preference
    ? { revision: suppression, suppressed: true }
    : { revision: preference, suppressed: false }
}

function preferenceView(route: ModelRoute, state: ConfigSubagentRouting.State, projectID: ProjectID) {
  const project = projectID === ProjectID.global ? undefined : state.projects[projectID]
  const projectActivity = state.activity.projects[projectID] ?? 0
  const candidates = [
    {
      tier: 4,
      activity: projectActivity,
      entry: ConfigSubagentRouting.routeEntry(project, route.identity, route.model),
      routeSpecific: true,
    },
    {
      tier: 3,
      activity: state.activity.global,
      entry: ConfigSubagentRouting.routeEntry(state.global, route.identity, route.model),
      routeSpecific: true,
    },
    {
      tier: 2,
      activity: projectActivity,
      entry: ConfigSubagentRouting.providerEntry(project, route.providerID),
      routeSpecific: false,
    },
    {
      tier: 1,
      activity: state.activity.global,
      entry: ConfigSubagentRouting.providerEntry(state.global, route.providerID),
      routeSpecific: false,
    },
  ]
  const effective = candidates.find((candidate) => latestEvent(candidate.entry) !== undefined)
  if (!effective) return { rank: undefined, dormant: false, suppressed: false }
  const event = latestEvent(effective.entry)!
  if (event.suppressed) return { rank: undefined, dormant: false, suppressed: true }
  const value = ConfigSubagentRouting.score(effective.entry?.preference, effective.activity)
  const active = value > ConfigSubagentRouting.DEFAULT_POLICY.dormantScore
  return {
    rank: active ? { tier: effective.tier, score: value } : undefined,
    dormant: !active,
    suppressed: false,
  }
}

export function applyPreferences(snap: Snapshot, state: ConfigSubagentRouting.State, projectID: ProjectID): Snapshot {
  const views = snap.routes.map((route) => ({ route, ...preferenceView(route, state, projectID) }))
  const winners = new Set<string>()
  const groups = Map.groupBy(views, (item) => item.route.identity)
  for (const items of groups.values()) {
    const ranked = items
      .filter((item) => !item.suppressed && !item.dormant && item.rank)
      .sort(
        (a, b) =>
          b.rank!.tier - a.rank!.tier ||
          b.rank!.score - a.rank!.score ||
          a.route.providerID.localeCompare(b.route.providerID) ||
          a.route.modelID.localeCompare(b.route.modelID),
      )
    const first = ranked[0]
    const second = ranked[1]
    if (!first) continue
    if (second && first.rank!.tier === second.rank!.tier && first.rank!.score === second.rank!.score) continue
    winners.add(first.route.model)
  }
  const routes = views
    .map((item) => ({
      ...item.route,
      dormant: item.dormant,
      preferred: winners.has(item.route.model),
      suppressed: item.suppressed,
      variants: [...item.route.variants],
    }))
    .sort(
      (a, b) =>
        a.identity.localeCompare(b.identity) ||
        Number(b.preferred) - Number(a.preferred) ||
        Number(a.dormant) - Number(b.dormant) ||
        Number(a.suppressed) - Number(b.suppressed) ||
        a.providerID.localeCompare(b.providerID) ||
        a.modelID.localeCompare(b.modelID),
    )
  return { routes, identities: summarize(routes.filter((route) => !route.dormant && !route.suppressed)) }
}

export const withPreferences = Effect.fn("SubagentModelCatalog.withPreferences")(function* (
  snap: Snapshot,
  projectID: ProjectID,
  routing: ConfigSubagentRouting.Interface,
  ) {
  const state = yield* routing.get().pipe(
    Effect.catchTag("SubagentRoutingStateFileError", (error) =>
      Effect.sync(() => {
        log.warn("ignoring invalid subagent routing state", { operation: error.operation })
        return ConfigSubagentRouting.empty()
      }),
    ),
  )
  return applyPreferences(snap, state, projectID)
})

export function disclosure(snap: Snapshot, maxChars = DISCLOSURE_MAX_CHARS): string | undefined {
  if (snap.identities.length === 0) return undefined
  const prefix = "## Available Subagent Model Identities\n\n"
  const footer = "\nUse `subagent_model_routes` to inspect current concrete routes before choosing a provider."
  const lines = snap.identities.map((identity) => {
    const preferred = identity.preferredProviderID ? `; preferred ${identity.preferredProviderID}` : ""
    const variants = identity.variants.length > 0 ? `; variants: ${identity.variants.join(", ")}` : ""
    return `- ${JSON.stringify(identity.identity)}: ${identity.routeCount} ${identity.routeCount === 1 ? "route" : "routes"}${variants}${preferred}`
  })
  for (let included = lines.length; included >= 0; included--) {
    const omitted = lines.length - included
  const omittedLine = omitted > 0 ? `\n- ${omitted} ${omitted === 1 ? "identity" : "identities"} omitted by the ${maxChars}-character budget.` : ""
    const text = `${prefix}${lines.slice(0, included).join("\n")}${omittedLine}${footer}`
    if (text.length <= maxChars) return text
  }
  return undefined
}

export function disclosureProjection(snap: Snapshot): string {
  return JSON.stringify(
    snap.routes.map((route) => ({
      identity: route.identity,
      providerID: route.providerID,
      modelID: route.modelID,
      variants: route.variants,
      preferred: route.preferred,
      dormant: route.dormant,
      suppressed: route.suppressed,
    })),
  )
}

export function routes(
  snap: Snapshot,
  query: { modelIdentity: string; provider?: string; includeSuppressed?: boolean },
): ModelRoute[] {
  const identity = ModelIdentity.normalize(query.modelIdentity)
  return snap.routes.filter(
    (route) =>
      ModelIdentity.normalize(route.identity) === identity &&
      (query.provider === undefined || route.providerID === query.provider) &&
      (query.includeSuppressed === true || !route.suppressed),
  )
}

export const resolveRoute = Effect.fn("SubagentModelCatalog.resolveRoute")(function* (
  snap: Snapshot,
  intent: ModelRouteIntent,
) {
  const identity = ModelIdentity.normalize(intent.modelIdentity)
  const provider = intent.provider?.trim()
  const matches = routes(snap, { modelIdentity: intent.modelIdentity, provider })
  if (!identity || matches.length === 0) {
    return yield* new ModelRouteNotFoundError({
      identity: intent.modelIdentity,
      provider,
      suggestions: suggest(snap, intent.modelIdentity, 3).map((item) => item.identity),
    })
  }
  if (matches.length === 1) return matches[0]
  const preferred = matches.filter((route) => route.preferred)
  if (preferred.length === 1) return preferred[0]
  return yield* new ModelRouteAmbiguousError({
    identity,
    routes: matches.map((route) => ({
      providerID: route.providerID,
      model: route.model,
      variants: [...route.variants],
    })),
    reason: new Set(matches.map((route) => route.providerID)).size > 1 ? "multiple-providers" : "multiple-deployments",
  })
})


export function suggest(snap: Snapshot, query: string, limit = 3): IdentitySummary[] {
  const results = fuzzysort.go(query, snap.identities, { key: "identity" })
  return results
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.target.localeCompare(b.target))
    .slice(0, Math.max(0, limit))
    .map((result) => result.obj)
}

export * as SubagentModelCatalog from "./subagent-model-catalog"
