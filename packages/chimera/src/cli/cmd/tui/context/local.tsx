import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { uniqueBy } from "remeda"
import { ConfigModelSelection } from "@/config/model-selection"
import { iife } from "@/util/iife"
import { useToast } from "../ui/toast"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { useRoute } from "./route"
import { remoteCompactionModelChangeBlocked, remoteCompactionModelLockMessage } from "../util/remote-compaction"
import { useEvent } from "./event"
import { useProject } from "./project"

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const route = useRoute()
    const event = useEvent()
    const project = useProject()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const state = {
        pending: false,
      }

      function applySelection(next: ConfigModelSelection.Info) {
        batch(() => {
          setModelStore("model", next.model)
          setModelStore("recent", next.recent)
          setModelStore("favorite", next.favorite)
          setModelStore("variant", next.variant)
        })
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        const next = {
          model: modelStore.model,
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        }
        void sdk.client.config.modelSelection.update({ modelSelectionPatch: next }).catch(() => ConfigModelSelection.write(next))
      }

      sdk.client.config.modelSelection
        .get()
        .then((x) => x.data ?? ConfigModelSelection.empty)
        .catch(() => ConfigModelSelection.read())
        .then(applySelection)
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const unsubscribeModelSelection = event.on("config.model_selection.updated", (msg) => applySelection(msg.properties))
      onCleanup(unsubscribeModelSelection)


      const args = useArgs()
      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => {
              if (!args.model) return
              const { providerID, modelID } = parseModel(args.model)
              return {
                providerID,
                modelID,
              }
            },
            () => a && modelStore.model[a.name],
            () => modelStore.recent.find((item) => isModelValid(item)),
            () => a && a.model,
            () => {
              if (!sync.data.config.model) return
              const { providerID, modelID } = parseModel(sync.data.config.model)
              return {
                providerID,
                modelID,
              }
            },
            () => {
              const provider = sync.data.provider[0]
              if (!provider) return
              const model = sync.data.provider_default[provider.id] ?? Object.values(provider.models)[0]?.id
              if (!model) return
              return {
                providerID: provider.id,
                modelID: model,
              }
            },
          ) ?? undefined
        )
      })


      const [remoteCompactionStatus, { refetch: refreshRemoteCompactionStatus }] = createResource(
        () => {
          const current = currentModel()
          if (!current) return
          return {
            providerID: current.providerID,
            modelID: current.modelID,
            sessionID: route.data.type === "session" ? route.data.sessionID : undefined,
            workspace: project.workspace.current(),
            configuredMode: sync.data.config.compaction?.remote,
            configuredProtocol: sync.data.config.compaction?.remote_protocol,
          }
        },
        (input) =>
          sdk.client.config.remoteCompaction
            .status({
              workspace: input.workspace,
              providerID: input.providerID,
              modelID: input.modelID,
              sessionID: input.sessionID,
            })
            .then((result) => result.data),
      )

      function warnRemoteCompactionLock() {
        const status = remoteCompactionStatus()
        if (!remoteCompactionModelChangeBlocked(status)) return false
        toast.show({
          variant: "warning",
          message: remoteCompactionModelLockMessage(status!),
          duration: 5000,
        })
        return true
      }

      const unsubscribeRemoteCompaction = event.subscribe((msg) => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        if (msg.type === "session.updated" && msg.properties.info.id !== sessionID) return
        if (msg.type === "message.part.updated" && msg.properties.part.sessionID !== sessionID) return
        if (msg.type !== "session.updated" && msg.type !== "message.part.updated" && msg.type !== "server.instance.disposed") return
        void refreshRemoteCompactionStatus()
      })
      onCleanup(unsubscribeRemoteCompaction)

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          if (warnRemoteCompactionLock()) return
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
          save()
        },
        cycleFavorite(direction: 1 | -1) {
          if (warnRemoteCompactionLock()) return
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          if (warnRemoteCompactionLock()) return false
          return batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return false
            }
            const a = agent.current()
            if (!a) return false
            setModelStore("model", a.name, model)
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
            }
            save()
            return true
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        remoteCompaction: {
          status: remoteCompactionStatus,
          refresh: refreshRemoteCompactionStatus,
        },
        warnRemoteCompactionLock,
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = m.providerID + "/" + m.modelID
            setModelStore("variant", key, value ?? "default")
            save()
          },
          next() {
            const variants = this.list()
            if (variants.length === 0) return undefined
            const current = this.current()
            if (!current) return { target: variants[0] }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) return { target: undefined }
            return { target: variants[index + 1] }
          },
          cycle() {
            const next = this.next()
            if (next) this.set(next.target)
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
    }
    return result
  },
})
