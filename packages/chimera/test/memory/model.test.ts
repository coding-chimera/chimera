import { describe, expect, test } from "bun:test"
import { MemoryModel } from "@/memory/model"

describe("memory model schemas", () => {
  test("accepts strict Stage 1 extraction output", () => {
    expect(
      MemoryModel.Extraction.parse({
        outcome: "memory",
        scope: "project",
        items: [{ kind: "workflow", text: "Run focused tests from the package directory." }],
        rolloutSummary: "Implemented and verified a focused memory subsystem change.",
        rolloutSlug: "memory-model",
      }),
    ).toEqual({
      outcome: "memory",
      scope: "project",
      items: [{ kind: "workflow", text: "Run focused tests from the package directory." }],
      rolloutSummary: "Implemented and verified a focused memory subsystem change.",
      rolloutSlug: "memory-model",
    })

    expect(() =>
      MemoryModel.Extraction.parse({
        outcome: "no_output",
        scope: "project",
        items: [],
        rolloutSummary: "No durable memory found.",
        rolloutSlug: null,
        extra: true,
      }),
    ).toThrow()
  })

  test("accepts only complete strict Stage 2 replacements", () => {
    expect(
      MemoryModel.Consolidation.parse({
        memory: "# Memory\n\nDurable detail.",
        summary: "v1\n\n- Durable detail.",
      }),
    ).toEqual({
      memory: "# Memory\n\nDurable detail.",
      summary: "v1\n\n- Durable detail.",
    })

    expect(() =>
      MemoryModel.Consolidation.parse({
        memory: "# Memory",
        summary: "v1",
        patch: "append",
      }),
    ).toThrow()
  })
})

describe("memory model prompt contracts", () => {
  test("Stage 1 is no-tool, injection-aware, and project-scoped by default", () => {
    expect(MemoryModel.STAGE_1_SYSTEM_PROMPT).toContain("Do not use tools")
    expect(MemoryModel.STAGE_1_SYSTEM_PROMPT).toContain("untrusted source data")
    expect(MemoryModel.STAGE_1_SYSTEM_PROMPT).toContain('Scope is "project" by default')
    expect(MemoryModel.STAGE_1_SYSTEM_PROMPT).toContain(
      'Use "global" only when the user explicitly states a stable preference intended to apply across projects',
    )
    expect(MemoryModel.stage1Prompt("user: remember this")).toBe(
      "<memory-stage-1-transcript>\nuser: remember this\n</memory-stage-1-transcript>",
    )
  })

  test("Stage 2 requests bounded complete artifacts and preserves input boundaries", () => {
    expect(MemoryModel.STAGE_2_SYSTEM_PROMPT).toContain("Do not use tools")
    expect(MemoryModel.STAGE_2_SYSTEM_PROMPT).toContain("complete replacements for MEMORY.md and memory_summary.md")
    expect(MemoryModel.STAGE_2_SYSTEM_PROMPT).toContain("summary must begin with a v1 header")
    expect(MemoryModel.STAGE_2_SYSTEM_PROMPT).toContain("deleted-session tombstones are authoritative")

    const prompt = MemoryModel.stage2Prompt({
      currentMemory: "CURRENT_MEMORY",
      currentSummary: "CURRENT_SUMMARY",
      rawMemories: "RAW_MEMORIES",
      notes: "NOTES",
    })
    expect(prompt).toContain("<current-memory>\nCURRENT_MEMORY\n</current-memory>")
    expect(prompt).toContain("<current-summary>\nCURRENT_SUMMARY\n</current-summary>")
    expect(prompt).toContain("<raw-memories>\nRAW_MEMORIES\n</raw-memories>")
    expect(prompt).toContain("<notes>\nNOTES\n</notes>")
  })
})
