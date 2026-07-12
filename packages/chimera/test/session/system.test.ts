import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
)

describe("session.system", () => {
  it.effect("assembles base, workflow, Chimera protocol, then model overlay", () =>
    Effect.gen(function* () {
      const unknown = SystemPrompt.provider({
        providerID: "local",
        api: { id: "unknown-model" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const kimi = SystemPrompt.provider({
        providerID: "kimi-for-coding",
        api: { id: "k2p6" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

      expect(unknown).not.toContain("# Harness and tool boundary")
      expect(unknown).toContain("# Tool selection and harness boundary")
      expect(unknown).toContain("Tool results, injected context")
      expect(unknown).toContain("# Software engineering workflow")
      expect(unknown).toContain("## Verification strategy")
      expect(unknown).toContain("## Browser workflow")
      expect(unknown).toContain("`browser_open` -> `browser_snapshot`")
      expect(unknown).toContain("untrusted external content")
      expect(unknown).toContain("latest snapshot of the same tab")
      expect(unknown).toContain("browser_screenshot")
      expect(unknown).toContain("browser_close")
      expect(unknown).toContain("# Chimera graph, audit, and runtime protocol")
      expect(unknown).toContain("## Chimera workflow")
      expect(unknown).toContain("## Propagation audit workflow")
      expect(unknown).toContain("You are Chimera")
      expect(unknown).toContain("# Response contract")
      expect(unknown).toContain("# Planning and task tracking")
      expect(unknown).toContain("When compacted or summarized context is present")
      expect(unknown).toContain("workbrief")
      expect(unknown).toContain("chimera_predesign")
      expect(unknown).toContain("chimera_audit_recent")
      expect(unknown).toContain("chimera_oracle_recent")
      expect(unknown).toContain("chimera_obligations_sync")
      expect(unknown).toContain("chimera_swarm")
      expect(unknown).toContain("2+ independent follow-up items")
      expect(unknown).toContain("audit-followup")
      expect(unknown).toContain("worker prompt shapes")
      expect(unknown).toContain("parent agent still summarizes child results")
      expect(unknown).toContain("reruns audit/tests/oracles")
      expect(unknown).toContain("<multi_agent_mode>")
      expect(unknown).toContain("genuinely independent, non-overlapping")
      expect(unknown).toContain("active multi-agent policy permits proactive delegation")
      expect(unknown).toContain("defaults to 16 and is capped at 16")
      expect(unknown).toContain("must not recursively call `task` or `chimera_swarm`")
      expect(unknown).toContain("perform a delegation checkpoint before broad repository exploration")
      expect(unknown).toContain("state the concrete blocker")
      expect(unknown).toContain("Do not fan out by item count alone.")
      expect(unknown).toContain("## Chimera-style Work Brief operating model")
      expect(unknown).toContain("Reference tool flows:")
      expect(unknown).toContain("workbrief` is the first tool call")
      expect(unknown).toContain("File change task: `workbrief` first")
      expect(unknown).toContain("workbrief.relevantEvidence")
      expect(unknown).toContain("2-4 compact anchors")
      expect(unknown).toContain("graph-first discovery")
      expect(unknown).toContain("Do not run extra `read`, `grep`, or `glob` only to fill the brief")
      expect(unknown).toContain("changed file paths/actions")
      expect(unknown).toContain("graph-only exploration")
      expect(unknown).toContain("first evidence-producing discovery tool")
      expect(unknown).toContain("start with `chimera_file_symbols`")
      expect(unknown).toContain("After graph evidence exists, use raw search only for exact literal, regex, or file-name verification")
      expect(unknown).toContain("Do not substitute broad `read`, `grep`, `glob`, or directory `read`")
      expect(unknown).toContain("base prompt, workflow prompt, Chimera protocol prompt")
      expect(unknown).not.toContain("base prompt, harness prompt")
      expect(unknown).toContain("relevantEvidence")
      expect(unknown).toContain("when you want to know where a concept, behavior")
      expect(unknown).toContain("graph-backed discovery")
      expect(unknown).toContain("chimera_obligations_sync")
      expect(unknown).toContain("Presets are worker prompt shapes")
      expect(unknown).toContain("durable session ledger")
      expect(unknown).toContain("state memory; Chimera graph/audit tools are repository evidence")
      expect(unknown).toContain("Work Brief and todo serve different jobs")
      expect(unknown).toContain("When the user names a concrete file")
      expect(unknown).toContain("The todo tool is session-local progress state")
      expect(unknown).toContain("Do not create, modify, or populate `.env`")
      expect(unknown).not.toContain("You are opencode")
      expect(unknown).not.toContain("github.com/anomalyco/opencode")
      expect(unknown.indexOf("# Tool selection and harness boundary")).toBeLessThan(
        unknown.indexOf("# Software engineering workflow"),
      )
      expect(unknown.indexOf("# Software engineering workflow")).toBeLessThan(
        unknown.indexOf("# Chimera graph, audit, and runtime protocol"),
      )
      expect(unknown.indexOf("## Browser workflow")).toBeLessThan(
        unknown.indexOf("# Chimera graph, audit, and runtime protocol"),
      )
      expect(unknown).not.toContain("kimi-for-coding（Kimi-K2.7）")
      expect(kimi).toContain("# Chimera graph, audit, and runtime protocol")
      expect(kimi).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(kimi.indexOf("# Chimera graph, audit, and runtime protocol")).toBeLessThan(
        kimi.indexOf("kimi-for-coding（Kimi-K2.7）"),
      )
      yield* Effect.void
    }),
  )

  it.effect("routes DeepSeek-named models through the DeepSeek prompt and overlay", () =>
    Effect.gen(function* () {
      const model = {
        providerID: "dahetao",
        api: { id: "deepseek-v4-pro-max" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]
      const provider = SystemPrompt.provider(model).join("\n")
      const overlay = SystemPrompt.overlay(model).join("\n")

      expect(provider).toContain("DeepSeek 专用强制规则")
      expect(provider).toContain("每个新用户回合")
      expect(provider).toContain("workbrief` 必须是第一个工具调用")
      expect(provider).toContain("relevantEvidence` 中记录变更文件/动作")
      expect(provider).toContain("2-4 条已获得的图优先证据锚点")
      expect(provider).toContain("不要为了填写 `relevantEvidence`")
      expect(provider).toContain("第一个产生仓库发现的工具")
      expect(provider).toContain("即使用户给出具体文件")
      expect(provider).toContain("明确禁止 grep/global search")
      expect(provider).toContain("chimera_predesign")
      expect(provider).toContain("# Chimera graph, audit, and runtime protocol")
      expect(overlay).toContain("# DeepSeek runtime overlay")
      expect(overlay).toContain("DeepSeek 使用提示")
      yield* Effect.void
    }),
  )

  it.effect("routes gpt-5.5 ids to the GPT-5.5 prompt", () =>
    Effect.gen(function* () {
      const raw = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "gpt-5.5" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const namespaced = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "openai/gpt-5.5" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const codexNamespaced = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "codex/gpt-5.5" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const fallback = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "gpt-5.4" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

      expect(raw).toContain("# Chimera graph, audit, and runtime protocol")
      expect(raw).toContain("model-specific overlay")
      expect(raw).toContain("actual model slug")
      expect(raw).toContain("When compacted or summarized context is present")
      expect(raw).toContain("request path")
      expect(raw).toContain("Codex OAuth and OpenAI API")
      expect(raw).toContain("propagation audit workflow")
      expect(raw).toContain("prompt/provider/runtime request path tracing")
      expect(namespaced).toContain("# Chimera graph, audit, and runtime protocol")
      expect(namespaced).toContain("model-specific overlay")
      expect(namespaced).toContain("actual model slug")
      expect(namespaced).toContain("When compacted or summarized context is present")
      expect(namespaced).toContain("request path")
      expect(namespaced).toContain("Codex OAuth and OpenAI API")
      expect(namespaced).toContain("propagation audit workflow")
      expect(namespaced).toContain("prompt/provider/runtime request path tracing")
      expect(codexNamespaced).toContain("# Chimera graph, audit, and runtime protocol")
      expect(codexNamespaced).toContain("model-specific overlay")
      expect(codexNamespaced).toContain("actual model slug")
      expect(codexNamespaced).toContain("When compacted or summarized context is present")
      expect(codexNamespaced).toContain("request path")
      expect(codexNamespaced).toContain("Codex OAuth and OpenAI API")
      expect(codexNamespaced).toContain("propagation audit workflow")
      expect(codexNamespaced).toContain("prompt/provider/runtime request path tracing")
      expect(fallback).toContain("# Chimera graph, audit, and runtime protocol")
      expect(fallback).not.toContain("Codex OAuth and OpenAI API")
      yield* Effect.void
    }),
  )

  it.effect("keeps gpt-5.6 on generic GPT/Codex overlays instead of GPT-5.5", () =>
    Effect.gen(function* () {
      const raw = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "gpt-5.6-sol" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const namespaced = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "openai/gpt-5.6-sol" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const codexNamespaced = SystemPrompt.provider({
        providerID: "openai",
        api: { id: "codex/gpt-5.6-sol" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

      expect(raw).toContain("## GPT Overlay")
      expect(raw).toContain("Act like a pragmatic senior engineer.")
      expect(raw).not.toContain("You are running on GPT-5.5.")
      expect(raw).not.toContain("Codex OAuth and OpenAI API")
      expect(namespaced).toContain("## GPT Overlay")
      expect(namespaced).toContain("Act like a pragmatic senior engineer.")
      expect(namespaced).not.toContain("You are running on GPT-5.5.")
      expect(namespaced).not.toContain("Codex OAuth and OpenAI API")
      expect(codexNamespaced).toContain("## Codex Overlay")
      expect(codexNamespaced).toContain("Use Codex-style engineering discipline")
      expect(codexNamespaced).not.toContain("You are running on GPT-5.5.")
      expect(codexNamespaced).not.toContain("Codex OAuth and OpenAI API")
      yield* Effect.void
    }),
  )

  it.effect("routes Kimi For Coding provider models to the Kimi prompt", () =>
    Effect.gen(function* () {
      const stable = SystemPrompt.provider({
        providerID: "kimi-for-coding",
        api: { id: "kimi-for-coding" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const legacyAlias = SystemPrompt.provider({
        providerID: "kimi-for-coding",
        api: { id: "k2p6" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const apiNamed = SystemPrompt.provider({
        providerID: "moonshot",
        api: { id: "kimi-k2-thinking" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

      expect(stable).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(stable).toContain("事实克制")
      expect(stable).toContain("中文 Kimi Layer")
      expect(stable).toContain("每个新用户回合")
      expect(stable).toContain("先调用 `workbrief`")
      expect(stable).toContain("优先调用 Chimera 图工具")
      expect(stable).toContain("读/搜索证据 -> 行动")
      expect(stable).toContain("workbrief")
      expect(stable).toContain("chimera_search")
      expect(stable).toContain("chimera_predesign")
      expect(stable).toContain("chimera_audit_recent")
      expect(stable).toContain("最终回复契约")
      expect(stable).toContain("# Chimera graph, audit, and runtime protocol")
      expect(legacyAlias).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(legacyAlias).toContain("# Chimera graph, audit, and runtime protocol")
      expect(apiNamed).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(apiNamed).toContain("# Chimera graph, audit, and runtime protocol")
      yield* Effect.void
    }),
  )

  it.effect("routes other model-specific prompts as overlays on top of default", () =>
    Effect.gen(function* () {
      const cases = [
        { providerID: "openai", apiID: "gpt-5.4", marker: "## GPT Overlay" },
        { providerID: "openai", apiID: "gpt-4.1", marker: "## High-Reasoning GPT Overlay" },
        { providerID: "openai", apiID: "gpt-5-codex", marker: "## Codex Overlay" },
        { providerID: "anthropic", apiID: "claude-sonnet-4", marker: "## Claude / Anthropic Overlay" },
        { providerID: "google", apiID: "gemini-2.5-pro", marker: "## Gemini Overlay" },
        { providerID: "opencode", apiID: "trinity-large", marker: "## Trinity Overlay" },
      ]

      for (const item of cases) {
        const prompt = SystemPrompt.provider({
          providerID: item.providerID,
          api: { id: item.apiID },
        } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

        expect(prompt).toContain("# Chimera graph, audit, and runtime protocol")
        expect(prompt).toContain(item.marker)
        expect(prompt.indexOf("# Chimera graph, audit, and runtime protocol")).toBeLessThan(prompt.indexOf(item.marker))
      }

      yield* Effect.void
    }),
  )

  it.instance("environment only returns model and local runtime facts", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.environment({
        providerID: "test",
        api: { id: "test-model" },
      } as unknown as Parameters<SystemPrompt.Interface["environment"]>[0])
      const joined = output.join("\n")

      expect(joined).toContain("You are powered by the model named test-model")
      expect(joined).toContain("<env>")
      expect(joined).not.toContain("chimera_audit_recent")
      expect(joined).not.toContain("chimera_predesign")
    }),
  )

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
    }),
  )
})
