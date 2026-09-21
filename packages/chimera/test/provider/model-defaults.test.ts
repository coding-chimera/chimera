import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@/provider/models"
import { CodexModel } from "@/provider/codex-model"
import { ModelDefaults } from "@/provider/model-defaults"
import {
  samplingFixtures,
  variantFixtures,
  catalogFixture,
  codexIDFixtures,
  fixtureModel,
} from "./model-defaults-fixtures"

// Golden captured from the pre-refactor hardcoded implementations
// (temperature/topP/topK chains, baseVariants family detection, variants ultra
// append, inferReasoningProtocol, codex profiles). The L4.3 data-table
// extraction must stay byte-identical on the default path.
const golden = await Bun.file(new URL("./fixtures/model-defaults.golden.json", import.meta.url)).json()

describe("model defaults extraction — default path byte equality", () => {
  test("sampling defaults match pre-extraction behavior", () => {
    const actual = samplingFixtures.map((model) => ({
      id: model.id,
      temperature: ProviderTransform.temperature(model) ?? null,
      top_p: ProviderTransform.topP(model) ?? null,
      top_k: ProviderTransform.topK(model) ?? null,
    }))
    expect(JSON.stringify(actual)).toBe(JSON.stringify(golden.sampling))
  })

  test("variants match pre-extraction behavior", () => {
    const actual = variantFixtures.map((model) => ({
      id: model.id,
      npm: model.api.npm,
      variants: ProviderTransform.variants(model),
    }))
    expect(JSON.stringify(actual)).toBe(JSON.stringify(golden.variants))
  })

  test("catalog reasoning protocol inference matches pre-extraction behavior", () => {
    expect(JSON.stringify(ModelsDev.normalizeCatalog(catalogFixture))).toBe(JSON.stringify(golden.catalog))
  })

  test("codex profiles match pre-extraction behavior", () => {
    const actual = codexIDFixtures.map((id) => ({
      id,
      capabilityModelID: CodexModel.capabilityModelID(id) ?? null,
      reasoningEfforts: CodexModel.reasoningEfforts(id),
      reasoningEffortsConfiguredLowHighMax: CodexModel.reasoningEfforts(id, ["low", "high", "max"]),
      smallReasoningEffort: CodexModel.smallReasoningEffort(id) ?? null,
      limit: CodexModel.limit(id) ?? null,
      isOAuthModel: CodexModel.isOAuthModel(id),
      supportsCatalogSemantics: CodexModel.supportsCatalogSemantics(id),
    }))
    expect(JSON.stringify(actual)).toBe(JSON.stringify(golden.codex))
  })
})

describe("model defaults tables", () => {
  test("resolved sampling on the model overrides the built-in table", () => {
    const qwen = fixtureModel({ id: "ali/qwen3.8-max", apiID: "qwen3.8-max" })
    expect(ProviderTransform.temperature(qwen)).toBe(1.0)
    expect(ProviderTransform.topP(qwen)).toBe(0.95)
    expect(ProviderTransform.topK(qwen)).toBe(20)
    const overridden = { ...qwen, sampling: { temperature: 0.3, top_p: 0.8, top_k: 5 } }
    expect(ProviderTransform.temperature(overridden)).toBe(0.3)
    expect(ProviderTransform.topP(overridden)).toBe(0.8)
    expect(ProviderTransform.topK(overridden)).toBe(5)
  })

  test("partial sampling override keeps built-in defaults for unset fields", () => {
    const qwen = fixtureModel({ id: "ali/qwen3.8-max", apiID: "qwen3.8-max" })
    const overridden = { ...qwen, sampling: { top_k: 40 } }
    expect(ProviderTransform.temperature(overridden)).toBe(1.0)
    expect(ProviderTransform.topP(overridden)).toBe(0.95)
    expect(ProviderTransform.topK(overridden)).toBe(40)
  })

  test("capability table matching is substring-based, case-insensitive, longest key last", () => {
    const table = {
      qwen: { default_variant: "low" },
      "ali/qwen3.8-max": { default_variant: "high" },
      QWEN3: { default_variant: "medium" },
    }
    const entries = ModelDefaults.matchModelCapabilityEntries(table, {
      providerID: "ali",
      modelID: "qwen3.8-max",
      apiID: "qwen3.8-max",
    })
    // least specific first; "ali/qwen3.8-max" (longest) wins when applied in order
    expect(entries.map((e) => e.default_variant)).toEqual(["low", "medium", "high"])
  })

  test("capability table matching covers provider-qualified keys only for the right provider", () => {
    const table = { "ali/qwen3.8-max": { default_variant: "high" } }
    expect(
      ModelDefaults.matchModelCapabilityEntries(table, {
        providerID: "other",
        modelID: "qwen3.8-max",
        apiID: "qwen3.8-max",
      }),
    ).toEqual([])
  })
})
