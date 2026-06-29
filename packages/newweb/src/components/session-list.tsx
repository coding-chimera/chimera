import { For, Show } from "solid-js"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"

function timeLabel(value: number) {
  return new Date(value).toLocaleString()
}

function statusLabel(status?: SessionStatus) {
  if (!status) return "unknown"
  if (status.type === "retry") return `retry ${status.attempt}`
  return status.type
}

export function SessionList(props: {
  sessions: Array<Session>
  activeID?: string
  statusByID: Record<string, SessionStatus>
  loading: boolean
  creating: boolean
  error?: string
  onSelect: (id: string) => void
  onCreate: () => void
  onRefresh: () => void
}) {
  return (
    <section class="panel session-list">
      <div class="panel-title">
        <span>Sessions</span>
        <div class="button-row">
          <button type="button" onClick={props.onRefresh} disabled={props.loading}>
            Refresh
          </button>
          <button type="button" onClick={props.onCreate} disabled={props.creating}>
            New
          </button>
        </div>
      </div>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <div class="session-items">
        <For each={props.sessions}>
          {(session) => (
            <button
              type="button"
              class={session.id === props.activeID ? "session-item active" : "session-item"}
              onClick={() => props.onSelect(session.id)}
            >
              <span>{session.title || session.id}</span>
              <small>{statusLabel(props.statusByID[session.id])}</small>
              <small>{timeLabel(session.time.updated || session.time.created)}</small>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}
