import { ModelIdentity } from "../provider/model-identity"

export function matchByDashPrefix(entry: string, candidate: string): boolean {
  return candidate === entry || candidate.startsWith(`${entry}-`)
}

export const SIZE_CLASSES = ["S", "M", "L", "XL"] as const
export type SizeClass = (typeof SIZE_CLASSES)[number]

const SIZE_CLASS_TABLE: Record<string, SizeClass> = {
  "kimi-k3": "XL",
  "qwen3.8-max": "XL",
  "gpt-5.6-sol": "XL",
  "claude-fable-5": "XL",
  "deepseek-v4-pro": "L",
  "deepseek-v4-flash": "L",
  "qwen3.8-flash": "L",
  "claude-opus-5": "L",
  "claude-opus-4.8": "L",
  "glm-5.2": "M",
  "gpt-5.6-terra": "M",
  "claude-sonnet-5": "M",
  "claude-sonnet-4.6": "M",
  "gpt-5.6-luna": "S",
  "claude-haiku": "S",
}

function isSizeClass(value: string | undefined): value is SizeClass {
  return value !== undefined && (SIZE_CLASSES as readonly string[]).includes(value)
}

function prefixSizeClass(normalized: string): SizeClass | undefined {
  const matches = Object.keys(SIZE_CLASS_TABLE).filter((entry) => matchByDashPrefix(entry, normalized))
  if (matches.length === 0) return undefined
  return SIZE_CLASS_TABLE[matches.toSorted((a, b) => b.length - a.length)[0]]
}

export function resolveSizeClass(input: { identity: string; configured?: string | undefined }): SizeClass | undefined {
  if (isSizeClass(input.configured)) return input.configured
  const normalized = ModelIdentity.normalize(input.identity)
  if (!normalized) return undefined
  return SIZE_CLASS_TABLE[normalized] ?? prefixSizeClass(normalized)
}

const SIZE_CLASS_SPEED: Record<SizeClass, number> = { XL: 0.15, L: 0.35, M: 0.6, S: 0.85 }
const SPEED_DEMOTION: Record<SizeClass, SizeClass> = { XL: "L", L: "M", M: "S", S: "S" }
const FAST_IDENTITY_PATTERN = /fast|flash/i
const LEGACY_FAST_PATTERN = /flash|luna|spark|lite|fast|k2\.7/i
const LEGACY_SLOW_PATTERN = /pro|sol|terra|opus|fable|ultra|k3|max/i

function legacyStaticSpeed(identity: string): number {
  if (LEGACY_FAST_PATTERN.test(identity)) return 1
  if (LEGACY_SLOW_PATTERN.test(identity)) return 0.3
  return 0.6
}

export function staticSpeedNorm(input: { sizeClass?: SizeClass | undefined; identity: string }): number {
  if (!input.sizeClass) return legacyStaticSpeed(input.identity)
  const demoted = FAST_IDENTITY_PATTERN.test(input.identity) ? SPEED_DEMOTION[input.sizeClass] : input.sizeClass
  return SIZE_CLASS_SPEED[demoted]
}

export * as SubagentModelSize from "./subagent-model-size"