import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { resolveSubagentExecution } from "../../src/agent/subagent-execution"
import type { Agent } from "../../src/agent/agent"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { it } from "../lib/effect"

const ok = Effect.succeed({ variants: { max: {}, xhigh: {} } })
const fail = Effect.sync(() => {
  throw new Error("nope")
})

const parent = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("parent-model"),
  variant: "high",
}

function subagent(overrides?: Partial<Agent.Info>): Agent.Info {
  return {
    name: "general",
    mode: "subagent",
    permission: [],
    options: {},
    ...overrides,
  }
}

describe("SubagentExecution.resolve", () => {
  it.effect("resolves an explicit model_profile over the delegation route", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: {
            flash: { model: "test/test-model", variant: "max" },
            luna: { model: "test/luna-model" },
          },
          routes: { general: "luna" },
        },
        validateModel: () => ok,
      })
      expect(result.source).toBe("request-profile")
      expect(result.profile).toBe("flash")
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "max",
      })
    }),
  )

  it.effect("resolves the route profile when no explicit model_profile is given", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: { flash: { model: "test/test-model" } },
          routes: { general: "flash" },
        },
        validateModel: () => ok,
      })
      expect(result.source).toBe("role-route")
      expect(result.profile).toBe("flash")
      expect(result.model.modelID).toBe(ModelID.make("test-model"))
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("falls back to the subagent configured model", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent({ model: { providerID: ProviderID.make("agent"), modelID: ModelID.make("agent-model") } }),
        validateModel: () => ok,
      })
      expect(result.source).toBe("agent-config")
      expect(result.model.providerID).toBe(ProviderID.make("agent"))
      expect(result.model.modelID).toBe(ModelID.make("agent-model"))
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("falls back to the parent model and inherits its variant", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      })
      expect(result.source).toBe("parent")
      expect(result.model).toEqual({
        providerID: parent.providerID,
        modelID: parent.modelID,
        variant: "high",
      })
    }),
  )

describe("SubagentExecution.ultra policy", () => {
  it.effect("rejects an explicit ultra variant for a subagent", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        variant: "ultra",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("Subagents do not support the ultra variant")
    }),
  )

  it.effect("rejects ultra case-insensitively on the model_identity path", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelIdentity: "test-model",
        variant: "Ultra",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
        resolveModelIdentity: () =>
          Effect.succeed({ providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }),
      }).pipe(Effect.flip)
      expect(String(error)).toContain("Subagents do not support the ultra variant")
    }),
  )

  it.effect("strips an inherited ultra variant from the parent fallback", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent: { ...parent, variant: "ultra" },
        subagent: subagent(),
        validateModel: () => ok,
      })
      expect(result.source).toBe("parent")
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("drops an agent-config ultra variant even when advertised", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent({
          model: { providerID: ProviderID.make("agent"), modelID: ModelID.make("agent-model") },
          variant: "ultra",
        }),
        validateModel: () => Effect.succeed({ variants: { ultra: {} } }),
      })
      expect(result.source).toBe("agent-config")
      expect(result.model.variant).toBeUndefined()
    }),
  )
})
  it.effect("fails for an unknown route target profile", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: { flash: { model: "test/test-model" } },
          routes: { general: "nope" },
        },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("Unknown model profile: nope")
      expect(String(error)).toContain('route "general"')
      expect(String(error)).toContain("Valid profiles: flash")
    }),
  )

  it.effect("applies the agent variant only when the model advertises it", () =>
    Effect.gen(function* () {
      const advertised = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent({
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          variant: "max",
        }),
        validateModel: () => ok,
      })
      expect(advertised.model.variant).toBe("max")

      const unadvertised = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent({
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          variant: "bogus",
        }),
        validateModel: () => ok,
      })
      expect(unadvertised.model.variant).toBeUndefined()
    }),
  )

  it.effect("ignores the agent variant when model validation fails", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent({
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          variant: "max",
        }),
        validateModel: () => fail,
      })
      expect(result.source).toBe("agent-config")
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("fails when a profile variant is not advertised", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model", variant: "bogus" } } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain('Model test/test-model does not advertise variant "bogus"')
      expect(String(error)).toContain("Available variants: max, xhigh")
    }),
  )

  it.effect("does not copy the parent variant for a variant-less profile", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("request-profile")
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("fails to resume a session created for a different agent", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "explore",
        parent,
        subagent: subagent(),
        existing: { agent: "general" },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("Cannot resume session: it was created for agent general, not explore")
    }),
  )

  it.effect("fails to resume a session locked to a different model", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        existing: { model: { id: ModelID.make("locked-model"), providerID: ProviderID.make("locked") } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain(
        "Cannot resume session: it is locked to model locked/locked-model, not test/test-model",
      )
    }),
  )

  it.effect("locks the child model and variant on resume", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        existing: {
          model: { id: parent.modelID, providerID: parent.providerID, variant: "xhigh" },
        },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model).toEqual({
        providerID: parent.providerID,
        modelID: parent.modelID,
        variant: "xhigh",
      })
    }),
  )

  it.effect("passes through when resuming an identity-less session", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        existing: {},
        validateModel: () => ok,
      })
      expect(result.source).toBe("parent")
      expect(result.model.providerID).toBe(parent.providerID)
    }),
  )
  it.effect("fails when the profile model cannot be validated even without a variant", () =>
    Effect.gen(function* () {
      const exit = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        validateModel: () =>
          Effect.sync(() => {
            throw new Error("Model test/test-model not found")
          }),
      }).pipe(Effect.exit)
      const message = Exit.match(exit, {
        onFailure: (cause) => Cause.prettyErrors(cause).map(String).join("\n"),
        onSuccess: () => "",
      })
      expect(message).toContain("Model test/test-model not found")
    }),
  )

  it.effect("does not inherit the parent variant when the persisted model has no variant", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        existing: { model: { id: parent.modelID, providerID: parent.providerID } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model.providerID).toBe(parent.providerID)
      expect(result.model.modelID).toBe(parent.modelID)
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("fails when the explicitly requested profile variant conflicts with the persisted variant", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model", variant: "max" } } },
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain('model test/test-model is locked to variant "xhigh"')
      expect(String(error)).toContain('not variant "max"')
    }),
  )

  it.effect("fails when a variant is requested for a persisted session that has none", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model", variant: "max" } } },
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test") } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("model test/test-model is locked to no variant")
      expect(String(error)).toContain('not variant "max"')
    }),
  )

  it.effect("keeps the persisted variant when the requested profile has no variant", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model.variant).toBe("xhigh")
    }),
  )

  it.effect("does not fail on a variant conflict for an implicit route profile", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: { flash: { model: "test/test-model", variant: "max" } },
          routes: { general: "flash" },
        },
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model.variant).toBe("xhigh")
    }),
  )

  it.effect("does not inherit a variant across a model lock", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model", variant: "max" } } },
        existing: { model: { id: ModelID.make("other-model"), providerID: ProviderID.make("other"), variant: "xhigh" } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("it is locked to model other/other-model, not test/test-model")
    }),
  )

  it.effect("implicit resume uses the persisted model even when the route points elsewhere", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: { luna: { model: "test/luna-model" } },
          routes: { general: "luna" },
        },
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.profile).toBeUndefined()
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
    }),
  )

  it.effect("implicit resume uses the persisted model when the agent-config model drifted", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent({
          model: { providerID: ProviderID.make("agent"), modelID: ModelID.make("agent-model") },
        }),
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
    }),
  )

  it.effect("implicit resume uses the persisted model when the parent model drifted", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
      expect(result.model).not.toEqual({
        providerID: parent.providerID,
        modelID: parent.modelID,
        variant: parent.variant,
      })
    }),
  )

  it.effect("agent mismatch still fails on implicit resume with a persisted model", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "explore",
        parent,
        subagent: subagent(),
        existing: {
          agent: "general",
          model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test") },
        },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("Cannot resume session: it was created for agent general, not explore")
    }),
  )

  it.effect("does not call validateModel on implicit resume with a persisted model", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: { luna: { model: "test/luna-model" } },
          routes: { general: "luna" },
        },
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => fail,
      })
      expect(result.source).toBe("resume")
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
    }),
  )

  it.effect("fast-path resume metadata is profile-less with source resume", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        existing: { model: { id: parent.modelID, providerID: parent.providerID, variant: parent.variant } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.profile).toBeUndefined()
      expect(result.model).toEqual({
        providerID: parent.providerID,
        modelID: parent.modelID,
        variant: parent.variant,
      })
    }),
  )
  it.effect("rejects empty explicit and route profile names", () =>
    Effect.gen(function* () {
      const explicit = yield* resolveSubagentExecution({
        subagentType: "general",
        modelProfile: " ",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(explicit)).toContain("Model profile name must not be empty")

      const route = yield* resolveSubagentExecution({
        subagentType: "general",
        parent,
        subagent: subagent(),
        delegation: { routes: { general: "" } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(route)).toContain("Model profile name must not be empty")
    }),
  )

  it.effect("resolves an explicit direct model with source request-model", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      })
      expect(result.source).toBe("request-model")
      expect(result.profile).toBeUndefined()
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: undefined,
      })
    }),
  )

  it.effect("resolves an explicit direct model with an advertised variant", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        variant: "max",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      })
      expect(result.source).toBe("request-model")
      expect(result.model.variant).toBe("max")
    }),
  )

  it.effect("fails for a model without provider/model format", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "nope",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain('Invalid model "nope"')
      expect(String(error)).toContain("provider/model")

      const empty = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(empty)).toContain("provider/model")

      const trailing = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(trailing)).toContain("provider/model")
    }),
  )

  it.effect("propagates validateModel failures for a direct model", () =>
    Effect.gen(function* () {
      const exit = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        parent,
        subagent: subagent(),
        validateModel: () => fail,
      }).pipe(Effect.exit)
      const message = Exit.match(exit, {
        onFailure: (cause) => Cause.prettyErrors(cause).map(String).join("\n"),
        onSuccess: () => "",
      })
      expect(message).toContain("nope")
    }),
  )

  it.effect("fails when a direct model variant is not advertised", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        variant: "bogus",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain('Model test/test-model does not advertise variant "bogus"')
      expect(String(error)).toContain("Available variants: max, xhigh")
    }),
  )

  it.effect("fails when variant is given without a direct model", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        variant: "max",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("variant requires model")
    }),
  )

  it.effect("fails when model and model_profile are both given", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        modelProfile: "flash",
        parent,
        subagent: subagent(),
        delegation: { model_profiles: { flash: { model: "test/test-model" } } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("mutually exclusive")
    }),
  )

  it.effect("leaves the variant undefined when a direct model is given without one", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      })
      expect(result.model.variant).toBeUndefined()
    }),
  )

  it.effect("allows an explicit direct model resume when the persisted model matches", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        parent,
        subagent: subagent(),
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
    }),
  )

  it.effect("fails an explicit direct model resume locked to a different model", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/other-model",
        parent,
        subagent: subagent(),
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("it is locked to model test/test-model, not test/other-model")
    }),
  )

  it.effect("fails an explicit direct model resume locked to a different variant", () =>
    Effect.gen(function* () {
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        variant: "max",
        parent,
        subagent: subagent(),
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(error)).toContain('model test/test-model is locked to variant "xhigh"')
      expect(String(error)).toContain('not variant "max"')
    }),
  )

  it.effect("keeps the persisted variant on explicit direct model resume without a variant", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        parent,
        subagent: subagent(),
        existing: { model: { id: ModelID.make("test-model"), providerID: ProviderID.make("test"), variant: "xhigh" } },
        validateModel: () => ok,
      })
      expect(result.source).toBe("resume")
      expect(result.model.variant).toBe("xhigh")
    }),
  )

  it.effect("direct model takes precedence over the delegation route", () =>
    Effect.gen(function* () {
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        parent,
        subagent: subagent(),
        delegation: {
          model_profiles: { luna: { model: "test/luna-model" } },
          routes: { general: "luna" },
        },
        validateModel: () => ok,
      })
      expect(result.source).toBe("request-model")
      expect(result.profile).toBeUndefined()
      expect(result.model.modelID).toBe(ModelID.make("test-model"))
    }),
  )
  it.effect("resolves model_identity through the callback with provider and variant", () =>
    Effect.gen(function* () {
      const seen: Array<{ modelIdentity: string; provider?: string }> = []
      const result = yield* resolveSubagentExecution({
        subagentType: "general",
        modelIdentity: "gpt-5.6",
        provider: "relay",
        variant: "max",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
        resolveModelIdentity: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { providerID: ProviderID.make("relay"), modelID: ModelID.make("deployment-a") }
          }),
      })
      expect(seen).toEqual([{ modelIdentity: "gpt-5.6", provider: "relay" }])
      expect(result.source).toBe("request-model-identity")
      expect(result.model).toEqual({
        providerID: ProviderID.make("relay"),
        modelID: ModelID.make("deployment-a"),
        variant: "max",
      })
    }),
  )

  it.effect("propagates model_identity resolution failures before model validation", () =>
    Effect.gen(function* () {
      let validated = false
      const error = yield* resolveSubagentExecution({
        subagentType: "general",
        modelIdentity: "ambiguous",
        parent,
        subagent: subagent(),
        validateModel: () => {
          validated = true
          return ok
        },
        resolveModelIdentity: () => Effect.fail(new Error("ambiguous current routes")),
      }).pipe(Effect.flip)
      expect(String(error)).toContain("ambiguous current routes")
      expect(validated).toBe(false)
    }),
  )

  it.effect("rejects invalid identity selector combinations and provider usage", () =>
    Effect.gen(function* () {
      const conflicts = yield* resolveSubagentExecution({
        subagentType: "general",
        model: "test/test-model",
        modelIdentity: "gpt-5.6",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(conflicts)).toContain("mutually exclusive")

      const providerOnly = yield* resolveSubagentExecution({
        subagentType: "general",
        provider: "relay",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(providerOnly)).toContain("provider requires model_identity")

      const emptyIdentity = yield* resolveSubagentExecution({
        subagentType: "general",
        modelIdentity: " ",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
      }).pipe(Effect.flip)
      expect(String(emptyIdentity)).toContain("model_identity must not be empty")
    }),
  )

  it.effect("rejects unadvertised identity variants and preserves the concrete resume lock", () =>
    Effect.gen(function* () {
      const unadvertised = yield* resolveSubagentExecution({
        subagentType: "general",
        modelIdentity: "gpt-5.6",
        variant: "bogus",
        parent,
        subagent: subagent(),
        validateModel: () => ok,
        resolveModelIdentity: () =>
          Effect.succeed({ providerID: ProviderID.make("relay"), modelID: ModelID.make("deployment-a") }),
      }).pipe(Effect.flip)
      expect(String(unadvertised)).toContain('does not advertise variant "bogus"')

      const locked = yield* resolveSubagentExecution({
        subagentType: "general",
        modelIdentity: "gpt-5.6",
        parent,
        subagent: subagent(),
        existing: {
          model: { id: ModelID.make("deployment-a"), providerID: ProviderID.make("relay"), variant: "max" },
        },
        validateModel: () => ok,
        resolveModelIdentity: () =>
          Effect.succeed({ providerID: ProviderID.make("relay"), modelID: ModelID.make("deployment-a") }),
      })
      expect(locked.source).toBe("resume")
      expect(locked.model).toEqual({
        providerID: ProviderID.make("relay"),
        modelID: ModelID.make("deployment-a"),
        variant: "max",
      })
    }),
  )
})
