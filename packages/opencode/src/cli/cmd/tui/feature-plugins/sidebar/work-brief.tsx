import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-work-brief"
type WorkBriefView = NonNullable<ReturnType<TuiPluginApi["state"]["session"]["workBrief"]>>

type Section = {
  label: string
  items: readonly string[]
}

function isEmpty(brief: WorkBriefView | undefined) {
  if (!brief) return true
  return (
    !brief.intent &&
    brief.confirmedDecisions.length === 0 &&
    brief.constraints.length === 0 &&
    brief.acceptanceCriteria.length === 0 &&
    brief.openQuestions.length === 0 &&
    brief.relevantEvidence.length === 0 &&
    brief.closeout.length === 0
  )
}

function sections(brief: WorkBriefView): Section[] {
  return [
    ...(brief.intent ? [{ label: "Intent", items: [brief.intent] }] : []),
    { label: "Decisions", items: brief.confirmedDecisions },
    { label: "Constraints", items: brief.constraints },
    { label: "Criteria", items: brief.acceptanceCriteria },
    { label: "Questions", items: brief.openQuestions },
    { label: "Evidence", items: brief.relevantEvidence },
    { label: "Closeout", items: brief.closeout },
  ].filter((section) => section.items.length > 0)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const brief = createMemo(() => props.api.state.session.workBrief(props.session_id))
  const list = createMemo(() => (brief() ? sections(brief()!) : []))
  const count = createMemo(() => list().reduce((sum, section) => sum + section.items.length, 0))
  const collapsible = createMemo(() => count() > 6)

  return (
    <Show when={!isEmpty(brief())}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => collapsible() && setOpen((x) => !x)}>
          <Show when={collapsible()}>
            <text fg={theme().text}>{open() ? "v" : ">"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Work Brief</b>
          </text>
        </box>
        <Show when={!collapsible() || open()}>
          <For each={list()}>
            {(section) => (
              <box paddingTop={1}>
                <text fg={theme().textMuted}>{section.label}</text>
                <For each={section.items}>
                  {(item) => (
                    <text fg={theme().textMuted}>
                      <span>- </span>
                      <span>{item}</span>
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
