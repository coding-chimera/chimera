export type RemoteCompactionOutputItem = {
  type: "compaction" | "compaction_summary"
  encrypted_content: string
}

export type RemoteCompactionImplementation = "responses_compact" | "responses_compaction_v2"
export type RemoteCompactionUsage = Record<string, number>
export type RemoteCompactionReplayBinding = {
  providerID: string
  modelID: string
  wireModelID: string
  driver: "codex-responses"
  format: "responses_compaction_v1"
  wire_api: "responses"
  compatibility_key: string
}
export type OfficialRemoteCompactionMetadata = {
  providerID: "openai"
  endpoint: "codex"
  implementation: RemoteCompactionImplementation
  modelID: string
  output: RemoteCompactionOutputItem[]
  usage?: RemoteCompactionUsage
}
export type ProviderRemoteCompactionMetadata = {
  providerID: string
  endpoint: "provider"
  driver: "codex-responses"
  profile: "codex-responses"
  implementation: RemoteCompactionImplementation
  modelID: string
  wireModelID: string
  replay: {
    format: "responses_compaction_v1"
    wire_api: "responses"
    compatibility_key: string
  }
  output: RemoteCompactionOutputItem[]
  usage?: RemoteCompactionUsage
}
export type RemoteCompactionMetadata = OfficialRemoteCompactionMetadata | ProviderRemoteCompactionMetadata

const ENVELOPE_KEY = "__chimera_remote_compaction"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function bindingFromMetadata(metadata: ProviderRemoteCompactionMetadata): RemoteCompactionReplayBinding {
  return {
    providerID: metadata.providerID,
    modelID: metadata.modelID,
    wireModelID: metadata.wireModelID,
    driver: metadata.driver,
    format: metadata.replay.format,
    wire_api: metadata.replay.wire_api,
    compatibility_key: metadata.replay.compatibility_key,
  }
}

export function bindingFromTransportIdentity(identity: {
  providerID: string
  modelID: string
  wireModelID: string
  compatibilityKey: string
}): RemoteCompactionReplayBinding {
  return {
    providerID: identity.providerID,
    modelID: identity.modelID,
    wireModelID: identity.wireModelID,
    driver: "codex-responses",
    format: "responses_compaction_v1",
    wire_api: "responses",
    compatibility_key: identity.compatibilityKey,
  }
}

function decodeBinding(value: unknown): RemoteCompactionReplayBinding | undefined {
  if (!isRecord(value)) return
  if (
    typeof value.providerID !== "string" ||
    typeof value.modelID !== "string" ||
    typeof value.wireModelID !== "string" ||
    value.driver !== "codex-responses" ||
    value.format !== "responses_compaction_v1" ||
    value.wire_api !== "responses" ||
    typeof value.compatibility_key !== "string"
  )
    return
  return {
    providerID: value.providerID,
    modelID: value.modelID,
    wireModelID: value.wireModelID,
    driver: value.driver,
    format: value.format,
    wire_api: value.wire_api,
    compatibility_key: value.compatibility_key,
  }
}

export function sameRemoteCompactionBinding(a: RemoteCompactionReplayBinding, b: RemoteCompactionReplayBinding) {
  return (
    a.providerID === b.providerID &&
    a.modelID === b.modelID &&
    a.wireModelID === b.wireModelID &&
    a.driver === b.driver &&
    a.format === b.format &&
    a.wire_api === b.wire_api &&
    a.compatibility_key === b.compatibility_key
  )
}

export function decodeRemoteCompactionOutput(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const output: RemoteCompactionOutputItem[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      (item.type !== "compaction" && item.type !== "compaction_summary") ||
      typeof item.encrypted_content !== "string"
    )
      return undefined
    output.push({ type: item.type, encrypted_content: item.encrypted_content })
  }
  return output
}

type DecodedEnvelope =
  | { version: 1; output: RemoteCompactionOutputItem[] }
  | { version: 2; output: RemoteCompactionOutputItem[]; binding: RemoteCompactionReplayBinding }

function reservedEnvelopeCandidate(text: string) {
  const trimmed = text.trimStart()
  return trimmed.startsWith("{") && trimmed.includes(`"${ENVELOPE_KEY}"`)
}

function decodeRemoteCompactionEnvelope(text: string): { status: "decoded"; envelope: DecodedEnvelope } | { status: "invalid" } | undefined {
  try {
    const parsed = JSON.parse(text)
    if (!isRecord(parsed) || !(ENVELOPE_KEY in parsed)) return undefined
    const envelope = parsed[ENVELOPE_KEY]
    if (!isRecord(envelope)) return { status: "invalid" }
    const output = decodeRemoteCompactionOutput(envelope.output)
    if (!output) return { status: "invalid" }
    if (envelope.version === 1) return { status: "decoded", envelope: { version: 1, output } }
    if (envelope.version === 2) {
      const binding = decodeBinding(envelope.binding)
      if (!binding) return { status: "invalid" }
      return { status: "decoded", envelope: { version: 2, output, binding } }
    }
    return { status: "invalid" }
  } catch {
    return reservedEnvelopeCandidate(text) ? { status: "invalid" } : undefined
  }
}

export function encodeRemoteCompactionInput(output: RemoteCompactionOutputItem[]): string
export function encodeRemoteCompactionInput(metadata: RemoteCompactionMetadata): string
export function encodeRemoteCompactionInput(value: RemoteCompactionOutputItem[] | RemoteCompactionMetadata) {
  if (Array.isArray(value)) return JSON.stringify({ [ENVELOPE_KEY]: { version: 1, output: value } })
  if (value.endpoint === "codex") return JSON.stringify({ [ENVELOPE_KEY]: { version: 1, output: value.output } })
  return JSON.stringify({
    [ENVELOPE_KEY]: { version: 2, output: value.output, binding: bindingFromMetadata(value) },
  })
}

export function decodeRemoteCompactionInput(text: string, expected?: RemoteCompactionReplayBinding) {
  const decoded = decodeRemoteCompactionEnvelope(text)
  if (decoded?.status !== "decoded") return undefined
  if (decoded.envelope.version === 1) return expected ? undefined : decoded.envelope.output
  if (!expected || !sameRemoteCompactionBinding(decoded.envelope.binding, expected)) return undefined
  return decoded.envelope.output
}

function findRemoteCompactionEnvelope(value: unknown): ReturnType<typeof decodeRemoteCompactionEnvelope> {
  if (typeof value === "string") return decodeRemoteCompactionEnvelope(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const decoded = findRemoteCompactionEnvelope(item)
      if (decoded) return decoded
    }
    return
  }
  if (!isRecord(value)) return
  for (const item of Object.values(value)) {
    const decoded = findRemoteCompactionEnvelope(item)
    if (decoded) return decoded
  }
}

export function inspectRemoteCompactionRequest(body: string): "none" | "decoded" | "invalid" {
  try {
    const decoded = findRemoteCompactionEnvelope(JSON.parse(body))
    return decoded?.status ?? "none"
  } catch {
    return "none"
  }
}

export class RemoteCompactionRewriteError extends Error {
  override readonly name = "RemoteCompactionRewriteError"
}

export type RemoteCompactionRewrite = {
  body: string
  envelope: "none" | "official-v1" | "provider-v2"
}

export function rewriteRemoteCompactionRequest(
  body: string,
  expected?: RemoteCompactionReplayBinding,
): RemoteCompactionRewrite {
  if (inspectRemoteCompactionRequest(body) === "none") return { body, envelope: "none" }
  try {
    const parsed = JSON.parse(body)
    if (!isRecord(parsed) || !Array.isArray(parsed.input))
      throw new RemoteCompactionRewriteError("remote compaction replay body does not contain a Responses input array")
    let envelope: RemoteCompactionRewrite["envelope"] = "none"
    const input = parsed.input.flatMap((item) => {
      const decoded = findRemoteCompactionEnvelope(item)
      if (!decoded) return [item]
      if (decoded.status === "invalid")
        throw new RemoteCompactionRewriteError("remote compaction replay payload was not rewritten")
      if (expected && decoded.envelope.version !== 2)
        throw new RemoteCompactionRewriteError("remote compaction replay version is not valid for provider replay")
      if (
        decoded.envelope.version === 2 &&
        (!expected || !sameRemoteCompactionBinding(decoded.envelope.binding, expected))
      )
        throw new RemoteCompactionRewriteError("remote compaction replay binding mismatch")
      const current = decoded.envelope.version === 2 ? "provider-v2" : "official-v1"
      if (envelope !== "none" && envelope !== current)
        throw new RemoteCompactionRewriteError("remote compaction replay body mixes incompatible envelope versions")
      envelope = current
      return decoded.envelope.output
    })
    if (envelope === "none") return { body, envelope }
    return { body: JSON.stringify({ ...parsed, input }), envelope }
  } catch (cause) {
    if (cause instanceof RemoteCompactionRewriteError) throw cause
    throw new RemoteCompactionRewriteError("remote compaction replay body could not be parsed")
  }
}

export function rewriteRemoteCompactionInput(body: string, expected?: RemoteCompactionReplayBinding) {
  return rewriteRemoteCompactionRequest(body, expected).body
}

export * as RemoteCompactionCodec from "./remote-compaction-codec"
