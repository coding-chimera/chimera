import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"

function metadata(item: PermissionRequest) {
  const text = JSON.stringify(item.metadata, null, 2)
  return text === "{}" ? "" : text
}

export function PermissionDock(props: {
  items: Array<PermissionRequest>
  onRespond: (requestID: string, reply: "once" | "always" | "reject") => void
}) {
  return (
    <section class="dock">
      <div class="panel-title">Permissions</div>
      <Show when={props.items.length === 0}>
        <div class="muted">No pending permissions</div>
      </Show>
      <For each={props.items}>
        {(item) => (
          <article class="request-card">
            <strong>{item.permission}</strong>
            <small>session {item.sessionID}</small>
            <Show when={item.patterns.length > 0}>
              <pre>{item.patterns.join("\n")}</pre>
            </Show>
            <Show when={metadata(item)}>
              <pre>{metadata(item)}</pre>
            </Show>
            <div class="button-row">
              <button type="button" onClick={() => props.onRespond(item.id, "once")}>
                Allow once
              </button>
              <button type="button" onClick={() => props.onRespond(item.id, "always")}>
                Always
              </button>
              <button type="button" onClick={() => props.onRespond(item.id, "reject")}>
                Reject
              </button>
            </div>
          </article>
        )}
      </For>
    </section>
  )
}
