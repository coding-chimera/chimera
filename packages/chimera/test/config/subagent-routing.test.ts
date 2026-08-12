import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigSubagentRouting } from "../../src/config/subagent-routing"
import { ProjectID } from "../../src/project/schema"
import { tmpdir } from "../fixture/fixture"

const projectID = ProjectID.make("phase-4-project")
const providerTarget = { type: "provider", providerID: "relay" } as const

function makeLayer(state: string) {
  const filesystem = AppFileSystem.defaultLayer
  const global = Global.layerWith({ state })
  const flock = EffectFlock.layer.pipe(Layer.provide(Layer.mergeAll(filesystem, global)))
  return ConfigSubagentRouting.layer.pipe(Layer.provide(Layer.mergeAll(filesystem, global, flock)))
}

function stateFile(state: string) {
  return path.join(state, "subagent-routing.json")
}

describe("delegation decay and reinforcement", () => {
  test("uses deterministic 32/96 delegation boundaries and stops once dormant", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const routing = yield* ConfigSubagentRouting.Service
        yield* routing.prefer({ scope: { type: "global" }, target: providerTarget })
        yield* Effect.forEach(Array.from({ length: 32 }), () => routing.recordDelegation(projectID), {
          discard: true,
        })
        const at32 = yield* routing.get()
        yield* Effect.forEach(Array.from({ length: 64 }), () => routing.recordDelegation(projectID), {
          discard: true,
        })
        const at96 = yield* routing.get()
        const stopped = yield* routing.recordDelegation(projectID)
        return { at32, at96, stopped }
      }).pipe(Effect.provide(makeLayer(root))),
    )

    const signal = result.at96.global.providers.relay.preference
    expect(ConfigSubagentRouting.score(result.at32.global.providers.relay.preference, 32)).toBeCloseTo(0.5, 12)
    expect(result.at32.activity.global).toBe(32)
    expect(ConfigSubagentRouting.score(signal, 96)).toBeCloseTo(0.125, 12)
    expect(ConfigSubagentRouting.dormant(signal, 95)).toBe(false)
    expect(ConfigSubagentRouting.dormant(signal, 96)).toBe(true)
    expect(result.at96.activity.global).toBe(96)
    expect(result.stopped.activity.global).toBe(96)
    expect(result.stopped.revision).toBe(result.at96.revision)
  })

  test("reinforces the decayed score and caps weight", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const routing = yield* ConfigSubagentRouting.Service
        yield* routing.prefer({ scope: { type: "global" }, target: providerTarget })
        yield* Effect.forEach(Array.from({ length: 32 }), () => routing.recordDelegation(projectID), {
          discard: true,
        })
        const reinforced = yield* routing.prefer({ scope: { type: "global" }, target: providerTarget })
        yield* Effect.forEach(
          Array.from({ length: 7 }),
          () => routing.prefer({ scope: { type: "global" }, target: providerTarget }),
          { discard: true },
        )
        return { reinforced, capped: yield* routing.get() }
      }).pipe(Effect.provide(makeLayer(root))),
    )

    expect(result.reinforced.global.providers.relay.preference?.weight).toBeCloseTo(1.5, 12)
    expect(result.reinforced.global.providers.relay.preference?.activity).toBe(32)
    expect(result.capped.global.providers.relay.preference?.weight).toBe(ConfigSubagentRouting.DEFAULT_POLICY.maxWeight)
  })

  test("does not advance activity for suppressed preferences and resumes after explicit restore", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const routing = yield* ConfigSubagentRouting.Service
        yield* routing.prefer({ scope: { type: "global" }, target: providerTarget })
        const suppressed = yield* routing.suppress({ scope: { type: "global" }, target: providerTarget })
        const idle = yield* routing.recordDelegation(projectID)
        const restored = yield* routing.prefer({ scope: { type: "global" }, target: providerTarget })
        const active = yield* routing.recordDelegation(projectID)
        return { suppressed, idle, restored, active }
      }).pipe(Effect.provide(makeLayer(root))),
    )

    expect(result.idle.revision).toBe(result.suppressed.revision)
    expect(result.idle.activity.global).toBe(0)
    expect(result.restored.global.providers.relay.suppressedRevision).toBe(result.suppressed.revision)
    expect(result.restored.global.providers.relay.preference?.revision).toBe(result.restored.revision)
    expect(result.active.activity.global).toBe(1)
    expect(result.active.revision).toBe(result.restored.revision + 1)
  })
})

describe("mutation validation and persistence", () => {
  test("rejects project-global scope and mismatched concrete route providers without writing", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const routing = yield* ConfigSubagentRouting.Service
        const prefer = yield* routing
          .prefer({
            scope: { type: "project", projectID: ProjectID.global },
            target: providerTarget,
          })
          .pipe(Effect.flip)
        const suppress = yield* routing
          .suppress({
            scope: { type: "project", projectID: ProjectID.global },
            target: providerTarget,
          })
          .pipe(Effect.flip)
        const route = yield* routing
          .prefer({
            scope: { type: "global" },
            target: {
              type: "route",
              identity: "gpt-5.6",
              providerID: "relay",
              model: "openai/gpt-5.6",
            },
          })
          .pipe(Effect.flip)
        return { prefer, suppress, route }
      }).pipe(Effect.provide(makeLayer(root))),
    )

    expect(errors.prefer.operation).toBe("write")
    expect(errors.suppress.operation).toBe("write")
    expect(errors.route.detail).toContain("provider")
    expect(await Bun.file(stateFile(root)).exists()).toBe(false)
  })

  test("preserves exact routes while excluding candidate and sensitive input fields", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const model = "relay/deployments/team/gpt-5.6"
    const target = {
      type: "route",
      identity: "gpt-5.6",
      providerID: "relay",
      model,
      variants: ["ultra-secret-variant"],
      capabilities: { hidden: "candidate-secret" },
      key: "sk-routing-secret",
      baseURL: "https://sensitive.example",
      headers: { authorization: "Bearer sensitive-token" },
    } as ConfigSubagentRouting.Target

    await Effect.runPromise(
      ConfigSubagentRouting.Service.use((routing) =>
        routing.prefer({ scope: { type: "global" }, target }),
      ).pipe(Effect.provide(makeLayer(root))),
    )

    const text = await Bun.file(stateFile(root)).text()
    const persisted = JSON.parse(text) as ConfigSubagentRouting.State
    expect(Object.keys(persisted.global.routes["gpt-5.6"] ?? {})).toEqual([model])
    for (const value of [
      "ultra-secret-variant",
      "candidate-secret",
      "sk-routing-secret",
      "sensitive.example",
      "sensitive-token",
      "capabilities",
      "headers",
    ]) {
      expect(text).not.toContain(value)
    }
    if (process.platform !== "win32") {
      expect((await fs.stat(stateFile(root))).mode & 0o777).toBe(0o600)
    }
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("reports corrupt state and preserves the original file on reads and mutations", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const original = "{invalid-json\n"
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(stateFile(root), original, { mode: 0o600 })
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const routing = yield* ConfigSubagentRouting.Service
        const read = yield* routing.get().pipe(Effect.flip)
        const mutation = yield* routing
          .prefer({ scope: { type: "global" }, target: providerTarget })
          .pipe(Effect.flip)
        return { read, mutation }
      }).pipe(Effect.provide(makeLayer(root))),
    )

    expect(errors.read.operation).toBe("read")
    expect(errors.mutation.operation).toBe("read")
    expect(await Bun.file(stateFile(root)).text()).toBe(original)
    expect((await fs.readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  test("serializes concurrent service instances without lost updates or torn JSON", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const first = makeLayer(root)
    const second = makeLayer(root)
    const providers = Array.from({ length: 12 }, (_, index) => `relay-${index.toString().padStart(2, "0")}`)

    await Promise.all(
      providers.map((providerID, index) =>
        Effect.runPromise(
          ConfigSubagentRouting.Service.use((routing) =>
            routing.prefer({ scope: { type: "global" }, target: { type: "provider", providerID } }),
          ).pipe(Effect.provide(index % 2 === 0 ? first : second)),
        ),
      ),
    )

    const persisted = JSON.parse(await Bun.file(stateFile(root)).text()) as ConfigSubagentRouting.State
    expect(persisted.revision).toBe(providers.length)
    expect(Object.keys(persisted.global.providers)).toEqual(providers)
    expect(Object.values(persisted.global.providers).every((entry) => entry.preference?.weight === 1)).toBe(true)
    if (process.platform !== "win32") {
      expect((await fs.stat(stateFile(root))).mode & 0o777).toBe(0o600)
    }
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})
