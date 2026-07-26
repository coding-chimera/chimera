import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const AUTO_COMPACTION_RATIO = 0.9
const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const configuredInput = input.model.limit.input
  const inferredInput = Math.max(0, context - input.model.limit.output) || context
  const capacity = configuredInput && configuredInput > 0 ? Math.min(configuredInput, inferredInput) : inferredInput
  const maxOutputTokens = ProviderTransform.maxOutputTokens(input.model)
  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens)
  const autoCompactLimit = Math.floor(capacity * AUTO_COMPACTION_RATIO)
  return Math.max(0, Math.min(autoCompactLimit, capacity - reserved))
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const componentCount =
    input.tokens.input +
    input.tokens.output +
    input.tokens.reasoning +
    input.tokens.cache.read +
    input.tokens.cache.write
  const count = Math.max(input.tokens.total ?? 0, componentCount)
  return count >= usable(input)
}
