import type { Provider, ProviderBalanceResult } from "@opencode-ai/sdk/v2/client"

type BalanceAccount = ProviderBalanceResult
type BalanceStatus = BalanceAccount["status"]
type QuotaLimit = Extract<BalanceAccount, { kind: "quota" }>["limits"][number]

export type BalanceSummary = {
  label: string
  tooltip: string
  status: BalanceStatus
}

export type BalanceDetail = {
  label: string
  value: string
}

export type BalanceProvider = {
  id: string
  provider: Provider
}

export function providerBalanceProviders(providers: Provider[], providerID?: string): BalanceProvider[] {
  return providers
    .map((provider) => ({ provider, id: providerBalanceID(provider.id, providers) }))
    .filter((item): item is BalanceProvider => !!item.id)
    .filter((item) => !providerID || item.id === providerID)
}

export function providerBalanceID(providerID: string | undefined, providers: Provider[]) {
  if (!providerID) return
  if (providerBalanceApplies(providerID, providers.find((provider) => provider.id === providerID))) return providerID
}

export function providerBalanceApplies(providerID: string, provider: Provider | undefined) {
  if (providerID === "openai") return typeof provider?.options.codexApiEndpoint === "string"
  if (providerID === "deepseek") return officialProviderEndpoint(provider, "api.deepseek.com")
  return false
}

export function providerBalanceSummary(account: BalanceAccount): BalanceSummary | undefined {
  if (account.kind === "quota") {
    if (account.limits.length === 0) {
      const message = account.message ?? "Codex usage unavailable"
      return { label: message, tooltip: message, status: account.status }
    }
    const details = account.limits.map((limit) => `${quotaLimitLabel(limit.label)} ${formatPercent(limit.remaining_percent)} left`)
    return {
      label: `Codex ${formatPercent(lowestQuotaLimit(account.limits)?.remaining_percent)} left`,
      tooltip: `${account.label ?? "Codex Usage"}: ${details.join(" · ")}`,
      status: account.status,
    }
  }

  const info = account.balance_infos[0]
  if (!info) {
    const message = account.message ?? `${account.providerID} balance unavailable`
    return { label: message, tooltip: message, status: account.status }
  }

  const label = `${providerBalanceName(account.providerID)} ${info.currency} ${formatBalance(info.total_balance)}`
  return {
    label,
    tooltip: label,
    status: account.status,
  }
}

export function providerBalanceDetails(account: BalanceAccount): BalanceDetail[] {
  if (account.kind === "quota") {
    if (account.limits.length === 0) return account.message ? [{ label: "Status", value: account.message }] : []
    return account.limits.map((limit) => ({
      label: quotaLimitName(limit.label),
      value: `${formatPercent(limit.remaining_percent)} left · ${formatPercent(limit.used_percent)} used`,
    }))
  }

  if (account.balance_infos.length === 0) return account.message ? [{ label: "Status", value: account.message }] : []
  return account.balance_infos.flatMap((info) => [
    { label: `${info.currency} total`, value: formatBalance(info.total_balance) },
    { label: `${info.currency} granted`, value: formatBalance(info.granted_balance) },
    { label: `${info.currency} topped up`, value: formatBalance(info.topped_up_balance) },
  ])
}

export function lowestQuotaLimit(limits: QuotaLimit[]) {
  return limits
    .map((limit) => ({ limit, remaining: finiteNumber(limit.remaining_percent) }))
    .filter((item): item is { limit: QuotaLimit; remaining: number } => item.remaining !== undefined)
    .sort((a, b) => a.remaining - b.remaining)[0]?.limit
}

function officialProviderEndpoint(provider: Provider | undefined, host: string) {
  const endpoint = stringOption(provider?.options.baseURL) ?? stringOption(provider?.options.endpoint)
  if (!endpoint) return provider !== undefined
  return endpoint.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0]?.toLowerCase() === host
}

export function providerBalanceName(providerID: string, provider?: Provider) {
  if (provider?.name) return provider.name
  if (providerID === "deepseek") return "DeepSeek"
  if (providerID === "openai") return "Codex"
  return providerID
}

function stringOption(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  return trimmed
}

function quotaLimitLabel(label: string) {
  if (label === "weekly") return "W"
  return label
}

function quotaLimitName(label: string) {
  if (label === "5h") return "5-hour"
  if (label === "weekly") return "Weekly"
  return label
}

function formatPercent(value: unknown) {
  const number = finiteNumber(value)
  if (number === undefined) return "0%"
  return `${Math.round(number)}%`
}

function finiteNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

function formatBalance(value: string) {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return number.toFixed(2)
}
