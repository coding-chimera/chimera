import { describe, expect, spyOn } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("lsp.spawn", () => {
  it.live("does not spawn builtin LSP for files outside instance", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.touchFile(path.join(dir, "..", "outside.ts"))
              yield* lsp.hover({
                file: path.join(dir, "..", "hover.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(0)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("does not spawn builtin LSP for files inside instance when LSP is unset", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("would spawn builtin LSP for files inside instance when lsp is true", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(1)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("would spawn builtin LSP for files inside instance when config object is provided", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(1)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      {
        config: {
          lsp: {
            eslint: { disabled: true },
          },
        },
      },
    ),
  )
})

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

describe("lsp.request", () => {
  it.live(
    "falls to no-data results when the server hangs past the request timeout",
    () =>
      provideTmpdirInstance(
        (dir) =>
          LSP.Service.use((lsp) =>
            Effect.gen(function* () {
              const file = path.join(dir, "test.ts")
              const started = Date.now()
              // Line 9999 is the fake server's hang sentinel; the injected short
              // timeout keeps the test fast instead of waiting the real 10s.
              expect(yield* lsp.hover({ file, line: 9999, character: 0 }, 50)).toEqual([null])
              expect(yield* lsp.typeDefinition({ file, line: 9999, character: 0 }, 50)).toEqual([])
              expect(Date.now() - started).toBeLessThan(5_000)

              // Off the sentinel the server answers immediately, so the default
              // (non-injected) timeout path resolves as well.
              expect(yield* lsp.typeDefinition({ file, line: 0, character: 0 })).toEqual([])
            }),
          ),
        {
          config: {
            lsp: {
              fake: {
                command: [process.execPath, fakeServerPath],
                extensions: [".ts"],
              },
            },
          },
        },
      ),
  )
})
