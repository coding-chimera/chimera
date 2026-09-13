import { isRecord } from "@/util/record"

/**
 * Chimera resolves reasoning options (variant profile, model/agent options) for every
 * request, but the AI SDK only writes the Responses `reasoning` field for models it
 * classifies as reasoning models: `@ai-sdk/openai` gates that field on o1/o3/o4-mini/gpt-5
 * id prefixes, so a DeepSeek model served through the Responses wire never receives the
 * effort the session resolved.
 *
 * The resolved value therefore travels to the provider fetch wrapper through an internal
 * header: the wrapper mirrors it into the JSON body and removes the header again, so it
 * never reaches the upstream.
 */

export const HEADER = "x-chimera-wire-reasoning"

export type Value = {
  effort?: string
  summary?: string
}

function pick(effort: unknown, summary: unknown): Value | undefined {
  const result: Value = {
    ...(typeof effort === "string" && effort !== "" ? { effort } : {}),
    ...(typeof summary === "string" && summary !== "" ? { summary } : {}),
  }
  if (result.effort === undefined && result.summary === undefined) return undefined
  return result
}

// Only an explicit effort (selected variant or configured options) is forwarded; the
// implicit default tier stays unset so it keeps whatever default the upstream applies.
export function fromOptions(providerOptions: Record<string, unknown>, explicit: boolean): Value | undefined {
  if (!explicit) return undefined
  const openai = providerOptions["openai"]
  if (!isRecord(openai)) return undefined
  return pick(openai["reasoningEffort"], openai["reasoningSummary"])
}

export function encode(value: Value) {
  return JSON.stringify(value)
}

export function decode(raw: string | null | undefined): Value | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    return pick(parsed["effort"], parsed["summary"])
  } catch {
    return undefined
  }
}

// Never overwrites a `reasoning` object the SDK produced itself (e.g. gpt-5 family ids).
export function inject(body: unknown, value: Value | undefined): boolean {
  if (value === undefined || !isRecord(body)) return false
  if (body["reasoning"] !== undefined) return false
  body["reasoning"] = value
  return true
}

// Consumes the internal header so it can be mirrored into the body and never sent upstream.
export function take(headers: unknown): { value: Value | undefined; headers: Headers } | undefined {
  if (!headers) return undefined
  const current = new Headers(headers as HeadersInit)
  const raw = current.get(HEADER)
  if (raw === null) return undefined
  current.delete(HEADER)
  return { value: decode(raw), headers: current }
}

export * as ReasoningWire from "./reasoning-wire"
