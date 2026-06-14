export type RemoteCompactionMode = "auto" | "on" | "off"

export type RemoteCompactionConfig = {
  compaction?: {
    remote?: RemoteCompactionMode
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

export function openAIRemoteCompactionStatusTitle(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return `OpenAI remote compaction: ${openAIRemoteCompactionStatus(config, model)}`
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

export function nextOpenAIRemoteCompactionMode(
  config: RemoteCompactionConfig,
  model: RemoteCompactionModel | undefined,
): RemoteCompactionMode {
  if (openAIRemoteCompactionEnabled(config, model)) return "off"
  return openAIRemoteCompactionApplies(model) ? "auto" : "on"
}

export function openAIRemoteCompactionToggleTitle(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return `${openAIRemoteCompactionStatusTitle(config, model)} (toggle ${openAIRemoteCompactionEnabled(config, model) ? "off" : "on"})`
}

export function openAIRemoteCompactionToggleDescription(config: RemoteCompactionConfig, model: RemoteCompactionModel | undefined) {
  return openAIRemoteCompactionEnabled(config, model)
    ? "Turn off to force local compaction for OpenAI remote models."
    : "Turn on to try Codex remote compaction for this model when OpenAI OAuth is available."
}
