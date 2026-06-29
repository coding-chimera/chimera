import type { Provider, ProviderBalanceResult } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"

type BalanceAccount = ProviderBalanceResult

type BalanceStatus = {
  label: string
  tooltip: string
  status: BalanceAccount["status"]
}

export function ProviderBalanceChip(props: { providerID?: string }) {
  const sync = useSync()
  const providers = useProviders()
  const providerID = createMemo(() => providerBalanceID(props.providerID, providers.all()))

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
    return providerBalanceStatus(account)
  })

  return (
    <Show when={status()}>
      {(item) => (
        <div data-component="provider-balance-chip" class="hidden sm:block min-w-0 shrink-0">
          <Tooltip value={item().tooltip} placement="top">
            <div
              class="h-7 max-w-[220px] px-2 flex items-center rounded-md border border-border-weak-base bg-surface-panel text-12-regular truncate"
              classList={{
                "text-text-weak": item().status === "available",
                "text-text-base": item().status === "unavailable",
                "text-icon-critical-base": item().status === "error",
              }}
            >
              <span class="truncate">{item().label}</span>
            </div>
          </Tooltip>
        </div>
      )}
    </Show>
  )
}

function providerBalanceID(providerID: string | undefined, providers: Provider[]) {
  if (!providerID) return
  if (providerBalanceApplies(providerID, providers.find((provider) => provider.id === providerID))) return providerID
}

function providerBalanceApplies(providerID: string, provider: Provider | undefined) {
  if (providerID === "openai") return typeof provider?.options.codexApiEndpoint === "string"
  if (providerID === "deepseek") return officialProviderEndpoint(provider, "api.deepseek.com")
  return false
}

function officialProviderEndpoint(provider: Provider | undefined, host: string) {
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

function providerBalanceStatus(account: BalanceAccount): BalanceStatus | undefined {
  if (account.kind === "quota") {
    if (account.limits.length === 0) {
      const message = account.message ?? "Codex usage unavailable"
      return { label: message, tooltip: message, status: account.status }
    }
    const details = account.limits.map((limit) => `${quotaLimitLabel(limit.label)} ${formatPercent(limit.remaining_percent)} left`)
    return {
      label: `Codex ${details.join(" · ")}`,
      tooltip: `${account.label ?? "Codex Usage"}: ${details.join(" · ")}`,
      status: account.status,
    }
  }

  const info = account.balance_infos[0]
  if (!info) {
    const message = account.message ?? `${account.providerID} balance unavailable`
    return { label: message, tooltip: message, status: account.status }
  }

  const label = `${account.providerID === "deepseek" ? "DeepSeek" : account.providerID} ${info.currency} ${formatBalance(info.total_balance)}`
  return {
    label,
    tooltip: label,
    status: account.status,
  }
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
