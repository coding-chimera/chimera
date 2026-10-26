import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

describe("builtin skills", () => {
  it.live("exposes orchestrate-authoring when no filesystem skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service

          const item = yield* skill.get("orchestrate-authoring")
          expect(item).toBeDefined()
          expect(item!.location).toBe("builtin:orchestrate-authoring")
          expect(item!.content.trim().length).toBeGreaterThan(0)

          expect((yield* skill.available()).map((entry) => entry.name)).toContain("orchestrate-authoring")
          expect(yield* skill.dirs()).not.toContain(item!.location)
        }),
      { git: true },
    ),
  )

  it.live("lets a filesystem skill override a built-in with the same name", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".chimera", "skill", "orchestrate-authoring", "SKILL.md"),
              `---
name: orchestrate-authoring
description: Filesystem override.
---

# Custom Override
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = yield* skill.get("orchestrate-authoring")

          expect(item).toBeDefined()
          expect(item!.description).toBe("Filesystem override.")
          expect(item!.content).toContain("# Custom Override")
          expect(item!.location).toContain(path.join("skill", "orchestrate-authoring", "SKILL.md"))
          expect(item!.location.startsWith("builtin:")).toBe(false)
        }),
      { git: true },
    ),
  )
})