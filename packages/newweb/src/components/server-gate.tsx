import { Show } from "solid-js"
import type { NewWebState } from "@/state/store"

export function ServerGate(props: { server: NewWebState["server"]; onRefresh: () => void }) {
  return (
    <section class="server-gate">
      <div>
        <strong>Chimera NewWeb</strong>
        <span class={props.server.healthy ? "pill ok" : "pill warn"}>
          {props.server.loading ? "connecting" : props.server.healthy ? "healthy" : "offline"}
        </span>
      </div>
      <div class="muted">{props.server.url}</div>
      <Show when={props.server.version}>
        <div class="muted">version {props.server.version}</div>
      </Show>
      <Show when={props.server.error}>
        <div class="error">{props.server.error}</div>
      </Show>
      <button type="button" onClick={props.onRefresh} disabled={props.server.loading}>
        Refresh
      </button>
    </section>
  )
}
