import path from "path"
import fs from "fs/promises"
import { beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MemoryArtifacts } from "@/memory/artifacts"
import { MemoryManagement } from "@/memory/management"
import { MemoryStore } from "@/memory/store"
import { ProjectID } from "@/project/schema"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(MemoryManagement.defaultLayer)

beforeEach(() => {
  Database.Client().$client.exec(`
    DELETE FROM memory_note;
    DELETE FROM memory_stage1_output;
    DELETE FROM memory_job;
    DELETE FROM memory_session_state;
  `)
})

describe("memory management", () => {
  it.instance(
    "keeps scopes isolated, rejects secrets, and queues content changes",
    () =>
      Effect.gen(function* () {
        const memory = yield* MemoryManagement.Service
        const project = yield* memory.create(new MemoryManagement.CreateInput({ text: "  Prefer focused   tests.  " }))
        const global = yield* memory.create(
          new MemoryManagement.CreateInput({ text: "Use stable release channels.", scope: "global" }),
        )

        expect(project.text).toBe("Prefer focused tests.")
        expect((yield* memory.list("project")).map((note) => note.id)).toEqual([project.id])
        expect((yield* memory.list("global")).map((note) => note.id)).toEqual([global.id])
        expect(yield* memory.create(new MemoryManagement.CreateInput({ text: "api_key=abcdefghijklmnop" })).pipe(Effect.flip)).toBeInstanceOf(
          MemoryManagement.BadRequestError,
        )

        const updated = yield* memory.update(project.id, new MemoryManagement.UpdateInput({ text: "Prefer regression tests." }))
        expect(updated.text).toBe("Prefer regression tests.")
        expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(MemoryStore.projectScope((yield* InstanceState.context).project.id)) })).toMatchObject({
          status: "pending",
        })

        expect(yield* memory.forget(project.id)).toEqual({ deleted: true })
        expect(yield* memory.list("project")).toEqual([])
      }),
    { config: { memories: { enabled: true, generate_memories: true } } },
  )

  it.instance(
    "returns the same not-found error for cross-project and missing IDs",
    () =>
      Effect.gen(function* () {
        const memory = yield* MemoryManagement.Service
        const foreign = MemoryStore.createNote({
          scope: MemoryStore.projectScope(ProjectID.make("foreign-project")),
          text: "Foreign note",
          sourceKind: "manual",
        })

        const crossProject = yield* memory.update(foreign.id, new MemoryManagement.UpdateInput({ text: "No access" })).pipe(Effect.flip)
        const missing = yield* memory.update("mem_missing", new MemoryManagement.UpdateInput({ text: "No access" })).pipe(Effect.flip)
        expect(crossProject).toEqual(missing)
        expect(crossProject).toBeInstanceOf(MemoryManagement.NotFoundError)
      }),
    { config: { memories: { enabled: true, generate_memories: true } } },
  )

  it.instance("keeps read, forget, and reset available while generation is disabled", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryManagement.Service
      const ctx = yield* InstanceState.context
      const note = MemoryStore.createNote({
        scope: MemoryStore.projectScope(ctx.project.id),
        text: "Existing note",
        sourceKind: "manual",
      })

      expect((yield* memory.status()).enabled).toBe(false)
      expect((yield* memory.list()).map((item) => item.id)).toEqual([note.id])
      expect(yield* memory.create(new MemoryManagement.CreateInput({ text: "Blocked" })).pipe(Effect.flip)).toBeInstanceOf(
        MemoryManagement.BadRequestError,
      )
      expect(yield* memory.forget(note.id)).toEqual({ deleted: true })
      expect(yield* memory.reset(new MemoryManagement.ResetInput({ scope: "project", confirm: true }))).toMatchObject({
        scope: "project",
      })
    }),
  )

  it.instance(
    "requires reset confirmation and removes generated artifacts",
    () =>
      Effect.gen(function* () {
        const memory = yield* MemoryManagement.Service
        const ctx = yield* InstanceState.context
        const scope = MemoryStore.projectScope(ctx.project.id)
        const root = MemoryArtifacts.root(scope)
        yield* Effect.promise(() => fs.mkdir(root, { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(root, MemoryArtifacts.MEMORY_FILE), "generated"))
        yield* memory.create(new MemoryManagement.CreateInput({ text: "Reset me" }))

        expect(yield* memory.reset({ scope: "project", confirm: false } as never).pipe(Effect.flip)).toBeInstanceOf(
          MemoryManagement.BadRequestError,
        )
        const result = yield* memory.reset(new MemoryManagement.ResetInput({ scope: "project", confirm: true }))
        expect(result.notes).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(path.join(root, MemoryArtifacts.MEMORY_FILE)).exists())).toBe(false)
        expect(yield* memory.list()).toEqual([])
      }),
    { config: { memories: { enabled: true, generate_memories: true } } },
  )

  it.instance(
    "imports legacy notes idempotently and queues rebuild asynchronously",
    () =>
      Effect.gen(function* () {
        const memory = yield* MemoryManagement.Service
        const legacy = {
          schemaVersion: 1,
          notes: [
            {
              id: "legacy-1",
              text: "Imported note",
              scope: "project",
              source: { kind: "manual" },
              time_created: 1_700_000_000_000,
            },
          ],
        } as const

        expect(yield* memory.importLegacy(legacy)).toEqual({ imported: 1, skipped: 0, total: 1 })
        expect(yield* memory.importLegacy(legacy)).toEqual({ imported: 1, skipped: 0, total: 1 })
        const notes = yield* memory.list()
        expect(notes).toHaveLength(1)
        expect(notes[0]).toMatchObject({ sourceKind: "legacy_import", timeCreated: 1_700_000_000_000 })

        expect(yield* memory.rebuild(new MemoryManagement.RebuildInput({ scope: "project" }))).toEqual({
          scope: "project",
          queued: true,
        })
        expect(MemoryStore.listJobs({ kind: "stage2" })).toHaveLength(1)
      }),
    { config: { memories: { enabled: true, generate_memories: true } } },
  )
})
