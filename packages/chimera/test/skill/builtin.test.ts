import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Skill } from "../../src/skill"
import { Parameters as OrchestrateParameters } from "../../src/tool/orchestrate"
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
  it.live("teaches the unlimited timeoutMs sentinel and the fixed JSON template", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const item = yield* skill.get("orchestrate-authoring")
          expect(item).toBeDefined()

          const content = item!.content
          expect(content).toMatch(/timeoutMs/)
          expect(content).toMatch(/0[^.]{0,120}(unlimited|no global timer)/i)
          expect(content).toMatch(/negative[^.]{0,120}(unlimited|no global timer)/i)
          expect(content).toMatch(/positive[^.]{0,120}(budget|deadline)/i)
          expect(content).toMatch(/null[^.]{0,80}(schema error|reject)/i)

          const examples = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!))
          expect(examples.length).toBeGreaterThan(0)
          const parsed = examples.map((example) => Schema.decodeUnknownSync(OrchestrateParameters)(example))
          expect(parsed.some((entry) => entry.timeoutMs === 0 && entry.maxTotalAgents === undefined)).toBe(true)
          expect(content).toContain("Omit `maxTotalAgents` for unlimited dispatches")
          expect(content).not.toContain("default 64, hard cap 256")
        }),
      { git: true },
    ),
  )

  it.live("pins the task/swarm/orchestrate selection guidance and the agent selector API", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const content = (yield* skill.get("orchestrate-authoring"))!.content
          expect(content).toContain("## Which tool")
          expect(content).toContain("`task`")
          expect(content).toContain("`chimera_swarm`")
          expect(content).toContain("explicit `items` + `prompt_template`")
          expect(content).toContain("plan the whole program up front")
          expect(content).toContain("Prefer `background: true` for any dispatch that supports it")
          expect(content).toContain("never sleep, poll, or busy-wait")
          expect(content).toContain("orche.agent({ prompt, agent?, model?, variant?, workload?, label?, schema? })")
          expect(content).not.toContain("default execution surface")
          expect(content).not.toContain("Only two shapes")
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
