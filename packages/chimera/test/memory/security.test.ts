import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MemoryPaths } from "@/memory/paths"
import { MemorySecurity } from "@/memory/security"

const it = testEffect(Layer.empty)

describe("memory paths", () => {
  it.effect("uses stable global and full-digest project roots", () =>
    Effect.sync(() => {
      const dataRoot = path.join(path.sep, "tmp", "chimera-data")
      const key = MemoryPaths.projectKey("project:/workspace/example")
      expect(key).toMatch(/^[a-f0-9]{64}$/)
      expect(MemoryPaths.roots("project:/workspace/example", dataRoot)).toEqual({
        memories: path.join(dataRoot, "memories"),
        global: path.join(dataRoot, "memories", "global"),
        project: path.join(dataRoot, "memories", "projects", key),
      })
    }),
  )

  it.instance("writes and validates project scope metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const metadata = yield* Effect.promise(() => MemoryPaths.writeProjectScopeMetadata("project:/workspace/example", test.directory))
      expect(metadata).toEqual({ schemaVersion: 1, scope: "project", projectID: "project:/workspace/example" })
      expect(yield* Effect.promise(() => MemoryPaths.readProjectScopeMetadata("project:/workspace/example", test.directory))).toEqual(metadata)
      expect(yield* Effect.promise(() => MemoryPaths.readProjectScopeMetadata("project:/workspace/other", test.directory))).toBeUndefined()
      if (process.platform !== "win32") {
        const mode = (yield* Effect.promise(() => fs.stat(MemoryPaths.scopeMetadataPath("project:/workspace/example", test.directory)))).mode & 0o777
        expect(mode).toBe(0o600)
      }
    }),
  )
})

describe("memory security", () => {
  it.effect("cleans text and redacts credentials without treating digests as secrets", () =>
    Effect.sync(() => {
      expect(MemorySecurity.cleanText("  keep\u0000 this\n compact  ", 20)).toBe("keep this compact")
      const input = "Authorization: Bearer top-secret-token\npassword=hunterhunter\ncommit 0123456789abcdef0123456789abcdef01234567"
      expect(MemorySecurity.containsSecret(input)).toBe(true)
      expect(MemorySecurity.redactSecrets(input)).toBe(
        "Authorization: Bearer [REDACTED]\npassword=[REDACTED]\ncommit 0123456789abcdef0123456789abcdef01234567",
      )
      expect(MemorySecurity.containsSecret("commit 0123456789abcdef0123456789abcdef01234567")).toBe(false)
    }),
  )

  it.instance("rejects path traversal, external paths, and symlink escapes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const root = path.join(test.directory, "root")
      const outside = path.join(test.directory, "outside")
      yield* Effect.promise(() => Promise.all([fs.mkdir(root), fs.mkdir(outside)]))

      expect(MemorySecurity.validateRelativePath("rollout_summaries/note.md")).toBe(path.join("rollout_summaries", "note.md"))
      expect(() => MemorySecurity.validateRelativePath("../outside.md")).toThrow(MemorySecurity.UnsafeMemoryPathError)
      expect(() => MemorySecurity.validateRelativePath(".hidden/note.md")).toThrow(MemorySecurity.UnsafeMemoryPathError)
      expect(MemorySecurity.isPathContained(root, path.join(root, "note.md"))).toBe(true)
      expect(MemorySecurity.isExternalPath(root, path.join(outside, "note.md"))).toBe(true)
      expect(yield* Effect.promise(() => MemorySecurity.resolveSafeRelativePath(root, "new/note.md"))).toBe(path.join(root, "new", "note.md"))

      if (process.platform === "win32") return
      yield* Effect.promise(() => fs.symlink(outside, path.join(root, "escape")))
      const error = yield* Effect.promise(() =>
        MemorySecurity.resolveSafeRelativePath(root, "escape/note.md").then(
          () => undefined,
          (cause) => cause,
        ),
      )
      expect(error).toBeInstanceOf(MemorySecurity.UnsafeMemoryPathError)
    }),
  )
})
