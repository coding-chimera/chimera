import type { Provider } from "@/provider/provider"

/**
 * Built-in trusted model capability defaults for remote compaction.
 *
 * Remote compaction is an OpenAI-native capability (Responses API + OAuth credential).
 * Only models listed here are considered truly capable of remote compaction.
 * Third-party relay providers (e.g. dahetao) may proxy this ability but are not
 * inherently trustworthy — eligibility is determined by the model, not the provider.
 *
 * The `remote_compaction_models` chimera.json config key extends these defaults.
 * Entries match the model api id exactly or as
 * a versioned prefix ("<entry>-..."), so "gpt-5.6" covers gpt-5.6-luna,
 * gpt-5.6-sol, and dated variants.
 *
 * To add a new trusted model: append its API model ID (the `model.api.id` value
 * used in requests to the upstream endpoint) to the list below.
 */
export const DEFAULT_REMOTE_COMPACTION_MODELS = [
  // GPT-5.6 series
  "gpt-5.6",
  // GPT-5.5 series
  "gpt-5.5",
  // GPT-5.4 series
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  // GPT-5.3 series
  "gpt-5.3-codex",
  // GPT-5.2 series
  "gpt-5.2",
  "gpt-5.2-codex",
  // GPT-5.1 series
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  // GPT-5 series
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-codex",
  "gpt-5-pro",
  // GPT-4.1 series
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  // GPT-4o series
  "gpt-4o",
  "gpt-4o-mini",
  // o-series (Responses API)
  "o1",
  "o1-mini",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "codex-mini",
  // New models: add here
]

function normalize(value: string) {
  return value.trim().toLowerCase()
}

export function remoteCompactionModels(configured?: readonly string[]) {
  return Array.from(
    new Set(
      [...DEFAULT_REMOTE_COMPACTION_MODELS, ...(configured ?? [])].map(normalize).filter((entry) => entry.length > 0),
    ),
  )
}

/**
 * Determine whether a model is truly capable of remote compaction based on the
 * built-in trusted defaults plus the `remote_compaction_models` config entries.
 * This checks `model.api.id` (the actual ID sent to the upstream endpoint),
 * not the provider ID.
 *
 * Handles versioned suffixes (e.g. `gpt-5.4-2026-03-05` matches `gpt-5.4`).
 */
export function isModelRemoteCompactionCapable(model: Provider.Model, configured?: readonly string[]) {
  const modelID = normalize(model.api.id)
  return remoteCompactionModels(configured).some((entry) => modelID === entry || modelID.startsWith(entry + "-"))
}

/**
 * Smart degradation: session-scoped failure tracking for non-OpenAI providers.
 *
 * When remote compaction fails repeatedly on a non-OpenAI provider (e.g. a
 * third-party relay that claims support but can't actually handle it), the
 * provider is marked degraded and subsequent resolves skip remote attempts.
 *
 * OpenAI native (OAuth credential) providers are exempt — they always retry.
 * The counter resets on success, on model switch, or on manual policy toggle.
 */
const REMOTE_COMPACTION_FAILURE_THRESHOLD = 3

type ProviderHealth = {
  failures: number
  degraded: boolean
}

const providerHealth = new Map<string, ProviderHealth>()

function healthKey(providerID: string): string {
  return providerID
}

/** Returns true if this provider has been marked degraded (too many failures). */
export function isProviderRemoteCompactionDegraded(providerID: string): boolean {
  return providerHealth.get(healthKey(providerID))?.degraded ?? false
}

/** Record a remote compaction failure for a non-OpenAI provider. */
export function recordRemoteCompactionFailure(providerID: string, isOAuth: boolean): void {
  if (isOAuth) return // OAuth providers always retry, no degradation
  const key = healthKey(providerID)
  const health = providerHealth.get(key) ?? { failures: 0, degraded: false }
  health.failures += 1
  if (health.failures >= REMOTE_COMPACTION_FAILURE_THRESHOLD) {
    health.degraded = true
  }
  providerHealth.set(key, health)
}

/** Reset failure counter on success or model/policy switch. */
export function resetRemoteCompactionHealth(providerID: string): void {
  providerHealth.delete(healthKey(providerID))
}
