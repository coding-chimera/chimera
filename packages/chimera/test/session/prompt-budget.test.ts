import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { ToolSearch } from "../../src/session/tool-search"

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
  generic: 25888,
  deepseek: 28528,
  deepseekUltra: 32467,
  kimi: 27905,
  gpt55: 30900,
  claude: 30008,
  gemini: 27246,
} as const

// Per-tool description budgets for the top offenders; the total budget below
// covers every other tool file. Budgets are byte lengths of the .txt source,
// which for shell.txt is the pre-render template (still a faithful growth
// signal for the rendered description).
const TOOL_BUDGETS = {
  "todowrite.txt": 9183,
  "ast_edit.txt": 10331,
  "task.txt": 7055,
  "swarm.txt": 6951,
  "workbrief.txt": 6546,
  "shell/shell.txt": 7174,
} as const

// 2026-10-08 re-record: the experimental session-goal tools (goal_get.txt,
// goal_create.txt, goal_update.txt = 1888 bytes) raised the floor from 80974.
// 2026-10-08 re-record (phase 2): one auto-continuation sentence in
// goal_create.txt and goal_update.txt raised the floor to 83332, and the
// ultra.txt "Session goals" section raised the deepseekUltra skeleton to 31911.
// 2026-10-08 re-record (progressive tool disclosure): tool_search.txt (1532 B)
// plus one tool_search parenthetical in task.txt/swarm.txt raised the floor to
// 84982. Those 11 deferred tool descriptions (10405 B) are no longer sent by
// default; the exposed-deferred-budget test below pins the trade.
// 2026-10-08 re-record (ast_edit tool): the always-on ast_edit.txt (2916 B)
// raised the floor to 87898.
// 2026-10-08 re-record (ast_edit pattern mode): the pattern-mode section of the
// always-on ast_edit.txt (2916 B -> 5722 B) raised the floor to 90704.
// 2026-10-09 re-record (ast_edit multi-file pattern mode): the `paths` addressing,
// per-language compile semantics, skipped-vs-failed contract, 100-file cap, and
// atomicity rules added to the always-on ast_edit.txt (5722 B -> 7551 B) raised
// the floor to 92533.
// 2026-10-09 re-record (concurrency note): a concurrent session's shell.txt
// growth (6286 -> 7174) is folded into the per-tool budget above so the
// recorded floor matches the live tree; ast_edit rename mode owns the
// ast_edit.txt raise (7551 -> 10331) and the 96202 total floor.
// 2026-10-10 re-record (progressive disclosure phase 2): tool_search.txt was
// rewritten for tail-section reveal semantics (1532 -> 2030 B), which also
// raised the always-on floor (96202 -> 98124; the drift since the last
// recording — concurrent prompt-layer and description growth — is folded in
// the same way the concurrency note above folds shell.txt growth). Six
// deferred tools join the catalog (chimera_obligations_sync/_claim/_resolve/
// _ignore, chimera_oracle_recent/_get = +3949 B withheld), lifting
// DEFERRED_TXT_BUDGET to 14354. Skeletons re-recorded for the chimera.txt /
// gpt-5.5.txt disclosure wording sync.
// 2026-10-10 re-record (/goal resume): the goal_update.txt transition note now
// points blocked-resume users at `/goal resume` and states the budget-priority
// refusal (1036 -> 1282), raising the always-on floor to 98370.
const TOOL_TOTAL_BUDGET = 98370

// The description bytes withheld from the default model-facing set by the
// ToolSearch defer filter: every registered deferred tool's .txt is off the
// wire until revealed, so the per-request description cost drops below the
// full-registration floor recorded above.
const DEFERRED_TXT_BUDGET = 14354
const TOOL_SEARCH_TXT_BUDGET = 2030

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

  test("deferred tool descriptions stay off the default exposed set", () => {
    const deferredBytes = [...ToolSearch.DEFERRED_TOOL_IDS].reduce(
      (sum, id) => sum + readFileSync(path.join(toolDir, `${id}.txt`), "utf8").length,
      0,
    )
    expect(deferredBytes).toBeLessThanOrEqual(DEFERRED_TXT_BUDGET)
    // the discovery tool itself is the only new always-on description
    expect(readFileSync(path.join(toolDir, "tool_search.txt"), "utf8").length).toBeLessThanOrEqual(
      TOOL_SEARCH_TXT_BUDGET,
    )
    // default exposed description bytes: full floor minus the deferred set
    // (withholds ~10.4KB) plus tool_search.txt (~1.5KB)
    expect(deferredBytes).toBeGreaterThan(TOOL_SEARCH_TXT_BUDGET)
    expect(TOOL_TOTAL_BUDGET - deferredBytes).toBeLessThan(TOOL_TOTAL_BUDGET)
  })

  test("top tool descriptions stay within per-tool budgets", () => {
    for (const [name, budget] of Object.entries(TOOL_BUDGETS)) {
      expect(readFileSync(path.join(toolDir, name), "utf8").length).toBeLessThanOrEqual(budget)
    }
  })
})
