import { describe, expect, test } from "bun:test"
import type { Provider, ProviderBalanceResult } from "@opencode-ai/sdk/v2/client"
import { lowestQuotaLimit, providerBalanceProviders, providerBalanceSummary } from "./provider-balance"

const provider = (id: string, options: Provider["options"] = {}) =>
  ({
    id,
    name: id,
    source: "config",
    env: [],
    options,
    models: {},
  }) as Provider

type QuotaBalance = Extract<ProviderBalanceResult, { kind: "quota" }>

const codexQuota = (limits: QuotaBalance["limits"]): QuotaBalance => ({
  kind: "quota",
  providerID: "openai",
  status: "available",
  label: "Codex Usage",
  limits,
})

describe("provider balance helpers", () => {
  test("summarizes Codex using the lowest remaining quota", () => {
    const account = codexQuota([
      { label: "weekly", used_percent: 20, remaining_percent: 80 },
      { label: "5h", used_percent: 75, remaining_percent: 25 },
    ])

    expect(lowestQuotaLimit(account.limits)?.label).toBe("5h")
    expect(providerBalanceSummary(account)?.label).toBe("Codex 25% left")
  })

  test("discovers supported balance providers", () => {
    expect(
      providerBalanceProviders([
        provider("openai", { codexApiEndpoint: "https://codex.example.com" }),
        provider("deepseek", { baseURL: "https://api.deepseek.com/v1" }),
        provider("anthropic"),
      ]).map((item) => item.id),
    ).toEqual(["openai", "deepseek"])
  })
})
