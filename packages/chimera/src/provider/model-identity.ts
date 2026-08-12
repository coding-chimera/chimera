export type IdentityConfidence = "explicit" | "api-exact" | "provider-scoped"

export interface ModelIdentityInput {
  providerID: string
  modelID: string
  apiID?: string
  explicitCapabilityModelID?: string
}

export interface ResolvedIdentity {
  key: string
  identity: string
  identityConfidence: IdentityConfidence
}

export interface IdentityGroup<T extends ModelIdentityInput = ModelIdentityInput> {
  key: string
  identity: string
  identityConfidence: IdentityConfidence
  routes: T[]
}

const CONFIDENCE_RANK: Record<IdentityConfidence, number> = {
  "provider-scoped": 0,
  "api-exact": 1,
  explicit: 2,
}

export function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  return normalized
}

export function identityKey(identity: string): string {
  return JSON.stringify(["identity", identity])
}

export function providerScopedKey(providerID: string, modelID: string): string {
  return JSON.stringify(["provider-scoped", providerID, modelID])
}

export function providerScopedIdentity(providerID: string, modelID: string): string {
  return `route:${encodeURIComponent(providerID)}/${encodeURIComponent(modelID)}`
}

export function resolve(input: ModelIdentityInput): ResolvedIdentity {
  const explicit = normalize(input.explicitCapabilityModelID)
  if (explicit) {
    return { key: identityKey(explicit), identity: explicit, identityConfidence: "explicit" }
  }
  const api = normalize(input.apiID)
  if (api) {
    return { key: identityKey(api), identity: api, identityConfidence: "api-exact" }
  }
  const providerID = normalize(input.providerID) ?? ""
  const modelID = normalize(input.modelID) ?? ""
  return {
    key: providerScopedKey(providerID, modelID),
    identity: providerScopedIdentity(providerID, modelID),
    identityConfidence: "provider-scoped",
  }
}

interface SortableRoute<T extends ModelIdentityInput> {
  route: T
  providerID: string
  modelID: string
  resolved: ResolvedIdentity
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function compareSortable<T extends ModelIdentityInput>(a: SortableRoute<T>, b: SortableRoute<T>): number {
  return compareStrings(a.providerID, b.providerID) || compareStrings(a.modelID, b.modelID)
}

function compareRoutes<T extends ModelIdentityInput>(a: T, b: T): number {
  return (
    compareStrings(normalize(a.providerID) ?? "", normalize(b.providerID) ?? "") ||
    compareStrings(normalize(a.modelID) ?? "", normalize(b.modelID) ?? "")
  )
}

export function group<T extends ModelIdentityInput>(routes: T[]): IdentityGroup<T>[] {
  const sorted = routes
    .map((route) => ({
      route,
      providerID: normalize(route.providerID) ?? "",
      modelID: normalize(route.modelID) ?? "",
      resolved: resolve(route),
    }))
    .sort(compareSortable)
  const groups = new Map<string, IdentityGroup<T>>()
  for (const item of sorted) {
    const existing = groups.get(item.resolved.key)
    if (!existing) {
      groups.set(item.resolved.key, {
        key: item.resolved.key,
        identity: item.resolved.identity,
        identityConfidence: item.resolved.identityConfidence,
        routes: [item.route],
      })
      continue
    }
    existing.routes.push(item.route)
    if (CONFIDENCE_RANK[item.resolved.identityConfidence] > CONFIDENCE_RANK[existing.identityConfidence]) {
      existing.identityConfidence = item.resolved.identityConfidence
    }
  }
  return [...groups.values()].sort(
    (a, b) => compareStrings(a.identity, b.identity) || compareRoutes(a.routes[0], b.routes[0]),
  )
}

export * as ModelIdentity from "./model-identity"
