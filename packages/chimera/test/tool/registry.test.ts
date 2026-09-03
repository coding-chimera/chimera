import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ToolRegistry } from "@/tool/registry"
import { BrowserRuntime } from "@/browser/runtime"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { WorkBrief } from "@/session/work-brief"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { ProviderID, ModelID } from "@/provider/schema"
import { WebSearchTool } from "@/tool/websearch"
import { Auth } from "@/auth"
import { MemoryManagement } from "@/memory/management"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import { WriteTool } from "@/tool/write"

import { DelegationLimiter } from "../../src/agent/delegation-limiter"
const node = CrossSpawnSpawner.defaultLayer
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".chimera")])),
})
const authLayer = Layer.mock(Auth.Service)({
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
  set: () => Effect.void,
  remove: () => Effect.void,
})
const makeRegistryLayer = () =>
  Layer.provide(
    ToolRegistry.layer.pipe(
      Layer.provide(Layer.mergeAll(configLayer, ConfigSubagentRouting.defaultLayer, DelegationLimiter.defaultLayer)),
      Layer.provide(authLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(WorkBrief.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(LSP.defaultLayer),
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

const registryLayer = makeRegistryLayer()
const it = testEffect(Layer.mergeAll(registryLayer, node))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("loads tools from .chimera/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".chimera")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("chimera_index")
      expect(ids).toContain("chimera_status")
      expect(ids).toContain("chimera_search")
      expect(ids).toContain("chimera_file_symbols")
      expect(ids).toContain("chimera_predesign")
      expect(ids).toContain("chimera_impact")
      expect(ids).not.toContain("chimera_context")
      expect(ids).toContain("chimera_audit_recent")
      expect(ids).toContain("chimera_audit")
      expect(ids).toContain("chimera_oracle_recent")
      expect(ids).toContain("chimera_oracle_get")
      expect(ids).toContain("chimera_obligations_list")
      expect(ids).toContain("chimera_obligations_sync")
      expect(ids).toContain("chimera_obligation_claim")
      expect(ids).toContain("chimera_obligation_resolve")
      expect(ids).toContain("chimera_obligation_ignore")
      expect(ids).toContain("workbrief")
      expect(ids).toContain("browser_open")
      expect(ids).toContain("browser_snapshot")
      expect(ids).toContain("browser_click")
      expect(ids).toContain("browser_type")
      expect(ids).toContain("browser_screenshot")
      expect(ids).toContain("browser_close")
      expect(ids).toContain("subagent_model_routes")
      expect(ids).toContain("subagent_model_schedule")
      expect(ids).toContain("subagent_model_prefer")
      expect(ids).toContain("subagent_model_suppress")
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads tools from .chimera/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".chimera")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".chimera")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )

  it.instance("registers subagent route and workload schedule discovery", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent: {
          name: "build",
          mode: "primary",
          permission: [
            { permission: "task", pattern: "*", action: "allow" },
            { permission: "task_model", pattern: "*", action: "allow" },
          ],
          options: {},
        },
      })
      const routeTool = tools.find((tool) => tool.id === "subagent_model_routes")
      expect(routeTool?.description).toContain("current runtime")
      expect(routeTool?.description).toContain("question")
      const scheduleTool = tools.find((tool) => tool.id === "subagent_model_schedule")
      expect(scheduleTool?.description).toContain("current cost-aware subagent model recommendations")
      expect(scheduleTool?.description).toContain("read-only")
      const preferTool = tools.find((tool) => tool.id === "subagent_model_prefer")
      const suppressTool = tools.find((tool) => tool.id === "subagent_model_suppress")
      expect(preferTool?.description).toContain("ONLY")
      expect(preferTool?.description).toContain("explicitly")
      expect(suppressTool?.description).toContain("ONLY")
      expect(suppressTool?.description).toContain("explicitly")
      const descriptions = tools
        .filter((tool) => tool.id === "task" || tool.id === "chimera_swarm")
        .map((tool) => tool.description)
        .join("\n")
      expect(descriptions).toContain("exact provider/model route")
      expect(descriptions).toContain("subagent_model_routes")
      expect(descriptions).toContain("## Subagent Model Scheduling")
      expect(descriptions).toContain("No model selector + workload => scheduler picks")
      // opencode/gpt-5-nano is the test provider fixture the scheduler now climbs to; keep guarding real provider routes.
      expect(descriptions.replace(/opencode\/gpt-5-nano/g, "")).not.toMatch(
        /deepseek\/deepseek-v4-flash|gpt-\d|anthropic\/|openai\//i,
      )
    }),
  )

  it.instance("hides preference mutations from subagent-mode registry views", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent: {
          name: "general",
          mode: "subagent",
          permission: [
            { permission: "subagent_model_prefer", pattern: "*", action: "allow" },
            { permission: "subagent_model_suppress", pattern: "*", action: "allow" },
          ],
          options: {},
        },
      })
      const ids = tools.map((tool) => tool.id)
      expect(ids).toContain("subagent_model_routes")
      expect(ids).not.toContain("subagent_model_prefer")
      expect(ids).not.toContain("subagent_model_suppress")
    }),
  )

  it.instance("registers unified websearch for non-OpenAI models", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.opencode,
        modelID: ModelID.make("kimi-k2"),
        agent: { name: "build", mode: "primary", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} },
      })

      expect(tools.map((tool) => tool.id)).toContain(WebSearchTool.id)
    }),
  )

  it.instance("does not register unified websearch for OpenAI hosted search models", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.openai,
        modelID: ModelID.make("gpt-5.2"),
        agent: { name: "build", mode: "primary", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} },
      })

      expect(tools.map((tool) => tool.id)).not.toContain(WebSearchTool.id)
    }),
  )

  it.instance("does not register unified websearch for Codex hosted search models", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("codex"),
        modelID: ModelID.make("gpt-5.2-codex"),
        agent: { name: "build", mode: "primary", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} },
      })

      expect(tools.map((tool) => tool.id)).not.toContain(WebSearchTool.id)
    }),
  )

  it.instance("routes GPT models to Hashline edit tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.openai,
        modelID: ModelID.make("openai/gpt-5.5"),
        agent: { name: "build", mode: "primary", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} },
      })
      const ids = tools.map((tool) => tool.id)

      expect(ids).toContain(EditTool.id)
      expect(ids).toContain(WriteTool.id)
      expect(ids).not.toContain(ApplyPatchTool.id)
    }),
  )

  it.instance("registers unified websearch for third-party models", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("deepseek"),
        modelID: ModelID.make("deepseek-chat"),
        agent: { name: "build", mode: "primary", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} },
      })

      expect(tools.map((tool) => tool.id)).toContain(WebSearchTool.id)
    }),
  )
})
