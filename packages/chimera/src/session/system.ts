import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_CHIMERA from "./prompt/chimera.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_WORKFLOW from "./prompt/workflow.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_GPT55 from "./prompt/gpt55.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_DEEPSEEK from "./prompt/deepseek.txt"
import PROMPT_DEEPSEEK_OVERLAY from "./prompt/deepseek-overlay.txt"

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

function isDeepSeek(model: Provider.Model) {
  const modelIDs = ids(model)
  return modelIDs.providerID.includes("deepseek") || modelIDs.apiID.includes("deepseek")
}

function specialization(model: Provider.Model) {
  const modelIDs = ids(model)

  if (modelIDs.apiID.includes("gpt-4") || modelIDs.apiID.includes("o1") || modelIDs.apiID.includes("o3"))
    return PROMPT_BEAST
  if (modelIDs.apiID.includes("gpt")) {
    if (modelIDs.modelSlug === "gpt-5.5") return PROMPT_GPT55
    if (modelIDs.apiID.includes("codex")) {
      return PROMPT_CODEX
    }
    return PROMPT_GPT
  }
  if (modelIDs.apiID.includes("gemini-")) return PROMPT_GEMINI
  if (modelIDs.apiID.includes("claude")) return PROMPT_ANTHROPIC
  if (modelIDs.apiID.includes("trinity")) return PROMPT_TRINITY
  if (modelIDs.providerID.includes("kimi") || modelIDs.apiID.includes("kimi")) return PROMPT_KIMI
  if (isDeepSeek(model)) return PROMPT_DEEPSEEK
}

export function provider(model: Provider.Model) {
  const tuned = specialization(model)
  return [PROMPT_DEFAULT, PROMPT_WORKFLOW, PROMPT_CHIMERA, ...(tuned ? [tuned] : [])]
}

export function overlay(model: Provider.Model) {
  if (isDeepSeek(model)) return [PROMPT_DEEPSEEK_OVERLAY]
  return []
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
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
