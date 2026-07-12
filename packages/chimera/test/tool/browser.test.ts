import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BrowserRuntime } from "@/browser/runtime"
import { MessageID, SessionID } from "@/session/schema"
import { BrowserClickTool } from "@/tool/browser_click"
import { BrowserCloseTool } from "@/tool/browser_close"
import { BrowserOpenTool } from "@/tool/browser_open"
import { BrowserScreenshotTool } from "@/tool/browser_screenshot"
import { BrowserSnapshotTool } from "@/tool/browser_snapshot"
import { BrowserTypeTool } from "@/tool/browser_type"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WithInstance } from "@/project/with-instance"

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
})
