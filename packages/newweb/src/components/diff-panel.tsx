import { For, Show } from "solid-js"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"

export function DiffPanel(props: {
  diffs: Array<SnapshotFileDiff>
  loading: boolean
  onRefresh: () => void
  onOpenFile: (path: string) => void
}) {
  return (
    <section class="panel preview-panel">
      <div class="panel-title">
        <span>Diff</span>
        <button type="button" onClick={props.onRefresh} disabled={props.loading}>
          Refresh
        </button>
      </div>
      <Show when={props.loading}>
        <div class="muted">Loading diff...</div>
      </Show>
      <Show when={!props.loading && props.diffs.length === 0}>
        <div class="muted">No diff loaded</div>
      </Show>
      <For each={props.diffs}>
        {(diff) => (
          <article class="diff-card">
            <header>
              <strong>{diff.file}</strong>
              <span>{diff.status || "modified"}</span>
              <span>+{diff.additions} -{diff.deletions}</span>
              <button type="button" onClick={() => props.onOpenFile(diff.file)}>
                Open
              </button>
            </header>
            <pre>{diff.patch}</pre>
          </article>
        )}
      </For>
    </section>
  )
}
