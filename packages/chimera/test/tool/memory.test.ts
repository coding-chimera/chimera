import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MemoryArtifacts } from "@/memory/artifacts"
import { MemoryManagement } from "@/memory/management"
import { MemoryStore } from "@/memory/store"
import { Database } from "@/storage/db"
import {
  MemoryForgetTool,
  MemoryListTool,
  MemoryReadTool,
  MemoryRememberTool,
} from "@/tool/memory"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const toolsLayer = Layer.mergeAll(
  MemoryManagement.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)
const it = testEffect(toolsLayer)
const registryIt = testEffect(ToolRegistry.defaultLayer)

beforeEach(() => {
  Database.Client().$client.exec(`
    DELETE FROM memory_note;
    DELETE FROM memory_stage1_output;
    DELETE FROM memory_job;
    DELETE FROM memory_session_state;
  `)
})

function toolCtx() {
  return {
    sessionID: SessionID.make("ses_memory_tool_test"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("memory tools", () => {
  it.instance(
    "remember/list/forget notes through management",
    () =>
      Effect.gen(function* () {
        const remember = yield* MemoryRememberTool
        const list = yield* MemoryListTool
        const forget = yield* MemoryForgetTool
        const rememberDef = yield* remember.init()
        const listDef = yield* list.init()
        const forgetDef = yield* forget.init()
        const ctx = toolCtx()

        const created = yield* rememberDef.execute({ text: "Prefer focused memory tool tests." }, ctx)
        expect(created.output).toContain("Prefer focused memory tool tests.")
        expect(created.metadata.note.scope).toBe("project")

        const listed = yield* listDef.execute({}, ctx)
        expect(listed.output).toContain(created.metadata.note.id)

        const forgotten = yield* forgetDef.execute({ id: created.metadata.note.id }, ctx)
        expect(forgotten.metadata.deleted).toBe(true)
        expect((yield* listDef.execute({}, ctx)).output).toContain("No active project memory notes.")
      }),
    { config: { memories: { enabled: true, generate_memories: true, dedicated_tools: true } } },
  )

  it.instance(
    "reads allowlisted memory artifacts",
    () =>
      Effect.gen(function* () {
        const read = yield* MemoryReadTool
        const readDef = yield* read.init()
        const ctx = toolCtx()
        const project = yield* InstanceState.context
        const scope = MemoryStore.projectScope(project.project.id)
        yield* Effect.promise(() =>
          MemoryArtifacts.commit(scope, {
            memory: `${MemoryArtifacts.HEADER}\n- Prefer memory tools.\n`,
            summary: `${MemoryArtifacts.HEADER}\nPrefer memory tools.\n`,
            raw: "",
          }),
        )

        const result = yield* readDef.execute({ path: "project/memory_summary.md" }, ctx)
        expect(result.output).toContain("Prefer memory tools.")
        expect(result.metadata.path).toBe("project/memory_summary.md")
      }),
    { config: { memories: { enabled: true, dedicated_tools: true } } },
  )

  registryIt.instance(
    "exposes memory tools only when enabled and dedicated_tools are true",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("memory_remember")
        expect(ids).toContain("memory_list")
        expect(ids).toContain("memory_forget")
        expect(ids).toContain("memory_read")
      }),
    { config: { memories: { enabled: true, dedicated_tools: true } } },
  )

  registryIt.instance("hides memory tools when dedicated_tools is off", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("memory_remember")
      expect(ids).not.toContain("memory_list")
      expect(ids).not.toContain("memory_forget")
      expect(ids).not.toContain("memory_read")
    }),
  )
})
