import { For, Show, createEffect, createMemo, type JSX } from "solid-js"
import { ProviderBalanceStatusPanel } from "@/components/provider-balance-chip"
import { useSync } from "@/context/sync"
import { useLocal } from "@/context/local"
export function SessionStatusPanel(props: { sessionID?: string; active: boolean; review: JSX.Element }) {
  const sync = useSync()
  const local = useLocal()
  const providerID = createMemo(() => local.model.current()?.provider?.id)
  const workBrief = createMemo(() => {
    const id = props.sessionID
    if (!id) return
    return sync.data.work_brief[id]
  })
  const briefItems = (items: string[] | undefined) => items?.filter((item) => !!item.trim()) ?? []
  const workBriefRows = createMemo(() => {
    const brief = workBrief()
    if (!brief) return []
    return [
      { label: "Intent", value: brief.intent?.trim() },
      { label: "Open questions", value: briefItems(brief.openQuestions).slice(0, 2).join(" · ") },
      { label: "Closeout", value: briefItems(brief.closeout).slice(0, 2).join(" · ") },
    ].filter((row) => !!row.value)
  })
  const briefStat = (label: string, count: number) => (count > 0 ? `${label} ${count}` : undefined)
  const workBriefStats = createMemo(() => {
    const brief = workBrief()
    if (!brief) return []
    return [
      briefStat("Decisions", briefItems(brief.confirmedDecisions).length),
      briefStat("Constraints", briefItems(brief.constraints).length),
      briefStat("Acceptance", briefItems(brief.acceptanceCriteria).length),
      briefStat("Evidence", briefItems(brief.relevantEvidence).length),
    ].filter((item): item is string => !!item)
  })

  createEffect(() => {
    if (!props.active) return
    const id = props.sessionID
    if (!id) return
    void sync.session.workBrief(id)
  })

  return (
    <div class="flex h-full flex-col overflow-hidden bg-background-stronger contain-strict">
      <div class="shrink-0 border-b border-border-weaker-base bg-background-stronger px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-12-medium text-text-strong">WorkBrief</div>
          <Show when={workBriefStats().length > 0}>
            <div class="flex flex-wrap justify-end gap-1">
              <For each={workBriefStats()}>
                {(item) => (
                  <div class="rounded-md bg-surface-base px-1.5 py-0.5 text-11-regular text-text-weak">{item}</div>
                )}
              </For>
            </div>
          </Show>
        </div>
        <Show
          when={workBriefRows().length > 0}
          fallback={<div class="mt-2 text-12-regular text-text-weak">No WorkBrief recorded for this session.</div>}
        >
          <div class="mt-2 flex flex-col gap-2">
            <For each={workBriefRows()}>
              {(row) => (
                <div class="min-w-0">
                  <div class="text-11-regular text-text-weaker">{row.label}</div>
                  <div class="truncate text-12-regular text-text-base">{row.value}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <ProviderBalanceStatusPanel providerID={providerID()} />
      <div class="min-h-0 flex-1 overflow-hidden">{props.review}</div>
    </div>
  )
}
