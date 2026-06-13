export type RemoteCompactionOutputItem = {
  type: "compaction" | "compaction_summary"
  encrypted_content: string
}

export type RemoteCompactionMetadata = {
  providerID: "openai"
  endpoint: "codex"
  implementation: "responses_compact"
  modelID: string
  output: RemoteCompactionOutputItem[]
}

const SENTINEL = "__chimera_remote_compaction__:"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function decodeRemoteCompactionOutput(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const output = value.flatMap((item): RemoteCompactionOutputItem[] =>
    isRecord(item) &&
    (item.type === "compaction" || item.type === "compaction_summary") &&
    typeof item.encrypted_content === "string"
      ? [{ type: item.type, encrypted_content: item.encrypted_content }]
      : [],
  )
  if (!output.length) return undefined
  return output
}

export function encodeRemoteCompactionSentinel(output: RemoteCompactionOutputItem[]) {
  return `${SENTINEL}${Buffer.from(JSON.stringify(output)).toString("base64url")}`
}

export function decodeRemoteCompactionSentinel(text: string) {
  if (!text.startsWith(SENTINEL)) return undefined
  try {
    return decodeRemoteCompactionOutput(JSON.parse(Buffer.from(text.slice(SENTINEL.length), "base64url").toString()))
  } catch {
    return undefined
  }
}

export function findRemoteCompactionOutput(value: unknown): RemoteCompactionOutputItem[] | undefined {
  if (typeof value === "string") return decodeRemoteCompactionSentinel(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const output = findRemoteCompactionOutput(item)
      if (output) return output
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const item of Object.values(value)) {
    const output = findRemoteCompactionOutput(item)
    if (output) return output
  }
  return undefined
}

export function rewriteRemoteCompactionInput(body: string) {
  try {
    const parsed = JSON.parse(body)
    if (!isRecord(parsed) || !Array.isArray(parsed.input)) return body
    let changed = false
    const input = parsed.input.flatMap((item) => {
      const output = findRemoteCompactionOutput(item)
      if (!output) return [item]
      changed = true
      return output
    })
    if (!changed) return body
    return JSON.stringify({ ...parsed, input })
  } catch {
    return body
  }
}

export * as RemoteCompactionCodec from "./remote-compaction-codec"
