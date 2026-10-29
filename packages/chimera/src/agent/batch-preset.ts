import { Schema } from "effect"
import type { SourceName } from "./batch-source"

/** Worker prompt shapes shared by batch surfaces (swarm facade, orche.batch). */
export const Preset = Schema.Literals(["audit-followup", "audit-review", "oracle-followup", "file-review"])
export type PresetName = Schema.Schema.Type<typeof Preset>

export const Item = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])
export type ExplicitItem = Schema.Schema.Type<typeof Item>

export type ScopeWarning = {
  file: string
  itemIndexes: number[]
  message: string
}

export const RETURN_CONTRACT = [
  "Return a concise structured report with these labels:",
  "Status: actionable | covered | irrelevant | duplicate | blocked | no-issue",
  "Changed files: <paths or none>",
  "Verification: <commands/results or not run>",
  "Remaining risk: <risk or none>",
  "Parent follow-up: <recommended parent action or none>",
]

export const DEFAULT_TEMPLATES: Record<PresetName, string> = {
  "audit-followup": [
    "You are a Chimera audit-followup subagent. Handle exactly one audit or obligation item.",
    "Presets are worker prompt shapes, not workflow engines or permission switches; use the tools available to your subagent normally.",
    "If the item has a clear, narrow fix and you have edit tools, make scoped edits only for this item, run focused verification when you edit, and report changed files.",
    "Do not broaden into unrelated refactors, do not take over other swarm items, and surface already-covered, irrelevant, duplicate, out-of-scope, or blocked items explicitly.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "audit-review": [
    "You are a Chimera audit-review subagent. Review exactly one audit or obligation item.",
    "Classify it as actionable, already covered, irrelevant, duplicate, stale, or out of scope.",
    "Do not edit unless the parent prompt explicitly tells you to. Return concise evidence and next action.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "oracle-followup": [
    "You are a Chimera oracle-followup subagent. Investigate exactly one failing or unknown verification oracle.",
    "Explain the likely cause, whether it is linked to recent changes, and the next focused check or fix.",
    "Do not rerun broad checks unless clearly necessary.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
  "file-review": [
    "You are a Chimera file-review subagent. Review exactly one file or work item.",
    "Report concrete risks, missing tests, or follow-up edits. Keep the result concise and evidence-backed.",
    ...RETURN_CONTRACT,
    "",
    "Item {{index}}/{{total}}:",
    "{{item}}",
  ].join("\n"),
}

export function inferPreset(source: SourceName | undefined): PresetName | undefined {
  if (!source) return undefined
  if (source.includes("oracle")) return "oracle-followup"
  if (source === "stale_obligations") return "audit-review"
  return "audit-followup"
}

export function inferSubagent(preset: PresetName | undefined): string {
  if (preset === "file-review") return "explore"
  return "general"
}

export function renderItem(item: ExplicitItem) {
  if (typeof item === "string") return item
  return JSON.stringify(item, null, 2) ?? "{}"
}

export function objectRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input))
}

export function stringValues(input: unknown) {
  if (typeof input === "string" && input.length > 0) return [input]
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.length > 0)
}

export function itemScopeFiles(item: ExplicitItem) {
  if (!objectRecord(item)) return []
  return [
    ...stringValues(item.files),
    ...stringValues(item.file),
    ...stringValues(item.path),
    ...stringValues(item.target),
    ...(objectRecord(item.scope)
      ? [...stringValues(item.scope.files), ...stringValues(item.scope.file), ...stringValues(item.scope.path), ...stringValues(item.scope.target)]
      : []),
  ]
}

export function collectScopeWarnings(items: ReadonlyArray<ExplicitItem>) {
  const byFile = new Map<string, number[]>()
  items.forEach((item, index) => itemScopeFiles(item).forEach((file) => byFile.set(file, [...(byFile.get(file) ?? []), index + 1])))
  return Array.from(byFile.entries())
    .filter(([, itemIndexes]) => itemIndexes.length > 1)
    .map(([file, itemIndexes]): ScopeWarning => ({
      file,
      itemIndexes,
      message: `Possible scope conflict: ${file} appears in items ${itemIndexes.join(", ")}; keep edits scoped, resolve conflicts in the parent, or lower concurrency.`,
    }))
}

export function scopeWarningPrompt(index: number, warnings: ScopeWarning[]) {
  return warnings
    .filter((warning) => warning.itemIndexes.includes(index))
    .map((warning) => `Scope warning: ${warning.message}`)
    .join("\n")
}

export function renderTemplate(template: string, item: ExplicitItem, index: number, total: number, warnings: ScopeWarning[]) {
  return [scopeWarningPrompt(index, warnings), template.replaceAll("{{item}}", renderItem(item)).replaceAll("{{index}}", String(index)).replaceAll("{{total}}", String(total))]
    .filter(Boolean)
    .join("\n\n")
}

export * as BatchPreset from "./batch-preset"