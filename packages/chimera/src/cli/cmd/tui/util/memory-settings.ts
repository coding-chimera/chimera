export type MemorySettingsConfig = {
  memories?: {
    enabled?: boolean
    dedicated_tools?: boolean
  }
}

export function memoryEnabled(config: MemorySettingsConfig) {
  return config.memories?.enabled === true
}

export function memoryDedicatedToolsEnabled(config: MemorySettingsConfig) {
  return config.memories?.dedicated_tools === true
}

export function memoryEnabledStatus(config: MemorySettingsConfig) {
  return memoryEnabled(config) ? "on" : "off"
}

export function memoryDedicatedToolsStatus(config: MemorySettingsConfig) {
  return memoryDedicatedToolsEnabled(config) ? "on" : "off"
}

export function memoryEnabledToggleTitle(config: MemorySettingsConfig) {
  return `Memory system: ${memoryEnabledStatus(config)} (toggle ${memoryEnabled(config) ? "off" : "on"})`
}

export function memoryDedicatedToolsToggleTitle(config: MemorySettingsConfig) {
  return `Memory dedicated tools: ${memoryDedicatedToolsStatus(config)} (toggle ${memoryDedicatedToolsEnabled(config) ? "off" : "on"})`
}

export function memoryEnabledToggleDescription(config: MemorySettingsConfig) {
  return memoryEnabled(config)
    ? "Turn off Chimera cross-session memory for this project."
    : "Turn on Chimera cross-session memory (memories.enabled)."
}

export function memoryDedicatedToolsToggleDescription(config: MemorySettingsConfig) {
  return memoryDedicatedToolsEnabled(config)
    ? "Hide agent-facing memory tools (memory_remember / memory_list / memory_forget / memory_read)."
    : "Expose agent-facing memory tools when memory is enabled (memories.dedicated_tools)."
}

export function nextMemoryEnabled(config: MemorySettingsConfig) {
  return !memoryEnabled(config)
}

export function nextMemoryDedicatedTools(config: MemorySettingsConfig) {
  return !memoryDedicatedToolsEnabled(config)
}
