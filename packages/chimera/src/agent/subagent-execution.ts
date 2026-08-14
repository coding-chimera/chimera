import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { ModelID, ProviderID } from "../provider/schema"
import { SessionID } from "../session/schema"
import type { Agent } from "./agent"

export type ResolvedSubagentExecution = {
  agent: string
  profile?: string
  model: {
    providerID: ProviderID
    modelID: ModelID
    variant?: string
  }
  source: "request-profile" | "role-route" | "agent-config" | "parent" | "resume" | "request-model" | "request-model-identity"
}

export type SubagentExecutionMetadata = {
  version: 2
  parentSessionId: SessionID
  agent: string
  modelProfile?: string
  workload?: string
  source: ResolvedSubagentExecution["source"]
  resumed: boolean
}

export type SubagentExecutionInput = {
  subagentType: string
  modelProfile?: string
  model?: string
  modelIdentity?: string
  provider?: string
  variant?: string
  parent: { providerID: ProviderID; modelID: ModelID; variant?: string }
  subagent: Agent.Info
  delegation?: {
    model_profiles?: Record<string, { model: string; variant?: string; description?: string }>
    routes?: Record<string, string>
  }
  existing?: { agent?: string; model?: { id: ModelID; providerID: ProviderID; variant?: string } | null }
  validateModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<{ variants?: Record<string, unknown> }>
  resolveModelIdentity?: (input: { modelIdentity: string; provider?: string }) => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }, Error>
}

export type SubagentModelSelection = Pick<
  SubagentExecutionInput,
  "modelProfile" | "model" | "modelIdentity" | "provider" | "variant"
>

const ULTRA_VARIANT_ERROR =
  "Subagents do not support the ultra variant; ultra is reserved for root sessions. Omit variant or choose a non-ultra variant."

export const validateSubagentModelSelection = Effect.fn("SubagentExecution.validateSelection")(function* (
  input: SubagentModelSelection,
) {
  if (input.model !== undefined && input.modelProfile !== undefined) {
    return yield* Effect.fail(
      new Error("model and model_profile are mutually exclusive: pass either model or model_profile, not both"),
    )
  }
  if (input.modelIdentity !== undefined && (input.model !== undefined || input.modelProfile !== undefined)) {
    return yield* Effect.fail(
      new Error("model_profile, model, and model_identity are mutually exclusive: pass at most one selector"),
    )
  }
  if (input.provider !== undefined && input.modelIdentity === undefined) {
    return yield* Effect.fail(new Error("provider requires model_identity; exact model already includes its provider"))
  }
  if (input.modelIdentity !== undefined && input.modelIdentity.trim().length === 0) {
    return yield* Effect.fail(new Error("model_identity must not be empty"))
  }
  if (input.provider !== undefined && input.provider.trim().length === 0) {
    return yield* Effect.fail(new Error("provider must not be empty"))
  }
  if (input.variant !== undefined && input.variant.toLowerCase() === "ultra") {
    return yield* Effect.fail(new Error(ULTRA_VARIANT_ERROR))
  }
  if (input.variant !== undefined && input.model === undefined && input.modelIdentity === undefined) {
    return yield* Effect.fail(new Error("variant requires model or model_identity"))
  }
})


const applyResume: (input: {
  subagentType: string
  existing: SubagentExecutionInput["existing"]
  resolved: Omit<ResolvedSubagentExecution, "profile"> & { profile?: string }
}) => Effect.Effect<ResolvedSubagentExecution, Error, never> = Effect.fnUntraced(function* (input) {
  const existing = input.existing
  if (existing == null) return input.resolved
  if (existing.agent && existing.agent !== input.subagentType) {
    return yield* Effect.fail(
      new Error(`Cannot resume session: it was created for agent ${existing.agent}, not ${input.subagentType}`),
    )
  }
  if (
    existing.model &&
    (existing.model.providerID !== input.resolved.model.providerID || existing.model.id !== input.resolved.model.modelID)
  ) {
    return yield* Effect.fail(
      new Error(
        `Cannot resume session: it is locked to model ${existing.model.providerID}/${existing.model.id}, not ${input.resolved.model.providerID}/${input.resolved.model.modelID}`,
      ),
    )
  }
  if (existing.model) {
    if (
      (input.resolved.source === "request-profile" || input.resolved.source === "request-model" || input.resolved.source === "request-model-identity") &&
      input.resolved.model.variant !== undefined &&
      input.resolved.model.variant !== existing.model.variant
    ) {
      return yield* Effect.fail(
        new Error(
          `Cannot resume session: model ${existing.model.providerID}/${existing.model.id} is locked to ${
            existing.model.variant === undefined ? "no variant" : `variant "${existing.model.variant}"`
          }, not variant "${input.resolved.model.variant}"`,
        ),
      )
    }
    return {
      agent: input.subagentType,
      profile: input.resolved.profile,
      model: {
        providerID: existing.model.providerID,
        modelID: existing.model.id,
        variant: existing.model.variant,
      },
      source: "resume",
    }
  }
  return input.resolved
})

export const resolveSubagentExecution: (
  input: SubagentExecutionInput,
) => Effect.Effect<ResolvedSubagentExecution, Error, never> = Effect.fn("SubagentExecution.resolve")(function* (
  input: SubagentExecutionInput,
) {
  yield* validateSubagentModelSelection(input)
  if (input.existing?.model && input.modelProfile === undefined && input.model === undefined && input.modelIdentity === undefined) {
    return yield* applyResume({
      subagentType: input.subagentType,
      existing: input.existing,
      resolved: {
        agent: input.subagentType,
        profile: undefined,
        model: {
          providerID: input.existing.model.providerID,
          modelID: input.existing.model.id,
          variant: input.existing.model.variant,
        },
        source: "resume",
      },
    })
  }

  if (input.model !== undefined) {
    const parsed = Provider.parseModel(input.model)
    if (parsed.providerID.trim().length === 0 || parsed.modelID.trim().length === 0) {
      return yield* Effect.fail(new Error(`Invalid model "${input.model}": expected "provider/model"`))
    }
    const info = yield* input.validateModel(parsed.providerID, parsed.modelID)
    if (input.variant !== undefined && !info.variants?.[input.variant]) {
      return yield* Effect.fail(
        new Error(
          `Model ${parsed.providerID}/${parsed.modelID} does not advertise variant "${input.variant}". Available variants: ${Object.keys(info.variants ?? {}).join(", ") || "none"}.`
        ),
      )
    }
    return yield* applyResume({
      subagentType: input.subagentType,
      existing: input.existing,
      resolved: {
        agent: input.subagentType,
        model: { providerID: parsed.providerID, modelID: parsed.modelID, variant: input.variant },
        source: "request-model",
      },
    })
  }

  if (input.modelIdentity !== undefined) {
    if (!input.resolveModelIdentity) {
      return yield* Effect.fail(new Error("model_identity resolution is unavailable"))
    }
    const route = yield* input.resolveModelIdentity({
      modelIdentity: input.modelIdentity,
      provider: input.provider,
    })
    const info = yield* input.validateModel(route.providerID, route.modelID)
    if (input.variant !== undefined && !info.variants?.[input.variant]) {
      return yield* Effect.fail(
        new Error(
          `Model ${route.providerID}/${route.modelID} does not advertise variant "${input.variant}". Available variants: ${Object.keys(info.variants ?? {}).join(", ") || "none"}.`,
        ),
      )
    }
    return yield* applyResume({
      subagentType: input.subagentType,
      existing: input.existing,
      resolved: {
        agent: input.subagentType,
        model: { providerID: route.providerID, modelID: route.modelID, variant: input.variant },
        source: "request-model-identity",
      },
    })
  }


  const profiles = input.delegation?.model_profiles
  const routeProfile = input.delegation?.routes?.[input.subagentType]
  const profileName = input.modelProfile ?? routeProfile

  if (profileName !== undefined) {
    if (profileName.trim().length === 0) {
      return yield* Effect.fail(new Error("Model profile name must not be empty"))
    }
    const entry = profiles?.[profileName]
    const valid = Object.keys(profiles ?? {})
    if (!entry) {
      const message =
        input.modelProfile !== undefined
          ? `Unknown model profile: ${profileName}. Valid profiles: ${valid.join(", ")}`
          : `Unknown model profile: ${profileName} for route "${input.subagentType}". Valid profiles: ${valid.join(", ")}`
      return yield* Effect.fail(new Error(message))
    }
    const parsed = Provider.parseModel(entry.model)
    const variant = entry.variant
    if (variant?.toLowerCase() === "ultra") {
      return yield* Effect.fail(new Error(ULTRA_VARIANT_ERROR))
    }
    const info = yield* input.validateModel(parsed.providerID, parsed.modelID)
    if (variant !== undefined && !info.variants?.[variant]) {
      return yield* Effect.fail(
        new Error(
          `Model ${parsed.providerID}/${parsed.modelID} does not advertise variant "${variant}". Available variants: ${Object.keys(info.variants ?? {}).join(", ") || "none"}.`
        ),
      )
    }
    return yield* applyResume({
      subagentType: input.subagentType,
      existing: input.existing,
      resolved: {
        agent: input.subagentType,
        profile: profileName,
        model: { providerID: parsed.providerID, modelID: parsed.modelID, variant },
        source: input.modelProfile !== undefined ? "request-profile" : "role-route",
      },
    })
  }

  if (input.subagent.model) {
    const model = { providerID: input.subagent.model.providerID, modelID: input.subagent.model.modelID }
    const variant =
      input.subagent.variant === undefined
        ? undefined
        : yield* input.validateModel(model.providerID, model.modelID).pipe(
            Effect.catchCause(() => Effect.succeed<{ variants?: Record<string, unknown> }>({})),
            Effect.map((info) =>
              info.variants?.[input.subagent.variant!] && input.subagent.variant!.toLowerCase() !== "ultra" ? input.subagent.variant : undefined,
            ),
          )
    return yield* applyResume({
      subagentType: input.subagentType,
      existing: input.existing,
      resolved: { agent: input.subagentType, model: { ...model, variant }, source: "agent-config" },
    })
  }

  return yield* applyResume({
    subagentType: input.subagentType,
    existing: input.existing,
    resolved: {
      agent: input.subagentType,
      model: {
        providerID: input.parent.providerID,
        modelID: input.parent.modelID,
        variant: input.parent.variant?.toLowerCase() === "ultra" ? undefined : input.parent.variant,
      },
      source: "parent",
    },
  })
})
