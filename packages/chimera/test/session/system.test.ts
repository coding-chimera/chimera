import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { LLM } from "../../src/session/llm"
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
  it.effect("assembles base and workflow, then model overlay", () =>
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
      expect(unknown).toContain("tool results, injected context")
      expect(unknown).toContain("You are Chimera")
      expect(unknown).toContain("# Response contract")
      expect(unknown).toContain("# Planning and task tracking")
      expect(unknown).toContain("# Procedure proportionality")
      expect(unknown).toContain("# Repository evidence")
      expect(unknown).toContain("# Safety and external effects")
      expect(unknown).toContain("# Code editing rules")
      expect(unknown).toContain("# Git rules")
      expect(unknown).toContain("Do not create, modify, or populate `.env`")
      expect(unknown).not.toContain("You are opencode")
      expect(unknown).not.toContain("github.com/anomalyco/opencode")

      expect(unknown).toContain("# Software engineering workflow")
      expect(unknown).toContain("## Verification strategy")
      expect(unknown).toContain("Verification discipline")
      expect(unknown).toContain("## Completion contract")
      expect(unknown).toContain("When compacted context exists, rebuild repository evidence when needed")
      expect(unknown.indexOf("# Tool selection and harness boundary")).toBeLessThan(
        unknown.indexOf("# Software engineering workflow"),
      )

      // Capability layers (chimera/workbrief/browser) are injected per-tool by
      // LLM.systemSegments, never part of provider().
      expect(unknown).not.toContain("# Chimera graph, audit, and runtime protocol")
      expect(unknown).not.toContain("## Tool selection map")
      expect(unknown).not.toContain("# Work Brief")
      expect(unknown).not.toContain("# Browser workflow")
      expect(unknown).not.toContain("kimi-for-coding（Kimi-K2.7）")

      expect(kimi).toContain("# Procedure proportionality")
      expect(kimi).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(kimi).not.toContain("# Chimera graph, audit, and runtime protocol")
      expect(kimi.indexOf("# Software engineering workflow")).toBeLessThan(
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
      expect(provider).toContain("# Procedure proportionality")
      expect(overlay).toContain("# DeepSeek runtime overlay")
      expect(overlay).toContain("DeepSeek 使用提示")
      yield* Effect.void
    }),
  )

  it.effect("routes DeepSeek ultra variant to the generic ultra layer plus the deepseek-ultra layer", () =>
    Effect.gen(function* () {
      const deepseek = {
        providerID: "dahetao",
        api: { id: "deepseek-v4-flash" },
      } as unknown as Parameters<typeof SystemPrompt.ultraVariant>[0]

      expect(SystemPrompt.ultraVariant(deepseek, "ultra").join("\n")).toContain("You are running on the ultra tier")
      expect(SystemPrompt.ultraVariant(deepseek, "ultra").join("\n")).toContain("swarm 派发纪律")
      expect(SystemPrompt.ultraVariant(deepseek, "ultra").join("\n")).toContain("规则 1：探索类任务前 3 步内派发 chimera_swarm")
      expect(SystemPrompt.ultraVariant(deepseek, "ultra").join("\n")).toContain("规则 5：禁止自我豁免")
      expect(SystemPrompt.ultraVariant(deepseek, "max")).toEqual([])
      expect(SystemPrompt.ultraVariant(deepseek, undefined)).toEqual([])

      const kimi = {
        providerID: "kimi-for-coding",
        api: { id: "k3" },
      } as unknown as Parameters<typeof SystemPrompt.ultraVariant>[0]
      expect(SystemPrompt.ultraVariant(kimi, "ultra").join("\n")).toContain("You are running on the ultra tier")
      expect(SystemPrompt.ultraVariant(kimi, "ultra").join("\n")).not.toContain("swarm 派发纪律")
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

      expect(raw).toContain("# Procedure proportionality")
      expect(raw).toContain("model-specific overlay")
      expect(raw).toContain("actual model slug")
      expect(raw).toContain("When compacted context exists, rebuild repository evidence when needed")
      expect(raw).toContain("request path")
      expect(raw).toContain("Codex OAuth and OpenAI API")
      expect(raw).toContain("propagation audit workflow")
      expect(raw).toContain("prompt/provider/runtime request path tracing")
      expect(namespaced).toContain("# Procedure proportionality")
      expect(namespaced).toContain("model-specific overlay")
      expect(namespaced).toContain("actual model slug")
      expect(namespaced).toContain("When compacted context exists, rebuild repository evidence when needed")
      expect(namespaced).toContain("request path")
      expect(namespaced).toContain("Codex OAuth and OpenAI API")
      expect(namespaced).toContain("propagation audit workflow")
      expect(namespaced).toContain("prompt/provider/runtime request path tracing")
      expect(codexNamespaced).toContain("# Procedure proportionality")
      expect(codexNamespaced).toContain("model-specific overlay")
      expect(codexNamespaced).toContain("actual model slug")
      expect(codexNamespaced).toContain("When compacted context exists, rebuild repository evidence when needed")
      expect(codexNamespaced).toContain("request path")
      expect(codexNamespaced).toContain("Codex OAuth and OpenAI API")
      expect(codexNamespaced).toContain("propagation audit workflow")
      expect(codexNamespaced).toContain("prompt/provider/runtime request path tracing")
      expect(fallback).toContain("# Procedure proportionality")
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

  it.effect("routes gpt-6 family ids to the Astra layer", () =>
    Effect.gen(function* () {
      const cases = [
        { providerID: "openai", apiID: "gpt-6" },
        { providerID: "openai", apiID: "gpt-6.0-astra" },
        { providerID: "openai", apiID: "openai/gpt-6" },
        { providerID: "test-relay", apiID: "gpt-6-sol" },
        // Upstream match order: the gpt-6 check precedes the codex check, so
        // a codex-namespaced gpt-6 still lands on the Astra layer.
        { providerID: "openai", apiID: "codex/gpt-6" },
      ]

      for (const item of cases) {
        const prompt = SystemPrompt.provider({
          providerID: item.providerID,
          api: { id: item.apiID },
        } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

        expect(prompt).toContain("powered by Chimera, a coding agent harness")
        expect(prompt).toContain("# Working in codebases")
        expect(prompt).not.toContain("OpenCode")
        expect(prompt).not.toContain("## GPT Overlay")
        expect(prompt).not.toContain("## Codex Overlay")
        // The Astra layer stacks on top of the shared default/workflow prompts.
        expect(prompt).toContain("# Software engineering workflow")
        expect(prompt.indexOf("# Software engineering workflow")).toBeLessThan(
          prompt.indexOf("# Working in codebases"),
        )
        expect(
          SystemPrompt.providerSegments({
            providerID: item.providerID,
            api: { id: item.apiID },
          } as unknown as Parameters<typeof SystemPrompt.provider>[0]).map((segment) => segment.key),
        ).toEqual(["core/default", "core/workflow", "model/gpt-astra"])
      }
      yield* Effect.void
    }),
  )

  it.effect("keeps non-gpt-6 model assembly byte-identical without the Astra layer", () =>
    Effect.gen(function* () {
      // Anchor for the #13 default-invariance requirement: with no gpt-6-family
      // model, no assembled prompt may gain Astra content, and layer attribution
      // stays exactly as before the layer was registered.
      const cases = [
        { providerID: "openai", apiID: "gpt-5.6", key: "model/gpt" },
        { providerID: "openai", apiID: "gpt-5.6-sol", key: "model/gpt" },
        { providerID: "openai", apiID: "gpt-5.6-luna", key: "model/gpt" },
        { providerID: "openai", apiID: "gpt-5.5", key: "model/gpt-5.5" },
        { providerID: "openai", apiID: "gpt-5.4", key: "model/gpt" },
        { providerID: "openai", apiID: "gpt-5-codex", key: "model/codex" },
        { providerID: "openai", apiID: "gpt-4.1", key: "model/gpt-4" },
        { providerID: "openai", apiID: "o3", key: "model/gpt-4" },
        { providerID: "anthropic", apiID: "claude-sonnet-4", key: "model/claude" },
        { providerID: "google", apiID: "gemini-2.5-pro", key: "model/gemini" },
        { providerID: "local", apiID: "unknown-model", key: undefined },
      ]

      for (const item of cases) {
        const prompt = SystemPrompt.provider({
          providerID: item.providerID,
          api: { id: item.apiID },
        } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

        expect(prompt).not.toContain("powered by Chimera, a coding agent harness")
        expect(prompt).not.toContain("# Working in codebases")
        expect(prompt).not.toContain("gpt-astra")
        expect(
          SystemPrompt.providerSegments({
            providerID: item.providerID,
            api: { id: item.apiID },
          } as unknown as Parameters<typeof SystemPrompt.provider>[0]).map((segment) => segment.key),
        ).toEqual(item.key ? ["core/default", "core/workflow", item.key] : ["core/default", "core/workflow"])
      }
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
      expect(stable).toContain("# Procedure proportionality")
      expect(legacyAlias).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(legacyAlias).toContain("# Procedure proportionality")
      expect(apiNamed).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(apiNamed).toContain("# Procedure proportionality")
      yield* Effect.void
    }),
  )

  it.effect("keeps k3-generation Kimi models off the K2.7 layer", () =>
    Effect.gen(function* () {
      const relayed = SystemPrompt.provider({
        providerID: "test-relay",
        api: { id: "kimi-k3" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const providerHosted = SystemPrompt.provider({
        providerID: "kimi-for-coding",
        api: { id: "k3" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const k2 = SystemPrompt.provider({
        providerID: "moonshot",
        api: { id: "kimi-k2.5" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

      expect(relayed).not.toContain("kimi-for-coding（Kimi-K2.7）")
      expect(relayed).not.toContain("中文 Kimi Layer")
      expect(relayed).toContain("# Procedure proportionality")
      expect(providerHosted).not.toContain("kimi-for-coding（Kimi-K2.7）")
      expect(providerHosted).not.toContain("中文 Kimi Layer")
      expect(providerHosted).toContain("# Procedure proportionality")
      expect(k2).toContain("kimi-for-coding（Kimi-K2.7）")
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

        expect(prompt).toContain("# Software engineering workflow")
        expect(prompt).toContain(item.marker)
        expect(prompt.indexOf("# Software engineering workflow")).toBeLessThan(prompt.indexOf(item.marker))
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

  it.effect("skills output is a sorted name-only index and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)
      expect(output).toContain("<available_skills>")

      const alpha = output.indexOf("- alpha-skill")
      const middle = output.indexOf("- middle-skill")
      const zeta = output.indexOf("- zeta-skill")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("Alpha skill.")
      expect(output).not.toContain("SKILL.md")
      expect(output).not.toContain("# alpha-skill")
    }),
  )
})

describe("session.system capability segments", () => {
  const capabilityTools = { workbrief: {}, browser_open: {}, chimera_search: {}, write: {} }

  test("capability keys are present exactly when their gate tool is present", () => {
    expect(SystemPrompt.capabilitySegments(capabilityTools).map((segment) => segment.key)).toEqual([
      "core/chimera",
      "core/workbrief",
      "core/browser",
    ])
    expect(SystemPrompt.capabilitySegments({ workbrief: {} }).map((segment) => segment.key)).toEqual([
      "core/workbrief",
    ])
    expect(SystemPrompt.capabilitySegments({ browser_open: {} }).map((segment) => segment.key)).toEqual([
      "core/browser",
    ])
    expect(SystemPrompt.capabilitySegments({ chimera_search: {} }).map((segment) => segment.key)).toEqual([
      "core/chimera",
    ])
    expect(SystemPrompt.capabilitySegments({ read: {}, bash: {} })).toEqual([])
    expect(SystemPrompt.capabilitySegments({})).toEqual([])
  })

  test("capability content anchors arrive with the gated segments", () => {
    const joined = SystemPrompt.capabilitySegments(capabilityTools)
      .map((segment) => segment.content)
      .join("\n")
    expect(joined).toContain("# Chimera graph, audit, and runtime protocol")
    expect(joined).toContain("## Tool selection map")
    expect(joined).toContain("# Work Brief")
    expect(joined).toContain("# Browser workflow")
    expect(joined).toContain("<multi_agent_mode>")
    expect(joined).toContain("`browser_open` -> `browser_snapshot`")
  })

  test("systemSegments injects capability segments in send order, gated on the tool set", () => {
    const base = {
      model: { providerID: "local", api: { id: "unknown-model" } },
      agent: {},
      small: false,
      parentSessionID: undefined,
      system: [],
      user: {},
      tools: {},
    } as unknown as Parameters<typeof LLM.systemSegments>[0]
    const keysFor = (tools: Record<string, unknown>, agentPrompt?: string): string[] =>
      LLM.systemSegments(
        {
          ...base,
          tools,
          agent: agentPrompt ? { prompt: agentPrompt } : {},
        } as unknown as Parameters<typeof LLM.systemSegments>[0],
        undefined,
        undefined,
      ).map((segment) => segment.key)

    expect(keysFor(capabilityTools)).toEqual([
      "core/default",
      "core/workflow",
      "core/chimera",
      "core/workbrief",
      "core/browser",
    ])
    expect(keysFor({})).toEqual(["core/default", "core/workflow"])
    expect(keysFor({ read: {}, bash: {} })).toEqual(["core/default", "core/workflow"])
    // An agent.prompt override replaces the entire provider stack, capability
    // segments included, even when the tools are present.
    expect(keysFor(capabilityTools, "You are a custom agent.")).toEqual(["agent/system"])
  })
})