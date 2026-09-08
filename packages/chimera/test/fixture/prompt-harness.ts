import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Auth } from "@/auth"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/agent/background-job"
import { BrowserRuntime } from "@/browser/runtime"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { ChimeraPromptContext } from "@/chimera/prompt-context"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { DelegationLimiter } from "@/agent/delegation-limiter"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { MemoryManagement } from "@/memory/management"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "../../src/question"
import { RemoteCompaction } from "../../src/session/remote-compaction"
import { Ripgrep } from "../../src/file/ripgrep"
import { Session } from "@/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "@/session/summary"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { WorkBrief } from "../../src/session/work-brief"
import { TestLLMServer } from "../lib/llm-server"
import type { Config as ConfigInfo } from "@/config/config"

let routingState: ConfigSubagentRouting.State = ConfigSubagentRouting.empty()
const routingLayer = Layer.succeed(
  ConfigSubagentRouting.Service,
  ConfigSubagentRouting.Service.of({
    get: () => Effect.succeed(routingState),
    prefer: () => Effect.die(new Error("unexpected preference mutation")),
    suppress: () => Effect.die(new Error("unexpected suppression mutation")),
    recordDelegation: () => Effect.succeed(routingState),
  }),
)

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

export function testProviderConfig(url: string): Partial<ConfigInfo.Info> {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

// Full SessionPrompt stack bound to the disposable TestLLMServer plus the
// BackgroundJob engine, so real prompt loops, background jobs, and the
// session-addressable injectSynthetic primitive can be exercised together.
export function makePromptHarness() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    routingLayer,
    Auth.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
    SyncEvent.defaultLayer,
    BackgroundJob.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const workBrief = WorkBrief.layer.pipe(Layer.provideMerge(deps))
  const chimeraPromptContext = ChimeraPromptContext.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provideMerge(DelegationLimiter.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(BrowserRuntime.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(MemoryManagement.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(workBrief),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RemoteCompaction.disabledLayer),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(RemoteCompaction.disabledLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provideMerge(workBrief),
      Layer.provideMerge(chimeraPromptContext),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}