import { describe, expect, test } from "bun:test"
import { PromptStats } from "../../src/session/prompt-stats"
import type { MessageID, SessionID } from "../../src/session/schema"

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
})
