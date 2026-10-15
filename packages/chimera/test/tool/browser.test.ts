import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "@/agent/agent"
import { BrowserArtifact } from "@/browser/artifact"
import { BrowserRuntime } from "@/browser/runtime"
import { Chimera } from "@/chimera"
import { ProcessRegistry } from "@/chimera/process-registry"
import { Config } from "@/config/config"
import { MessageID, SessionID } from "@/contracts/session-ids"
import { InstanceState } from "@/effect/instance-state"
import { BrowserClickTool } from "@/tool/browser_click"
import { BrowserCloseTool } from "@/tool/browser_close"
import { BrowserOpenTool } from "@/tool/browser_open"
import { BrowserScreenshotTool } from "@/tool/browser_screenshot"
import { BrowserSnapshotTool } from "@/tool/browser_snapshot"
import { BrowserTypeTool } from "@/tool/browser_type"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WithInstance } from "@/project/with-instance"
import { disposeAllInstances, provideInstance, provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const projectRoot = path.join(import.meta.dir, "../..")
const tab = {
  id: "tab-1",
  sessionID: SessionID.make("ses_browser_tool"),
  url: "https://example.com/account?token=secret",
  title: "Example",
  current: true,
} satisfies BrowserRuntime.TabInfo

type Ask = Parameters<Tool.Context["ask"]>[0]

function context(asks: Ask[], order: string[] = []): Tool.Context {
  return {
    sessionID: tab.sessionID,
    messageID: MessageID.make("msg_browser_tool"),
    callID: "call_browser_tool",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        order.push("ask")
        asks.push(input)
      }),
  }
}

function fakeRuntime(overrides: Partial<BrowserRuntime.Interface> = {}): BrowserRuntime.Interface {
  return {
    open: (input) => Effect.succeed({ ...tab, sessionID: input.sessionID }),
    tabs: () => Effect.succeed([tab]),
    select: () => Effect.void,
    snapshot: () =>
      Effect.succeed({
        text: "[UNTRUSTED BROWSER CONTENT]\nbutton \"Continue\" [ref=g1e1]",
        refs: new Map([["g1e1", { id: "#continue", role: "button", name: "Continue" }]]),
        truncated: false,
        omittedLines: 0,
        trust: {
          source: "browser",
          untrusted: true,
          url: "https://example.com/account?token=%5BREDACTED%5D",
          origin: "https://example.com",
        },
        tabID: tab.id,
        generation: 1,
        title: tab.title,
      }),
    click: () => Effect.void,
    type: () => Effect.void,
screenshot: () =>
Effect.succeed({
artifact: {
kind: "screenshot",
path: "/managed/browser/screenshot.png",
filename: "screenshot.png",
mime: "image/png",
},
attachment: {
type: "file",
mime: "image/png",
filename: "screenshot.png",
url: "data:image/png;base64,cG5n",
        },
        url: "/global/browser-artifact/project-hash/session-hash/screenshot.png",
}),
    closeTab: () => Effect.void,
    closeSession: () => Effect.void,
    ...overrides,
  }
}

function run<A>(
  effect: Effect.Effect<A, never, BrowserRuntime.Service | Truncate.Service | Agent.Service>,
  runtime: BrowserRuntime.Interface,
) {
  return WithInstance.provide({
    directory: projectRoot,
    fn: () =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(Layer.succeed(BrowserRuntime.Service, runtime), Truncate.defaultLayer, Agent.defaultLayer),
        ),
        Effect.runPromise,
      ),
  })
}

describe("browser tools", () => {
  test("browser_open asks for the normalized origin before navigation", async () => {
    const asks: Ask[] = []
    const order: string[] = []
    const runtime = fakeRuntime({
      open: (input) =>
        Effect.sync(() => {
          order.push("open")
          expect(input.url).toBe("https://example.com/path?q=1")
          return { ...tab, sessionID: input.sessionID }
        }),
    })
    const ctx = context(asks, order)
    const result = await run(
      BrowserOpenTool.pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((tool) => tool.execute({ url: "https://example.com/path?q=1" }, ctx)),
      ),
      runtime,
    )

    expect(order).toEqual(["ask", "open"])
    expect(asks[0]?.permission).toBe("browser_open")
    expect(asks[0]?.patterns).toEqual(["https://example.com"])
    expect(asks[0]?.always).toEqual(["https://example.com"])
    expect(asks[0]?.metadata).toEqual({ origin: "https://example.com" })
    expect(result.metadata.tabID).toBe(tab.id)
  })

  test("browser_snapshot returns untrusted content and origin-scoped permission", async () => {
    const asks: Ask[] = []
    const result = await run(
      BrowserSnapshotTool.pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((tool) => tool.execute({}, context(asks))),
      ),
      fakeRuntime(),
    )

    expect(asks[0]?.patterns).toEqual(["https://example.com"])
    expect(asks[0]?.metadata).toEqual({ tabID: tab.id, origin: "https://example.com" })
    expect(result.output).toStartWith("[UNTRUSTED BROWSER CONTENT]")
    expect(result.metadata.untrusted).toBe(true)
    expect(result.metadata.refCount).toBe(1)
  })

  test("browser_click propagates stale-ref failures after asking permission", async () => {
    const asks: Ask[] = []
    const runtime = fakeRuntime({
      click: () =>
        Effect.fail(
          new BrowserRuntime.RuntimeError({
            operation: "click browser ref",
            message: "Unknown or stale browser ref: g0e1",
          }),
        ),
    })

    await expect(
      run(
        BrowserClickTool.pipe(
          Effect.flatMap((info) => info.init()),
          Effect.flatMap((tool) => tool.execute({ ref: "g0e1" }, context(asks))),
        ),
        runtime,
      ),
    ).rejects.toThrow("Unknown or stale browser ref: g0e1")
    expect(asks[0]?.metadata).toEqual({ tabID: tab.id, origin: "https://example.com", ref: "g0e1" })
  })

  test("browser_type does not copy typed text into permission metadata or output", async () => {
    const asks: Ask[] = []
    const result = await run(
      BrowserTypeTool.pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((tool) => tool.execute({ ref: "g1e1", text: "private value" }, context(asks))),
      ),
      fakeRuntime(),
    )

    expect(JSON.stringify(asks[0])).not.toContain("private value")
    expect(result.output).not.toContain("private value")
    expect(result.output).toContain("run browser_snapshot again")
  })

  test("browser_screenshot returns the managed screenshot attachment", async () => {
    const asks: Ask[] = []
    const result = await run(
      BrowserScreenshotTool.pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((tool) => tool.execute({ name: "evidence", fullPage: true }, context(asks))),
      ),
      fakeRuntime(),
    )

    expect(asks[0]?.metadata).toEqual({ tabID: tab.id, origin: "https://example.com", fullPage: true })
    expect(result.metadata.artifactPath).toBe("/managed/browser/screenshot.png")
    expect(result.metadata.url).toBe("/global/browser-artifact/project-hash/session-hash/screenshot.png")
    // Copy-pasteable markdown snippet for inline WebUI display.
    expect(result.output).toContain("![screenshot](/global/browser-artifact/project-hash/session-hash/screenshot.png)")
    expect(result.attachments).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,cG5n",
      },
    ])
  })

  test("browser_close closes the session when tabID is omitted", async () => {
    const asks: Ask[] = []
    const order: string[] = []
    const runtime = fakeRuntime({
      closeSession: () =>
        Effect.sync(() => {
          order.push("close")
        }),
    })
    const result = await run(
      BrowserCloseTool.pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((tool) => tool.execute({}, context(asks, order))),
      ),
      runtime,
    )

    expect(order).toEqual(["ask", "close"])
    expect(asks[0]?.metadata).toEqual({ tabID: tab.id, origin: "https://example.com", scope: "session" })
    expect(result.metadata.scope).toBe("session")
  })

  test("browser_open forwards the headless parameter into the runtime launch options", async () => {
    const asks: Ask[] = []
    let launch: BrowserRuntime.LaunchOptions | undefined
    const runtime = fakeRuntime({
      open: (input) =>
        Effect.sync(() => {
          launch = input.launch
          return { ...tab, sessionID: input.sessionID }
        }),
    })
    await run(
      BrowserOpenTool.pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((tool) => tool.execute({ url: "https://example.com/x", headless: false, timeout: 9_000 }, context(asks))),
      ),
      runtime,
    )

    expect(launch).toEqual({ headless: false, timeout: 9_000 })
  })
})

// ---------------------------------------------------------------------------
// Real BrowserRuntime over a fake driver: session process registry lifecycle
// and the headless fallback chain (tool param > config > env > default).
// ---------------------------------------------------------------------------

function fakePage(): BrowserRuntime.PageLike {
  let current = "about:blank"
  return {
    goto: async (url: string) => {
      current = url
    },
    url: () => current,
    title: async () => "Fake Registry App",
    close: async () => {},
    screenshot: async () => new Uint8Array(),
    locator: () => ({ click: async () => {}, fill: async () => {} }),
    evaluate: async <A,>() => undefined as A,
  }
}

class RegistryFakeBrowser implements BrowserRuntime.BrowserLike {
  closed = false
  readonly disconnectHandlers: Array<() => void> = []

  async newContext(): Promise<BrowserRuntime.BrowserContextLike> {
    return { newPage: async () => fakePage(), close: async () => {} }
  }

  async close() {
    this.closed = true
  }

  emitDisconnected() {
    for (const handler of this.disconnectHandlers) handler()
  }
}

// The pid is mutable so one shared harness can cover both the registering
// (alive pid) and the pid-less skip paths. process.pid is provably alive, so
// the registry liveness sweep keeps rows running while assertions run.
let fakePid: number | null = process.pid
const launched: Array<Parameters<BrowserRuntime.Driver["launch"]>[0]> = []
const browsers: RegistryFakeBrowser[] = []

const registryDriver: BrowserRuntime.Driver = {
  launch: async (options) => {
    launched.push(options)
    const browser = new RegistryFakeBrowser()
    browsers.push(browser)
    return browser
  },
  connectOverCDP: async () => {
    const browser = new RegistryFakeBrowser()
    browsers.push(browser)
    return browser
  },
  pid: () => fakePid,
  onDisconnected: (browser, handler) => {
    if (browser instanceof RegistryFakeBrowser) browser.disconnectHandlers.push(handler)
  },
}

const registryRoot = path.join(os.tmpdir(), `chimera-browser-registry-${process.pid}-${Date.now()}`)
const registryPlatformLayer = Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer, NodePath.layer)
const registryRuntimeLayer = BrowserRuntime.layerWith(registryDriver).pipe(
  Layer.provide(
    BrowserArtifact.layer.pipe(
      Layer.provide(registryPlatformLayer),
      Layer.provide(
        Global.layerWith({
          home: path.join(registryRoot, "home"),
          data: path.join(registryRoot, "data"),
          tmp: path.join(registryRoot, "tmp"),
        }),
      ),
    ),
  ),
  Layer.provide(registryPlatformLayer),
  Layer.provide(Config.defaultLayer),
)
const itRegistry = testEffect(Layer.mergeAll(registryRuntimeLayer, registryPlatformLayer))

afterAll(async () => {
  await fs.rm(registryRoot, { recursive: true, force: true })
})

afterEach(async () => {
  delete process.env.CHIMERA_BROWSER_HEADLESS
  fakePid = process.pid
  await disposeAllInstances()
  await new Promise((resolve) => setTimeout(resolve, 50))
})

const BROWSER_COMMAND = "chromium (chimera browser)"

const instanceProjectRoot = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  return ctx.worktree === "/" ? ctx.directory : ctx.worktree
})

const writeExecutable = (directory: string) =>
  Effect.gen(function* () {
    const executable = path.join(directory, "chrome")
    yield* Effect.promise(() => Bun.write(executable, "#!/bin/sh\n"))
    yield* Effect.promise(() => fs.chmod(executable, 0o755))
    return executable
  })

const browserEntries = (root: string) =>
  Effect.promise(() => ProcessRegistry.listActive(root)).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.command === BROWSER_COMMAND)),
  )

describe("browser runtime session process registry", () => {
  itRegistry.live("registers the launched local browser and marks it exited on instance cleanup", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      // Manual tmpdir (not tmpdirScoped): the registry DB must outlive instance
      // disposal so the exited transition written by the connection finalizer
      // stays observable after disposeAllInstances().
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      const root = tmp.path
      let entryID = ""
      yield* provideInstance(root)(
        Effect.gen(function* () {
          yield* Chimera.initProjectGraph({ watch: false })
          const executable = yield* writeExecutable(root)
          yield* runtime.open({ sessionID: "ses_registry_launch", launch: { executablePath: executable } })

          const entries = yield* browserEntries(root)
          expect(entries).toHaveLength(1)
          expect(entries[0]?.pid).toBe(process.pid)
          expect(entries[0]?.pgid).toBeNull()
          expect(entries[0]?.sessionID).toBe("ses_registry_launch")
          entryID = entries[0]!.id
        }),
      )

      yield* Effect.promise(() => disposeAllInstances())
      const rows = yield* Effect.promise(() => ProcessRegistry.getByPids(root, [process.pid]))
      expect(rows.find((row) => row.id === entryID)?.status).toBe("exited")
      expect(browsers.at(-1)?.closed).toBe(true)
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )

  itRegistry.live("marks the entry exited when the headed browser window disconnects", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      yield* provideTmpdirInstance((directory) =>
        Effect.gen(function* () {
          yield* Chimera.initProjectGraph({ watch: false })
          const root = yield* instanceProjectRoot
          const executable = yield* writeExecutable(directory)
          yield* runtime.open({ sessionID: "ses_registry_disconnect", launch: { executablePath: executable } })
          const entry = (yield* browserEntries(root))[0]!

          browsers.at(-1)!.emitDisconnected()

          // markExited is fire-and-forget from the disconnect callback; poll until visible.
          let status: string | undefined
          for (let attempt = 0; attempt < 100; attempt++) {
            const rows = yield* Effect.promise(() => ProcessRegistry.getByPids(root, [process.pid]))
            status = rows.find((row) => row.id === entry.id)?.status
            if (status !== "running") break
            yield* Effect.sleep("20 millis")
          }
          expect(status).toBe("exited")
        }),
        { git: true },
      )
    }),
  )

  itRegistry.live("re-registers under a new session when the original entry went terminal", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      yield* provideTmpdirInstance((directory) =>
        Effect.gen(function* () {
          yield* Chimera.initProjectGraph({ watch: false })
          const root = yield* instanceProjectRoot
          const executable = yield* writeExecutable(directory)
          yield* runtime.open({ sessionID: "ses_registry_owner_a", launch: { executablePath: executable } })
          const original = (yield* browserEntries(root))[0]!
          // Simulate sweep/TTL/session-removal marking the owner entry terminal.
          yield* Effect.promise(() => ProcessRegistry.markExited(root, original.id, null))

          yield* runtime.open({ sessionID: "ses_registry_owner_b", launch: { executablePath: executable } })

          const entries = yield* browserEntries(root)
          expect(entries).toHaveLength(1)
          expect(entries[0]?.id).not.toBe(original.id)
          expect(entries[0]?.sessionID).toBe("ses_registry_owner_b")
        }),
        { git: true },
      )
    }),
  )

  itRegistry.live("skips registration when the driver reports no local pid", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      fakePid = null
      yield* provideTmpdirInstance((directory) =>
        Effect.gen(function* () {
          yield* Chimera.initProjectGraph({ watch: false })
          const root = yield* instanceProjectRoot
          const executable = yield* writeExecutable(directory)
          yield* runtime.open({ sessionID: "ses_registry_nopid", launch: { executablePath: executable } })
          expect(yield* browserEntries(root)).toHaveLength(0)
        }),
        { git: true },
      )
    }),
  )
})

describe("browser runtime headless fallback chain", () => {
  itRegistry.live("defaults to headless and honors CHIMERA_BROWSER_HEADLESS=false", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      fakePid = null
      delete process.env.CHIMERA_BROWSER_HEADLESS
      yield* Effect.scoped(
        provideTmpdirInstance((directory) =>
          Effect.gen(function* () {
            const executable = yield* writeExecutable(directory)
            yield* runtime.open({ sessionID: "ses_headless_default", launch: { executablePath: executable } })
            expect(launched.at(-1)?.headless).toBe(true)
          }),
        ),
      )
      yield* Effect.scoped(
        provideTmpdirInstance((directory) =>
          Effect.gen(function* () {
            process.env.CHIMERA_BROWSER_HEADLESS = "false"
            const executable = yield* writeExecutable(directory)
            yield* runtime.open({ sessionID: "ses_headless_env", launch: { executablePath: executable } })
            expect(launched.at(-1)?.headless).toBe(false)
          }),
        ),
      )
    }),
  )

  itRegistry.live("reads config browser.headless and lets the launch option win", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.Service
      fakePid = null
      delete process.env.CHIMERA_BROWSER_HEADLESS
      yield* Effect.scoped(
        provideTmpdirInstance(
          (directory) =>
            Effect.gen(function* () {
              const executable = yield* writeExecutable(directory)
              yield* runtime.open({ sessionID: "ses_headless_config", launch: { executablePath: executable } })
              expect(launched.at(-1)?.headless).toBe(false)
            }),
          { config: { browser: { headless: false } } },
        ),
      )
      // The connection is a per-directory singleton, so the tool-parameter
      // override needs a fresh instance to observe a new launch.
      yield* Effect.scoped(
        provideTmpdirInstance(
          (directory) =>
            Effect.gen(function* () {
              const executable = yield* writeExecutable(directory)
              yield* runtime.open({
                sessionID: "ses_headless_tool",
                launch: { executablePath: executable, headless: true },
              })
              expect(launched.at(-1)?.headless).toBe(true)
            }),
          { config: { browser: { headless: false } } },
        ),
      )
    }),
  )
})
