import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_CLAUDE from "./prompt/claude.txt"
import PROMPT_CHIMERA from "./prompt/chimera.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_WORKFLOW from "./prompt/workflow.txt"
import PROMPT_GPT4 from "./prompt/gpt-4.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_GPT55 from "./prompt/gpt-5.5.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_DEEPSEEK from "./prompt/deepseek.txt"
import PROMPT_DEEPSEEK_OVERLAY from "./prompt/deepseek-overlay.txt"
import PROMPT_DEEPSEEK_ULTRA from "./prompt/deepseek-ultra.txt"
import PROMPT_ULTRA from "./prompt/ultra.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

function ids(model: Provider.Model) {
  const apiID = model.api.id.toLowerCase()
  const providerID = model.providerID.toLowerCase()
  const modelSlug = apiID.split("/").at(-1) ?? apiID
  return { apiID, providerID, modelSlug }
}

type ModelIDs = ReturnType<typeof ids>

// Convention-based prompt layers. Entries are matched in order (first match
// wins). By default a key matches as a case-insensitive substring of the
// api id; `scope: "both"` also matches the provider id, `exact` restricts
// matching to the exact model slug, and `match` overrides the predicate.
// Adding a layer for a new model family is normally just a new txt file plus
// one entry here.
type LayerEntry = {
  keys: string[]
  content: string
  exact?: boolean
  scope?: "api" | "both"
  match?: (ids: ModelIDs) => boolean
}

const SPECIALIZATIONS: LayerEntry[] = [
  { keys: ["gpt-4", "o1", "o3"], content: PROMPT_GPT4 },
  { keys: ["gpt-5.5"], content: PROMPT_GPT55, exact: true },
  { keys: ["codex"], content: PROMPT_CODEX, match: (modelIDs) => modelIDs.apiID.includes("gpt") && modelIDs.apiID.includes("codex") },
  { keys: ["gpt"], content: PROMPT_GPT },
  { keys: ["gemini"], content: PROMPT_GEMINI },
  { keys: ["claude"], content: PROMPT_CLAUDE },
  { keys: ["trinity"], content: PROMPT_TRINITY },
  { keys: ["kimi"], content: PROMPT_KIMI, scope: "both" },
  { keys: ["deepseek"], content: PROMPT_DEEPSEEK, scope: "both" },
]

const OVERLAYS: LayerEntry[] = [
  { keys: ["deepseek"], content: PROMPT_DEEPSEEK_OVERLAY, scope: "both" },
]

const ULTRA_LAYERS: LayerEntry[] = [
  { keys: ["deepseek"], content: PROMPT_DEEPSEEK_ULTRA, scope: "both" },
]

function matches(entry: LayerEntry, modelIDs: ModelIDs) {
  if (entry.match) return entry.match(modelIDs)
  if (entry.exact) return entry.keys.includes(modelIDs.modelSlug)
  const haystacks = entry.scope === "both" ? [modelIDs.apiID, modelIDs.providerID] : [modelIDs.apiID]
  return entry.keys.some((key) => haystacks.some((haystack) => haystack.includes(key)))
}

function matchLayer(entries: LayerEntry[], model: Provider.Model) {
  const modelIDs = ids(model)
  return entries.find((entry) => matches(entry, modelIDs))?.content
}

export function provider(model: Provider.Model) {
  const tuned = matchLayer(SPECIALIZATIONS, model)
  return [PROMPT_DEFAULT, PROMPT_WORKFLOW, PROMPT_CHIMERA, ...(tuned ? [tuned] : [])]
}

export function overlay(model: Provider.Model) {
  const found = matchLayer(OVERLAYS, model)
  return found ? [found] : []
}

// Ultra root sessions always receive the generic ultra layer, plus a
// model-specific ultra layer when one is registered for the model.
export function ultraVariant(model: Provider.Model, variant: string | undefined) {
  if (variant !== "ultra") return []
  const specific = matchLayer(ULTRA_LAYERS, model)
  return [PROMPT_ULTRA, ...(specific ? [specific] : [])]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills are loaded on demand. The index below contains names only.",
          "Use the skill tool with an exact listed name when that skill clearly matches the task.",
          Skill.fmt(list),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
