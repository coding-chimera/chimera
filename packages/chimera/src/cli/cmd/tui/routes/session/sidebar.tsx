import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { Locale } from "@/util/locale"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

export function Sidebar(props: { sessionID: string; overlay?: boolean; showPromptStability?: boolean }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const promptStats = createMemo(() => sync.data.prompt_stats[props.sessionID])
  const promptBlocks = createMemo(() => promptStats()?.blocks.toSorted((a, b) => b.approxTokens - a.approxTokens).slice(0, 4) ?? [])
  const lastUsage = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const last = messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.input + item.tokens.cache.read + item.tokens.cache.write > 0)
    if (!last) return
    const promptTokens = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write
    return {
      prompt: promptTokens,
      cacheRead: last.tokens.cache.read,
      cacheWrite: last.tokens.cache.write,
      cachePct: promptTokens > 0 ? Math.round((last.tokens.cache.read / promptTokens) * 100) : 0,
    }
  })
  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <Show when={props.showPromptStability}>
              <box border={["top"]} borderColor={theme.border} paddingTop={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between" gap={1}>
                  <text fg={theme.text}>
                    <b>Prompt Stability</b>
                  </text>
                  <Show when={promptStats()} fallback={<text fg={theme.textMuted}>waiting</text>}>
                    {(stats) => (
                      <text fg={stats().warnings.length ? theme.warning : theme.success}>
                        {stats().warnings.length ? "warn" : "ok"}
                      </text>
                    )}
                  </Show>
                </box>
                <Show when={promptStats()} fallback={<text fg={theme.textMuted}>Send a prompt to populate request stats.</text>}>
                  {(stats) => (
                    <box gap={1}>
                      <text fg={theme.textMuted} wrapMode="none">
                        {stats().stage} · step {stats().step} · {stats().fingerprints.request}
                      </text>
                      <text fg={theme.textMuted}>
                        ~{Locale.number(stats().totals.approxTokens)} tok · {formatBytes(stats().totals.bytes)} · {stats().totals.blocks} blocks
                      </text>
                      <Show when={lastUsage()}>
                        {(usage) => (
                          <text fg={theme.textMuted}>
                            cache r/w {Locale.number(usage().cacheRead)}/{Locale.number(usage().cacheWrite)} · hit {usage().cachePct}%
                          </text>
                        )}
                      </Show>
                      <For each={promptBlocks()}>
                        {(block) => (
                          <text fg={theme.textMuted} wrapMode="none">
                            {block.kind}: ~{Locale.number(block.approxTokens)} · {block.hash}
                          </text>
                        )}
                      </For>
                      <For each={stats().warnings}>
                        {(warning) => <text fg={theme.warning}>! {warning}</text>}
                      </For>
                    </box>
                  )}
                </Show>
              </box>
            </Show>
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span>{" "}
              <span style={{ fg: theme.text }}>
                <b>Chimera</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}

function formatBytes(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}MB`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}KB`
  return `${value}B`
}
