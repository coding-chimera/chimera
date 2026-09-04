import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Bus } from "@/bus"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { ContextEpoch } from "@/session/context-epoch"
import { ContextSnapshotDecodeError } from "@/session/error"
import { LLM } from "@/session/llm"
import { SessionID } from "@/session/schema"
import { SessionContextEpochTable, SessionTable } from "@/session/session.sql"
import { SessionSystemContext } from "@/session/system-context"
import { SystemPrompt } from "@/session/system"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

type AssemblyInput = {
  model: Parameters<typeof SystemPrompt.provider>[0]
  agentPrompt?: string
  multiAgent?: string
  small?: boolean
  parentSessionID?: string
  variant?: string
  system: string[]
  userSystem?: string
}

// The exact legacy assembly expression that systemSegments replaces.
function legacyAssembly(input: AssemblyInput) {
  return [
    ...(input.agentPrompt ? [input.agentPrompt] : SystemPrompt.provider(input.model)),
    ...SystemPrompt.overlay(input.model),
    ...(input.multiAgent ? [input.multiAgent] : []),
    ...(!input.small && !input.parentSessionID ? SystemPrompt.ultraVariant(input.model, input.variant) : []),
    ...input.system,
    ...(input.userSystem ? [input.userSystem] : []),
  ]
    .filter((x) => x)
    .join("\n")
}

function segments(input: AssemblyInput) {
  return LLM.systemSegments(
    {
      model: input.model,
      agent: { prompt: input.agentPrompt },
      small: input.small,
      parentSessionID: input.parentSessionID,
      system: input.system,
      user: { system: input.userSystem },
    } as unknown as Parameters<typeof LLM.systemSegments>[0],
    input.multiAgent,
    input.variant,
  )
}

const deepseek = { providerID: "dahetao", api: { id: "deepseek-v4-pro-max" } } as AssemblyInput["model"]
const unknownModel = { providerID: "local", api: { id: "unknown-model" } } as AssemblyInput["model"]
const gpt = { providerID: "openai", api: { id: "gpt-5.4" } } as AssemblyInput["model"]

describe("system context flag off: assembly byte-identity", () => {
  const cases: AssemblyInput[] = [
    // unknown model, no extras
    { model: unknownModel, system: [] },
    // deepseek: specialization + overlay + multi-agent + ultra + custom system + user system
    {
      model: deepseek,
      multiAgent: ["<multi_agent_mode>", "Proactive multi-agent delegation is active.", "</multi_agent_mode>"].join("\n"),
      variant: "ultra",
      system: ["extra one", "", "extra two"],
      userSystem: "per-user note",
    },
    // agent prompt replaces the provider layers
    { model: gpt, agentPrompt: "You are a custom agent.", system: ["injected"] },
    // small child session: ultra layers skipped even when variant says ultra
    { model: deepseek, small: true, parentSessionID: "ses_parent", variant: "ultra", system: ["child extra"] },
    // non-ultra variant on a model with no overlay
    { model: gpt, variant: "max", system: [], userSystem: "user extras" },
  ]

  for (const [index, input] of cases.entries()) {
    test(`case ${index}: segment assembly is byte-identical to the legacy join`, () => {
      const assembled = segments(input)
        .map((segment) => segment.content)
        .join("\n")
      expect(assembled).toBe(legacyAssembly(input))
    })
  }

  test("segment keys are valid SystemContext keys and carry attribution", () => {
    const assembled = segments(cases[1])
    for (const segment of assembled) {
      expect(() => SystemContext.Key.make(segment.key)).not.toThrow()
    }
    expect(assembled.map((segment) => segment.key)).toEqual([
      "core/default",
      "core/workflow",
      "core/chimera",
      "model/deepseek",
      "overlay/deepseek",
      "policy/multi-agent",
      "variant/ultra",
      "variant/ultra-deepseek",
      "input/system/0",
      // input/system/1 is dropped because its content is empty
      "input/system/2",
      "user/system/0",
    ])
  })
})

describe("system context flag on: epoch behavior", () => {
  const it = testEffect(Layer.mergeAll(ContextEpoch.defaultLayer))

  let projectSeq = 0

  function seedSession(sessionID: SessionID) {
    const projectID = ProjectID.make(`proj_sysctx${String(projectSeq++).padStart(8, "0")}`)
    Database.transaction((db) => {
      db.insert(ProjectTable)
        .values({ id: projectID, worktree: "/tmp/system-context", sandboxes: [] })
        .run()
      db.insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "system-context",
          directory: "/tmp/system-context",
          title: "System Context Test",
          version: "test",
        })
        .run()
    })
  }

  function epochRow(sessionID: SessionID) {
    return Database.use((db) =>
      db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, sessionID)).get(),
    )
  }

  // Bus publishing happens in a post-commit effect; give it a macro-task.
  const settle = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

  function captureContextUpdated() {
    const types: string[] = []
    const dispose = Bus.subscribeAll((event) => {
      if (String(event.type) === "session.next.context.updated") types.push(event.type)
    })
    return { types, dispose }
  }

  const baseSegments = [
    { key: "core/default", content: "base layer" },
    { key: "core/chimera", content: "chimera layer" },
    { key: "input/system/0", content: "extra instruction" },
  ]

  it.instance("first turn stores the default-path baseline", () =>
    Effect.gen(function* () {
      const epoch = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const prepared = yield* SessionSystemContext.prepare(epoch, sessionID, baseSegments)
      if (Option.isNone(prepared)) throw new Error("expected the epoch to be prepared")
      // The stored baseline is exactly the default-path join of the segments.
      const defaultJoin = baseSegments.map((segment) => segment.content).join("\n")
      expect(prepared.value.baseline).toBe(defaultJoin)
      expect(prepared.value.delta).toBeUndefined()
      const row = epochRow(sessionID)
      expect(row?.baseline).toBe(defaultJoin)
      expect(row?.snapshot).toEqual({ "prompt/system": { value: baseSegments } })
    }),
  )

  it.instance("unchanged second turn reuses the baseline without ContextUpdated", () =>
    Effect.gen(function* () {
      const epoch = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const first = yield* SessionSystemContext.prepare(epoch, sessionID, baseSegments)
      if (Option.isNone(first)) throw new Error("expected the epoch to be prepared")
      const captured = captureContextUpdated()
      try {
        const second = yield* SessionSystemContext.prepare(epoch, sessionID, baseSegments)
        yield* settle()
        if (Option.isNone(second)) throw new Error("expected the epoch to be prepared")
        expect(second.value.baseline).toBe(first.value.baseline)
        expect(second.value.baselineSeq).toBe(first.value.baselineSeq)
        expect(second.value.delta).toBeUndefined()
        expect(captured.types).toEqual([])
      } finally {
        captured.dispose()
      }
    }),
  )

  it.instance("changed source keeps the baseline, injects a delta, and advances the snapshot", () =>
    Effect.gen(function* () {
      const epoch = yield* ContextEpoch.Service
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const first = yield* SessionSystemContext.prepare(epoch, sessionID, baseSegments)
      if (Option.isNone(first)) throw new Error("expected the epoch to be prepared")
      const changed = [...baseSegments.slice(0, 2), { key: "input/system/0", content: "updated instruction" }]
      const captured = captureContextUpdated()
      try {
        const second = yield* SessionSystemContext.prepare(epoch, sessionID, changed)
        yield* settle()
        if (Option.isNone(second)) throw new Error("expected the epoch to be prepared")
        // Baseline stays stable for provider prompt caching...
        expect(second.value.baseline).toBe(first.value.baseline)
        expect(second.value.baselineSeq).toBe(first.value.baselineSeq)
        // ...and the changed segment rides the delta injection.
        expect(second.value.delta).toBe("updated instruction")
        expect(captured.types).toEqual(["session.next.context.updated"])
        const row = epochRow(sessionID)
        expect(row?.baseline).toBe(first.value.baseline)
        expect(row?.snapshot).toEqual({ "prompt/system": { value: changed } })
      } finally {
        captured.dispose()
      }
    }),
  )

  it.instance("prepare failure degrades to the default path without writing", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      seedSession(sessionID)
      const dying: ContextEpoch.Interface = {
        initialize: () => Effect.die(new Error("db unavailable")),
        prepare: () => Effect.die(new Error("db unavailable")),
        reset: () => Effect.void,
      }
      const fromDefect = yield* SessionSystemContext.prepare(dying, sessionID, baseSegments)
      expect(Option.isNone(fromDefect)).toBe(true)
      const failing: ContextEpoch.Interface = {
        initialize: () => Effect.fail(new SystemContext.InitializationBlocked({ keys: [] })),
        prepare: () => Effect.fail(new ContextSnapshotDecodeError({ sessionID, details: "corrupt snapshot" })),
        reset: () => Effect.void,
      }
      const fromFailure = yield* SessionSystemContext.prepare(failing, sessionID, baseSegments)
      expect(Option.isNone(fromFailure)).toBe(true)
      // Fallback must not persist anything for the session.
      expect(epochRow(sessionID)).toBeUndefined()
    }),
  )
})
