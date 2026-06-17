export type RemoteCompactionOutputItem = {
  type: "compaction" | "compaction_summary"
  encrypted_content: string
}

export type RemoteCompactionImplementation = "responses_compact" | "responses_compaction_v2"

export type RemoteCompactionMetadata = {
  providerID: "openai"
  endpoint: "codex"
  implementation: RemoteCompactionImplementation
  modelID: string
  output: RemoteCompactionOutputItem[]
}

const ENVELOPE_KEY = "__chimera_remote_compaction"
const ENVELOPE_VERSION = 1

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

export function encodeRemoteCompactionInput(output: RemoteCompactionOutputItem[]) {
  return JSON.stringify({ [ENVELOPE_KEY]: { version: ENVELOPE_VERSION, output } })
}

export function decodeRemoteCompactionInput(text: string) {
  try {
    const parsed = JSON.parse(text)
    if (!isRecord(parsed)) return undefined
    const envelope = parsed[ENVELOPE_KEY]
    if (!isRecord(envelope) || envelope.version !== ENVELOPE_VERSION) return undefined
    return decodeRemoteCompactionOutput(envelope.output)
  } catch {
    return undefined
  }
}

function findRemoteCompactionOutput(value: unknown): RemoteCompactionOutputItem[] | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.text === "string") return decodeRemoteCompactionInput(value.text)
  if (typeof value.content === "string") return decodeRemoteCompactionInput(value.content)
  if (!Array.isArray(value.content)) return undefined
  for (const item of value.content) {
    const output = findRemoteCompactionOutput(item)
    if (output) return output
  }
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
