import type { RemoteCompactionPolicyPatch, RemoteCompactionResolution } from "@opencode-ai/sdk/v2"

export type RemoteCompactionMode = RemoteCompactionResolution["configured"]["mode"]
export type RemoteCompactionProtocol = RemoteCompactionResolution["configured"]["protocol"]

const reasons: Record<RemoteCompactionResolution["reason"], string> = {
  policy_off: "policy off",
  provider_capability_missing: "provider capability missing",
  model_disabled: "model disabled",
  wire_api_not_responses: "Responses transport unavailable",
  credential_unavailable: "credential unavailable",
  protocol_mismatch: "protocol mismatch",
  routing_identity_unsafe: "routing identity unsafe",
  model_unsupported: "model unsupported",
  ready: "ready",
}

const replayReasons: Record<RemoteCompactionResolution["replay"]["reason"], string> = {
  no_lock: "no installed state",
  exact_binding: "exact binding",
  model_mismatch: "provider/model mismatch",
  transport_unavailable: "transport unavailable",
  wire_api_not_responses: "Responses transport unavailable",
  binding_mismatch: "route binding changed",
  credential_unavailable: "credential unavailable",
  routing_identity_unsafe: "routing identity unsafe",
}

export function nextRemoteCompactionMode(mode: RemoteCompactionMode): RemoteCompactionMode {
  if (mode === "auto") return "on"
  if (mode === "on") return "off"
  return "auto"
}

export function nextRemoteCompactionProtocol(protocol: RemoteCompactionProtocol): RemoteCompactionProtocol {
  if (protocol === "auto") return "v2"
  if (protocol === "v2") return "legacy"
  return "auto"
}

export function remoteCompactionModePatch(status: RemoteCompactionResolution): RemoteCompactionPolicyPatch {
  return { remote: nextRemoteCompactionMode(status.configured.mode) }
}

export function remoteCompactionProtocolPatch(status: RemoteCompactionResolution): RemoteCompactionPolicyPatch {
  return { remote_protocol: nextRemoteCompactionProtocol(status.configured.protocol) }
}

export function remoteCompactionReason(status: RemoteCompactionResolution) {
  return reasons[status.reason]
}

export function remoteCompactionReplay(status: RemoteCompactionResolution) {
  return `${status.replay.mode} (${replayReasons[status.replay.reason]})`
}

export function remoteCompactionLock(status: RemoteCompactionResolution) {
  if (status.lock.status === "none") return "none"
  return `${status.lock.status} ${status.lock.providerID}/${status.lock.modelID}`
}

export function remoteCompactionProtocols(status: RemoteCompactionResolution) {
  return status.protocols.length ? status.protocols.join(" → ") : "none"
}

export function remoteCompactionCredential(status: RemoteCompactionResolution) {
  return status.credential.replaceAll("-", " ")
}

export function remoteCompactionTarget(status: RemoteCompactionResolution) {
  if (status.target === "local") return "local"
  return `${status.target} ${status.effective.providerID}/${status.effective.modelID}`
}

export function remoteCompactionSummary(status: RemoteCompactionResolution) {
  return [
    status.mode,
    remoteCompactionTarget(status),
    `protocol ${remoteCompactionProtocols(status)}`,
    `credential ${remoteCompactionCredential(status)}`,
    `replay ${status.replay.mode}`,
    `lock ${status.lock.status}`,
    status.localFallback ? "local fallback" : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function remoteCompactionDescription(status: RemoteCompactionResolution) {
  return `${remoteCompactionReason(status)}; replay ${remoteCompactionReplay(status)}; lock ${remoteCompactionLock(status)}; local fallback available.`
}

export function remoteCompactionModeTitle(status: RemoteCompactionResolution) {
  return `Remote compaction mode: ${status.configured.mode} (switch to ${nextRemoteCompactionMode(status.configured.mode)})`
}

export function remoteCompactionProtocolTitle(status: RemoteCompactionResolution) {
  return `Remote compaction protocol: ${status.configured.protocol} (switch to ${nextRemoteCompactionProtocol(status.configured.protocol)})`
}

export function remoteCompactionModeDescription(status: RemoteCompactionResolution) {
  return `${remoteCompactionSummary(status)}; ${remoteCompactionReason(status)}.`
}

export function remoteCompactionProtocolDescription(status: RemoteCompactionResolution) {
  return `Configured ${status.configured.protocol}; authoritative attempt order ${remoteCompactionProtocols(status)}; local fallback available.`
}

export function remoteCompactionModelChangeBlocked(status: RemoteCompactionResolution | undefined) {
  return status?.lock.status === "model_mismatch" || status?.replay.mode === "blocked"
}

export function remoteCompactionModelLockMessage(status: RemoteCompactionResolution) {
  const lock = status.lock.status === "none" ? "installed remote state" : `${status.lock.providerID}/${status.lock.modelID}`
  return `This session cannot replay ${lock}: ${remoteCompactionReplay(status)}. Fork or start a new session before changing models.`
}

export function remoteCompactionShortAlert(status: RemoteCompactionResolution | undefined): string | undefined {
  if (!status) return undefined
  if (status.mode === "remote") return "✓ remote"
  if (remoteCompactionModelChangeBlocked(status)) return `⚠ ${remoteCompactionReplay(status)}`
  return undefined
}

