import { Show } from "solid-js"
import type { FileContent } from "@opencode-ai/sdk/v2/client"

export function FilePreview(props: {
  path?: string
  content?: FileContent
  loading: boolean
  error?: string
  onReload: () => void
  onClose: () => void
}) {
  return (
    <section class="panel preview-panel">
      <div class="panel-title">
        <span>File</span>
        <div class="button-row">
          <button type="button" onClick={props.onReload} disabled={!props.path || props.loading}>
            Reload
          </button>
          <button type="button" onClick={props.onClose} disabled={!props.path}>
            Close
          </button>
        </div>
      </div>
      <Show when={props.path} fallback={<div class="muted">No file selected</div>}>
        <strong>{props.path}</strong>
      </Show>
      <Show when={props.loading}>
        <div class="muted">Loading file...</div>
      </Show>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <Show when={props.content?.type === "binary"}>
        <div class="muted">Binary file preview is not available.</div>
      </Show>
      <Show when={props.content?.type === "text"}>
        <pre class="file-content">{props.content?.content}</pre>
      </Show>
    </section>
  )
}
