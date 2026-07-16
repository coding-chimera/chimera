export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

type Profile = {
  aliases?: readonly string[]
  catalogSemantics?: boolean
  codexEfforts?: readonly ReasoningEffort[]
  requiresConfiguredEfforts?: boolean
  codexInputLimit?: number
  ultra?: boolean
}

const profiles: Record<string, Profile> = {
  "gpt-5.2": {},
  "gpt-5.3-codex": {},
  "gpt-5.3-codex-spark": {},
  "gpt-5.4": {},
  "gpt-5.4-mini": {},
  "gpt-5.5": { codexEfforts: ["low", "medium", "high", "xhigh"], codexInputLimit: 272_000 },
  "gpt-5.6": {
    aliases: ["fast", "pro"],
    catalogSemantics: true,
    codexEfforts: ["low", "medium", "high", "xhigh", "max"],
    requiresConfiguredEfforts: true,
  },
  "gpt-5.6-sol": {
    aliases: ["fast", "pro"],
    catalogSemantics: true,
    codexEfforts: ["low", "medium", "high", "xhigh", "max"],
    codexInputLimit: 372_000,
    ultra: true,
  },
  "gpt-5.6-terra": {
    aliases: ["fast", "pro"],
    catalogSemantics: true,
    codexEfforts: ["low", "medium", "high", "xhigh", "max"],
    codexInputLimit: 372_000,
    ultra: true,
  },
  "gpt-5.6-luna": {
    aliases: ["fast", "pro"],
    catalogSemantics: true,
    codexEfforts: ["low", "medium", "high", "xhigh", "max"],
    codexInputLimit: 372_000,
  },
}

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

export function reasoningEfforts(capabilityID: string, configured?: readonly unknown[]) {
  const current = profile(capabilityID)
  const preferred = current?.codexEfforts
  if (!preferred || (current.requiresConfiguredEfforts && configured === undefined)) return []
  const available = configured === undefined ? undefined : normalizeReasoningEfforts(configured)
  const efforts = available ? preferred.filter((effort) => available.includes(effort)) : [...preferred]
  if (!efforts.includes("max") || !supportsUltra(capabilityID)) return efforts
  return [...efforts, "ultra" as const]
}

export function smallReasoningEffort(capabilityID: string, configured?: readonly unknown[]) {
  const efforts = reasoningEfforts(capabilityID, configured)
  if (efforts.includes("low")) return "low"
  return efforts.find((effort) => effort !== "ultra")
}

export function isOAuthModel(value: string) {
  if (capabilityModelID(value)) return true
  const match = modelID(value).match(/^gpt-(\d+\.\d+)$/)
  return match ? parseFloat(match[1]) > 5.4 : false
}

export function limit(value: string) {
  const input = profile(value)?.codexInputLimit
  if (!input) return
  return { context: input + 128_000, input, output: 128_000 }
}

export function supportsCatalogSemantics(value: string) {
  return profile(value)?.catalogSemantics === true
}

export function supportsUltra(value: string) {
  return profile(value)?.ultra === true
}

export * as CodexModel from "./codex-model"
