// Ultra tier membership: which models advertise the `ultra` variant (highest
// declared reasoning effort plus proactive multi-agent delegation). Built-in
// defaults preserve out-of-the-box behavior; the `ultra_models` config key
// extends them. Entries match as case-insensitive substrings of the model id
// or api id.
export const DEFAULT_ULTRA_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "k3", "deepseek-v4-flash"]

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function nameCandidates(model: { id: string; api?: { id?: string } }) {
  const api = normalize(model.api?.id ?? "")
  return [normalize(model.id), api, api.split("/").at(-1) ?? ""].filter((candidate) => candidate.length > 0)
}

export function ultraModels(configured?: readonly string[]) {
  return [...DEFAULT_ULTRA_MODELS, ...(configured ?? [])].map(normalize).filter((entry) => entry.length > 0)
}

export function isUltraModel(model: { id: string; api?: { id?: string } }, configured?: readonly string[]) {
  const candidates = nameCandidates(model)
  return ultraModels(configured).some((entry) => candidates.some((candidate) => candidate.includes(entry)))
}

export * as ProviderUltra from "./ultra"
