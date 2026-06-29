import { Show } from "solid-js"

export function Composer(props: {
  text: string
  sending: boolean
  canSend: boolean
  error?: string
  onInput: (value: string) => void
  onSend: () => void
  onAbort: () => void
}) {
  return (
    <section class="composer">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          props.onSend()
        }}
      >
        <textarea
          value={props.text}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          placeholder="Ask Chimera..."
          rows={4}
        />
        <div class="composer-actions">
          <Show when={props.error}>
            <span class="error">{props.error}</span>
          </Show>
          <button type="button" onClick={props.onAbort} disabled={!props.canSend}>
            Abort
          </button>
          <button type="submit" disabled={!props.canSend || props.sending || !props.text.trim()}>
            Send
          </button>
        </div>
      </form>
    </section>
  )
}
