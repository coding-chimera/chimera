import { For, Show } from "solid-js"
import type { Project } from "@opencode-ai/sdk/v2/client"

export function DirectoryPicker(props: {
  current: string
  input: string
  projects: Array<Project>
  loading: boolean
  error?: string
  onInput: (value: string) => void
  onSelect: (directory: string) => void
  onSubmit: () => void
  onRefresh: () => void
}) {
  return (
    <section class="panel directory-picker">
      <div class="panel-title">
        <span>Directory</span>
        <button type="button" onClick={props.onRefresh} disabled={props.loading}>
          Refresh
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit()
        }}
      >
        <input value={props.input} onInput={(event) => props.onInput(event.currentTarget.value)} placeholder="/path/to/project" />
        <button type="submit" disabled={!props.input.trim()}>
          Open
        </button>
      </form>
      <Show when={props.current}>
        <div class="current-path">{props.current}</div>
      </Show>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <div class="project-list">
        <For each={props.projects}>
          {(project) => (
            <button
              type="button"
              class={project.worktree === props.current ? "project-item active" : "project-item"}
              onClick={() => props.onSelect(project.worktree)}
            >
              <span>{project.name || project.worktree.split("/").at(-1) || project.worktree}</span>
              <small>{project.worktree}</small>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}
