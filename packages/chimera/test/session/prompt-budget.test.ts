import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"

// Prompt budget baseline (L1 of the prompt-optimization bench). These ceilings
// are the recorded byte sizes of the current assembly; any increase is a
// deliberate decision and must raise (and re-record) the budget here. The
// optimization phases lower them as layers shrink.
//
// The skeleton mirrors LLM.systemSegments send order for a primary agent with
// the full capability tool set (chimera_* + workbrief + browser_open) and no
// agent.prompt override: providerSegments + overlaySegments +
// capabilitySegments + ultraVariantSegments, joined with "\n" exactly like
// src/session/llm.ts:231. input/system/* (env, instructions, mcp, skills) is
// runtime state and intentionally out of scope.

const BASELINE = {
  generic: 25332,
  deepseek: 27972,
  deepseekUltra: 31057,
  kimi: 27349,
  gpt55: 30042,
  claude: 29452,
  gemini: 26690,
} as const

// Per-tool description budgets for the top offenders; the total budget below
// covers every other tool file. Budgets are byte lengths of the .txt source,
// which for shell.txt is the pre-render template (still a faithful growth
// signal for the rendered description).
const TOOL_BUDGETS = {
  "todowrite.txt": 9183,
  "task.txt": 7000,
  "swarm.txt": 6894,
  "workbrief.txt": 6546,
  "shell/shell.txt": 6287,
} as const

const TOOL_TOTAL_BUDGET = 80974

const CAPABILITY_TOOLS = { chimera_search: {}, workbrief: {}, browser_open: {}, read: {}, bash: {} }

function model(providerID: string, id: string) {
  return { providerID, api: { id } } as unknown as Provider.Model
}

function skeleton(providerID: string, id: string, variant?: string) {
  const m = model(providerID, id)
  return [
    ...SystemPrompt.providerSegments(m),
    ...SystemPrompt.overlaySegments(m),
    ...SystemPrompt.capabilitySegments(CAPABILITY_TOOLS),
    ...SystemPrompt.ultraVariantSegments(m, variant),
  ]
    .map((segment) => segment.content)
    .join("\n")
}

const toolDir = path.join(import.meta.dir, "../../src/tool")

function toolFiles() {
  return [
    ...readdirSync(toolDir)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => path.join(toolDir, name)),
    path.join(toolDir, "shell/shell.txt"),
  ]
}

describe("session prompt budget", () => {
  test("system prompt skeletons stay within the recorded baseline", () => {
    expect(skeleton("test", "qwen3.8-flash").length).toBeLessThanOrEqual(BASELINE.generic)
    expect(skeleton("test", "deepseek-v4.1-flash").length).toBeLessThanOrEqual(BASELINE.deepseek)
    expect(skeleton("test", "deepseek-v4.1-flash", "ultra").length).toBeLessThanOrEqual(BASELINE.deepseekUltra)
    expect(skeleton("openai", "gpt-5.5").length).toBeLessThanOrEqual(BASELINE.gpt55)
    expect(skeleton("anthropic", "claude-sonnet-4").length).toBeLessThanOrEqual(BASELINE.claude)
    expect(skeleton("google", "gemini-2.5-pro").length).toBeLessThanOrEqual(BASELINE.gemini)
  })

  test("tool description total stays within the recorded baseline", () => {
    const bytes = toolFiles().reduce((sum, file) => sum + readFileSync(file, "utf8").length, 0)
    expect(bytes).toBeLessThanOrEqual(TOOL_TOTAL_BUDGET)
  })

  test("top tool descriptions stay within per-tool budgets", () => {
    for (const [name, budget] of Object.entries(TOOL_BUDGETS)) {
      expect(readFileSync(path.join(toolDir, name), "utf8").length).toBeLessThanOrEqual(budget)
    }
  })
})
