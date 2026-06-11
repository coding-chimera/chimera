import type { AssistantMessage, Part, StepFinishPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import { Locale } from "@/util/locale"

const id = "internal:sidebar-context"
const localCacheMinimum = 1024

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type Tokens = AssistantMessage["tokens"]

const empty = {
  input: 0,
  output: 0,
  reasoning: 0,
  outputEstimated: false,
  contextEstimated: false,
  cacheRead: 0,
  cacheReadEstimated: false,
  context: 0,
}

const isAssistant = (item: ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number]): item is AssistantMessage =>
  item.role === "assistant"

const isStepFinish = (part: Part): part is StepFinishPart => part.type === "step-finish"
const inputTokens = (tokens: Tokens) => tokens.input + tokens.cache.read + tokens.cache.write
const contextTokens = (tokens: Tokens) => inputTokens(tokens) + tokens.output + tokens.reasoning
const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const formatTokens = (tokens: number, estimated: boolean) => `${estimated ? "~" : ""}${Locale.number(tokens)}`

const formatCached = (usage: typeof empty) => {
  const cached = `${usage.cacheReadEstimated ? "~" : ""}${Locale.number(usage.cacheRead)} cached`
  return `${Locale.number(usage.input)} (${cached})`
}

const estimateStreamingTokens = (parts: readonly Part[]) => {
  const lastFinish = parts.findLastIndex(isStepFinish)
  const pending = parts.slice(lastFinish + 1)
  const chars = pending.reduce(
    (sum, part) => ({
      output: sum.output + (part.type === "text" ? part.text.length : 0),
      reasoning: sum.reasoning + (part.type === "reasoning" ? part.text.length : 0),
    }),
    { output: 0, reasoning: 0 },
  )

  return {
    input: 0,
    output: estimateTokens(chars.output),
    reasoning: estimateTokens(chars.reasoning),
    cache: { read: 0, write: 0 },
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  const requests = createMemo(() =>
    msg().flatMap((item) => {
      if (!isAssistant(item)) return []

      const parts = props.api.state.part(item.id).filter(isStepFinish)
      const allParts = props.api.state.part(item.id)
      const finished = parts.length
        ? parts.map((part) => ({ message: item, tokens: part.tokens, outputEstimated: false, contextEstimated: false }))
        : contextTokens(item.tokens) > 0
          ? [{ message: item, tokens: item.tokens, outputEstimated: false, contextEstimated: false }]
          : []
      if (item.time.completed) return finished

      const pending = estimateStreamingTokens(allParts)
      if (pending.output + pending.reasoning <= 0) return finished
      return [
        ...finished,
        {
          message: item,
          tokens: pending,
          outputEstimated: pending.output > 0,
          contextEstimated: true,
        },
      ]
    }),
  )

  const usage = createMemo(() => {
    const entries = requests()
    const enhanced = entries.map((entry, index) => {
      const previous = entries
        .slice(0, index)
        .findLast(
          (item) => item.message.providerID === entry.message.providerID && item.message.modelID === entry.message.modelID,
        )
      const hasApiCache = entries.some(
        (item) =>
          item.message.providerID === entry.message.providerID &&
          item.message.modelID === entry.message.modelID &&
          (item.tokens.cache.read > 0 || item.tokens.cache.write > 0),
      )
      const localCacheRead =
        !hasApiCache && previous && inputTokens(previous.tokens) >= localCacheMinimum
          ? Math.min(inputTokens(entry.tokens), inputTokens(previous.tokens))
          : 0

      return {
        message: entry.message,
        input: inputTokens(entry.tokens),
        output: entry.tokens.output,
        reasoning: entry.tokens.reasoning,
        outputEstimated: entry.outputEstimated,
        contextEstimated: entry.contextEstimated,
        cacheRead: entry.tokens.cache.read || localCacheRead,
        cacheReadEstimated: entry.tokens.cache.read === 0 && localCacheRead > 0,
        context: contextTokens(entry.tokens),
      }
    })

    const total = enhanced.reduce(
      (sum, item) => ({
        input: sum.input + item.input,
        output: sum.output + item.output,
        reasoning: sum.reasoning + item.reasoning,
        outputEstimated: sum.outputEstimated || item.outputEstimated,
        contextEstimated: sum.contextEstimated || item.contextEstimated,
        cacheRead: sum.cacheRead + item.cacheRead,
        cacheReadEstimated: sum.cacheReadEstimated || item.cacheReadEstimated,
        context: sum.context + item.context,
      }),
      empty,
    )
    const lastUser = msg().findLast((item) => item.role === "user")
    const currentMessage = lastUser
      ? msg().findLast((item): item is AssistantMessage => isAssistant(item) && item.parentID === lastUser.id)
      : msg().findLast(isAssistant)
    const current = enhanced
      .filter((item) => item.message.id === currentMessage?.id)
      .reduce(
        (sum, item) => ({
          input: sum.input + item.input,
          output: sum.output + item.output,
          reasoning: sum.reasoning + item.reasoning,
          outputEstimated: sum.outputEstimated || item.outputEstimated,
          contextEstimated: sum.contextEstimated || item.contextEstimated,
          cacheRead: sum.cacheRead + item.cacheRead,
          cacheReadEstimated: sum.cacheReadEstimated || item.cacheReadEstimated,
          context: sum.context + item.context,
        }),
        empty,
      )

    return { total, current }
  })

  const state = createMemo(() => {
    const last = requests().findLast((item) => item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens = contextTokens(last.tokens)
    const model = props.api.state.provider.find((item) => item.id === last.message.providerID)?.models[last.message.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>Total {formatTokens(usage().total.context, usage().total.contextEstimated)}</text>
      <text fg={theme().textMuted}>in {formatCached(usage().total)}</text>
      <text fg={theme().textMuted}>out {formatTokens(usage().total.output, usage().total.outputEstimated)}</text>
      <text fg={theme().textMuted}>Turn {formatTokens(usage().current.context, usage().current.contextEstimated)}</text>
      <text fg={theme().textMuted}>in {formatCached(usage().current)}</text>
      <text fg={theme().textMuted}>out {formatTokens(usage().current.output, usage().current.outputEstimated)}</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
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
