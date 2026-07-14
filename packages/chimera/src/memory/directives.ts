import type { MessageID, SessionID } from "@/session/schema"
import { MemorySecurity } from "./security"

const DIRECTIVE = /^\s*(?:remember|memory|记住|记忆)\s*[:：]\s*(.+?)\s*$/i

export type InputPart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

export type Directive = {
  text: string
  idempotencyKey: string
  line: number
}

export function extract(input: { sessionID: SessionID; messageID: MessageID; parts: readonly InputPart[] }) {
  return input.parts.flatMap((part): Directive[] => {
    if (part.type !== "text" || part.synthetic || part.ignored || part.metadata?.runtimeContext || part.metadata?.memorySource) return []
    return (part.text ?? "").split(/\r?\n/).flatMap((line, index) => {
      const match = line.match(DIRECTIVE)
      if (!match) return []
      const text = MemorySecurity.cleanText(MemorySecurity.redactSecrets(match[1]), 2_000)
      if (!text || text === "[REDACTED]" || MemorySecurity.containsSecret(text)) return []
      return [{ text, idempotencyKey: `${input.sessionID}\0${input.messageID}\0${index}`, line: index + 1 }]
    })
  })
}

export * as MemoryDirectives from "./directives"
