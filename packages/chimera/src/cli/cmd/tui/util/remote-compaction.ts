export type RemoteCompactionMode = "auto" | "off"

export type RemoteCompactionConfig = {
  compaction?: {
    remote?: RemoteCompactionMode
  }
}

export function openAIRemoteCompactionEnabled(config: RemoteCompactionConfig) {
  return config.compaction?.remote !== "off"
}

export function openAIRemoteCompactionStatus(config: RemoteCompactionConfig) {
  return openAIRemoteCompactionEnabled(config) ? "on" : "off"
}

export function openAIRemoteCompactionStatusTitle(config: RemoteCompactionConfig) {
  return `OpenAI remote compaction: ${openAIRemoteCompactionStatus(config)}`
}

export function openAIRemoteCompactionDescription(config: RemoteCompactionConfig) {
  return openAIRemoteCompactionEnabled(config)
    ? "Uses Codex remote compaction with OpenAI OAuth when available; falls back to local compaction."
    : "Disabled; Chimera will always use local compaction."
}

export function nextOpenAIRemoteCompactionMode(config: RemoteCompactionConfig): RemoteCompactionMode {
  return openAIRemoteCompactionEnabled(config) ? "off" : "auto"
}

export function openAIRemoteCompactionToggleTitle(config: RemoteCompactionConfig) {
  return `${openAIRemoteCompactionStatusTitle(config)} (toggle ${openAIRemoteCompactionEnabled(config) ? "off" : "on"})`
}

export function openAIRemoteCompactionToggleDescription(config: RemoteCompactionConfig) {
  return openAIRemoteCompactionEnabled(config)
    ? "Turn off to force local compaction for every provider."
    : "Turn on to use Codex remote compaction for OpenAI OAuth sessions when available."
}
