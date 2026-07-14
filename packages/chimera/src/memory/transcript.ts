import type { MessageV2 } from "@/session/message-v2"
import { MemoryCitation } from "./citation"
import { MemorySecurity } from "./security"
import type { Extraction } from "./model"

const DEFAULT_MAX_CHARS = 48_000

function textParts(message: MessageV2.WithParts) {
  return message.parts.flatMap((part): string[] => {
    if (part.type !== "text" || part.synthetic || part.ignored || part.metadata?.runtimeContext || part.metadata?.memorySource) return []
    const text = MemoryCitation.strip(part.text).text.trim()
    return text ? [text] : []
  })
}

export function build(messages: readonly MessageV2.WithParts[], maxChars = DEFAULT_MAX_CHARS) {
  const blocks = messages.flatMap((message): string[] => {
    if (message.info.role !== "user" && message.info.role !== "assistant") return []
    if (message.info.role === "assistant" && message.info.summary) return []
    if (message.info.role === "assistant" && message.info.memory) return []
    const text = textParts(message).join("\n").trim()
    if (!text) return []
    return [`[${message.info.role} ${message.info.id}]\n${MemorySecurity.redactSecrets(text)}`]
  })
  const output: string[] = []
  let chars = 0
  for (const block of blocks.toReversed()) {
    if (chars >= maxChars) break
    const remaining = maxChars - chars
    output.unshift(block.length > remaining ? block.slice(0, remaining) : block)
    chars += Math.min(block.length, remaining)
  }
  return output.join("\n\n")
}

function provenance(text: string, transcript: string) {
  const source = transcript.toLowerCase()
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []
  return terms.length === 0 || terms.some((term) => source.includes(term))
}

export function validateExtraction(input: Extraction, transcript: string) {
  const items = input.items
    .map((item) => ({ ...item, text: MemorySecurity.cleanText(MemorySecurity.redactSecrets(item.text), 2_000) }))
    .filter((item) => item.text && !MemorySecurity.containsSecret(item.text) && provenance(item.text, transcript))
  const explicitGlobal = /\b(?:across|all|every)\s+projects?\b|\bglobal(?:ly)?\b|跨项目|所有项目/i.test(transcript)
  const scope: "global" | "project" = input.scope === "global" && explicitGlobal ? "global" : "project"
  return {
    outcome: input.outcome === "memory" && items.length > 0 ? "memory" as const : "no_output" as const,
    scope,
    items,
    rolloutSummary: MemorySecurity.redactSecrets(input.rolloutSummary).slice(0, 12_000),
    rolloutSlug: input.rolloutSlug?.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160) || undefined,
  }
}

export * as MemoryTranscript from "./transcript"
