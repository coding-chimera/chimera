import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { BrowserArtifact } from "../../src/browser/artifact"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const root = path.join(os.tmpdir(), `chimera-browser-artifact-${process.pid}-${Date.now()}`)
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
const it = testEffect(Layer.mergeAll(artifactLayer, platformLayer))

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("browser.artifact", () => {
  it.instance("writes unique managed artifacts and creates attachments", () =>
    Effect.gen(function* () {
      const service = yield* BrowserArtifact.Service
      const first = yield* service.write({
        sessionID: "session-one",
        kind: "screenshot",
        name: "../../Login Result",
        extension: ".png",
        mime: "image/png",
        data: new Uint8Array([1, 2, 3]),
      })
      const second = yield* service.write({
        sessionID: "session-one",
        kind: "screenshot",
        name: "../../Login Result",
        extension: "png",
        mime: "image/png",
        data: new Uint8Array([4, 5, 6]),
      })

      expect(first.path.startsWith(path.join(root, "data", "browser-artifacts"))).toBe(true)
      expect(first.filename).not.toContain("..")
      expect(first.path).not.toBe(second.path)
      expect(Array.from(yield* service.read(first))).toEqual([1, 2, 3])
      expect(yield* service.attachment(first)).toEqual({
        type: "file",
        mime: "image/png",
        filename: first.filename,
        url: "data:image/png;base64,AQID",
      })
    }),
  )

  it.live("removes the scoped runtime directory when an instance is disposed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const service = yield* BrowserArtifact.Service
      let runtimeDirectory = ""

      yield* Effect.scoped(
        provideTmpdirInstance(() =>
          Effect.gen(function* () {
            runtimeDirectory = yield* service.runtimeDirectory
            expect(yield* fs.exists(runtimeDirectory)).toBe(true)
          }),
        ),
      )

      expect(runtimeDirectory).not.toBe("")
      expect(yield* fs.exists(runtimeDirectory)).toBe(false)
    }),
  )
})
