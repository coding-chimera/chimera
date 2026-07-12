import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { BrowserDiscovery } from "../../src/browser/discovery"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer, NodePath.layer))

describe("browser.discovery", () => {
  test("orders macOS and Windows standard browser candidates deterministically", () => {
    const mac = BrowserDiscovery.candidates({ platform: "darwin", env: { PATH: "" }, home: "/Users/test" })
    expect(mac.slice(0, 4).map((candidate) => candidate.kind)).toEqual(["chrome", "chromium", "edge", "brave"])
    expect(mac[0]?.path).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    expect(mac[4]?.path).toBe("/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

    const windows = BrowserDiscovery.candidates({
      platform: "win32",
      env: {
        PATH: "",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        PROGRAMFILES: "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      },
      home: "C:\\Users\\test",
    })
    expect(windows[0]).toEqual({
      kind: "chrome",
      path: "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      source: "standard",
    })
  })

  it.live("prefers explicit executables and validates executable files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* tmpdirScoped()
      const chrome = path.join(directory, "google-chrome-stable")
      const chromium = path.join(directory, "chromium")
      yield* fs.writeFileString(chrome, "chrome")
      yield* fs.writeFileString(chromium, "chromium")
      yield* fs.chmod(chrome, 0o755)
      yield* fs.chmod(chromium, 0o755)

      const discovered = yield* BrowserDiscovery.discover({
        platform: "linux",
        env: { PATH: directory },
      })
      expect(discovered.path).toBe(chrome)
      expect(discovered.kind).toBe("chrome")
      expect(discovered.source).toBe("path")

      const explicit = yield* BrowserDiscovery.discover({
        executablePath: chromium,
        platform: "linux",
        env: { PATH: directory },
      })
      expect(explicit.path).toBe(chromium)
      expect(explicit.kind).toBe("chromium")
      expect(explicit.source).toBe("explicit")
    }),
  )

  it.live("rejects an invalid explicit executable without falling back", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const error = yield* BrowserDiscovery.discover({
        executablePath: path.join(directory, "missing"),
        platform: "linux",
        env: { PATH: directory },
      }).pipe(Effect.flip)

      expect(error._tag).toBe("BrowserInvalidExecutableError")
      if (error._tag !== "BrowserInvalidExecutableError") throw error
      expect(error.path).toContain("missing")
    }),
  )
})
