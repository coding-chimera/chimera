import { describe, expect, test } from "bun:test"
import { PromptStats } from "../../src/session/prompt-stats"
import type { Tool } from "ai"
import type { MessageID, SessionID } from "../../src/contracts/session-ids"

describe("prompt stats", () => {
  test("summarizes request blocks without prompt text", () => {
    const stats = PromptStats.summarizePreparedRequest({
      sessionID: "ses_prompt_stats" as SessionID,
      messageID: "msg_prompt_stats" as MessageID,
      step: 1,
      agent: "build",
      providerID: "openai",
      modelID: "gpt-5.5",
      system: ["stable system secret"],
      history: [{ role: "user", content: "old history secret" }],
      runtime: [{ role: "user", content: "<runtime-context>runtime secret</runtime-context>" }],
      memory: [{ role: "user", content: "memory context secret" }],
      current: [{ role: "user", content: "current user secret" }],
      extra: [],
      tools: {},
    })

    const body = JSON.stringify(stats)
    expect(stats.blocks.map((block) => block.kind)).toContain("runtime_context")
    expect(stats.blocks.map((block) => block.kind)).toContain("memory_context")
    expect(stats.fingerprints.memory).toHaveLength(16)
    expect(stats.fingerprints.request).toHaveLength(16)
    expect(body).not.toContain("stable system secret")
    expect(body).not.toContain("old history secret")
    expect(body).not.toContain("runtime secret")
    expect(body).not.toContain("memory context secret")
    expect(body).not.toContain("current user secret")
  })

  test("warns when runtime context leaks into system", () => {
    const stats = PromptStats.summarizePreparedRequest({
      sessionID: "ses_prompt_stats" as SessionID,
      messageID: "msg_prompt_stats" as MessageID,
      step: 1,
      agent: "build",
      providerID: "openai",
      modelID: "gpt-5.5",
      system: ["## Current Work Brief"],
      history: [],
      runtime: [],
      current: [{ role: "user", content: "hello" }],
      extra: [],
      tools: {},
    })

    expect(stats.warnings).toContain("runtime context leaked into system")
  })
  test("produces identical output for identical input", () => {
    const make = () =>
      PromptStats.summarizePreparedRequest({
        sessionID: "ses_prompt_stats" as SessionID,
        messageID: "msg_prompt_stats" as MessageID,
        step: 3,
        agent: "build",
        providerID: "openai",
        modelID: "gpt-5.5",
        system: ["sys"],
        history: [{ role: "user", content: "h" }],
        runtime: [{ role: "user", content: "<runtime-context>r</runtime-context>" }],
        memory: [{ role: "user", content: "m" }],
        current: [{ role: "user", content: "c" }],
        extra: [{ role: "assistant", content: "MAX STEPS" }],
        tools: {},
      })

    const a = make()
    const b = make()
    expect({ ...a, createdAt: 0 }).toEqual({ ...b, createdAt: 0 })
  })

  test("request fingerprint is deterministic and changes with input", () => {
    const make = (history: { role: "user"; content: string }[]) =>
      PromptStats.summarizePreparedRequest({
        sessionID: "ses_prompt_stats" as SessionID,
        messageID: "msg_prompt_stats" as MessageID,
        step: 1,
        agent: "build",
        providerID: "openai",
        modelID: "gpt-5.5",
        system: ["sys"],
        history,
        runtime: [],
        current: [{ role: "user", content: "c" }],
        extra: [],
        tools: {},
      })

    const base = make([{ role: "user", content: "a" }])
    expect(base.fingerprints.request).toBe(make([{ role: "user", content: "a" }]).fingerprints.request)
    expect(base.fingerprints.request).not.toBe(make([{ role: "user", content: "b" }]).fingerprints.request)
  })

  test("warns on oversized runtime and tool blocks", () => {
    const stats = PromptStats.summarizePreparedRequest({
      sessionID: "ses_prompt_stats" as SessionID,
      messageID: "msg_prompt_stats" as MessageID,
      step: 1,
      agent: "build",
      providerID: "openai",
      modelID: "gpt-5.5",
      system: ["sys"],
      history: [],
      runtime: [{ role: "user", content: "x".repeat(17_000) }],
      current: [{ role: "user", content: "c" }],
      extra: [],
      tools: { big: { description: "d".repeat(210_000) } } as unknown as Record<string, Tool>,
    })

    expect(stats.warnings).toContain("runtime context over 16KB")
    expect(stats.warnings).toContain("tool schemas over 200KB")
  })

  test("treats omitted memory like an empty memory array", () => {
    const base = {
      sessionID: "ses_prompt_stats" as SessionID,
      messageID: "msg_prompt_stats" as MessageID,
      step: 1,
      agent: "build",
      providerID: "openai",
      modelID: "gpt-5.5",
      system: ["sys"],
      history: [{ role: "user" as const, content: "h" }],
      runtime: [],
      current: [{ role: "user" as const, content: "c" }],
      extra: [],
      tools: {},
    }

    const omitted = PromptStats.summarizePreparedRequest(base)
    const empty = PromptStats.summarizePreparedRequest({ ...base, memory: [] })
    expect({ ...omitted, createdAt: 0 }).toEqual({ ...empty, createdAt: 0 })
  })
})
