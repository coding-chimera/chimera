import { CODEX_MODEL_PROFILES, type CodexProfile } from "./model-defaults"

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

// The codex profile table lives in model-defaults.ts (L4.3 built-in default
// data table); config layers override efforts through the `configured`
// argument of reasoningEfforts() below.
const profiles = CODEX_MODEL_PROFILES
type Profile = CodexProfile

function modelID(value: string) {
  return (value.toLowerCase().split("/").at(-1) ?? value.toLowerCase()).replace(/^openai[._:-]+/, "")
}

export function capabilityModelID(value: string) {
  const id = modelID(value)
  if (profiles[id]) return id
  return Object.entries(profiles).find(([base, profile]) =>
    profile.aliases?.some((suffix) => id === `${base}-${suffix}`),
  )?.[0]
}

export function profile(value: string) {
  const id = capabilityModelID(value)
  return id ? profiles[id] : undefined
}

export function normalizeReasoningEfforts(values: readonly unknown[] | undefined) {
  if (!values) return []
  return Array.from(
    new Set(
      values.filter(
        (value): value is ReasoningEffort =>
          typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort),
      ),
    ),
  )
}
export function highestReasoningEffort(efforts: readonly string[]) {
  return REASONING_EFFORTS.filter((effort) => efforts.includes(effort)).at(-1)
}

export function reasoningEfforts(capabilityID: string, configured?: readonly unknown[]) {
  const current = profile(capabilityID)
  const preferred = current?.codexEfforts
  if (!preferred || (current.requiresConfiguredEfforts && configured === undefined)) return []
  const available = configured === undefined ? undefined : normalizeReasoningEfforts(configured)
  const efforts = available ? preferred.filter((effort) => available.includes(effort)) : [...preferred]
  if (!efforts.length) return efforts
  return [...efforts, "ultra"]
}

export function smallReasoningEffort(capabilityID: string, configured?: readonly unknown[]) {
  const efforts = reasoningEfforts(capabilityID, configured)
  if (efforts.includes("low")) return "low"
  return efforts.find((effort) => effort !== "ultra")
}

// The version fallback regex is unanchored (upstream terminal state): unknown
// suffixed variants of allowed generations (e.g. gpt-6.0-astra) pass, matching
// upstream. The fork's previous `$` anchor doubled as the only gate keeping
// paid-API-only suffixed variants (gpt-5.5-pro) out of Codex OAuth; upstream
// excludes those through an explicit DISALLOWED_MODELS set instead, so that
// guard is ported alongside the regex to preserve the pinned exclusion.
const DISALLOWED_MODELS = new Set(["gpt-5.5-pro"])

export function isOAuthModel(value: string) {
  if (capabilityModelID(value)) return true
  const id = modelID(value)
  if (DISALLOWED_MODELS.has(id)) return false
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor > 4)
}

export function limit(value: string) {
  const input = profile(value)?.codexInputLimit
  if (!input) return
  return { context: input + 128_000, input, output: 128_000 }
}

export function supportsCatalogSemantics(value: string) {
  return profile(value)?.catalogSemantics === true
}
export * as CodexModel from "./codex-model"
