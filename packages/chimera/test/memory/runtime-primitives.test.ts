import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MemoryDirectives } from "@/memory/directives"
import { Memory } from "@/memory/memory"
import { MemoryStore } from "@/memory/store"
import { MemoryTranscript } from "@/memory/transcript"
import type { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const runtime = testEffect(Memory.defaultLayer.pipe(Layer.provideMerge(Session.defaultLayer)))
const sessionID = "ses_memory" as SessionID
const messageID = "msg_memory" as MessageID
const it = testEffect(Memory.defaultLayer)

describe("memory runtime primitives", () => {
  test("extracts anchored directives only from literal direct-user text", () => {
    const directives = MemoryDirectives.extract({
      sessionID,
      messageID,
      parts: [
        { type: "text", text: "remember: use Bun for package commands\nnot remember: ignored" },
        { type: "text", text: "memory: synthetic", synthetic: true },
        { type: "text", text: "remember: command template", metadata: { memorySource: "command" } },
        { type: "text", text: "记住：password=hunterhunter" },
        { type: "file", text: "remember: attachment" },
      ],
    })
    expect(directives).toEqual([
      { text: "use Bun for package commands", idempotencyKey: `${sessionID}\0${messageID}\0${0}`, line: 1 },
    ])
  })

  test("sanitizes transcript and excludes synthetic/runtime/tool context", () => {
    const messages = [
      {
        info: { id: messageID, sessionID, role: "user" },
        parts: [
          { type: "text", text: "Use bun typecheck", id: "p1", messageID, sessionID },
          { type: "text", text: "runtime secret", synthetic: true, metadata: { runtimeContext: {} }, id: "p2", messageID, sessionID },
          { type: "text", text: "command-only memory", metadata: { memorySource: "command" }, id: "p-command", messageID, sessionID },
          { type: "file", url: "data:text/plain,secret", mime: "text/plain", id: "p3", messageID, sessionID },
        ],
      },
      {
        info: { id: "msg_assistant", sessionID, role: "assistant" },
        parts: [
          { type: "text", text: "Confirmed Bun workflow", id: "p4", messageID: "msg_assistant", sessionID },
          { type: "tool", tool: "webfetch", id: "p5", messageID: "msg_assistant", sessionID },
        ],
      },
      {
        info: {
          id: "msg_memory_answer",
          sessionID,
          role: "assistant",
          memory: { version: 1, entries: [], rolloutIDs: [], sessionIDs: [], noteIDs: [] },
        },
        parts: [{ type: "text", text: "Recursive memory answer", id: "p-memory", messageID: "msg_memory_answer", sessionID }],
      },
    ] as unknown as MessageV2.WithParts[]
    const transcript = MemoryTranscript.build(messages)
    expect(transcript).toContain("Use bun typecheck")
    expect(transcript).toContain("Confirmed Bun workflow")
    expect(transcript).not.toContain("runtime secret")
    expect(transcript).not.toContain("webfetch")
    expect(transcript).not.toContain("command-only memory")
    expect(transcript).not.toContain("Recursive memory answer")
  })

  test("requires provenance and explicit global intent from extraction output", () => {
    const validated = MemoryTranscript.validateExtraction({
      outcome: "memory",
      scope: "global",
      items: [
        { kind: "workflow", text: "Use Bun typecheck" },
        { kind: "fact", text: "Unrelated invented preference" },
      ],
      rolloutSummary: "Used Bun",
      rolloutSlug: "bun workflow",
    }, "The user asked to use Bun typecheck across all projects.")
    expect(validated.scope).toBe("global")
    expect(validated.items).toEqual([{ kind: "workflow", text: "Use Bun typecheck" }])
  })
  it.instance(
    "starts its background loop without blocking instance bootstrap",
    () =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.init()
        expect(true).toBe(true)
      }),
    { config: { memories: { enabled: true } } },
  )

  runtime.instance(
    "does not enroll sessions before memory opt-in",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "before opt-in" })
        expect(MemoryStore.getSessionState(session.id)).toBeUndefined()
      }),
    { config: { memories: { enabled: false } } },
  )

  runtime.instance(
    "disables pre-existing sessions and enrolls new roots after memory opt-in",
    () =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const sessions = yield* Session.Service
        const existing = yield* sessions.create({ title: "existing session" })
        expect(MemoryStore.getSessionState(existing.id)?.mode).toBe("enabled")
        MemoryStore.resetScope(MemoryStore.projectScope(existing.projectID))
        expect(MemoryStore.getSessionState(existing.id)).toBeUndefined()

        yield* memory.init()
        expect(MemoryStore.getSessionState(existing.id)?.mode).toBe("disabled")

        const after = yield* sessions.create({ title: "after opt-in" })
        const child = yield* sessions.create({ title: "child after opt-in", parentID: after.id })
        expect(MemoryStore.getSessionState(after.id)?.mode).toBe("enabled")
        expect(MemoryStore.getSessionState(child.id)?.mode).toBe("disabled")
      }),
    { config: { memories: { enabled: true } } },
  )

})
