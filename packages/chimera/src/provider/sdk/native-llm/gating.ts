import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"

// L4.4 native llm runtime pilot gate (flag: experimental.llm_runtime).
// Strangler-fig discipline: the flag defaults off and the off path never
// constructs anything from @coding-chimera/llm. Eligibility is deliberately
// narrow — the pilot list grows one provider at a time, each with its own
// recorded/parity evidence, mirroring the upstream native-runtime rollout.

/** Providers whose transport may switch to the llm route runtime when the flag is on. */
export const PILOT_PROVIDER_IDS: readonly string[] = ["deepseek"]

export type EligibilityInput = {
  readonly llmRuntime: boolean | undefined
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
}

/**
 * Pure decision function for the seam in src/session/llm.ts. Returns true
 * only for pilot providers on the openai-compatible chat wire with API-key
 * auth (auth-store entry or provider-config apiKey; a missing auth entry is
 * accepted because the key may live in provider options). Everything else
 * (responses wire, OAuth, wellknown, workflow models, non-pilot providers)
 * stays on the AI SDK transport regardless of the flag.
 */
export function eligible(input: EligibilityInput): boolean {
  if (input.llmRuntime !== true) return false
  if (!PILOT_PROVIDER_IDS.includes(input.model.providerID)) return false
  if (input.model.api.npm !== "@ai-sdk/openai-compatible") return false
  if ((input.model.wire_api ?? input.provider.wire_api) === "responses") return false
  if (input.auth && input.auth.type !== "api") return false
  return true
}

export * as NativeLLMGating from "./gating"
