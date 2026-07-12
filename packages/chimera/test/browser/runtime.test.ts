import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { BrowserArtifact } from "../../src/browser/artifact"
import { BrowserRuntime } from "../../src/browser/runtime"
import { BrowserSnapshot } from "../../src/browser/snapshot"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

class FakeLocator implements BrowserRuntime.LocatorLike {
  clicks = 0
  fills: string[] = []

  async click() {
    this.clicks += 1
  }

  async fill(value: string) {
    this.fills.push(value)
  }
}

class FakePage implements BrowserRuntime.PageLike {
  currentUrl = "about:blank"
  closed = false
  readonly locatorState = new Map<string, FakeLocator>()
  readonly nodes: readonly BrowserSnapshot.Node[] = [
    {
      id: "#continue",
      role: "button",
      name: "Continue",
      interactive: true,
      children: [],
    },
  ]

  async goto(url: string) {
    this.currentUrl = url
  }

  url() {
    return this.currentUrl
  }

  async title() {
    return "Fake App"
  }

  async close() {
    this.closed = true
  }

  async screenshot() {
    return new Uint8Array([137, 80, 78, 71])
  }

  locator(selector: string) {
    const hit = this.locatorState.get(selector)
    if (hit) return hit
    const next = new FakeLocator()
    this.locatorState.set(selector, next)
    return next
  }

  async evaluate<A>() {
    return this.nodes as A
  }
}

class FakeContext implements BrowserRuntime.BrowserContextLike {
  closed = false
  readonly pages: FakePage[] = []

  async newPage() {
    const page = new FakePage()
    this.pages.push(page)
    return page
  }

  async close() {
    this.closed = true
    await Promise.all(this.pages.map((page) => page.close()))
  }
}

class FakeBrowser implements BrowserRuntime.BrowserLike {
  closed = false
  readonly contexts: FakeContext[] = []
  readonly contextOptions: Array<Parameters<BrowserRuntime.BrowserLike["newContext"]>[0]> = []

  async newContext(options?: Parameters<BrowserRuntime.BrowserLike["newContext"]>[0]) {
    const context = new FakeContext()
    this.contexts.push(context)
    this.contextOptions.push(options)
    return context
  }

  async close() {
    this.closed = true
    await Promise.all(this.contexts.map((context) => context.close()))
  }
}

class FakeDriver implements BrowserRuntime.Driver {
  connects = 0
  launches = 0
  readonly browsers: FakeBrowser[] = []
  readonly connectOptions: Array<{
    readonly endpoint: string
    readonly options: Parameters<BrowserRuntime.Driver["connectOverCDP"]>[1]
  }> = []
  readonly launchOptions: Array<Parameters<BrowserRuntime.Driver["launch"]>[0]> = []

  async connectOverCDP(
    endpoint: string,
    options?: Parameters<BrowserRuntime.Driver["connectOverCDP"]>[1],
  ) {
    this.connects += 1
    this.connectOptions.push({ endpoint, options })
    return this.browser()
  }

  async launch(options: Parameters<BrowserRuntime.Driver["launch"]>[0]) {
    this.launches += 1
    this.launchOptions.push(options)
    return this.browser()
  }

  private async browser() {
    await Bun.sleep(10)
    const browser = new FakeBrowser()
    this.browsers.push(browser)
    return browser
  }
}

const root = path.join(os.tmpdir(), `chimera-browser-runtime-${process.pid}-${Date.now()}`)
const driver = new FakeDriver()
const globalLayer = Global.layerWith({
  home: path.join(root, "home"),
  data: path.join(root, "data"),
  tmp: path.join(root, "tmp"),
})
const platformLayer = Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer, NodePath.layer)
const artifactLayer = BrowserArtifact.layer.pipe(
  Layer.provide(platformLayer),
  Layer.provide(globalLayer),
)
const runtimeLayer = BrowserRuntime.layerWith(driver).pipe(
  Layer.provide(artifactLayer),
  Layer.provide(platformLayer),
)
const it = testEffect(Layer.mergeAll(runtimeLayer, platformLayer))

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("browser.runtime", () => {
  it.live("shares a lazy connection, isolates sessions, scopes refs, and cleans up", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      driver.connects = 0
      driver.launches = 0
      driver.browsers.length = 0
      driver.connectOptions.length = 0
      driver.launchOptions.length = 0
      let firstBrowser: FakeBrowser | undefined

      yield* Effect.scoped(
        provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const [first, second] = yield* Effect.all(
            [
              runtime.open({
                sessionID: "session-one",
                url: "https://example.com/one",
                launch: { cdpUrl: "http://browser.test", locale: "en-US" },
              }),
              runtime.open({
                sessionID: "session-two",
                url: "https://example.com/two",
                launch: { cdpUrl: "http://browser.test", locale: "ja-JP" },
              }),
            ],
            { concurrency: 2 },
          )

          firstBrowser = driver.browsers[0]
          expect(driver.connects).toBe(1)
          expect(driver.launches).toBe(0)
          expect(driver.connectOptions).toEqual([
            { endpoint: "http://browser.test", options: { timeout: 15_000 } },
          ])
          expect(firstBrowser?.contexts).toHaveLength(2)
          expect(firstBrowser?.contextOptions).toHaveLength(2)
          expect(firstBrowser?.contextOptions).toContainEqual({ locale: "en-US" })
          expect(firstBrowser?.contextOptions).toContainEqual({ locale: "ja-JP" })
          expect(first.url).toBe("https://example.com/one")
          expect(second.url).toBe("https://example.com/two")

          const snapshot = yield* runtime.snapshot({ sessionID: "session-one" })
          expect(snapshot.generation).toBe(1)
          expect(snapshot.text).toContain("[ref=g1e1]")
          expect(Array.from(snapshot.refs.keys())).toEqual(["g1e1"])

          yield* runtime.click({ sessionID: "session-one", ref: "g1e1" })
          expect(firstBrowser?.contexts[0]?.pages[0]?.locatorState.get("#continue")?.clicks).toBe(1)
          const stale = yield* runtime.click({ sessionID: "session-one", ref: "g1e1" }).pipe(Effect.flip)
          expect(stale.message).toContain("Unknown or stale")

          const refreshed = yield* runtime.snapshot({ sessionID: "session-one" })
          expect(refreshed.generation).toBe(3)
          expect(refreshed.text).toContain("[ref=g3e1]")
          yield* runtime.type({ sessionID: "session-one", ref: "g3e1", text: "hello" })
          expect(firstBrowser?.contexts[0]?.pages[0]?.locatorState.get("#continue")?.fills).toEqual(["hello"])

          const screenshot = yield* runtime.screenshot({ sessionID: "session-one", name: "runtime-test" })
          expect(screenshot.artifact.path.startsWith(path.join(root, "data", "browser-artifacts"))).toBe(true)
          expect(screenshot.attachment.url).toBe("data:image/png;base64,iVBORw==")

          expect(yield* runtime.tabs("session-one")).toHaveLength(1)
          yield* runtime.closeSession("session-one")
          expect(firstBrowser?.contexts[0]?.closed).toBe(true)
          expect(firstBrowser?.contexts[1]?.closed).toBe(false)
          yield* runtime.closeTab({ sessionID: "session-two", tabID: second.id })
          expect(firstBrowser?.contexts[1]?.closed).toBe(true)
          }),
        ),
      )

      expect(firstBrowser?.closed).toBe(true)

      yield* Effect.scoped(
        provideTmpdirInstance(() =>
        runtime.open({
          sessionID: "session-three",
          launch: { cdpUrl: "http://browser.test" },
        }),
        ),
      )
      expect(driver.connects).toBe(2)
      expect(driver.browsers[1]?.closed).toBe(true)
    }),
  )

  it.live("launches local system browsers through Playwright pipe transport", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      driver.connects = 0
      driver.launches = 0
      driver.browsers.length = 0
      driver.connectOptions.length = 0
      driver.launchOptions.length = 0
      let browser: FakeBrowser | undefined

      yield* Effect.scoped(
        provideTmpdirInstance((directory) =>
          Effect.gen(function* () {
            const executable = path.join(directory, "chrome")
            yield* Effect.promise(() => Bun.write(executable, "#!/bin/sh\n"))
            yield* Effect.promise(() => fs.chmod(executable, 0o755))

            const tab = yield* runtime.open({
              sessionID: "local-session",
              launch: { executablePath: executable, headless: false, locale: "en-US", timeout: 1_234 },
            })
            browser = driver.browsers[0]
            expect(tab.url).toBe("about:blank")
            expect(driver.connects).toBe(0)
            expect(driver.launches).toBe(1)
            expect(driver.launchOptions).toEqual([
              { executablePath: executable, headless: false, timeout: 1_234 },
            ])
            expect(browser?.contextOptions).toEqual([{ locale: "en-US" }])
          }),
        ),
      )

      expect(browser?.closed).toBe(true)
    }),
  )
})
