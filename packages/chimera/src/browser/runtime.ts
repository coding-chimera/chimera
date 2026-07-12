export * as BrowserRuntime from "./runtime"

import { Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { chromium } from "playwright-core"
import { ulid } from "ulid"
import { InstanceState } from "@/effect/instance-state"
import { BrowserArtifact } from "./artifact"
import { BrowserDiscovery } from "./discovery"
import { BrowserSnapshot } from "./snapshot"

export interface LaunchOptions {
  readonly cdpUrl?: string
  readonly executablePath?: string
  readonly headless?: boolean
  readonly locale?: string
  readonly timeout?: number
}

export interface OpenInput {
  readonly sessionID: string
  readonly url?: string
  readonly launch?: LaunchOptions
}

export interface TabInput {
  readonly sessionID: string
  readonly tabID?: string
}

export interface RefInput extends TabInput {
  readonly ref: string
  readonly timeout?: number
}

export interface TabInfo {
  readonly id: string
  readonly sessionID: string
  readonly url: string
  readonly title: string
  readonly current: boolean
}

export interface SnapshotResult extends BrowserSnapshot.Result {
  readonly tabID: string
  readonly generation: number
  readonly title: string
}

export interface ScreenshotResult {
  readonly artifact: BrowserArtifact.Artifact
  readonly attachment: BrowserArtifact.Attachment
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("BrowserRuntimeError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface LocatorLike {
  readonly click: (options?: { readonly timeout?: number }) => Promise<void>
  readonly fill: (value: string, options?: { readonly timeout?: number }) => Promise<void>
}

export interface PageLike {
  readonly goto: (
    url: string,
    options?: { readonly timeout?: number; readonly waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" },
  ) => Promise<unknown>
  readonly url: () => string
  readonly title: () => Promise<string>
  readonly close: () => Promise<void>
  readonly screenshot: (options?: { readonly fullPage?: boolean; readonly type?: "png" }) => Promise<Uint8Array>
  readonly locator: (selector: string) => LocatorLike
  readonly evaluate: <A>(expression: string) => Promise<A>
}

export interface BrowserContextLike {
  readonly newPage: () => Promise<PageLike>
  readonly close: () => Promise<void>
}

export interface BrowserLike {
  readonly newContext: (options?: { readonly locale?: string }) => Promise<BrowserContextLike>
  readonly close: () => Promise<void>
}

export interface Driver {
  readonly launch: (options: {
    readonly executablePath: string
    readonly headless: boolean
    readonly timeout: number
  }) => Promise<BrowserLike>
  readonly connectOverCDP: (endpoint: string, options?: { readonly timeout?: number }) => Promise<BrowserLike>
}

export interface Interface {
  readonly open: (input: OpenInput) => Effect.Effect<TabInfo, RuntimeError>
  readonly tabs: (sessionID: string) => Effect.Effect<readonly TabInfo[], RuntimeError>
  readonly select: (sessionID: string, tabID: string) => Effect.Effect<void, RuntimeError>
  readonly snapshot: (input: TabInput & { readonly options?: BrowserSnapshot.Options }) => Effect.Effect<SnapshotResult, RuntimeError>
  readonly click: (input: RefInput) => Effect.Effect<void, RuntimeError>
  readonly type: (input: RefInput & { readonly text: string }) => Effect.Effect<void, RuntimeError>
  readonly screenshot: (
    input: TabInput & { readonly fullPage?: boolean; readonly name?: string },
  ) => Effect.Effect<ScreenshotResult, RuntimeError>
  readonly closeTab: (input: TabInput) => Effect.Effect<void, RuntimeError>
  readonly closeSession: (sessionID: string) => Effect.Effect<void, RuntimeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserRuntime") {}

type Connection = {
  readonly mode: "remote" | "local"
  readonly browser: BrowserLike
}

type TabState = {
  readonly id: string
  readonly page: PageLike
  generation: number
  refs: Map<string, BrowserSnapshot.Target>
}

type SessionState = {
  readonly context: BrowserContextLike
  readonly tabs: Map<string, TabState>
  current?: string
}

type State = {
  readonly lock: Semaphore.Semaphore
  readonly sessions: Map<string, SessionState>
  connection?: Connection
}

const DEFAULT_TIMEOUT = 15_000

const PLAYWRIGHT_DRIVER: Driver = {
  launch: async (options) => (await chromium.launch(options)) as unknown as BrowserLike,
  connectOverCDP: async (endpoint, options) =>
    (await chromium.connectOverCDP(endpoint, options)) as unknown as BrowserLike,
}

export const layerWith = (driver: Driver) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const artifacts = yield* BrowserArtifact.Service

      const attempt = <A>(operation: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new RuntimeError({ operation, message: errorMessage(cause) }),
        })

      const cleanupSession = (session: SessionState) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from(session.tabs.values()),
            (tab) => attempt("close tab", () => tab.page.close()).pipe(Effect.ignore),
            { concurrency: "unbounded" },
          )
          session.tabs.clear()
          yield* attempt("close browser context", () => session.context.close()).pipe(Effect.ignore)
        })

      const cleanupState = (current: State) =>
        Effect.gen(function* () {
          yield* Effect.forEach(Array.from(current.sessions.values()), cleanupSession, { concurrency: "unbounded" })
          current.sessions.clear()
          if (!current.connection) return
          yield* attempt("close browser connection", () => current.connection!.browser.close()).pipe(Effect.ignore)
          current.connection = undefined
        })

      const state = yield* InstanceState.make<State>(() =>
        Effect.gen(function* () {
          const current: State = {
            lock: Semaphore.makeUnsafe(1),
            sessions: new Map(),
          }
          yield* Effect.addFinalizer(() => cleanupState(current))
          return current
        }),
      )

      const connect = (endpoint: string, timeout: number) =>
        attempt("connect to browser CDP", () => driver.connectOverCDP(endpoint, { timeout }))


      const ensureConnection = (current: State, launch: LaunchOptions = {}) =>
        current.lock.withPermits(1)(
          Effect.gen(function* () {
            if (current.connection) return current.connection
            const timeout = launch.timeout ?? DEFAULT_TIMEOUT
            const cdpUrl = launch.cdpUrl ?? process.env.CHIMERA_BROWSER_CDP_URL
            if (cdpUrl) {
              const connection = { mode: "remote" as const, browser: yield* connect(cdpUrl, timeout) }
              current.connection = connection
              return connection
            }

            const discovered = yield* BrowserDiscovery.discover({
              executablePath: launch.executablePath ?? process.env.CHIMERA_BROWSER_EXECUTABLE_PATH,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.mapError(
                (cause) => new RuntimeError({ operation: "discover browser", message: cause.message }),
              ),
            )
            const browser = yield* attempt("launch browser", () =>
              driver.launch({
                executablePath: discovered.path,
                headless: launch.headless ?? process.env.CHIMERA_BROWSER_HEADLESS !== "false",
                timeout,
              }),
            )
            const connection = { mode: "local" as const, browser }
            current.connection = connection
            return connection
          }),
        )

      const getSession = (current: State, sessionID: string, launch?: LaunchOptions) =>
        Effect.gen(function* () {
          const hit = current.sessions.get(sessionID)
          if (hit) return hit
          const connection = yield* ensureConnection(current, launch)
          const session: SessionState = {
            context: yield* attempt("create browser context", () =>
              connection.browser.newContext(launch?.locale ? { locale: launch.locale } : undefined),
            ),
            tabs: new Map<string, TabState>(),
          }
          current.sessions.set(sessionID, session)
          return session
        })

      const getTab = (current: State, input: TabInput) =>
        Effect.gen(function* () {
          const session = current.sessions.get(input.sessionID)
          if (!session)
            return yield* new RuntimeError({
              operation: "resolve tab",
              message: `Browser session not found: ${input.sessionID}`,
            })
          const id = input.tabID ?? session.current
          const tab = id ? session.tabs.get(id) : undefined
          if (!tab)
            return yield* new RuntimeError({
              operation: "resolve tab",
              message: `Browser tab not found for session: ${input.sessionID}`,
            })
          return { session, tab }
        })

      const info = (sessionID: string, session: SessionState, tab: TabState) =>
        Effect.gen(function* () {
          return {
            id: tab.id,
            sessionID,
            url: tab.page.url(),
            title: yield* attempt("read browser title", () => tab.page.title()),
            current: session.current === tab.id,
          } satisfies TabInfo
        })

      const invalidate = (tab: TabState) => {
        tab.generation += 1
        tab.refs.clear()
      }

      return Service.of({
        open: Effect.fn("BrowserRuntime.open")(function* (input: OpenInput) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const session = yield* getSession(current, input.sessionID, input.launch)
              const page = yield* attempt("open browser tab", () => session.context.newPage())
              if (input.url)
                yield* attempt("navigate browser tab", () =>
                  page.goto(input.url!, {
                    timeout: input.launch?.timeout ?? DEFAULT_TIMEOUT,
                    waitUntil: "domcontentloaded",
                  }),
                ).pipe(Effect.tapError(() => attempt("close failed browser tab", () => page.close()).pipe(Effect.ignore)))
              const tab = { id: ulid(), page, generation: 0, refs: new Map<string, BrowserSnapshot.Target>() }
              session.tabs.set(tab.id, tab)
              session.current = tab.id
              return yield* info(input.sessionID, session, tab)
            }),
          )
        }),
        tabs: Effect.fn("BrowserRuntime.tabs")(function* (sessionID: string) {
          return yield* InstanceState.useEffect(state, (current) => {
            const session = current.sessions.get(sessionID)
            if (!session) return Effect.succeed([])
            return Effect.forEach(Array.from(session.tabs.values()), (tab) => info(sessionID, session, tab))
          })
        }),
        select: Effect.fn("BrowserRuntime.select")(function* (sessionID: string, tabID: string) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const resolved = yield* getTab(current, { sessionID, tabID })
              resolved.session.current = resolved.tab.id
            }),
          )
        }),
        snapshot: Effect.fn("BrowserRuntime.snapshot")(function* (
          input: TabInput & { readonly options?: BrowserSnapshot.Options },
        ) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const resolved = yield* getTab(current, input)
              const roots = yield* attempt("collect browser snapshot", () =>
                resolved.tab.page.evaluate<readonly BrowserSnapshot.Node[]>(COLLECTOR_SCRIPT),
              )
              resolved.tab.generation += 1
              const rendered = scopeRefs(
                BrowserSnapshot.render({ url: resolved.tab.page.url(), roots }, input.options),
                resolved.tab.generation,
              )
              resolved.tab.refs = new Map(rendered.refs)
              return {
                ...rendered,
                tabID: resolved.tab.id,
                generation: resolved.tab.generation,
                title: yield* attempt("read browser title", () => resolved.tab.page.title()),
              }
            }),
          )
        }),
        click: Effect.fn("BrowserRuntime.click")(function* (input: RefInput) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const resolved = yield* getTab(current, input)
              const target = resolved.tab.refs.get(input.ref)
              if (!target)
                return yield* new RuntimeError({
                  operation: "click browser ref",
                  message: `Unknown or stale browser ref: ${input.ref}`,
                })
              yield* attempt("click browser ref", () =>
                resolved.tab.page.locator(target.id).click({ timeout: input.timeout ?? DEFAULT_TIMEOUT }),
              )
              invalidate(resolved.tab)
            }),
          )
        }),
        type: Effect.fn("BrowserRuntime.type")(function* (input: RefInput & { readonly text: string }) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const resolved = yield* getTab(current, input)
              const target = resolved.tab.refs.get(input.ref)
              if (!target)
                return yield* new RuntimeError({
                  operation: "type into browser ref",
                  message: `Unknown or stale browser ref: ${input.ref}`,
                })
              yield* attempt("type into browser ref", () =>
                resolved.tab.page.locator(target.id).fill(input.text, { timeout: input.timeout ?? DEFAULT_TIMEOUT }),
              )
              invalidate(resolved.tab)
            }),
          )
        }),
        screenshot: Effect.fn("BrowserRuntime.screenshot")(function* (
          input: TabInput & { readonly fullPage?: boolean; readonly name?: string },
        ) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const resolved = yield* getTab(current, input)
              const bytes = yield* attempt("capture browser screenshot", () =>
                resolved.tab.page.screenshot({ fullPage: input.fullPage ?? false, type: "png" }),
              )
              const artifact = yield* artifacts
                .write({
                  sessionID: input.sessionID,
                  kind: "screenshot",
                  name: input.name,
                  extension: "png",
                  mime: "image/png",
                  data: bytes,
                })
                .pipe(
                  Effect.mapError(
                    (cause) => new RuntimeError({ operation: "write browser screenshot", message: errorMessage(cause) }),
                  ),
                )
              const attachment = yield* artifacts.attachment(artifact).pipe(
                Effect.mapError(
                  (cause) => new RuntimeError({ operation: "attach browser screenshot", message: errorMessage(cause) }),
                ),
              )
              return { artifact, attachment }
            }),
          )
        }),
        closeTab: Effect.fn("BrowserRuntime.closeTab")(function* (input: TabInput) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const resolved = yield* getTab(current, input)
              yield* attempt("close browser tab", () => resolved.tab.page.close())
              resolved.session.tabs.delete(resolved.tab.id)
              if (resolved.session.current === resolved.tab.id)
                resolved.session.current = resolved.session.tabs.keys().next().value
              if (resolved.session.tabs.size) return
              yield* attempt("close browser context", () => resolved.session.context.close())
              current.sessions.delete(input.sessionID)
            }),
          )
        }),
        closeSession: Effect.fn("BrowserRuntime.closeSession")(function* (sessionID: string) {
          return yield* InstanceState.useEffect(state, (current) =>
            Effect.gen(function* () {
              const session = current.sessions.get(sessionID)
              if (!session) return
              yield* cleanupSession(session)
              current.sessions.delete(sessionID)
            }),
          )
        }),
      })
    }),
  )

export const layer = layerWith(PLAYWRIGHT_DRIVER)

export const defaultLayer = layer.pipe(
  Layer.provide(BrowserArtifact.defaultLayer),
  Layer.provide(NodeFileSystem.layer),
)

function scopeRefs(result: BrowserSnapshot.Result, generation: number): BrowserSnapshot.Result {
  const prefix = `g${generation}`
  const refs = new Map(Array.from(result.refs, ([ref, target]) => [`${prefix}${ref}`, target] as const))
  return {
    ...result,
    text: result.text.replace(/\[ref=(e\d+)\]/g, (_match: string, ref: string) => `[ref=${prefix}${ref}]`),
    refs,
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof globalThis.Error ? cause.message : String(cause)
}

const COLLECTOR_SCRIPT = `(() => {
  const interactiveRoles = new Set([
    "button", "checkbox", "combobox", "link", "listbox", "menuitem", "option", "radio", "searchbox",
    "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"
  ])
  const roleFor = (element) => {
    const explicit = element.getAttribute("role")
    if (explicit) return explicit.split(/\\s+/)[0].toLowerCase()
    const tag = element.tagName.toLowerCase()
    if (tag === "button") return "button"
    if (tag === "a" && element.hasAttribute("href")) return "link"
    if (tag === "textarea") return "textbox"
    if (tag === "select") return element.multiple ? "listbox" : "combobox"
    if (tag === "img") return "img"
    if (/^h[1-6]$/.test(tag)) return "heading"
    if (tag === "nav") return "navigation"
    if (tag === "main") return "main"
    if (tag === "form") return "form"
    if (tag === "ul" || tag === "ol") return "list"
    if (tag === "li") return "listitem"
    if (tag === "table") return "table"
    if (tag === "tr") return "row"
    if (tag === "td") return "cell"
    if (tag === "th") return "columnheader"
    if (tag === "dialog") return "dialog"
    if (tag !== "input") return "generic"
    const type = (element.getAttribute("type") || "text").toLowerCase()
    if (type === "button" || type === "submit" || type === "reset") return "button"
    if (type === "checkbox") return "checkbox"
    if (type === "radio") return "radio"
    if (type === "range") return "slider"
    if (type === "number") return "spinbutton"
    if (type === "search") return "searchbox"
    return "textbox"
  }
  const text = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, 500)
  const labelled = (element, includeDescendants) => {
    const aria = text(element.getAttribute("aria-label"))
    if (aria) return aria
    const ids = text(element.getAttribute("aria-labelledby"))
    if (ids) {
      const value = text(ids.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "))
      if (value) return value
    }
    if (element.labels?.length) {
      const value = text(Array.from(element.labels).map((label) => label.textContent || "").join(" "))
      if (value) return value
    }
    const alt = text(element.getAttribute("alt"))
    if (alt) return alt
    const placeholder = text(element.getAttribute("placeholder"))
    if (placeholder) return placeholder
    const own = text(Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent || "").join(" "))
    if (own) return own
    if (includeDescendants) {
      const descendants = text("innerText" in element ? element.innerText : element.textContent)
      if (descendants) return descendants
    }
    return ""
  }
  const escape = (value) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
  const selector = (element) => {
    if (element.id) return "#" + escape(element.id)
    const parts = []
    let current = element
    while (current && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase()
      let index = 1
      let sibling = current.previousElementSibling
      while (sibling) {
        if (sibling.tagName.toLowerCase() === tag) index += 1
        sibling = sibling.previousElementSibling
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")")
      current = current.parentElement
    }
    return "html > " + parts.join(" > ")
  }
  const visit = (element) => {
    if (!(element instanceof Element)) return null
    if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) return null
    const style = getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden") return null
    const role = roleFor(element)
    const tag = element.tagName.toLowerCase()
    const interactive = interactiveRoles.has(role) || ["button", "input", "select", "textarea", "summary"].includes(tag) ||
      (tag === "a" && element.hasAttribute("href")) || element.isContentEditable || element.tabIndex >= 0
    const inputType = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : ""
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase()
    const sensitive = inputType === "password" || autocomplete === "current-password" || autocomplete === "new-password"
    const name = labelled(element, interactive)
    const description = text(element.getAttribute("aria-description") || element.getAttribute("title"))
    const value = !sensitive && "value" in element ? text(String(element.value || "")) : ""
    const bool = (name) => element.hasAttribute(name) ? element.getAttribute(name) !== "false" : undefined
    const mixed = (name) => element.getAttribute(name) === "mixed" ? "mixed" : bool(name)
    const children = Array.from(element.children).map(visit).filter(Boolean)
    return {
      id: selector(element),
      role,
      ...(name ? { name } : {}),
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      interactive,
      ...(sensitive ? { sensitive: true } : {}),
      ...(("disabled" in element || element.hasAttribute("aria-disabled")) ? { disabled: Boolean(element.disabled) || bool("aria-disabled") === true } : {}),
      ...(("checked" in element || element.hasAttribute("aria-checked")) ? { checked: element.getAttribute("aria-checked") === "mixed" ? "mixed" : Boolean(element.checked) || bool("aria-checked") === true } : {}),
      ...(element.hasAttribute("aria-expanded") ? { expanded: bool("aria-expanded") } : {}),
      ...(("selected" in element || element.hasAttribute("aria-selected")) ? { selected: Boolean(element.selected) || bool("aria-selected") === true } : {}),
      ...(element.hasAttribute("aria-pressed") ? { pressed: mixed("aria-pressed") } : {}),
      children
    }
  }
  const root = document.body || document.documentElement
  return Array.from(root.children).map(visit).filter(Boolean)
})()`
