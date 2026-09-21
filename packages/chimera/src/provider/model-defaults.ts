// Built-in default data tables for model capabilities (L4.3).
//
// Three-layer merge, lowest to highest priority:
//   models.dev snapshot < provider config (config.provider[].models) < global model_capabilities
//
// This module holds the default (lowest) layer: the hardcoded matching chains
// formerly inlined in transform.ts (temperature/topP/topK, variant family
// suppression, effort sets), models.ts (reasoning protocol inference), and
// codex-model.ts (codex profiles) extracted as plain data tables. The tables
// are pure data + pure lookups with no config dependency, so transform/models
// consumers stay pure functions of Provider.Model (memoization-safe). Higher
// layers do not mutate these tables: they are resolved onto Provider.Model
// fields (sampling, variants, reasoning_protocol, ...) during provider state
// assembly, and the lookups here are consulted only when the model carries no
// resolved override.

export type ReasoningProtocolName =
  | "zhipuai_thinking"
  | "dashscope_enable_thinking"
  | "vllm_chat_template"
  | "anthropic_thinking"
  | "google_thinking_config"

export type SamplingField = "temperature" | "top_p" | "top_k"

// First matching rule wins. `include` must be a substring of the lowercased
// model id; when `any` is present at least one of its substrings must match
// too. A rule without `value` is an explicit terminator: it matches and
// resolves to "no default" (preserves the former early `return undefined`
// for claude ids ahead of later rules).
export type SamplingRule = {
  field: SamplingField
  include?: string
  any?: readonly string[]
  value?: number
}

export const SAMPLING_RULES: readonly SamplingRule[] = [
  // temperature
  { field: "temperature", include: "north-mini-code", value: 1.0 },
  // Qwen3.8 official recommendation: temperature=1.0, top_p=0.95, top_k=20
  { field: "temperature", include: "qwen3.8", value: 1.0 },
  { field: "temperature", include: "qwen", value: 0.55 },
  { field: "temperature", include: "claude" },
  { field: "temperature", include: "gemini", value: 1.0 },
  { field: "temperature", include: "glm-4.6", value: 1.0 },
  { field: "temperature", include: "glm-4.7", value: 1.0 },
  { field: "temperature", include: "minimax-m2", value: 1.0 },
  // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
  { field: "temperature", include: "kimi-k2", any: ["thinking", "k2.", "k2p", "k2-5"], value: 1.0 },
  { field: "temperature", include: "kimi-k2", value: 0.6 },
  // DSv4 family: harness standard mode (DeepSWE reference conditions)
  { field: "temperature", include: "deepseek-v4", value: 1.0 },
  // top_p
  { field: "top_p", include: "qwen3.8", value: 0.95 },
  { field: "top_p", include: "qwen", value: 1 },
  { field: "top_p", any: ["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"], value: 0.95 },
  { field: "top_p", include: "deepseek-v4", value: 0.95 },
  // top_k
  { field: "top_k", include: "qwen3.8", value: 20 },
  { field: "top_k", include: "minimax-m2", any: ["m2.", "m25", "m21"], value: 40 },
  { field: "top_k", include: "minimax-m2", value: 20 },
  { field: "top_k", include: "gemini", value: 64 },
]

export function samplingDefault(modelID: string, field: SamplingField): number | undefined {
  const id = modelID.toLowerCase()
  for (const rule of SAMPLING_RULES) {
    if (rule.field !== field) continue
    if (rule.include && !id.includes(rule.include)) continue
    if (rule.any && !rule.any.some((s) => id.includes(s))) continue
    return rule.value
  }
  return undefined
}

// Model families with no tunable effort knob: matched ids advertise no effort
// variants (baseVariants returns {}). `unlessConfiguredEfforts` preserves the
// glm carve-out: an explicit reasoning_efforts list generates variants.
export type VariantSuppressionRule = {
  include: string
  alsoApiID?: boolean
  unlessConfiguredEfforts?: boolean
}

export const VARIANT_SUPPRESSION_RULES: readonly VariantSuppressionRule[] = [
  { include: "glm", unlessConfiguredEfforts: true },
  { include: "deepseek-chat" },
  { include: "deepseek-reasoner" },
  { include: "deepseek-r1" },
  { include: "deepseek-v3" },
  { include: "minimax" },
  { include: "kimi" },
  { include: "k2p" },
  { include: "qwen" },
  { include: "big-pickle" },
]

// Grok suppression runs after the grok effort rules (grok-3-mini / grok-4.5
// families keep their variants; every other grok id gets none) and also checks
// the api id.
export const GROK_VARIANT_SUPPRESSION_RULES: readonly VariantSuppressionRule[] = [
  { include: "grok", alsoApiID: true },
]

export function matchesVariantSuppression(
  rules: readonly VariantSuppressionRule[],
  id: string,
  apiID: string,
  hasConfiguredEfforts: boolean,
): boolean {
  return rules.some(
    (rule) =>
      (id.includes(rule.include) || (rule.alsoApiID && apiID.includes(rule.include))) &&
      !(rule.unlessConfiguredEfforts && hasConfiguredEfforts),
  )
}

export const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
export const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
export const NVIDIA_KIMI_K26_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh", "max"]

// OpenAI rolled out the `none` reasoning_effort tier on this date (Responses API).
// Models released before it 400 on `reasoning_effort: "none"`, so we only expose
// it as a variant for models new enough to accept it.
export const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"

// OpenAI rolled out the `xhigh` reasoning_effort tier on this date. Same reasoning.
export const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"

// Matches members of the gpt-5 family across the id formats we encounter:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored to start-of-string or "/" so it doesn't false-match "gpt-50" or "gpt-5o".
export const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/

// Only these Mistral ids support adjustable reasoning.
export const MISTRAL_REASONING_IDS = [
  "mistral-small-2603",
  "mistral-small-latest",
  "mistral-medium-3.5",
  "mistral-medium-2604",
]

// Anthropic adaptive-thinking generations, matched by api id substring.
export type AdaptiveEffortRule = { include: readonly string[]; efforts: readonly string[] }

export const ANTHROPIC_ADAPTIVE_EFFORT_RULES: readonly AdaptiveEffortRule[] = [
  { include: ["opus-4-7", "opus-4.7"], efforts: ["low", "medium", "high", "xhigh", "max"] },
  { include: ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"], efforts: ["low", "medium", "high", "max"] },
]

export function anthropicAdaptiveEfforts(apiID: string): string[] | null {
  for (const rule of ANTHROPIC_ADAPTIVE_EFFORT_RULES) {
    if (rule.include.some((v) => apiID.includes(v))) return [...rule.efforts]
  }
  return null
}

// xAI reasoning effort knobs differ by Grok generation:
// - grok-3-mini: low/high
// - grok-4.5 / grok-4.20-multi-agent: low/medium/high (default high; cannot disable)
// - other grok: no tunable effort in Chimera today
// see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
export const GROK_EFFORT_RULES: readonly AdaptiveEffortRule[] = [
  { include: ["grok-3-mini"], efforts: ["low", "high"] },
  { include: ["grok-4.5", "grok-4-5", "grok-4.20-multi-agent", "grok-4-20-multi-agent"], efforts: WIDELY_SUPPORTED_EFFORTS },
]

export function grokReasoningEfforts(key: string): string[] | null {
  if (!key.includes("grok")) return null
  for (const rule of GROK_EFFORT_RULES) {
    if (rule.include.some((v) => key.includes(v))) return [...rule.efforts]
  }
  return null
}

export function isGrok45Family(key: string): boolean {
  return GROK_EFFORT_RULES[1].include.some((v) => key.includes(v))
}

// Reasoning protocol inference, formerly the hardcoded branch chain in
// models.ts inferReasoningProtocol. First matching rule wins. Condition
// fields are ANDed; `familyOrIdIncludes` ORs a family equality check with an
// id substring check (zhipuai GLM shape). Caller lowercases id/family.
export type ReasoningProtocolRule = {
  protocol: ReasoningProtocolName
  providerEquals?: readonly string[]
  providerIncludes?: readonly string[]
  npmEquals?: readonly string[]
  idEquals?: readonly string[]
  idIncludes?: readonly string[]
  idExcludes?: readonly string[]
  familyOrIdIncludes?: readonly string[]
  requireReasoning?: boolean
}

export const REASONING_PROTOCOL_RULES: readonly ReasoningProtocolRule[] = [
  // zhipuai / zai / tencent GLM models use the OpenAI-compatible `thinking`
  // field with clear_thinking to enable reasoning_content output.
  {
    protocol: "zhipuai_thinking",
    familyOrIdIncludes: ["glm"],
    providerIncludes: ["zhipuai", "zai", "tencent"],
    npmEquals: ["@ai-sdk/openai-compatible"],
  },
  // DashScope (alibaba-cn) requires enable_thinking in the body for reasoning
  // models; kimi-k2-thinking returns reasoning_content by default and is excluded.
  {
    protocol: "dashscope_enable_thinking",
    providerEquals: ["alibaba-cn"],
    requireReasoning: true,
    npmEquals: ["@ai-sdk/openai-compatible"],
    idExcludes: ["kimi-k2-thinking"],
  },
  // vLLM-style chat template arg for providers that deploy GLM/Kimi via
  // baseten or the opencode hosted proxy.
  { protocol: "vllm_chat_template", providerEquals: ["baseten"] },
  { protocol: "vllm_chat_template", providerEquals: ["opencode"], idEquals: ["kimi-k2-thinking", "glm-4.6"] },
  // Google AI SDK exposes thinkingConfig for reasoning models.
  { protocol: "google_thinking_config", npmEquals: ["@ai-sdk/google", "@ai-sdk/google-vertex"], requireReasoning: true },
  // Anthropic SDK with Kimi K2 models uses budget-token thinking.
  {
    protocol: "anthropic_thinking",
    npmEquals: ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"],
    idIncludes: ["k2p", "kimi-k2.", "kimi-k2p"],
  },
]

export function matchReasoningProtocol(input: {
  providerID: string
  id: string
  family: string
  npm: string
  reasoning: boolean
}): ReasoningProtocolName | undefined {
  for (const rule of REASONING_PROTOCOL_RULES) {
    if (rule.providerEquals && !rule.providerEquals.includes(input.providerID)) continue
    if (rule.providerIncludes && !rule.providerIncludes.some((p) => input.providerID.includes(p))) continue
    if (rule.npmEquals && !rule.npmEquals.includes(input.npm)) continue
    if (rule.idEquals && !rule.idEquals.includes(input.id)) continue
    if (rule.idIncludes && !rule.idIncludes.some((v) => input.id.includes(v))) continue
    if (rule.idExcludes && rule.idExcludes.some((v) => input.id.includes(v))) continue
    if (
      rule.familyOrIdIncludes &&
      !rule.familyOrIdIncludes.some((v) => input.family === v || input.id.includes(v))
    )
      continue
    if (rule.requireReasoning && !input.reasoning) continue
    return rule.protocol
  }
  return undefined
}

// Codex capability profiles, formerly the private `profiles` record in
// codex-model.ts. Config layers override codex efforts through the model's
// reasoning_efforts (the `configured` argument of CodexModel.reasoningEfforts),
// which intersects with these built-in preferences.
export type CodexProfile = {
  aliases?: readonly string[]
  catalogSemantics?: boolean
  codexEfforts?: readonly import("./codex-model").ReasoningEffort[]
  requiresConfiguredEfforts?: boolean
  codexInputLimit?: number
}

export const CODEX_MODEL_PROFILES: Record<string, CodexProfile> = {
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
  },
  "gpt-5.6-terra": {
    aliases: ["fast", "pro"],
    catalogSemantics: true,
    codexEfforts: ["low", "medium", "high", "xhigh", "max"],
    codexInputLimit: 372_000,
  },
  "gpt-5.6-luna": {
    aliases: ["fast", "pro"],
    catalogSemantics: true,
    codexEfforts: ["low", "medium", "high", "xhigh", "max"],
    codexInputLimit: 372_000,
  },
}

// Global model_capabilities matcher. Keys match case-insensitively as
// substrings against `<providerID>/<modelID>`, `<modelID>`, and the api id.
// Matched entries are returned least-specific first (shorter keys first,
// declaration order preserved within equal length) so callers can apply them
// in order with the longest key winning.
export function matchModelCapabilityEntries<T>(
  table: Record<string, T> | undefined,
  identity: { providerID: string; modelID: string; apiID: string },
): T[] {
  if (!table) return []
  const candidates = [
    `${identity.providerID}/${identity.modelID}`.toLowerCase(),
    identity.modelID.toLowerCase(),
    identity.apiID.toLowerCase(),
  ]
  return Object.entries(table)
    .filter(([key]) => {
      const lower = key.trim().toLowerCase()
      return lower.length > 0 && candidates.some((candidate) => candidate.includes(lower))
    })
    .sort((a, b) => a[0].length - b[0].length)
    .map(([, value]) => value)
}

export * as ModelDefaults from "./model-defaults"
