import { Effect } from "effect"
import { BrowserRuntime } from "@/browser/runtime"
import type { Tool } from "./tool"

export function run<A>(effect: Effect.Effect<A, BrowserRuntime.RuntimeError>) {
  return effect.pipe(
    Effect.mapError((error) => new Error(error.message)),
    Effect.orDie,
  )
}

export function httpURL(value: string) {
  if (!URL.canParse(value)) throw new Error("Browser URL must be an absolute http:// or https:// URL")
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Browser URL must be an absolute http:// or https:// URL")
  return url
}

export function origin(value: string) {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  return url.origin === "null" ? url.protocol : url.origin
}

export function currentTab(runtime: BrowserRuntime.Interface, sessionID: string, tabID?: string) {
  return Effect.gen(function* () {
    const tabs = yield* run(runtime.tabs(sessionID))
    const tab = tabID ? tabs.find((item) => item.id === tabID) : tabs.find((item) => item.current)
    if (!tab) throw new Error(`Browser tab not found for session: ${sessionID}`)
    return tab
  })
}

export function askForTab(
  runtime: BrowserRuntime.Interface,
  ctx: Tool.Context,
  permission: string,
  tabID?: string,
  metadata: Record<string, unknown> = {},
) {
  return Effect.gen(function* () {
    const tab = yield* currentTab(runtime, ctx.sessionID, tabID)
    const pattern = origin(tab.url)
    yield* ctx.ask({
      permission,
      patterns: [pattern],
      always: [pattern],
      metadata: { tabID: tab.id, origin: pattern, ...metadata },
    })
    return tab
  })
}
