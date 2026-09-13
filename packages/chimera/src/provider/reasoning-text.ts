import { isRecord } from "@/util/record"

/**
 * DeepSeek reasoning models served over the Responses wire require the previous turn's
 * chain of thought to be replayed as `content: [{ type: "reasoning_text" }]`; continuations
 * that only carry `encrypted_content`/`summary` are rejected upstream with
 * "The `reasoning_text` in the thinking mode must be passed back to the API".
 *
 * The AI SDK Responses implementation only understands OpenAI reasoning summaries, so
 * Chimera captures the streamed `response.reasoning_text.*` events itself and mirrors the
 * stored text back into `content` before the request leaves the process.
 */

type Target = {
  api: { id: string; npm: string }
  wire_api?: string | undefined
  capabilities: { reasoning: boolean }
}

export function needed(model: Target): boolean {
  return (
    model.api.npm === "@ai-sdk/openai" &&
    model.wire_api === "responses" &&
    model.capabilities.reasoning === true &&
    model.api.id.toLowerCase().includes("deepseek")
  )
}

export function deltaFromRaw(rawValue: unknown): { id: string; text: string } | undefined {
  if (!isRecord(rawValue)) return
  if (rawValue.type !== "response.reasoning_text.delta") return
  if (typeof rawValue.item_id !== "string" || !rawValue.item_id) return
  if (typeof rawValue.delta !== "string" || !rawValue.delta) return
  const index = typeof rawValue.content_index === "number" ? rawValue.content_index : 0
  return { id: `${rawValue.item_id}:${index}`, text: rawValue.delta }
}

export function mirrorIntoContent(body: unknown): number {
  if (!isRecord(body) || !Array.isArray(body.input)) return 0
  let patched = 0
  for (const item of body.input) {
    if (!isRecord(item) || item.type !== "reasoning") continue
    if (Array.isArray(item.content) && item.content.length > 0) continue
    const text = (Array.isArray(item.summary) ? item.summary : [])
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
    if (!text) continue
    item.content = [{ type: "reasoning_text", text }]
    patched += 1
  }
  return patched
}

export * as ReasoningText from "./reasoning-text"