const MODEL_TIMEOUT = 5_000

type ModelFetch = (input: string, init: RequestInit) => Promise<Response>

function cleanBaseURL(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) return
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.toString().replace(/\/+$/, "")
  } catch {
    return
  }
}

function modelURL(baseURL: string) {
  return `${baseURL.replace(/\/+$/, "")}/models`
}

export function normalizeOpenAICompatibleBaseURL(value: string) {
  return cleanBaseURL(value)
}

export function openAICompatibleModelBaseURLCandidates(value: string) {
  const baseURL = cleanBaseURL(value)
  if (!baseURL) return []
  const candidates = [baseURL]
  if (!new URL(baseURL).pathname.replace(/\/+$/, "").endsWith("/v1")) candidates.push(`${baseURL}/v1`)
  return Array.from(new Set(candidates))
}

export function parseOpenAICompatibleModels(value: unknown) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : value && typeof value === "object" && Array.isArray((value as { models?: unknown }).models)
        ? (value as { models: unknown[] }).models
        : []
  return Array.from(
    new Set(
      source.flatMap((item) => {
        if (typeof item === "string") return [item.trim()]
        if (!item || typeof item !== "object") return []
        const id = (item as { id?: unknown; name?: unknown; model?: unknown }).id
        if (typeof id === "string") return [id.trim()]
        const model = (item as { model?: unknown }).model
        if (typeof model === "string") return [model.trim()]
        const name = (item as { name?: unknown }).name
        if (typeof name === "string") return [name.trim()]
        return []
      }),
    ),
  ).filter(Boolean)
}

export async function discoverOpenAICompatibleModels(input: {
  baseURL: string
  token?: string
  fetch?: ModelFetch
  timeout?: number
}) {
  const candidates = openAICompatibleModelBaseURLCandidates(input.baseURL)
  const fn: ModelFetch = input.fetch ?? fetch
  const errors: string[] = []
  for (const baseURL of candidates) {
    try {
      const response = await fn(modelURL(baseURL), {
        headers: {
          Accept: "application/json",
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
        signal: AbortSignal.timeout(input.timeout ?? MODEL_TIMEOUT),
      })
      if (!response.ok) {
        errors.push(`${baseURL}: ${response.status}`)
        continue
      }
      const models = parseOpenAICompatibleModels(await response.json())
      if (models.length > 0) return { baseURL, models }
      errors.push(`${baseURL}: no models`)
    } catch (error) {
      errors.push(`${baseURL}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(errors.join("; ") || "No model endpoint candidates")
}

export function suggestOpenAICompatibleProviderID(value: string) {
  const baseURL = cleanBaseURL(value)
  if (!baseURL) return "custom-openai"
  const url = new URL(baseURL)
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return "local-llm"
  const parts = url.hostname.split(".").filter((part) => part && part !== "www")
  const core = parts[0] === "api" && parts[1] ? parts[1] : parts[0]
  const providerID = (core ?? "custom-openai")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return providerID || "custom-openai"
}
