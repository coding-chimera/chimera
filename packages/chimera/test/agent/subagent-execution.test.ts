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

})
