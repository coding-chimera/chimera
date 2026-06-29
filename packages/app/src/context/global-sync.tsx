import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  ProviderBalanceResult,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { batch, createContext, getOwner, onCleanup, onMount, type ParentProps, untrack, useContext } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { useGlobalSDK } from "./global-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"

const CHIMERA_TOOL_MUTATION_RECORDED = "chimera.tool.mutation.recorded"
const CHIMERA_GRAPH_READY = "chimera.graph.ready"
const RESUME_REFRESH_BACKGROUND_MS = 5_000
const RESUME_REFRESH_MIN_INTERVAL_MS = 5_000
const ACTIVE_STATUS_POLL_MS = 5_000

function chimeraMutationSummary(properties: unknown) {
  if (!properties || typeof properties !== "object") return undefined
  const files = (properties as { files?: unknown }).files
  if (!Array.isArray(files)) return undefined
  const count = files.length
  if (count === 0) return "CodeGraph recorded a tool mutation."
  if (count === 1) return `CodeGraph updated for ${String(files[0])}.`
  return `CodeGraph updated for ${count} files.`
}

function chimeraGraphReadySummary(properties: unknown) {
  if (!properties || typeof properties !== "object") return "CodeGraph is ready for this project."
  const props = properties as { fileCount?: unknown; nodeCount?: unknown }
  if (typeof props.fileCount === "number" && typeof props.nodeCount === "number") {
    return `CodeGraph ready with ${props.fileCount} files and ${props.nodeCount} nodes.`
  }
  if (typeof props.fileCount === "number") return `CodeGraph ready with ${props.fileCount} files.`
  return "CodeGraph is ready for this project."
}

function providerBalanceFallback(providerID: string): ProviderBalanceResult {
  if (providerID === "openai") {
    return {
      kind: "quota",
      providerID,
      status: "error",
      label: "Codex Usage",
      limits: [],
      message: "Failed to load Codex usage.",
    }
  }
  return {
    kind: "billing",
    providerID,
    status: "error",
    balance_infos: [],
    message: "Failed to load provider balance.",
  }
}

function providerBalanceSupported(providerID: string) {
  return providerID === "deepseek" || providerID === "openai"
}

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadSessionsQueryKey = (directory: string) => [directory, "loadSessions"] as const

export const mcpQueryKey = (directory: string) => [directory, "mcp"] as const

export const loadMcpQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: mcpQueryKey(directory),
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const lspQueryKey = (directory: string) => [directory, "lsp"] as const

export const loadLspQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: lspQueryKey(directory),
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()
  const providerBalanceInFlight = new Set<string>()

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [
      loadGlobalConfigQuery(globalSDK.client),
      loadProvidersQuery(null, globalSDK.client),
      loadPathQuery(null, globalSDK.client),
    ],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return bootstrap.isPending
    },
    project: [],
    session_todo: {},
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: [], connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })
  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  let resumeFrame: number | undefined
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
  let backgroundedAt = typeof document !== "undefined" && document.visibilityState === "hidden" ? Date.now() : undefined
  let lastResumeRefreshAt = 0
  let activeStatusPollTimer: ReturnType<typeof setInterval> | undefined
  let activeStatusPollInFlight = false

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
    if (resumeFrame !== undefined) cancelAnimationFrame(resumeFrame)
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    if (activeStatusPollTimer !== undefined) clearInterval(activeStatusPollTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: ["bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        globalSDK: globalSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: ["bootstrap"] }),
    bootstrapInstance,
  })

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = globalSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(key)
      clearSessionPrefetchDirectory(key)
    },
    translate: language.t,
    getSdk: sdkFor,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadProviderBalance(input: { directory: string; providerID: string; force?: boolean }) {
    const directory = directoryKey(input.directory)
    if (!directory) return
    if (!providerBalanceSupported(input.providerID)) return
    const [store] = children.peek(directory, { bootstrap: false })
    if (store.provider_balance[input.providerID] && !input.force) return
    const key = `${directory}:${input.providerID}`
    if (providerBalanceInFlight.has(key)) return
    providerBalanceInFlight.add(key)
    await sdkFor(directory).provider
      .balance({ providerID: input.providerID })
      .then((x) => {
        const child = children.children[directory]
        if (!child || !x.data) return
        child[1]("provider_balance", input.providerID, reconcile(x.data as ProviderBalanceResult))
      })
      .catch(() => {
        const child = children.children[directory]
        if (!child) return
        child[1]("provider_balance", input.providerID, providerBalanceFallback(input.providerID))
      })
      .finally(() => {
        providerBalanceInFlight.delete(key)
      })
  }

  async function refreshProviderBalances(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const child = children.children[key]
    if (!child) return
    await Promise.all(Object.keys(child[0].provider_balance).map((providerID) => loadProviderBalance({ directory: key, providerID, force: true })))
  }

  async function loadSessions(directory: string) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) return pending

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo)
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        queryKey: loadSessionsQueryKey(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => globalSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = store.limit
              const childSessions = store.session.filter((s) => !!s.parentID)
              const sessions = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: store.permission,
              })
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(sessions, { key: "id" }))
                cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo)
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500
    const unknownEvent = event as { type: string; properties?: unknown }

    if (unknownEvent.type === CHIMERA_TOOL_MUTATION_RECORDED) {
      const description = chimeraMutationSummary(unknownEvent.properties)
      showToast({
        title: "CodeGraph updated",
        description,
        variant: "success",
      })
    }

    if (unknownEvent.type === CHIMERA_GRAPH_READY) {
      showToast({
        title: "CodeGraph ready",
        description: chimeraGraphReadySummary(unknownEvent.properties),
        variant: "success",
      })
    }

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(loadLspQuery(key, sdkFor(directory)))
      },
      refreshProviderBalances: () => {
        void refreshProviderBalances(directory)
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  const refreshActiveSessionStatus = async () => {
    if (paused()) return
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    const directories = Object.keys(children.children).filter((directory) =>
      Object.values(children.children[directory]?.[0].session_status ?? {}).some((status) => status.type !== "idle"),
    )
    if (directories.length === 0) return
    await Promise.all(
      directories.map((directory) =>
        sdkFor(directory)
          .session.status()
          .then((x) => {
            const child = children.children[directory]
            if (!child || !x.data) return
            child[1]("session_status", reconcile(x.data))
          })
          .catch((err) => {
            console.error("Failed to refresh session status", err)
          }),
      ),
    )
  }

  onMount(() => {
    activeStatusPollTimer = setInterval(() => {
      if (activeStatusPollInFlight) return
      activeStatusPollInFlight = true
      void refreshActiveSessionStatus().finally(() => {
        activeStatusPollInFlight = false
      })
    }, ACTIVE_STATUS_POLL_MS)
  })

  const queueMountedRefresh = () => {
    queue.refresh()
    for (const directory of Object.keys(children.children)) {
      children.mark(directory)
      queue.push(directory)
    }
  }

  const scheduleResumeRefresh = (force?: boolean) => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    const now = Date.now()
    const slept = backgroundedAt === undefined ? 0 : now - backgroundedAt
    backgroundedAt = undefined
    if (!force && slept < RESUME_REFRESH_BACKGROUND_MS) return
    if (now - bootedAt < RESUME_REFRESH_BACKGROUND_MS) return
    if (now - lastResumeRefreshAt < RESUME_REFRESH_MIN_INTERVAL_MS) return
    lastResumeRefreshAt = now
    if (resumeFrame !== undefined || resumeTimer !== undefined) return
    resumeFrame = requestAnimationFrame(() => {
      resumeFrame = undefined
      resumeTimer = setTimeout(() => {
        resumeTimer = undefined
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return
        queueMountedRefresh()
      }, 0)
    })
  }

  const markBackgrounded = () => {
    backgroundedAt = backgroundedAt ?? Date.now()
  }

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void globalSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void globalSDK.event.start()
      }, 0)
    }
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        markBackgrounded()
        return
      }
      scheduleResumeRefresh()
    })
    makeEventListener(window, "blur", markBackgrounded)
    makeEventListener(window, "pagehide", markBackgrounded)
    makeEventListener(window, "focus", () => scheduleResumeRefresh())
    makeEventListener(window, "online", () => scheduleResumeRefresh(true))
    makeEventListener(window, "pageshow", (event) => scheduleResumeRefresh(event.persisted))
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => globalSDK.client.global.config.update({ config }),
    onSuccess: () => bootstrap.refetch(),
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
    providerBalance: {
      load: loadProviderBalance,
      refresh: refreshProviderBalances,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
