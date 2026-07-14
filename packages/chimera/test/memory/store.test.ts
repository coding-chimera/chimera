import { beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { eq } from "drizzle-orm"
import {
  MemoryJobTable,
  MemoryNoteTable,
  MemorySessionStateTable,
  MemoryStage1OutputTable,
} from "@/memory/memory.sql"
import { MemoryStore } from "@/memory/store"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { Database } from "@/storage/db"

const projectA = ProjectID.make("project-a")
const projectB = ProjectID.make("project-b")
const base = 1_000_000

beforeEach(() => {
  Database.Client().$client.exec(`
    DELETE FROM memory_note;
    DELETE FROM memory_stage1_output;
    DELETE FROM memory_job;
    DELETE FROM memory_session_state;
    DELETE FROM session;
    DELETE FROM project;
  `)
})

function insertProject(id: ProjectID) {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id, worktree: `/${id}`, sandboxes: [], time_created: base, time_updated: base })
      .run(),
  )
}

function insertSession(input: {
  id: SessionID
  projectID?: ProjectID
  updatedAt: number
  parentID?: SessionID
  compacting?: number
}) {
  const projectID = input.projectID ?? projectA
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: input.id,
        project_id: projectID,
        parent_id: input.parentID,
        slug: input.id,
        directory: `/${projectID}`,
        title: input.id,
        version: "test",
        time_created: input.updatedAt - 1,
        time_updated: input.updatedAt,
        time_compacting: input.compacting,
      })
      .run(),
  )
}

describe("memory migration", () => {
  test("creates all memory tables and indexes and records them in the snapshot", async () => {
    const schema = Database.Client().$client
      .query("SELECT type, name FROM sqlite_master WHERE name LIKE 'memory_%' ORDER BY type, name")
      .all() as Array<{ type: string; name: string }>
    expect(schema.filter((item) => item.type === "table").map((item) => item.name)).toEqual([
      "memory_job",
      "memory_note",
      "memory_session_state",
      "memory_stage1_output",
    ])
    expect(schema.filter((item) => item.type === "index").map((item) => item.name)).toEqual([
      "memory_job_kind_status_retry_lease_idx",
      "memory_note_content_checksum_idx",
      "memory_note_scope_project_time_deleted_idx",
      "memory_note_selected_for_stage2_idx",
      "memory_note_source_session_idx",
      "memory_session_state_mode_updated_watermark_idx",
      "memory_stage1_output_project_generated_at_idx",
      "memory_stage1_output_selected_for_stage2_idx",
      "memory_stage1_output_source_updated_at_idx",
    ])

    const snapshot = await Bun.file(
      path.join(import.meta.dir, "../../migration/20260714000000_memory_system/snapshot.json"),
    ).json()
    const tables = snapshot.ddl
      .filter((item: { entityType: string }) => item.entityType === "tables")
      .map((item: { name: string }) => item.name)
    expect(tables).toEqual(
      expect.arrayContaining(["memory_note", "memory_stage1_output", "memory_job", "memory_session_state"]),
    )
    expect(snapshot.prevIds).toEqual(["2e40fe0c-3e5d-4646-97dd-1257e90ecb79"])
    const memoryTables = ["memory_note", "memory_stage1_output", "memory_job", "memory_session_state"]
    for (const table of memoryTables) {
      const actual = Database.Client().$client
        .query(`PRAGMA table_info('${table}')`)
        .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
      const recorded = snapshot.ddl
        .filter((item: { entityType: string; table?: string }) => item.entityType === "columns" && item.table === table)
        .map((item: { name: string; type: string; notNull: boolean; default: number | string | null }) => ({
          name: item.name,
          type: item.type,
          notNull: item.notNull,
          default: item.default,
        }))
      expect(recorded).toEqual(
        actual.map((item) => ({
          name: item.name,
          type: item.type.toLowerCase(),
          notNull: item.notnull === 1,
          default: item.dflt_value === null ? null : Number(item.dflt_value),
        })),
      )
    }
    for (const index of schema.filter((item) => item.type === "index")) {
      const actual = Database.Client().$client
        .query(`PRAGMA index_info('${index.name}')`)
        .all() as Array<{ name: string }>
      const recorded = snapshot.ddl.find(
        (item: { entityType: string; name: string }) => item.entityType === "indexes" && item.name === index.name,
      )
      expect(recorded.columns.map((item: { value: string }) => item.value)).toEqual(actual.map((item) => item.name))
    }
  })
})

describe("session state and candidates", () => {
  test("keeps pollution sticky and watermarks monotonic while copying state", () => {
    const source = SessionID.make("ses_state_source")
    const target = SessionID.make("ses_state_target")
    expect(MemoryStore.ensureSessionState({ sessionID: source, mode: "enabled", watermark: 100, now: 100 })).toMatchObject({
      mode: "enabled",
      created_watermark: 100,
      updated_watermark: 100,
    })
    expect(MemoryStore.ensureSessionState({ sessionID: source, mode: "disabled", watermark: 50, now: 101 })).toMatchObject({
      mode: "enabled",
      created_watermark: 50,
      updated_watermark: 100,
    })
    MemoryStore.markSessionPolluted({ sessionID: source, watermark: 120, reason: "web fetch", now: 120 })
    expect(MemoryStore.setSessionMode({ sessionID: source, mode: "enabled", watermark: 110, now: 121 })).toMatchObject({
      mode: "polluted",
      pollution_reason: "web fetch",
      created_watermark: 50,
      updated_watermark: 120,
    })
    MemoryStore.ensureSessionState({ sessionID: source, watermark: 150, now: 150 })
    expect(MemoryStore.copySessionState({ sourceSessionID: source, targetSessionID: target, now: 151 })).toMatchObject({
      mode: "polluted",
      pollution_reason: "web fetch",
      created_watermark: 50,
      updated_watermark: 150,
    })
  })

  test("filters candidates by project and configurable polluted eligibility", () => {
    insertProject(projectA)
    insertProject(projectB)
    const enabledA = SessionID.make("ses_enabled_a")
    const pollutedA = SessionID.make("ses_polluted_a")
    const enabledB = SessionID.make("ses_enabled_b")
    insertSession({ id: enabledA, updatedAt: base - 200 })
    insertSession({ id: pollutedA, updatedAt: base - 210 })
    insertSession({ id: enabledB, projectID: projectB, updatedAt: base - 220 })
    MemoryStore.ensureSessionState({ sessionID: enabledA, watermark: base - 500 })
    MemoryStore.markSessionPolluted({ sessionID: pollutedA, watermark: base - 500, reason: "browser" })
    MemoryStore.ensureSessionState({ sessionID: enabledB, watermark: base - 500 })

    const query = { projectID: projectA, now: base, idleMs: 100, maxAgeMs: 1_000, limit: 10 }
    expect(MemoryStore.listStage1Candidates(query).map((item) => item.session.id)).toEqual([enabledA])
    expect(
      MemoryStore.listStage1Candidates({ ...query, includePolluted: true }).map((item) => item.session.id),
    ).toEqual([enabledA, pollutedA])
  })
})

describe("memory notes", () => {
  test("upserts deterministically, isolates scope, and enqueues mutations atomically", () => {
    const global = MemoryStore.globalScope()
    const project = MemoryStore.projectScope(projectA)
    const first = MemoryStore.upsertNoteAndEnqueue({
      scope: project,
      idempotencyKey: "directive:session:message",
      text: "first",
      sourceKind: "explicit",
      now: 10,
    })
    const second = MemoryStore.upsertNoteAndEnqueue({
      scope: project,
      idempotencyKey: "directive:session:message",
      text: "updated",
      sourceKind: "explicit",
      now: 11,
    })
    expect(second.note.id).toBe(first.note.id)
    expect(MemoryStore.listNotes(project)).toHaveLength(1)
    expect(MemoryStore.getNote(global, first.note.id)).toBeUndefined()
    expect(MemoryStore.updateNote(global, first.note.id, { text: "wrong scope" })).toBeUndefined()
    expect(MemoryStore.forgetNote(global, first.note.id)).toBeUndefined()
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(project) })).toMatchObject({
      status: "pending",
      input_watermark: 11,
    })
    expect(MemoryStore.updateNoteAndEnqueue(project, first.note.id, { text: "third", now: 12 })?.note.text).toBe("third")
    expect(MemoryStore.forgetNoteAndEnqueue(project, first.note.id, 13)?.note.time_deleted).toBe(13)
    expect(MemoryStore.getStats(project)).toMatchObject({ notes: { total: 1, active: 0, deleted: 1 } })
  })
})

describe("jobs and Stage 2", () => {
  test("decrements retry budget on lease recovery and sanitizes failures", () => {
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: "exhaust", retryRemaining: 1, now: 1 })
    MemoryStore.claimJob({ kind: "stage1", jobKey: "exhaust", workerID: "worker", leaseMs: 5, now: 2 })
    expect(MemoryStore.recoverJobs({ kind: "stage1", now: 8 })).toMatchObject([
      { job_key: "exhaust", status: "failed", retry_remaining: 0, retry_at: null, last_error: "lease expired" },
    ])
    expect(MemoryStore.claimJob({ kind: "stage1", jobKey: "exhaust", workerID: "worker", leaseMs: 5, now: 9 })).toBeUndefined()

    MemoryStore.enqueueJob({ kind: "stage1", jobKey: "retry", retryRemaining: 2, now: 10 })
    const claim = MemoryStore.claimJob({ kind: "stage1", jobKey: "retry", workerID: "worker", leaseMs: 5, now: 11 })!
    expect(
      MemoryStore.failJob({
        kind: "stage1",
        jobKey: "retry",
        ownershipToken: claim.ownership_token,
        error: `bad\u0000\n${"x".repeat(3_000)}`,
        retryDelayMs: 1,
        now: 12,
      }),
    ).toBeTrue()
    const failed = MemoryStore.getJob({ kind: "stage1", jobKey: "retry" })!
    expect(failed.retry_remaining).toBe(1)
    expect(failed.last_error?.length).toBe(2_000)
    expect(failed.last_error).not.toContain("\u0000")
  })

  test("rejects expired ownership and reclaims the job on the next claim", () => {
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: "expired", retryRemaining: 2, now: 1 })
    const claim = MemoryStore.claimJob({ kind: "stage1", jobKey: "expired", workerID: "worker-a", leaseMs: 5, now: 2 })!
    expect(MemoryStore.heartbeatJob({
      kind: "stage1",
      jobKey: "expired",
      ownershipToken: claim.ownership_token,
      leaseMs: 5,
      now: 7,
    })).toBeFalse()
    expect(MemoryStore.isJobOwned({ kind: "stage1", jobKey: "expired", ownershipToken: claim.ownership_token, now: 7 })).toBeFalse()
    expect(MemoryStore.succeedJob({ kind: "stage1", jobKey: "expired", ownershipToken: claim.ownership_token, now: 7 })).toBeFalse()
    const reclaimed = MemoryStore.claimJob({ kind: "stage1", jobKey: "expired", workerID: "worker-b", leaseMs: 5, now: 7 })!
    expect(reclaimed.ownership_token).not.toBe(claim.ownership_token)
    expect(reclaimed.retry_remaining).toBe(1)
  })

  test("finalizes Stage 1 only for a current inactive owned snapshot", () => {
    insertProject(projectA)
    const session = SessionID.make("ses_stage1_current")
    const scope = MemoryStore.projectScope(projectA)
    insertSession({ id: session, updatedAt: 100 })
    MemoryStore.ensureSessionState({ sessionID: session, watermark: 100 })
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: session, inputWatermark: 100, now: 1 })
    const active = MemoryStore.claimJob({ kind: "stage1", jobKey: session, workerID: "worker", leaseMs: 100, now: 2 })!
    expect(MemoryStore.completeStage1Job({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 100,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "stale" }] },
      rolloutSummary: "stale",
      ownershipToken: active.ownership_token,
      active: true,
      now: 3,
    })).toBe("stale")
    expect(MemoryStore.listStage1Outputs(scope)).toEqual([])

    const stale = MemoryStore.claimJob({ kind: "stage1", jobKey: session, workerID: "worker", leaseMs: 100, now: 4 })!
    Database.use((db) => db.update(SessionTable).set({ time_updated: 101 }).where(eq(SessionTable.id, session)).run())
    expect(MemoryStore.completeStage1Job({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 100,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "stale" }] },
      rolloutSummary: "stale",
      ownershipToken: stale.ownership_token,
      now: 5,
    })).toBe("stale")
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: session, inputWatermark: 101, now: 6 })

    const current = MemoryStore.claimJob({ kind: "stage1", jobKey: session, workerID: "worker", leaseMs: 100, now: 7 })!
    expect(MemoryStore.completeStage1Job({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 101,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "current" }] },
      rolloutSummary: "current",
      ownershipToken: current.ownership_token,
      now: 8,
    })).toBe("completed")
    expect(MemoryStore.listStage1Outputs(scope)[0]).toMatchObject({ source_updated_at: 101, rollout_summary: "current" })
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope) })).toMatchObject({ input_watermark: 101 })
  })

  test("queues both the previous and next Stage 2 scopes when Stage 1 changes scope or removes memory", () => {
    insertProject(projectA)
    const session = SessionID.make("ses_stage1_scope_change")
    const project = MemoryStore.projectScope(projectA)
    const global = MemoryStore.globalScope()
    insertSession({ id: session, updatedAt: 200 })
    MemoryStore.ensureSessionState({ sessionID: session, watermark: 200 })
    MemoryStore.upsertStage1Output({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 100,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "project fact" }] },
      rolloutSummary: "project",
    })
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: session, inputWatermark: 200, now: 1 })
    const moved = MemoryStore.claimJob({ kind: "stage1", jobKey: session, workerID: "worker", leaseMs: 100, now: 2 })!
    expect(MemoryStore.completeStage1Job({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 200,
      payload: { outcome: "memory", scope: "global", items: [{ kind: "workflow", text: "global preference" }] },
      rolloutSummary: "global",
      ownershipToken: moved.ownership_token,
      now: 3,
    })).toBe("completed")
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(project) })).toMatchObject({ input_watermark: 200 })
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(global) })).toMatchObject({ input_watermark: 200 })

    Database.use((db) => db.update(SessionTable).set({ time_updated: 300 }).where(eq(SessionTable.id, session)).run())
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: session, inputWatermark: 300, now: 4 })
    const removed = MemoryStore.claimJob({ kind: "stage1", jobKey: session, workerID: "worker", leaseMs: 100, now: 5 })!
    expect(MemoryStore.completeStage1Job({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 300,
      payload: { outcome: "no_output", scope: "global", items: [] },
      rolloutSummary: "",
      ownershipToken: removed.ownership_token,
      now: 6,
    })).toBe("completed")
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(global) })).toMatchObject({ input_watermark: 300 })
  })

  test("requeues Stage 2 while an unselected note remains", () => {
    const scope = MemoryStore.projectScope(projectA)
    const first = MemoryStore.upsertNoteAndEnqueue({ scope, id: "note-first", text: "first", sourceKind: "manual", now: 10 })
    const second = MemoryStore.upsertNoteAndEnqueue({ scope, id: "note-second", text: "second", sourceKind: "manual", now: 20 })
    const claim = MemoryStore.claimJob({
      kind: "stage2",
      jobKey: MemoryStore.scopeKey(scope),
      workerID: "worker",
      leaseMs: 100,
      now: 21,
    })!
    const selected = MemoryStore.selectNotes(scope, 1)
    expect(selected.map((note) => note.id)).toEqual([first.note.id])
    expect(MemoryStore.completeStage2Job({
      scope,
      ownershipToken: claim.ownership_token,
      selectedOutputs: [],
      selectedNotes: selected.map((note) => ({ noteID: note.id, sourceWatermark: note.time_updated })),
      completedWatermark: claim.input_watermark ?? 0,
      now: 22,
    })).toBeTrue()
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope) })?.status).toBe("pending")
    expect(MemoryStore.selectNotes(scope).map((note) => note.id)).toEqual([second.note.id])
  })

  test("atomically marks selected inputs and succeeds only for the owning Stage 2 token", () => {
    const scope = MemoryStore.projectScope(projectA)
    const session = SessionID.make("ses_stage2")
    MemoryStore.upsertStage1Output({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 20,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "fact" }] },
      rolloutSummary: "summary",
      generatedAt: 21,
    })
    MemoryStore.enqueueJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope), inputWatermark: 20, now: 22 })
    const claim = MemoryStore.claimJob({
      kind: "stage2",
      jobKey: MemoryStore.scopeKey(scope),
      workerID: "worker",
      leaseMs: 10,
      now: 23,
    })!
    expect(
      MemoryStore.completeStage2Job({
        scope,
        ownershipToken: "stale",
        selectedOutputs: [{ sessionID: session, sourceWatermark: 20 }],
        selectedNotes: [],
        completedWatermark: 20,
        now: 24,
      }),
    ).toBeFalse()
    expect(
      Database.use((db) =>
        db.select().from(MemoryStage1OutputTable).where(eq(MemoryStage1OutputTable.session_id, session)).get(),
      )?.selected_for_stage2_source_updated_at,
    ).toBeNull()
    expect(
      MemoryStore.completeStage2Job({
        scope,
        ownershipToken: claim.ownership_token,
        selectedOutputs: [{ sessionID: session, sourceWatermark: 20 }],
        selectedNotes: [],
        completedWatermark: 20,
        now: 25,
      }),
    ).toBeTrue()
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope) })).toMatchObject({
      status: "succeeded",
      last_success_watermark: 20,
      ownership_token: null,
    })
    expect(
      Database.use((db) =>
        db.select().from(MemoryStage1OutputTable).where(eq(MemoryStage1OutputTable.session_id, session)).get(),
      )?.selected_for_stage2_source_updated_at,
    ).toBe(20)
  })

  test("requeues Stage 2 when input advances after the worker snapshot", () => {
    const scope = MemoryStore.projectScope(projectA)
    const session = SessionID.make("ses_stage2_updated")
    MemoryStore.upsertStage1Output({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 20,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "old" }] },
      rolloutSummary: "old",
      generatedAt: 21,
    })
    MemoryStore.enqueueJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope), inputWatermark: 20, now: 22 })
    const claim = MemoryStore.claimJob({
      kind: "stage2",
      jobKey: MemoryStore.scopeKey(scope),
      workerID: "worker",
      leaseMs: 10,
      now: 23,
    })!
    const selected = MemoryStore.selectStage1Outputs(scope)
    MemoryStore.upsertStage1Output({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 30,
      payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: "new" }] },
      rolloutSummary: "new",
      generatedAt: 31,
    })
    MemoryStore.enqueueJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope), inputWatermark: 30, now: 31 })

    expect(
      MemoryStore.completeStage2Job({
        scope,
        ownershipToken: claim.ownership_token,
        selectedOutputs: selected.map((output) => ({
          sessionID: output.session_id,
          sourceWatermark: Math.max(output.source_updated_at, output.source_deleted_at ?? 0),
        })),
        selectedNotes: [],
        completedWatermark: 20,
        now: 32,
      }),
    ).toBeTrue()
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope) })).toMatchObject({
      status: "pending",
      input_watermark: 30,
      last_success_watermark: 20,
      ownership_token: null,
    })
    expect(MemoryStore.selectStage1Outputs(scope).map((output) => output.source_updated_at)).toEqual([30])
  })

  test("requeues Stage 2 while an unselected output remains", () => {
    const scope = MemoryStore.projectScope(projectA)
    const sessions = [SessionID.make("ses_stage2_first"), SessionID.make("ses_stage2_second")]
    sessions.forEach((sessionID, index) =>
      MemoryStore.upsertStage1Output({
        sessionID,
        projectID: projectA,
        sourceUpdatedAt: 10 + index * 10,
        payload: { outcome: "memory", scope: "project", items: [{ kind: "fact", text: sessionID }] },
        rolloutSummary: sessionID,
        generatedAt: 11 + index * 10,
      }),
    )
    MemoryStore.enqueueJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope), inputWatermark: 20, now: 22 })
    const claim = MemoryStore.claimJob({
      kind: "stage2",
      jobKey: MemoryStore.scopeKey(scope),
      workerID: "worker",
      leaseMs: 10,
      now: 23,
    })!
    const selected = MemoryStore.selectStage1Outputs(scope, 1)

    expect(
      MemoryStore.completeStage2Job({
        scope,
        ownershipToken: claim.ownership_token,
        selectedOutputs: selected.map((output) => ({
          sessionID: output.session_id,
          sourceWatermark: Math.max(output.source_updated_at, output.source_deleted_at ?? 0),
        })),
        selectedNotes: [],
        completedWatermark: claim.input_watermark ?? 0,
        now: 24,
      }),
    ).toBeTrue()
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope) })?.status).toBe("pending")
    expect(MemoryStore.selectStage1Outputs(scope).map((output) => output.session_id)).toEqual([sessions[1]])
  })
})

describe("deletion and reset", () => {
  test("tombstones selected session memory and enqueues a rebuild transactionally", () => {
    const session = SessionID.make("ses_deleted")
    const scope = MemoryStore.projectScope(projectA)
    MemoryStore.ensureSessionState({ sessionID: session, watermark: 10 })
    MemoryStore.upsertStage1Output({
      sessionID: session,
      projectID: projectA,
      sourceUpdatedAt: 20,
      payload: { outcome: "memory", scope: "project", items: [] },
      rolloutSummary: "summary",
      generatedAt: 21,
    })
    MemoryStore.markStage1Selected(scope, [session])
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: session, now: 22 })

    expect(MemoryStore.deleteSessionMemory({ sessionID: session, now: 30 })).toMatchObject({
      output: "tombstoned",
      jobs: 1,
      states: 1,
      rebuild: true,
    })
    expect(MemoryStore.getSessionState(session)).toBeUndefined()
    expect(MemoryStore.getJob({ kind: "stage1", jobKey: session })).toBeUndefined()
    expect(MemoryStore.getJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope) })).toMatchObject({ status: "pending" })
    expect(MemoryStore.listStage1Outputs(scope, { includeDeleted: true })[0]?.source_deleted_at).toBe(30)
  })

  test("resets only the requested project scope and cancels its jobs and state", () => {
    insertProject(projectA)
    insertProject(projectB)
    const sessionA = SessionID.make("ses_reset_a")
    const sessionB = SessionID.make("ses_reset_b")
    insertSession({ id: sessionA, updatedAt: 100 })
    insertSession({ id: sessionB, projectID: projectB, updatedAt: 100 })
    MemoryStore.ensureSessionState({ sessionID: sessionA, watermark: 100 })
    MemoryStore.ensureSessionState({ sessionID: sessionB, watermark: 100 })
    MemoryStore.upsertNote({ scope: MemoryStore.projectScope(projectA), id: "note-a", text: "a", sourceKind: "manual" })
    MemoryStore.upsertNote({ scope: MemoryStore.projectScope(projectB), id: "note-b", text: "b", sourceKind: "manual" })
    MemoryStore.upsertStage1Output({
      sessionID: sessionA,
      projectID: projectA,
      sourceUpdatedAt: 100,
      payload: { outcome: "memory", scope: "project", items: [] },
      rolloutSummary: "a",
    })
    MemoryStore.upsertStage1Output({
      sessionID: sessionB,
      projectID: projectB,
      sourceUpdatedAt: 100,
      payload: { outcome: "memory", scope: "project", items: [] },
      rolloutSummary: "b",
    })
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: sessionA })
    MemoryStore.enqueueJob({ kind: "stage1", jobKey: sessionB })
    MemoryStore.enqueueJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(MemoryStore.projectScope(projectA)) })

    expect(MemoryStore.resetScope(MemoryStore.projectScope(projectA))).toEqual({
      notes: 1,
      outputs: 1,
      stage1Jobs: 1,
      stage2Jobs: 1,
      sessions: 1,
    })
    expect(MemoryStore.getNote(MemoryStore.projectScope(projectB), "note-b")).toBeDefined()
    expect(MemoryStore.getSessionState(sessionB)).toBeDefined()
    expect(MemoryStore.getJob({ kind: "stage1", jobKey: sessionB })).toBeDefined()
    expect(Database.use((db) => db.select().from(MemoryNoteTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(MemorySessionStateTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(MemoryJobTable).all())).toHaveLength(1)
  })
})
