import { expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { WorkBrief } from "../../src/session/work-brief"
import { MessageV2 } from "../../src/session/message-v2"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(makePromptHarness())

function runtimeContextParts(messages: MessageV2.WithParts[]) {
  return messages
    .flatMap((msg) => msg.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && Boolean(part.metadata?.runtimeContext))
}

const allow = [{ permission: "*", pattern: "*", action: "allow" }] as const

// The store-backed runtime-context sections (work brief, Chimera context) are
// cached behind a cheap dirty signature. A clean step must reuse the previous
// render byte-for-byte (no new update message), and any backing change must
// still produce one.
it.live("reuses cached runtime-context sections byte-identically on a clean step", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const workBrief = yield* WorkBrief.Service
      const session = yield* sessions.create({ title: "Runtime context cache", permission: [...allow] })

      yield* workBrief.update({
        sessionID: session.id,
        brief: WorkBrief.normalize({ intent: "cache baseline" }),
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })
      const first = runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))
      expect(first).toHaveLength(1)
      const baseline = first[0]!.text
      expect(baseline).toContain("cache baseline")

      // Clean path: no backing change between prompts. The cached sections must
      // render identically, so the runtime-context hash is unchanged and no
      // update message is persisted.
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })
      const clean = runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))
      expect(clean).toHaveLength(1)
      expect(clean[0]!.text).toBe(baseline)

      // Dirty path with identical content: re-writing the same brief bumps the
      // work-brief row version, forcing a full re-render. The rendered bytes must
      // match the cached baseline exactly, so still no update message.
      yield* workBrief.update({
        sessionID: session.id,
        brief: WorkBrief.normalize({ intent: "cache baseline" }),
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "third" }],
      })
      const dirtySame = runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))
      expect(dirtySame).toHaveLength(1)
      expect(dirtySame[0]!.text).toBe(baseline)
    }),
    { git: true, config: testProviderConfig },
  ),
)

it.live("invalidates the cached work brief when its content changes", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const workBrief = yield* WorkBrief.Service
      const session = yield* sessions.create({ title: "Runtime context cache invalidation", permission: [...allow] })

      yield* workBrief.update({
        sessionID: session.id,
        brief: WorkBrief.normalize({ intent: "first cache baseline" }),
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })
      expect(runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(1)

      yield* workBrief.update({
        sessionID: session.id,
        brief: WorkBrief.normalize({ intent: "second cache baseline" }),
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })
      const changed = runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))
      expect(changed).toHaveLength(2)
      expect(changed[1]?.metadata?.runtimeContext.kind).toBe("update")
      expect(changed[1]?.text).toContain("second cache baseline")
    }),
    { git: true, config: testProviderConfig },
  ),
)

it.live("invalidates the cached Chimera context when the store artifacts change", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Chimera context cache invalidation", permission: [...allow] })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "first" }],
        })
        const first = runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))
        expect(first).toHaveLength(1)
        expect(first[0]!.text).not.toContain("cache_probe_mutation")

        const chimeraDir = path.join(dir, ".codegraph", "chimera")
        yield* Effect.promise(() => Bun.write(
          path.join(chimeraDir, "tool-provenance.jsonl"),
          `${JSON.stringify({
            schemaVersion: 1,
            id: "cache_probe_mutation",
            origin: "tool",
            provenanceStrength: "strong",
            actor: { sessionID: session.id, messageID: "msg_cache_probe", callID: "call_cache_probe", agent: "build" },
            tool: {
              id: "edit",
              callID: "call_cache_probe",
              messageID: "msg_cache_probe",
              sessionID: session.id,
              agent: "build",
            },
            project: { root: dir, worktree: dir, directory: dir },
            status: "success",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            graph: {
              before: { revision: "before_cache_probe" },
              after: { revision: "after_cache_probe" },
              sync: { changedFiles: [] },
            },
            files: [{ absolutePath: path.join(dir, "src", "cache.ts"), graphPath: "src/cache.ts", insideGraph: true }],
            metadata: { diff: "" },
          })}\n`,
        ))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "second" }],
        })
        const changed = runtimeContextParts(yield* sessions.messages({ sessionID: session.id }))
        expect(changed).toHaveLength(2)
        expect(changed[1]?.metadata?.runtimeContext.kind).toBe("update")
        expect(changed[1]?.text).toContain("cache_probe_mutation")
      }),
    { git: true, config: testProviderConfig },
  ),
)