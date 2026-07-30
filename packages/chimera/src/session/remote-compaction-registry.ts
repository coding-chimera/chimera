import type { Provider } from "@/provider/provider"

/**
 * Built-in trusted model capability registry for remote compaction.
 *
 * Remote compaction is an OpenAI-native capability (Responses API + OAuth credential).
 * Only models listed here are considered truly capable of remote compaction.
 * Third-party relay providers (e.g. dahetao) may proxy this ability but are not
 * inherently trustworthy — eligibility is determined by the model, not the provider.
 *
 * To add a new model: append its API model ID (the `model.api.id` value used in
 * requests to the upstream endpoint) to the set below.
 */
const REMOTE_COMPACTION_CAPABLE_MODELS = new Set([
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
])

/**
 * Determine whether a model is truly capable of remote compaction based on the
 * built-in trusted registry. This checks `model.api.id` (the actual ID sent to
 * the upstream endpoint), not the provider ID.
 *
 * Handles versioned suffixes (e.g. `gpt-5.4-2026-03-05` matches `gpt-5.4`).
 */
export function isModelRemoteCompactionCapable(model: Provider.Model): boolean {
  const modelID = model.api.id
  if (REMOTE_COMPACTION_CAPABLE_MODELS.has(modelID)) return true
  // Prefix match for versioned suffixes: "gpt-5.4-2026-03-05" matches "gpt-5.4"
  for (const capable of REMOTE_COMPACTION_CAPABLE_MODELS) {
    if (modelID.startsWith(capable + "-")) return true
  }
  return false
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
