export type RemoteCompactionMode = "auto" | "on" | "off"
export type RemoteCompactionProtocol = "auto" | "v2" | "legacy"
export type RemoteCompactionProtocolStatus = "v2" | "legacy" | "off"

export type RemoteCompactionConfig = {
  compaction?: {
    remote?: RemoteCompactionMode
    remote_protocol?: RemoteCompactionProtocol
  }
}

export type RemoteCompactionModel = {
  id?: string
  providerID?: string
  api?: {
    id?: string
  }
}

function openAIRemoteCompactionCompatible(model: RemoteCompactionModel | undefined) {
  const id = (model?.api?.id ?? model?.id ?? "").toLowerCase()
  return openAIRemoteCompactionApplies(model) || /^(gpt-|o[1-9](?:-|$)|chatgpt-|codex-)/.test(id)
}

export function openAIRemoteCompactionApplies(model: RemoteCompactionModel | undefined) {
  return model?.providerID === "openai"
}

export function openAIRemoteCompactionEnabled(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  const mode = config.compaction?.remote ?? "auto"
  if (mode === "off") return false
  if (mode === "on") return openAIRemoteCompactionCompatible(model)
  return openAIRemoteCompactionApplies(model)
}

export function openAIRemoteCompactionStatus(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return openAIRemoteCompactionEnabled(config, model) ? "on" : "off"
}

export function openAIRemoteCompactionProtocolStatus(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
): RemoteCompactionProtocolStatus {
  if (!openAIRemoteCompactionEnabled(config, model)) return "off"
  return config.compaction?.remote_protocol === "legacy" ? "legacy" : "v2"
}

export function openAIRemoteCompactionStatusTitle(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return `OpenAI remote compaction: ${openAIRemoteCompactionStatus(config, model)}`
}

export function openAIRemoteCompactionProtocolStatusTitle(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
) {
  return `OpenAI remote compaction protocol: ${openAIRemoteCompactionProtocolStatus(config, model)}`
}

export function openAIRemoteCompactionDescription(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  const mode = config.compaction?.remote ?? "auto"
  if (mode === "off") return "Disabled; Chimera will always use local compaction."
  if (mode === "on" && openAIRemoteCompactionCompatible(model)) {
    return "Forced on; tries Codex remote compaction with OpenAI OAuth when available."
  }
  if (mode === "on") return "Forced on in config, but off for this provider."
  return openAIRemoteCompactionApplies(model)
    ? "Auto-enabled for OpenAI OAuth sessions; falls back to local compaction."
    : "Auto mode is off for this provider; turn on manually only if the endpoint supports remote compaction."
}

export function openAIRemoteCompactionProtocolDescription(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
) {
  const status = openAIRemoteCompactionProtocolStatus(config, model)
  if (status === "off") return "Remote compaction is off; Chimera will use local compaction."
  if ((config.compaction?.remote_protocol ?? "auto") === "auto") {
    return "Prefers v2 and falls back to legacy remote compaction."
  }
  if (status === "v2") return "Uses Responses compaction v2, then falls back to local compaction."
  return "Uses legacy /responses/compact, then falls back to local compaction."
}

export function nextOpenAIRemoteCompactionMode(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
): RemoteCompactionMode {
  if (openAIRemoteCompactionEnabled(config, model)) return "off"
  return openAIRemoteCompactionApplies(model) ? "auto" : "on"
}

export function nextOpenAIRemoteCompactionProtocolStatus(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
): RemoteCompactionProtocolStatus {
  const status = openAIRemoteCompactionProtocolStatus(config, model)
  if (status === "v2") return "legacy"
  if (status === "legacy") return "off"
  return "v2"
}

export function openAIRemoteCompactionProtocolConfig(
  status: RemoteCompactionProtocolStatus,
  model: RemoteCompactionModel | undefined,
): { remote: RemoteCompactionMode; remote_protocol: RemoteCompactionProtocol } {
  if (status === "off") return { remote: "off", remote_protocol: "v2" }
  return {
    remote: openAIRemoteCompactionApplies(model) ? "auto" : "on",
    remote_protocol: status,
  }
}

export function openAIRemoteCompactionToggleTitle(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return `${openAIRemoteCompactionStatusTitle(config, model)} (toggle ${openAIRemoteCompactionEnabled(config, model) ? "off" : "on"})`
}

export function openAIRemoteCompactionProtocolToggleTitle(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
) {
  return `${openAIRemoteCompactionProtocolStatusTitle(config, model)} (switch to ${nextOpenAIRemoteCompactionProtocolStatus(config, model)})`
}

export function openAIRemoteCompactionToggleDescription(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return openAIRemoteCompactionEnabled(config, model)
    ? "Turn off to force local compaction for OpenAI remote models."
    : "Turn on to try Codex remote compaction for this model when OpenAI OAuth is available."
}

export function openAIRemoteCompactionProtocolToggleDescription(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
) {
  const next = nextOpenAIRemoteCompactionProtocolStatus(config, model)
  if (next === "off") return "Switch to local compaction only."
  if (next === "legacy") return "Switch to legacy /responses/compact remote compaction."
  return "Switch to Responses compaction v2."
}
