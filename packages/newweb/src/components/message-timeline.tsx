import { For, Show } from "solid-js"
import type { FilePart, Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import type { MessageRow } from "@/state/store"

function timeLabel(value: number) {
  return new Date(value).toLocaleTimeString()
}

function output(value: unknown) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

function toolText(part: ToolPart) {
  if (part.state.status === "pending") return part.state.raw || output(part.state.input)
  if (part.state.status === "running") return part.state.title || output(part.state.input)
  if (part.state.status === "completed") return part.state.output
  return part.state.error
}

function filePath(part: FilePart) {
  if (part.source && "path" in part.source) return part.source.path
  return part.filename || part.url
}

function partBody(part: Part) {
  if (part.type === "text") return part.text
  if (part.type === "reasoning") return part.text
  if (part.type === "tool") return toolText(part)
  if (part.type === "file") return filePath(part)
  if (part.type === "agent") return part.name
  if (part.type === "patch") return part.files.join("\n")
  if (part.type === "subtask") return `${part.description}\n${part.prompt}`
  if (part.type === "retry") return part.error.data.message
  if (part.type === "compaction") return part.auto ? "automatic compaction" : "compaction"
  if (part.type === "step-finish") return part.reason
  return part.type
}

export function MessageTimeline(props: {
  rows: Array<MessageRow>
  loading: boolean
  error?: string
  onLoadOlder: () => void
  onOpenFile: (path: string) => void
  onOpenDiff: (messageID?: string) => void
}) {
  return (
    <section class="panel timeline">
      <div class="panel-title">
        <span>Messages</span>
        <div class="button-row">
          <button type="button" onClick={props.onLoadOlder} disabled={props.loading}>
            Older
          </button>
          <button type="button" onClick={() => props.onOpenDiff()}>
            Session diff
          </button>
        </div>
      </div>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <Show when={props.loading}>
        <div class="muted">Loading messages...</div>
      </Show>
      <div class="message-list">
        <For each={props.rows}>
          {(row) => (
            <article class={`message ${row.info.role}`}>
              <header>
                <span>{row.info.role}</span>
                <time>{timeLabel(row.info.time.created)}</time>
                <button type="button" onClick={() => props.onOpenDiff(row.info.id)}>
                  Diff
                </button>
              </header>
              <For each={row.parts}>
                {(part) => (
                  <div class={`part ${part.type}`}>
                    <div class="part-kind">{part.type}</div>
                    <pre>{partBody(part)}</pre>
                    <Show when={part.type === "file" && filePath(part as FilePart)}>
                      <button type="button" onClick={() => props.onOpenFile(filePath(part as FilePart))}>
                        Open file
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </article>
          )}
        </For>
      </div>
    </section>
  )
}
