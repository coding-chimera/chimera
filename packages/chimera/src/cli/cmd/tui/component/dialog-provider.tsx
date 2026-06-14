import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "@tui/util/provider-origin"
import { useConnected } from "./use-connected"
import {
  discoverOpenAICompatibleModels,
  normalizeOpenAICompatibleBaseURL,
  suggestOpenAICompatibleProviderID,
} from "@tui/util/custom-provider"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

const CUSTOM_PROVIDER_OPTION_VALUE = "__opencode_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return [
    ...pipe(
      list,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          opencode: "(Recommended)",
          anthropic: "(API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
          "opencode-go": "Low cost subscription for everyone",
        }[provider.id],
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
      })),
    ),
    {
      type: "custom",
      title: "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: "Custom provider",
      category: "Providers",
    },
  ]
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()

  function providerExists(providerID: string) {
    return (
      sync.data.provider.some((provider) => provider.id === providerID) ||
      sync.data.provider_next.all.some((provider) => provider.id === providerID) ||
      Boolean(sync.data.config.provider?.[providerID])
    )
  }

  async function promptCustomProviderID(value?: string): Promise<string | undefined> {
    const input = await DialogPrompt.show(dialog, "Provider id", {
      placeholder: "Provider id",
      value,
      description: () => (
        <text fg={theme.textMuted}>
          Use lowercase letters, numbers, hyphens, and underscores.
        </text>
      ),
    })
    if (input === null) return

    const providerID = normalizeCustomProviderID(input)
    if (providerID) return providerID

    toast.show({
      variant: "error",
      message:
        "Provider ids must start with a lowercase letter or number and only use lowercase letters, numbers, hyphens, and underscores",
    })
    return promptCustomProviderID(value)
  }

  async function promptEndpointURL(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, "OpenAI-compatible endpoint", {
      placeholder: "https://api.example.com/v1",
      description: () => <text fg={theme.textMuted}>Enter the endpoint base URL. Chimera will try /models.</text>,
    })
    if (value === null) return
    const baseURL = normalizeOpenAICompatibleBaseURL(value)
    if (baseURL) return baseURL
    toast.show({ variant: "error", message: "Endpoint URL must start with http:// or https://" })
    return promptEndpointURL()
  }

  async function promptToken() {
    const value = await DialogPrompt.show(dialog, "API token", {
      placeholder: "Optional API token",
      description: () => <text fg={theme.textMuted}>Leave empty for local endpoints that do not require a token.</text>,
    })
    if (value === null) return
    return value.trim()
  }

  async function promptManualModelID(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, "Model id", {
      placeholder: "gpt-5.5",
      description: () => <text fg={theme.textMuted}>Enter the model id accepted by this endpoint.</text>,
    })
    if (value === null) return
    const modelID = value.trim()
    if (modelID) return modelID
    toast.show({ variant: "error", message: "Model id is required" })
    return promptManualModelID()
  }

  async function selectDiscoveredModel(models: string[]) {
    return new Promise<string | undefined>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Select model"
            options={models.toSorted((a, b) => a.localeCompare(b)).map((model) => ({
              title: model,
              value: model,
              category: "Discovered models",
            }))}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(undefined),
      )
    })
  }

  async function selectDiscoveryFallback(error: unknown) {
    return new Promise<"retry" | "manual" | undefined>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Model discovery failed"
            options={[
              {
                title: "Retry",
                value: "retry" as const,
                description: error instanceof Error ? error.message : String(error),
              },
              {
                title: "Enter model id manually",
                value: "manual" as const,
              },
            ]}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(undefined),
      )
    })
  }

  async function discoverOrPromptModel(baseURL: string, token: string): Promise<{
    baseURL: string
    models: string[]
    selected: string
  } | undefined> {
    dialog.replace(() => (
      <DialogPrompt title="Discover models" busy busyText="Fetching /models..." value={baseURL} />
    ))
    try {
      const discovered = await discoverOpenAICompatibleModels({ baseURL, token: token || undefined })
      const selected = await selectDiscoveredModel(discovered.models)
      if (!selected) return
      return { ...discovered, selected }
    } catch (error) {
      const next = await selectDiscoveryFallback(error)
      if (next === "retry") return discoverOrPromptModel(baseURL, token)
      if (next === "manual") {
        const modelID = await promptManualModelID()
        if (!modelID) return
        return { baseURL, models: [modelID], selected: modelID }
      }
    }
  }

  async function promptCustomOpenAICompatibleProvider() {
    const inputBaseURL = await promptEndpointURL()
    if (!inputBaseURL) return
    const token = await promptToken()
    if (token === undefined) return
    const discovered = await discoverOrPromptModel(inputBaseURL, token)
    if (!discovered) return
    const providerID = await promptCustomProviderID(suggestOpenAICompatibleProviderID(discovered.baseURL))
    if (!providerID) return
    if (providerExists(providerID)) {
      const ok = await DialogConfirm.show(
        dialog,
        "Replace provider",
        `${providerID} already exists. Replace its custom endpoint configuration?`,
      )
      if (!ok) return
    }
    const models = Object.fromEntries(
      Array.from(new Set([...discovered.models, discovered.selected])).map((modelID) => [modelID, {}]),
    )
    const result = await sdk.client.global.config.update({
      config: {
        model: `${providerID}/${discovered.selected}`,
        provider: {
          [providerID]: {
            name: providerID,
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models,
            options: {
              baseURL: discovered.baseURL,
            },
          },
        },
      },
    })
    if (result.error) {
      toast.show({ variant: "error", message: JSON.stringify(result.error), duration: 5000 })
      dialog.clear()
      return
    }
    if (token) {
      const auth = await sdk.client.auth.set({
        providerID,
        auth: {
          type: "api",
          key: token,
        },
      })
      if (auth.error) {
        toast.show({ variant: "error", message: JSON.stringify(auth.error), duration: 5000 })
        dialog.clear()
        return
      }
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    toast.show({ variant: "info", message: `Connected ${providerID}` })
    dialog.replace(() => <DialogModel providerID={providerID} />)
  }

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              return promptCustomOpenAICompatibleProvider()
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = sync.data.provider_auth[providerID] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
  custom?: boolean
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> and enable OpenCode Go
              </text>
            </box>
          ),
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        if (props.custom && !sync.data.provider_next.all.some((provider) => provider.id === props.providerID)) {
          toast.show({
            variant: "info",
            message: `Saved credential for ${props.providerID}. Configure it in chimera.json to use it.`,
          })
          dialog.clear()
          return
        }
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
