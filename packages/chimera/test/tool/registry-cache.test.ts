import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ToolRegistry } from "@/tool/registry"
import { BrowserRuntime } from "@/browser/runtime"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { WorkBrief } from "@/session/work-brief"
import { Goal } from "@/session/goal"
import { ToolSearch } from "@/session/tool-search"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { LSP } from "@/lsp/lsp"
import { Ledger } from "@/lsp/ledger"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { ProviderID, ModelID } from "@/provider/schema"
import { Auth } from "@/auth"
import { MemoryManagement } from "@/memory/management"
import { DelegationLimiter } from "../../src/agent/delegation-limiter"
import { Parameters as TaskParameters, TaskTool } from "@/tool/task"
import { toJsonSchema } from "@/util/effect-zod"

const node = CrossSpawnSpawner.defaultLayer
// Production `Config.get` returns a stable per-instance object; mirror that so
// the registry cache is exercised the same way it is in a running session.
let testConfig: Config.Info = {}
const configLayer = TestConfig.layer({
  get: () => Effect.succeed(testConfig),
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".chimera")])),
})
const authLayer = Layer.mock(Auth.Service)({
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
  set: () => Effect.void,
  remove: () => Effect.void,
})

const registryLayer = Layer.provide(
  ToolRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(configLayer, ConfigSubagentRouting.defaultLayer, DelegationLimiter.defaultLayer)),
    Layer.provide(authLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Layer.mergeAll(WorkBrief.defaultLayer, Goal.defaultLayer, ToolSearch.defaultLayer)),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Layer.mergeAll(LSP.defaultLayer, Ledger.defaultLayer)),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(node),
    Layer.provide(BrowserRuntime.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
  ),
  MemoryManagement.defaultLayer,
)

const it = testEffect(Layer.mergeAll(registryLayer, node))

afterEach(async () => {
  await disposeAllInstances()
})

const buildAgent = (permission: Agent.Info["permission"] = [{ permission: "task", pattern: "*", action: "allow" }]) => ({
  name: "build",
  mode: "primary" as const,
  permission,
  options: {},
})

describe("tool.registry caching", () => {
  it.instance("reuses the tool list for repeated calls with the same config", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = buildAgent()
      const input = {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent,
      }

      const first = yield* registry.tools(input)
      const second = yield* registry.tools(input)

      expect(second).toBe(first)
      expect(second[0]).toBe(first[0])
      expect(second.map((tool) => tool.id)).toEqual(first.map((tool) => tool.id))
    }),
  )

  it.instance("recomputes the tool list when the agent permission changes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

      const first = yield* registry.tools({ ...model, agent: buildAgent() })
      const second = yield* registry.tools({
        ...model,
        agent: buildAgent([{ permission: "task", pattern: "*", action: "deny" }]),
      })

      expect(second).not.toBe(first)
    }),
  )

  it.instance("recomputes the tool list when the config instance changes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = buildAgent()
      const input = {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent,
      }

      const first = yield* registry.tools(input)
      const previous = testConfig
      testConfig = {}
      const second = yield* registry.tools(input)
      testConfig = previous

      expect(second).not.toBe(first)
    }),
  )

  it.instance("reuses the task description across repeated task/swarm/orchestrate tool lookups", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = buildAgent()
      const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

      const first = yield* registry.tools({ ...model, agent })
      const task = first.find((tool) => tool.id === TaskTool.id)
      const swarm = first.find((tool) => tool.id === "chimera_swarm")
      const orchestrate = first.find((tool) => tool.id === "orchestrate")

      expect(task).toBeDefined()
      expect(swarm).toBeDefined()
      expect(orchestrate).toBeDefined()
      // Each task-like tool appends the same shared describeTask output.
      const suffix = (description: string) => description.slice(description.indexOf("Available agent types"))
      expect(suffix(task!.description)).toBe(suffix(swarm!.description))
      expect(suffix(task!.description)).toBe(suffix(orchestrate!.description))
    }),
  )
})

describe("toJsonSchema caching", () => {
  test("returns the same JSON Schema reference for the same parameter schema", () => {
    const first = toJsonSchema(TaskParameters)
    const second = toJsonSchema(TaskParameters)

    expect(second).toBe(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  test("keeps wire bytes stable while memoizing", () => {
    const cached = toJsonSchema(TaskParameters)
    // A structurally identical derivation must match the memoized bytes.
    expect(JSON.parse(JSON.stringify(cached))).toEqual(JSON.parse(JSON.stringify(toJsonSchema(TaskParameters))))
  })
})