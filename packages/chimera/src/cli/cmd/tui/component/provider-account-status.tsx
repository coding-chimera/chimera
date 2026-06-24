import { createEffect, createMemo, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import type { Provider as ProviderInfo, ProviderBalanceResult } from "@opencode-ai/sdk/v2"

export function ProviderAccountStatus(props: { providerID?: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const providerID = createMemo(() => providerAccountID(props.providerID, sync.data.provider))
  createEffect(() => {
    const current = providerID()
    if (current) void sync.providerBalance.load(current)
  })
  const status = createMemo(() => {
    const current = providerID()
    if (!current) return
    const account = sync.data.provider_balance[current]
    if (!account) return
    if (account.status === "not_configured" || account.status === "unsupported") return
    const label = providerAccountLabel(account)
    if (!label) return
    return {
      label,
      color: providerAccountStatusColor(account.status, theme),
    }
  })
  return <Show when={status()}>{(item) => <text fg={item().color} wrapMode="none">{item().label}</text>}</Show>
}

function providerAccountID(providerID: string | undefined, providers: ProviderInfo[]) {
  if (!providerID) return
  if (providerAccountApplies(providerID, providers.find((provider) => provider.id === providerID))) return providerID
}

function providerAccountApplies(providerID: string, provider: ProviderInfo | undefined) {
  if (providerID === "openai") return typeof provider?.options.codexApiEndpoint === "string"
  if (providerID === "deepseek") return officialProviderEndpoint(provider, "api.deepseek.com")
  return false
}

function officialProviderEndpoint(provider: ProviderInfo | undefined, host: string) {
  const endpoint = stringOption(provider?.options.baseURL) ?? stringOption(provider?.options.endpoint)
  if (!endpoint) return provider !== undefined
  return endpoint.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0]?.toLowerCase() === host
}

function stringOption(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  return trimmed
}

function providerAccountLabel(account: ProviderBalanceResult) {
  if (account.kind === "quota") {
    if (account.limits.length === 0) return account.message ?? "Codex usage unavailable"
    return `Codex ${account.limits.map((limit) => `${quotaLimitLabel(limit.label)} ${formatPercent(limit.remaining_percent)}`).join(" · ")}`
  }
  const info = account.balance_infos[0]
  if (!info) return account.message ?? `${account.providerID} balance unavailable`
  return `${account.providerID === "deepseek" ? "DeepSeek" : account.providerID} ${info.currency} ${formatBalance(info.total_balance)}`
}

function quotaLimitLabel(label: string) {
  if (label === "weekly") return "W"
  return label
}

function formatPercent(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0%"
  return `${Math.round(value)}%`
}

function formatBalance(value: string) {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return number.toFixed(2)
}

function providerAccountStatusColor(status: ProviderBalanceResult["status"], theme: Pick<ReturnType<typeof useTheme>["theme"], "success" | "warning" | "error">) {
  if (status === "available") return theme.success
  if (status === "unavailable") return theme.warning
  return theme.error
}
