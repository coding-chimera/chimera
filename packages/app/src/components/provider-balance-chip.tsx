import { createEffect, createMemo, For, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import {
  providerBalanceDetails,
  providerBalanceID,
  providerBalanceName,
  providerBalanceProviders,
  providerBalanceSummary,
} from "./provider-balance"

export function ProviderBalanceChip(props: { providerID?: string }) {
  const sync = useSync()
  const providers = useProviders()
  const providerID = createMemo(() => providerBalanceID(props.providerID, providers.all()))

  createEffect(() => {
    const current = providerID()
    if (current) void sync.providerBalance.load(current)
  })

  const summary = createMemo(() => {
    const current = providerID()
    if (!current) return
    const account = sync.data.provider_balance[current]
    if (!account) return
    if (account.status === "not_configured" || account.status === "unsupported") return
    return providerBalanceSummary(account)
  })

  return (
    <Show when={summary()}>
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

export function ProviderBalanceStatusPanel() {
  const sync = useSync()
  const providers = useProviders()
  const items = createMemo(() => providerBalanceProviders(providers.all()))

  createEffect(() => {
    for (const item of items()) {
      void sync.providerBalance.load(item.id)
    }
  })

  const rows = createMemo(() =>
    items().map((item) => {
      const account = sync.data.provider_balance[item.id]
      return {
        ...item,
        account,
        summary: account ? providerBalanceSummary(account) : undefined,
        details: account ? providerBalanceDetails(account) : [],
      }
    }),
  )

  return (
    <div class="shrink-0 border-b border-border-weaker-base bg-background-stronger px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <div class="text-12-medium text-text-strong">Provider Balance</div>
        <Show when={rows().length > 0}>
          <div class="text-11-regular text-text-weaker">{rows().length}</div>
        </Show>
      </div>
      <Show
        when={rows().length > 0}
        fallback={<div class="mt-2 text-12-regular text-text-weak">No provider balance sources are configured.</div>}
      >
        <div class="mt-2 flex flex-col gap-2">
          <For each={rows()}>
            {(row) => (
              <div class="rounded-md border border-border-weaker-base bg-surface-base px-3 py-2">
                <div class="flex items-start gap-2">
                  <ProviderIcon id={row.id} class="mt-0.5 size-4 shrink-0 opacity-70" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-12-medium text-text-strong">{providerBalanceName(row.id, row.provider)}</div>
                    <div
                      class="truncate text-12-regular"
                      classList={{
                        "text-text-weak": !row.summary || row.summary.status === "available",
                        "text-text-base": row.summary?.status === "unavailable",
                        "text-icon-critical-base": row.summary?.status === "error",
                      }}
                    >
                      {row.summary?.label ?? "Loading balance..."}
                    </div>
                  </div>
                </div>
                <Show when={row.details.length > 0}>
                  <div class="mt-2 grid grid-cols-2 gap-2">
                    <For each={row.details}>
                      {(detail) => (
                        <div class="min-w-0 rounded-md bg-background-base px-2 py-1">
                          <div class="truncate text-11-regular text-text-weaker">{detail.label}</div>
                          <div class="truncate text-12-regular text-text-base">{detail.value}</div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
