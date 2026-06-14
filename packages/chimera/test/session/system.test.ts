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
  it.effect("always includes the default prompt before model-specific tuning", () =>
    Effect.gen(function* () {
      const unknown = SystemPrompt.provider({
        providerID: "local",
        api: { id: "unknown-model" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
      const kimi = SystemPrompt.provider({
        providerID: "kimi-for-coding",
        api: { id: "k2p6" },
      } as unknown as Parameters<typeof SystemPrompt.provider>[0]).join("\n")

      expect(unknown).toContain("# Chimera tools")
      expect(unknown).toContain("# Work Brief")
      expect(unknown).toContain("You are Chimera")
      expect(unknown).toContain("Concision applies to visible communication")
      expect(unknown).toContain("After compaction or a synthetic continuation prompt")
      expect(unknown).toContain("workbrief")
      expect(unknown).toContain("chimera_audit_recent")
      expect(unknown).toContain("When the user names a concrete file")
      expect(unknown).toContain("The todo tool tracks the current coding session's step list")
      expect(unknown).not.toContain("You are opencode")
      expect(unknown).not.toContain("github.com/anomalyco/opencode")
      expect(unknown).not.toContain("fewer than 4 lines")
      expect(unknown).not.toContain("kimi-for-coding（Kimi-K2.7）")
      expect(kimi).toContain("# Chimera tools")
      expect(kimi).toContain("# Work Brief")
      expect(kimi).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(kimi.indexOf("# Chimera tools")).toBeLessThan(kimi.indexOf("kimi-for-coding（Kimi-K2.7）"))
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

      expect(raw).toContain("# Chimera tools")
      expect(raw).toContain("lightweight model-specific overlay")
      expect(raw).toContain("actual model slug")
      expect(raw).toContain("When compacted or summarized context is present")
      expect(raw).toContain("After compaction or a synthetic continuation prompt")
      expect(raw).toContain("Codex OAuth and OpenAI API")
      expect(namespaced).toContain("# Chimera tools")
      expect(namespaced).toContain("lightweight model-specific overlay")
      expect(namespaced).toContain("actual model slug")
      expect(namespaced).toContain("When compacted or summarized context is present")
      expect(namespaced).toContain("After compaction or a synthetic continuation prompt")
      expect(namespaced).toContain("Codex OAuth and OpenAI API")
      expect(codexNamespaced).toContain("# Chimera tools")
      expect(codexNamespaced).toContain("lightweight model-specific overlay")
      expect(codexNamespaced).toContain("actual model slug")
      expect(codexNamespaced).toContain("When compacted or summarized context is present")
      expect(codexNamespaced).toContain("After compaction or a synthetic continuation prompt")
      expect(codexNamespaced).toContain("Codex OAuth and OpenAI API")
      expect(fallback).toContain("# Chimera tools")
      expect(fallback).not.toContain("Codex OAuth and OpenAI API")
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
      expect(stable).toContain("# Chimera tools")
      expect(legacyAlias).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(legacyAlias).toContain("# Chimera tools")
      expect(apiNamed).toContain("kimi-for-coding（Kimi-K2.7）")
      expect(apiNamed).toContain("# Chimera tools")
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

        expect(prompt).toContain("# Chimera tools")
        expect(prompt).toContain(item.marker)
        expect(prompt.indexOf("# Chimera tools")).toBeLessThan(prompt.indexOf(item.marker))
      }

      yield* Effect.void
    }),
  )

  it.instance("environment includes Chimera propagation audit guidance", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.environment({
        providerID: "test",
        api: { id: "test-model" },
      } as unknown as Parameters<SystemPrompt.Interface["environment"]>[0])

      expect(output.join("\n")).toContain("chimera_audit")
      expect(output.join("\n")).toContain("chimera_audit_recent")
      expect(output.join("\n")).toContain("chimera_predesign")
      expect(output.join("\n")).toContain("chimera_obligations_sync")
      expect(output.join("\n")).toContain("After any successful code mutation")
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
