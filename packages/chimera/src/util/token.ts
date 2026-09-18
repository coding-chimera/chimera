const CHARS_PER_TOKEN = 4

export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

/**
 * (R1 hotspot-2) Same value as `estimate` for a string of the given length,
 * without materializing the string. Callers that only need the token estimate
 * (compaction sizing) can sum serialized lengths incrementally instead of
 * building one huge concatenated JSON payload just to measure it.
 */
export function estimateLength(length: number) {
  return Math.max(0, Math.round(Math.max(0, length) / CHARS_PER_TOKEN))
}

export * as Token from "./token"
