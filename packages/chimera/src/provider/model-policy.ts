export interface ModelPolicyRef {
  id?: string
  api?: {
    id?: string
  }
  capability_model_id?: string
}

export interface AstraReadDedupConfig {
  gpt_6_astra?: boolean
}

const ASTRA_ID = /^gpt-6(?:\.\d+)?-astra(?:$|[-.])/

function normalizeModelID(value: string | undefined) {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed) return undefined
  return (trimmed.split("/").at(-1) ?? trimmed).replace(/^openai[._:-]+/, "")
}

function isAstraID(value: string | undefined) {
  const id = normalizeModelID(value)
  return id ? ASTRA_ID.test(id) : false
}

function primaryModelID(model: ModelPolicyRef | undefined) {
  return normalizeModelID(model?.capability_model_id) ?? normalizeModelID(model?.api?.id) ?? normalizeModelID(model?.id)
}

export function modelID(model: ModelPolicyRef | undefined) {
  return primaryModelID(model)
}

export function isGpt6Astra(model: ModelPolicyRef | undefined) {
  return isAstraID(primaryModelID(model))
}

export function astraReadDedupEnabled(config: AstraReadDedupConfig | undefined) {
  return config?.gpt_6_astra !== false
}

export * as ModelPolicy from "./model-policy"