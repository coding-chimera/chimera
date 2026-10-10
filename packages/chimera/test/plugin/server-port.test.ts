import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import { pathToFileURL } from "url"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

type Capture = { url?: string; client?: { app: { agents(): Promise<unknown> } } }
const captured: Capture = {}
;(globalThis as { __serverPortCapture?: Capture }).__serverPortCapture = captured

const { Plugin } = await import("../../src/plugin/index")
const { Server } = await import("../../src/server/server")

const it = testEffect(Layer.mergeAll(Plugin.defaultLayer, CrossSpawnSpawner.defaultLayer))

const PLUGIN_SOURCE = [
  "export default async (input) => {",
  "  globalThis.__serverPortCapture.url = input.serverUrl.href",
  "  globalThis.__serverPortCapture.client = input.client",
  "  return {}",
  "}",
  "",
].join("\n")

function loadPlugin(dir: string) {
  return Effect.gen(function* () {
    const file = path.join(dir, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, PLUGIN_SOURCE)),
        Effect.promise(() =>
          Bun.write(
            path.join(dir, "chimera.json"),
            JSON.stringify(
              {
                $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    const plugin = yield* Plugin.Service
    yield* plugin.init()
  })
}

afterAll(() => {
  Plugin._resetServerPortForTest()
  if (disableDefault === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

describe("plugin server port", () => {
  it.live("delegates fetch and url to the port registered by the server startup path", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const listener = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" }))
        try {
          yield* loadPlugin(dir)
          expect(captured.url).toBe(listener.url.href)

          const original = globalThis.fetch
          globalThis.fetch = (() => {
            throw new Error("global fetch used while a server port is injected")
          }) as unknown as typeof fetch
          try {
            const result = yield* Effect.promise(() => captured.client!.app.agents())
            expect(result).toBeDefined()
          } finally {
            globalThis.fetch = original
          }
        } finally {
          yield* Effect.promise(() => listener.stop())
        }
      }),
    ),
  )

  it.live("falls back to global fetch and the default url when no port is registered", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        Plugin._resetServerPortForTest()
        yield* loadPlugin(dir)
        expect(captured.url).toBe(new URL("http://localhost:4096").href)

        const calls: unknown[] = []
        const original = globalThis.fetch
        globalThis.fetch = ((input: RequestInfo | URL) => {
          calls.push(input)
          return Promise.resolve(
            new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
          )
        }) as typeof fetch
        try {
          yield* Effect.promise(() => captured.client!.app.agents())
          expect(calls.length).toBe(1)
        } finally {
          globalThis.fetch = original
        }
      }),
    ),
  )
})