import { createHash, randomUUID } from "crypto"
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import type { ProjectID } from "../project/schema"
import { SessionTable } from "../session/session.sql"
import type { MessageID, SessionID } from "../session/schema"
import { Database, type TxOrDb } from "../storage/db"
import {
  MemoryJobTable,
  MemoryNoteTable,
  MemorySessionStateTable,
  MemoryStage1OutputTable,
  type MemoryJobKind,
  type MemoryJobStatus,
  type MemoryNoteSourceKind,
  type MemorySessionMode,
  type MemoryStage1Payload,
} from "./memory.sql"

export type Scope = { scope: "global"; projectID?: never } | { scope: "project"; projectID: ProjectID }

export type NoteInput = {
  id?: string
  idempotencyKey?: string
  scope: Scope
  text: string
  sourceKind: MemoryNoteSourceKind
  sourceSessionID?: SessionID
  sourceMessageID?: MessageID
  now?: number
}

export type Stage1CandidateQuery = {
  projectID: ProjectID
  now?: number
  idleMs: number
  maxAgeMs: number
  limit: number
  includePolluted?: boolean
  currentSessionID?: SessionID
  excludedSessionIDs?: SessionID[]
}

export type JobRef = {
  kind: MemoryJobKind
  jobKey: string
}

export type JobClaim = typeof MemoryJobTable.$inferSelect & { ownership_token: string }

const MAX_CANDIDATES = 500
const MAX_STAGE1_OUTPUTS = 1_000
const MAX_NOTES = 1_000
const MAX_ERROR_CHARS = 2_000

export const globalScope = (): Scope => ({ scope: "global" })

export const projectScope = (projectID: ProjectID): Scope => ({ scope: "project", projectID })

export function scopeKey(scope: Scope) {
  if (scope.scope === "global") return "global"
  return `project:${scope.projectID}`
}

export function parseScopeKey(key: string): Scope | undefined {
  if (key === "global") return globalScope()
  if (!key.startsWith("project:") || key.length === "project:".length) return
  return projectScope(key.slice("project:".length) as ProjectID)
}

export function scopeValues(scope: Scope) {
  if (scope.scope === "global") return { scope: "global" as const, project_id: null }
  return { scope: "project" as const, project_id: scope.projectID }
}

function noteScopeWhere(scope: Scope): SQL {
  if (scope.scope === "global") return and(eq(MemoryNoteTable.scope, "global"), isNull(MemoryNoteTable.project_id))!
  return and(eq(MemoryNoteTable.scope, "project"), eq(MemoryNoteTable.project_id, scope.projectID))!
}

function stage1ScopeWhere(scope: Scope): SQL {
  if (scope.scope === "global") return sql`json_extract(${MemoryStage1OutputTable.payload}, '$.scope') = 'global'`
  return and(
    eq(MemoryStage1OutputTable.project_id, scope.projectID),
    sql`json_extract(${MemoryStage1OutputTable.payload}, '$.scope') = 'project'`,
  )!
}

function checksum(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function bounded(value: number, maximum: number) {
  return Math.max(0, Math.min(Math.floor(value), maximum))
}

function nextWatermark(current: number, now = Date.now()) {
  return Math.max(current + 1, now)
}

function sanitizeError(error: string) {
  return error
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS)
}

export function deterministicNoteID(scope: Scope, key: string) {
  return `mem_${createHash("sha256").update(`${scopeKey(scope)}\0${key}`).digest("hex")}`
}

function noteID(input: NoteInput) {
  if (input.id) return input.id
  if (input.idempotencyKey) return deterministicNoteID(input.scope, input.idempotencyKey)
  return `mem_${randomUUID()}`
}

function insertNoteTx(tx: TxOrDb, input: NoteInput) {
  const now = input.now ?? Date.now()
  return tx
    .insert(MemoryNoteTable)
    .values({
      id: noteID(input),
      ...scopeValues(input.scope),
      text: input.text,
      source_kind: input.sourceKind,
      source_session_id: input.sourceSessionID,
      source_message_id: input.sourceMessageID,
      content_checksum: checksum(input.text),
      time_created: now,
      time_updated: now,
    })
    .returning()
    .get()
}

function upsertNoteTx(tx: TxOrDb, input: NoteInput) {
  const now = input.now ?? Date.now()
  const id = noteID(input)
  const existing = tx.select().from(MemoryNoteTable).where(eq(MemoryNoteTable.id, id)).get()
  if (!existing) return insertNoteTx(tx, { ...input, id })
  const values = scopeValues(input.scope)
  if (existing.scope !== values.scope || existing.project_id !== values.project_id) {
    throw new Error(`memory note ${id} belongs to a different scope`)
  }
  return tx
    .update(MemoryNoteTable)
    .set({
      text: input.text,
      source_kind: input.sourceKind,
      source_session_id: input.sourceSessionID ?? null,
      source_message_id: input.sourceMessageID ?? null,
      content_checksum: checksum(input.text),
      time_deleted: null,
      time_updated: nextWatermark(existing.time_updated, now),
    })
    .where(and(eq(MemoryNoteTable.id, id), noteScopeWhere(input.scope)))
    .returning()
    .get()!
}

export function createNote(input: NoteInput) {
  return Database.use((db) => insertNoteTx(db, input))
}

export function upsertNote(input: NoteInput) {
  return Database.transaction((tx) => upsertNoteTx(tx, input), { behavior: "immediate" })
}

export function getNote(scope: Scope, id: string, options?: { includeDeleted?: boolean }) {
  return Database.use((db) =>
    db
      .select()
      .from(MemoryNoteTable)
      .where(
        and(
          eq(MemoryNoteTable.id, id),
          noteScopeWhere(scope),
          options?.includeDeleted ? undefined : isNull(MemoryNoteTable.time_deleted),
        ),
      )
      .get(),
  )
}

export function getNotesByIDs(scope: Scope, ids: string[], options?: { includeDeleted?: boolean }) {
  if (ids.length === 0) return []
  return Database.use((db) =>
    db
      .select()
      .from(MemoryNoteTable)
      .where(
        and(
          noteScopeWhere(scope),
          inArray(MemoryNoteTable.id, [...new Set(ids)]),
          options?.includeDeleted ? undefined : isNull(MemoryNoteTable.time_deleted),
        ),
      )
      .orderBy(desc(MemoryNoteTable.time_updated), desc(MemoryNoteTable.id))
      .all(),
  )
}

export function listNotes(scope: Scope, options?: { includeDeleted?: boolean; limit?: number }) {
  const limit = bounded(options?.limit ?? MAX_NOTES, MAX_NOTES)
  if (limit === 0) return []
  return Database.use((db) =>
    db
      .select()
      .from(MemoryNoteTable)
      .where(and(noteScopeWhere(scope), options?.includeDeleted ? undefined : isNull(MemoryNoteTable.time_deleted)))
      .orderBy(desc(MemoryNoteTable.time_updated), desc(MemoryNoteTable.id))
      .limit(limit)
      .all(),
  )
}

export function listAllNotes(scope: Scope, options?: { includeDeleted?: boolean }) {
  return Database.use((db) =>
    db
      .select()
      .from(MemoryNoteTable)
      .where(and(noteScopeWhere(scope), options?.includeDeleted ? undefined : isNull(MemoryNoteTable.time_deleted)))
      .orderBy(desc(MemoryNoteTable.time_updated), desc(MemoryNoteTable.id))
      .all(),
  )
}

function pendingNoteWhere(scope: Scope) {
  return and(
    noteScopeWhere(scope),
    or(
      isNull(MemoryNoteTable.selected_for_stage2_time_updated),
      gt(MemoryNoteTable.time_updated, MemoryNoteTable.selected_for_stage2_time_updated),
    ),
  )!
}

export function selectNotes(scope: Scope, limit = MAX_NOTES) {
  const size = bounded(limit, MAX_NOTES)
  if (size === 0) return []
  return Database.use((db) =>
    db
      .select()
      .from(MemoryNoteTable)
      .where(pendingNoteWhere(scope))
      .orderBy(asc(MemoryNoteTable.time_updated), asc(MemoryNoteTable.id))
      .limit(size)
      .all(),
  )
}

function updateNoteTx(tx: TxOrDb, scope: Scope, id: string, input: { text: string; now?: number }) {
  return tx
    .update(MemoryNoteTable)
    .set({
      text: input.text,
      content_checksum: checksum(input.text),
      time_updated: sql`MAX(${MemoryNoteTable.time_updated} + 1, ${input.now ?? Date.now()})`,
    })
    .where(and(eq(MemoryNoteTable.id, id), noteScopeWhere(scope), isNull(MemoryNoteTable.time_deleted)))
    .returning()
    .get()
}

export function updateNote(scope: Scope, id: string, input: { text: string; now?: number }) {
  return Database.use((db) => updateNoteTx(db, scope, id, input))
}

function forgetNoteTx(tx: TxOrDb, scope: Scope, id: string, now: number) {
  return tx
    .update(MemoryNoteTable)
    .set({
      time_deleted: sql`MAX(${MemoryNoteTable.time_updated} + 1, ${now})`,
      time_updated: sql`MAX(${MemoryNoteTable.time_updated} + 1, ${now})`,
    })
    .where(and(eq(MemoryNoteTable.id, id), noteScopeWhere(scope), isNull(MemoryNoteTable.time_deleted)))
    .returning()
    .get()
}

export function forgetNote(scope: Scope, id: string, now = Date.now()) {
  return Database.use((db) => forgetNoteTx(db, scope, id, now))
}

export function forgetNotes(scope: Scope, ids: string[], now = Date.now()) {
  if (ids.length === 0) return []
  return Database.transaction((tx) =>
    tx
      .update(MemoryNoteTable)
      .set({
        time_deleted: sql`MAX(${MemoryNoteTable.time_updated} + 1, ${now})`,
        time_updated: sql`MAX(${MemoryNoteTable.time_updated} + 1, ${now})`,
      })
      .where(
        and(
          noteScopeWhere(scope),
          inArray(MemoryNoteTable.id, [...new Set(ids)]),
          isNull(MemoryNoteTable.time_deleted),
        ),
      )
      .returning()
      .all(),
  )
}

export function recordNoteUsage(scope: Scope, ids: string[], now = Date.now()) {
  if (ids.length === 0) return 0
  return Database.transaction((tx) =>
    [...new Set(ids)].reduce(
      (total, id) =>
        total +
        tx
          .update(MemoryNoteTable)
          .set({ usage_count: sql`${MemoryNoteTable.usage_count} + 1`, last_usage: now })
          .where(and(eq(MemoryNoteTable.id, id), noteScopeWhere(scope), isNull(MemoryNoteTable.time_deleted)))
          .returning({ id: MemoryNoteTable.id })
          .all().length,
      0,
    ),
  )
}

function enqueueJobTx(
  tx: TxOrDb,
  input: JobRef & { inputWatermark?: number; retryRemaining?: number; now?: number },
) {
  const now = input.now ?? Date.now()
  const existing = tx
    .select()
    .from(MemoryJobTable)
    .where(and(eq(MemoryJobTable.kind, input.kind), eq(MemoryJobTable.job_key, input.jobKey)))
    .get()
  if (!existing) {
    return tx
      .insert(MemoryJobTable)
      .values({
        kind: input.kind,
        job_key: input.jobKey,
        status: "pending",
        retry_remaining: input.retryRemaining ?? 3,
        input_watermark: input.inputWatermark,
        time_created: now,
        time_updated: now,
      })
      .returning()
      .get()
  }
  const watermark = Math.max(existing.input_watermark ?? 0, input.inputWatermark ?? 0)
  return tx
    .update(MemoryJobTable)
    .set({
      status: existing.status === "running" ? "running" : "pending",
      retry_at: existing.status === "running" ? existing.retry_at : null,
      retry_remaining: Math.max(existing.retry_remaining, input.retryRemaining ?? 3),
      input_watermark: watermark || null,
      last_error: existing.status === "running" ? existing.last_error : null,
      time_finished: existing.status === "running" ? existing.time_finished : null,
      time_updated: Math.max(existing.time_updated, now),
    })
    .where(and(eq(MemoryJobTable.kind, input.kind), eq(MemoryJobTable.job_key, input.jobKey)))
    .returning()
    .get()!
}

export function enqueueJob(input: JobRef & { inputWatermark?: number; retryRemaining?: number; now?: number }) {
  return Database.transaction((tx) => enqueueJobTx(tx, input), { behavior: "immediate" })
}

export function upsertNoteAndEnqueue(input: NoteInput) {
  return Database.transaction(
    (tx) => {
      const note = upsertNoteTx(tx, input)
      const job = enqueueJobTx(tx, {
        kind: "stage2",
        jobKey: scopeKey(input.scope),
        inputWatermark: note.time_updated,
        now: input.now,
      })
      return { note, job }
    },
    { behavior: "immediate" },
  )
}

export function updateNoteAndEnqueue(scope: Scope, id: string, input: { text: string; now?: number }) {
  return Database.transaction(
    (tx) => {
      const note = updateNoteTx(tx, scope, id, input)
      if (!note) return
      return {
        note,
        job: enqueueJobTx(tx, {
          kind: "stage2",
          jobKey: scopeKey(scope),
          inputWatermark: note.time_updated,
          now: input.now,
        }),
      }
    },
    { behavior: "immediate" },
  )
}

export function forgetNoteAndEnqueue(scope: Scope, id: string, now = Date.now()) {
  return Database.transaction(
    (tx) => {
      const note = forgetNoteTx(tx, scope, id, now)
      if (!note) return
      return {
        note,
        job: enqueueJobTx(tx, { kind: "stage2", jobKey: scopeKey(scope), inputWatermark: now, now }),
      }
    },
    { behavior: "immediate" },
  )
}

function writeSessionStateTx(
  tx: TxOrDb,
  input: {
    sessionID: SessionID
    mode: MemorySessionMode
    watermark: number
    createdWatermark?: number
    pollutionReason?: string
    timePolluted?: number
    now?: number
  },
) {
  const now = input.now ?? Date.now()
  const existing = tx
    .select()
    .from(MemorySessionStateTable)
    .where(eq(MemorySessionStateTable.session_id, input.sessionID))
    .get()
  const polluted = existing?.mode === "polluted" || input.mode === "polluted"
  const mode = existing?.mode === "polluted" ? "polluted" : input.mode
  const pollutionReason = polluted
    ? existing?.pollution_reason ?? input.pollutionReason ?? "external context"
    : null
  const timePolluted = polluted ? existing?.time_polluted ?? input.timePolluted ?? now : null
  if (!existing) {
    return tx
      .insert(MemorySessionStateTable)
      .values({
        session_id: input.sessionID,
        mode,
        pollution_reason: pollutionReason,
        time_polluted: timePolluted,
        created_watermark: input.createdWatermark ?? input.watermark,
        updated_watermark: input.watermark,
        time_created: now,
        time_updated: now,
      })
      .returning()
      .get()
  }
  return tx
    .update(MemorySessionStateTable)
    .set({
      mode,
      pollution_reason: pollutionReason,
      time_polluted: timePolluted,
      created_watermark: Math.min(existing.created_watermark, input.createdWatermark ?? input.watermark),
      updated_watermark: Math.max(existing.updated_watermark, input.watermark),
      time_updated: Math.max(existing.time_updated, now),
    })
    .where(eq(MemorySessionStateTable.session_id, input.sessionID))
    .returning()
    .get()!
}

export function ensureSessionState(input: {
  sessionID: SessionID
  watermark: number
  mode?: MemorySessionMode
  now?: number
}) {
  return Database.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(MemorySessionStateTable)
        .where(eq(MemorySessionStateTable.session_id, input.sessionID))
        .get()
      if (!existing) {
        return writeSessionStateTx(tx, {
          sessionID: input.sessionID,
          mode: input.mode ?? "enabled",
          watermark: input.watermark,
          now: input.now,
        })
      }
      return writeSessionStateTx(tx, {
        sessionID: input.sessionID,
        mode: existing.mode,
        watermark: input.watermark,
        pollutionReason: existing.pollution_reason ?? undefined,
        timePolluted: existing.time_polluted ?? undefined,
        now: input.now,
      })
    },
    { behavior: "immediate" },
  )
}

export function setSessionMode(input: {
  sessionID: SessionID
  mode: MemorySessionMode
  watermark: number
  pollutionReason?: string
  now?: number
}) {
  return Database.transaction((tx) => writeSessionStateTx(tx, input), { behavior: "immediate" })
}

export function markSessionPolluted(input: {
  sessionID: SessionID
  watermark: number
  reason: string
  now?: number
}) {
  return setSessionMode({
    sessionID: input.sessionID,
    mode: "polluted",
    watermark: input.watermark,
    pollutionReason: input.reason,
    now: input.now,
  })
}

export function copySessionState(input: {
  sourceSessionID: SessionID
  targetSessionID: SessionID
  watermark?: number
  now?: number
}) {
  return Database.transaction(
    (tx) => {
      const source = tx
        .select()
        .from(MemorySessionStateTable)
        .where(eq(MemorySessionStateTable.session_id, input.sourceSessionID))
        .get()
      if (!source) return
      return writeSessionStateTx(tx, {
        sessionID: input.targetSessionID,
        mode: source.mode,
        watermark: Math.max(source.updated_watermark, input.watermark ?? 0),
        createdWatermark: source.created_watermark,
        pollutionReason: source.pollution_reason ?? undefined,
        timePolluted: source.time_polluted ?? undefined,
        now: input.now,
      })
    },
    { behavior: "immediate" },
  )
}

export function getSessionState(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(MemorySessionStateTable).where(eq(MemorySessionStateTable.session_id, sessionID)).get(),
  )
}

export function listStage1Candidates(input: Stage1CandidateQuery) {
  const limit = bounded(input.limit, MAX_CANDIDATES)
  if (limit === 0) return []
  const now = input.now ?? Date.now()
  const exclusions = [input.currentSessionID, ...(input.excludedSessionIDs ?? [])].filter(
    (id): id is SessionID => id !== undefined,
  )
  return Database.use((db) =>
    db
      .select({
        session: SessionTable,
        state: MemorySessionStateTable,
        output_watermark: MemoryStage1OutputTable.source_updated_at,
        success_watermark: MemoryJobTable.last_success_watermark,
      })
      .from(SessionTable)
      .innerJoin(MemorySessionStateTable, eq(MemorySessionStateTable.session_id, SessionTable.id))
      .leftJoin(MemoryStage1OutputTable, eq(MemoryStage1OutputTable.session_id, SessionTable.id))
      .leftJoin(
        MemoryJobTable,
        and(eq(MemoryJobTable.kind, "stage1"), eq(MemoryJobTable.job_key, SessionTable.id)),
      )
      .where(
        and(
          eq(SessionTable.project_id, input.projectID),
          isNull(SessionTable.parent_id),
          isNull(SessionTable.time_compacting),
          input.includePolluted
            ? inArray(MemorySessionStateTable.mode, ["enabled", "polluted"])
            : eq(MemorySessionStateTable.mode, "enabled"),
          gte(SessionTable.time_updated, now - Math.max(0, input.maxAgeMs)),
          lte(SessionTable.time_updated, now - Math.max(0, input.idleMs)),
          exclusions.length > 0 ? notInArray(SessionTable.id, exclusions) : undefined,
          sql`${SessionTable.time_updated} > MAX(COALESCE(${MemoryStage1OutputTable.source_updated_at}, 0), COALESCE(${MemoryJobTable.last_success_watermark}, 0))`,
        ),
      )
      .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
      .limit(limit)
      .all(),
  )
}

export const listCandidateSessions = listStage1Candidates

type Stage1OutputInput = {
  sessionID: SessionID
  projectID?: ProjectID
  sourceUpdatedAt: number
  payload: MemoryStage1Payload
  rolloutSummary: string
  rolloutSlug?: string
  generatedAt?: number
}

function upsertStage1OutputTx(tx: TxOrDb, input: Stage1OutputInput) {
  if (input.payload.scope === "project" && !input.projectID) {
    throw new Error("project Stage 1 output requires projectID")
  }
  const generatedAt = input.generatedAt ?? Date.now()
  return tx
    .insert(MemoryStage1OutputTable)
    .values({
      session_id: input.sessionID,
      project_id: input.projectID,
      source_updated_at: input.sourceUpdatedAt,
      source_deleted_at: null,
      payload: input.payload,
      rollout_summary: input.rolloutSummary,
      rollout_slug: input.rolloutSlug,
      generated_at: generatedAt,
    })
    .onConflictDoUpdate({
      target: MemoryStage1OutputTable.session_id,
      set: {
        project_id: input.projectID ?? null,
        source_updated_at: input.sourceUpdatedAt,
        source_deleted_at: null,
        payload: input.payload,
        rollout_summary: input.rolloutSummary,
        rollout_slug: input.rolloutSlug ?? null,
        generated_at: generatedAt,
      },
    })
    .returning()
    .get()
}

export function upsertStage1Output(input: Stage1OutputInput) {
  return Database.use((db) => upsertStage1OutputTx(db, input))
}

export function listStage1Outputs(scope: Scope, options?: { includeDeleted?: boolean; limit?: number }) {
  const limit = bounded(options?.limit ?? MAX_STAGE1_OUTPUTS, MAX_STAGE1_OUTPUTS)
  if (limit === 0) return []
  return Database.use((db) =>
    db
      .select()
      .from(MemoryStage1OutputTable)
      .where(and(stage1ScopeWhere(scope), options?.includeDeleted ? undefined : isNull(MemoryStage1OutputTable.source_deleted_at)))
      .orderBy(desc(MemoryStage1OutputTable.source_updated_at), desc(MemoryStage1OutputTable.session_id))
      .limit(limit)
      .all(),
  )
}

export function listAllStage1Outputs(scope: Scope, options?: { includeDeleted?: boolean }) {
  return Database.use((db) =>
    db
      .select()
      .from(MemoryStage1OutputTable)
      .where(and(stage1ScopeWhere(scope), options?.includeDeleted ? undefined : isNull(MemoryStage1OutputTable.source_deleted_at)))
      .orderBy(desc(MemoryStage1OutputTable.source_updated_at), desc(MemoryStage1OutputTable.session_id))
      .all(),
  )
}

export function tombstoneStage1Output(sessionID: SessionID, sourceDeletedAt = Date.now()) {
  return Database.use((db) =>
    db
      .update(MemoryStage1OutputTable)
      .set({ source_deleted_at: sourceDeletedAt })
      .where(eq(MemoryStage1OutputTable.session_id, sessionID))
      .returning()
      .get(),
  )
}

function pendingStage1Where(scope: Scope) {
  return and(
    stage1ScopeWhere(scope),
    or(
      isNull(MemoryStage1OutputTable.selected_for_stage2_source_updated_at),
      gt(MemoryStage1OutputTable.source_updated_at, MemoryStage1OutputTable.selected_for_stage2_source_updated_at),
      gt(MemoryStage1OutputTable.source_deleted_at, MemoryStage1OutputTable.selected_for_stage2_source_updated_at),
    ),
  )!
}

export function selectStage1Outputs(scope: Scope, limit = MAX_STAGE1_OUTPUTS) {
  const size = bounded(limit, MAX_STAGE1_OUTPUTS)
  if (size === 0) return []
  return Database.use((db) =>
    db
      .select()
      .from(MemoryStage1OutputTable)
      .where(pendingStage1Where(scope))
      .orderBy(asc(MemoryStage1OutputTable.source_updated_at), asc(MemoryStage1OutputTable.session_id))
      .limit(size)
      .all(),
  )
}

type Stage2Selection = { sessionID: SessionID; sourceWatermark: number }
type Stage2NoteSelection = { noteID: string; sourceWatermark: number }

function markStage1SelectedTx(tx: TxOrDb, scope: Scope, selected: Stage2Selection[]) {
  return selected.reduce(
    (total, item) =>
      total +
      tx
        .update(MemoryStage1OutputTable)
        .set({
          selected_for_stage2_source_updated_at: sql`MAX(COALESCE(${MemoryStage1OutputTable.selected_for_stage2_source_updated_at}, 0), ${item.sourceWatermark})`,
        })
        .where(
          and(
            stage1ScopeWhere(scope),
            eq(MemoryStage1OutputTable.session_id, item.sessionID),
          ),
        )
        .returning({ id: MemoryStage1OutputTable.session_id })
        .all().length,
    0,
  )
}

function markNotesSelectedTx(tx: TxOrDb, scope: Scope, selected: Stage2NoteSelection[]) {
  return selected.reduce(
    (total, item) =>
      total +
      tx
        .update(MemoryNoteTable)
        .set({
          selected_for_stage2_time_updated: sql`MAX(COALESCE(${MemoryNoteTable.selected_for_stage2_time_updated}, 0), ${item.sourceWatermark})`,
          time_updated: sql`${MemoryNoteTable.time_updated}`,
        })
        .where(and(noteScopeWhere(scope), eq(MemoryNoteTable.id, item.noteID)))
        .returning({ id: MemoryNoteTable.id })
        .all().length,
    0,
  )
}

export function markStage1Selected(scope: Scope, sessionIDs: SessionID[]) {
  if (sessionIDs.length === 0) return 0
  return Database.transaction(
    (tx) =>
      markStage1SelectedTx(
        tx,
        scope,
        tx
          .select({
            sessionID: MemoryStage1OutputTable.session_id,
            sourceUpdatedAt: MemoryStage1OutputTable.source_updated_at,
            sourceDeletedAt: MemoryStage1OutputTable.source_deleted_at,
          })
          .from(MemoryStage1OutputTable)
          .where(
            and(
              stage1ScopeWhere(scope),
              inArray(MemoryStage1OutputTable.session_id, [...new Set(sessionIDs)]),
            ),
          )
          .all()
          .map((item) => ({
            sessionID: item.sessionID,
            sourceWatermark: Math.max(item.sourceUpdatedAt, item.sourceDeletedAt ?? 0),
          })),
      ),
    { behavior: "immediate" },
  )
}

export function recordStage1Usage(scope: Scope, sessionIDs: SessionID[], now = Date.now()) {
  if (sessionIDs.length === 0) return 0
  return Database.transaction((tx) =>
    [...new Set(sessionIDs)].reduce(
      (total, sessionID) =>
        total +
        tx
          .update(MemoryStage1OutputTable)
          .set({ usage_count: sql`${MemoryStage1OutputTable.usage_count} + 1`, last_usage: now })
          .where(
            and(
              eq(MemoryStage1OutputTable.session_id, sessionID),
              stage1ScopeWhere(scope),
              isNull(MemoryStage1OutputTable.source_deleted_at),
            ),
          )
          .returning({ id: MemoryStage1OutputTable.session_id })
          .all().length,
      0,
    ),
  )
}

export function claimJob(input: {
  kind: MemoryJobKind
  workerID: string
  leaseMs: number
  jobKey?: string
  now?: number
}): JobClaim | undefined {
  const now = input.now ?? Date.now()
  recoverJobs({ kind: input.kind, now })
  return Database.transaction(
    (tx) => {
      const candidate = tx
        .select()
        .from(MemoryJobTable)
        .where(
          and(
            eq(MemoryJobTable.kind, input.kind),
            input.jobKey ? eq(MemoryJobTable.job_key, input.jobKey) : undefined,
            or(
              eq(MemoryJobTable.status, "pending"),
              and(
                eq(MemoryJobTable.status, "failed"),
                gt(MemoryJobTable.retry_remaining, 0),
                or(isNull(MemoryJobTable.retry_at), lte(MemoryJobTable.retry_at, now)),
              ),
            ),
            isNull(MemoryJobTable.ownership_token),
          ),
        )
        .orderBy(asc(MemoryJobTable.retry_at), asc(MemoryJobTable.time_created), asc(MemoryJobTable.job_key))
        .limit(1)
        .get()
      if (!candidate) return
      const ownershipToken = randomUUID()
      return tx
        .update(MemoryJobTable)
        .set({
          status: "running",
          worker_id: input.workerID,
          ownership_token: ownershipToken,
          lease_until: now + Math.max(1, input.leaseMs),
          retry_at: null,
          time_started: now,
          time_finished: null,
          time_updated: now,
        })
        .where(
          and(
            eq(MemoryJobTable.kind, candidate.kind),
            eq(MemoryJobTable.job_key, candidate.job_key),
            eq(MemoryJobTable.status, candidate.status),
            isNull(MemoryJobTable.ownership_token),
          ),
        )
        .returning()
        .get() as JobClaim | undefined
    },
    { behavior: "immediate" },
  )
}

export function heartbeatJob(input: JobRef & { ownershipToken: string; leaseMs: number; now?: number }) {
  const now = input.now ?? Date.now()
  return Database.transaction(
    (tx) =>
      tx
        .update(MemoryJobTable)
        .set({ lease_until: now + Math.max(1, input.leaseMs), time_updated: now })
        .where(
          and(
            eq(MemoryJobTable.kind, input.kind),
            eq(MemoryJobTable.job_key, input.jobKey),
            eq(MemoryJobTable.status, "running"),
            eq(MemoryJobTable.ownership_token, input.ownershipToken),
            gt(MemoryJobTable.lease_until, now),
          ),
        )
        .returning({ key: MemoryJobTable.job_key })
        .get() !== undefined,
    { behavior: "immediate" },
  )
}

export function isJobOwned(input: JobRef & { ownershipToken: string; now?: number }) {
  const now = input.now ?? Date.now()
  return Database.use((db) =>
    db
      .select({ key: MemoryJobTable.job_key })
      .from(MemoryJobTable)
      .where(
        and(
          eq(MemoryJobTable.kind, input.kind),
          eq(MemoryJobTable.job_key, input.jobKey),
          eq(MemoryJobTable.status, "running"),
          eq(MemoryJobTable.ownership_token, input.ownershipToken),
          gt(MemoryJobTable.lease_until, now),
        ),
      )
      .get() !== undefined,
  )
}

function succeedJobTx(
  tx: TxOrDb,
  input: JobRef & { ownershipToken: string; successWatermark?: number; now?: number },
) {
  const now = input.now ?? Date.now()
  return (
    tx
      .update(MemoryJobTable)
      .set({
        status: "succeeded",
        worker_id: null,
        ownership_token: null,
        lease_until: null,
        retry_at: null,
        last_error: null,
        last_success_watermark: input.successWatermark ?? sql`${MemoryJobTable.input_watermark}`,
        time_finished: now,
        time_updated: now,
      })
      .where(
        and(
          eq(MemoryJobTable.kind, input.kind),
          eq(MemoryJobTable.job_key, input.jobKey),
          eq(MemoryJobTable.status, "running"),
          eq(MemoryJobTable.ownership_token, input.ownershipToken),
          gt(MemoryJobTable.lease_until, now),
        ),
      )
      .returning({ key: MemoryJobTable.job_key })
      .get() !== undefined
  )
}

export function succeedJob(input: JobRef & { ownershipToken: string; successWatermark?: number; now?: number }) {
  return Database.transaction((tx) => succeedJobTx(tx, input), { behavior: "immediate" })
}

export function completeStage1Job(
  input: Stage1OutputInput & {
    ownershipToken: string
    includePolluted?: boolean
    active?: boolean
    now?: number
  },
) {
  const now = input.now ?? Date.now()
  return Database.transaction(
    (tx) => {
      const job = tx
        .select()
        .from(MemoryJobTable)
        .where(
          and(
            eq(MemoryJobTable.kind, "stage1"),
            eq(MemoryJobTable.job_key, input.sessionID),
            eq(MemoryJobTable.status, "running"),
            eq(MemoryJobTable.ownership_token, input.ownershipToken),
            gt(MemoryJobTable.lease_until, now),
          ),
        )
        .get()
      if (!job) return "lost" as const
      const snapshot = tx
        .select({ session: SessionTable, state: MemorySessionStateTable })
        .from(SessionTable)
        .innerJoin(MemorySessionStateTable, eq(MemorySessionStateTable.session_id, SessionTable.id))
        .where(eq(SessionTable.id, input.sessionID))
        .get()
      if (!snapshot) {
        tx
          .delete(MemoryJobTable)
          .where(
            and(
              eq(MemoryJobTable.kind, "stage1"),
              eq(MemoryJobTable.job_key, input.sessionID),
              eq(MemoryJobTable.ownership_token, input.ownershipToken),
            ),
          )
          .run()
        return "discarded" as const
      }
      const eligible =
        !input.active &&
        snapshot.session.project_id === input.projectID &&
        snapshot.session.parent_id === null &&
        snapshot.session.time_compacting === null &&
        snapshot.session.time_updated === input.sourceUpdatedAt &&
        (input.includePolluted
          ? snapshot.state.mode === "enabled" || snapshot.state.mode === "polluted"
          : snapshot.state.mode === "enabled")
      if (!eligible) {
        tx
          .update(MemoryJobTable)
          .set({
            status: "pending",
            worker_id: null,
            ownership_token: null,
            lease_until: null,
            retry_at: null,
            last_error: null,
            time_finished: null,
            time_updated: now,
          })
          .where(
            and(
              eq(MemoryJobTable.kind, "stage1"),
              eq(MemoryJobTable.job_key, input.sessionID),
              eq(MemoryJobTable.status, "running"),
              eq(MemoryJobTable.ownership_token, input.ownershipToken),
              gt(MemoryJobTable.lease_until, now),
            ),
          )
          .run()
        return "stale" as const
      }
      const previous = tx
        .select()
        .from(MemoryStage1OutputTable)
        .where(eq(MemoryStage1OutputTable.session_id, input.sessionID))
        .get()
      upsertStage1OutputTx(tx, input)
      const affected = new Map<string, Scope>()
      if (previous?.payload.outcome === "memory") {
        const scope = previous.payload.scope === "global" ? globalScope() : projectScope(previous.project_id!)
        affected.set(scopeKey(scope), scope)
      }
      if (input.payload.outcome === "memory") {
        const scope = input.payload.scope === "global" ? globalScope() : projectScope(snapshot.session.project_id)
        affected.set(scopeKey(scope), scope)
      }
      affected.forEach((scope) =>
        enqueueJobTx(tx, { kind: "stage2", jobKey: scopeKey(scope), inputWatermark: input.sourceUpdatedAt, now }),
      )
      if (!succeedJobTx(tx, {
        kind: "stage1",
        jobKey: input.sessionID,
        ownershipToken: input.ownershipToken,
        successWatermark: input.sourceUpdatedAt,
        now,
      })) {
        throw new Error("Stage 1 ownership was lost")
      }
      return "completed" as const
    },
    { behavior: "immediate" },
  )
}

export function failJob(input: JobRef & { ownershipToken: string; error: string; retryDelayMs: number; now?: number }) {
  const now = input.now ?? Date.now()
  return Database.transaction(
    (tx) => {
      const job = tx
        .select()
        .from(MemoryJobTable)
        .where(
          and(
            eq(MemoryJobTable.kind, input.kind),
            eq(MemoryJobTable.job_key, input.jobKey),
            eq(MemoryJobTable.status, "running"),
            eq(MemoryJobTable.ownership_token, input.ownershipToken),
            gt(MemoryJobTable.lease_until, now),
          ),
        )
        .get()
      if (!job) return false
      const remaining = Math.max(0, job.retry_remaining - 1)
      return (
        tx
          .update(MemoryJobTable)
          .set({
            status: "failed",
            worker_id: null,
            ownership_token: null,
            lease_until: null,
            retry_at: remaining > 0 ? now + Math.max(0, input.retryDelayMs) : null,
            retry_remaining: remaining,
            last_error: sanitizeError(input.error),
            time_finished: now,
            time_updated: now,
          })
          .where(
            and(
              eq(MemoryJobTable.kind, input.kind),
              eq(MemoryJobTable.job_key, input.jobKey),
              eq(MemoryJobTable.status, "running"),
              eq(MemoryJobTable.ownership_token, input.ownershipToken),
              gt(MemoryJobTable.lease_until, now),
            ),
          )
          .returning({ key: MemoryJobTable.job_key })
          .get() !== undefined
      )
    },
    { behavior: "immediate" },
  )
}

export function recoverJobs(input?: { kind?: MemoryJobKind; now?: number }) {
  const now = input?.now ?? Date.now()
  return Database.transaction(
    (tx) =>
      tx
        .select()
        .from(MemoryJobTable)
        .where(
          and(
            input?.kind ? eq(MemoryJobTable.kind, input.kind) : undefined,
            eq(MemoryJobTable.status, "running"),
            lte(MemoryJobTable.lease_until, now),
          ),
        )
        .all()
        .map((job) => {
          const remaining = Math.max(0, job.retry_remaining - 1)
          return tx
            .update(MemoryJobTable)
            .set({
              status: "failed",
              worker_id: null,
              ownership_token: null,
              lease_until: null,
              retry_at: remaining > 0 ? now : null,
              retry_remaining: remaining,
              last_error: "lease expired",
              time_finished: now,
              time_updated: now,
            })
            .where(
              and(
                eq(MemoryJobTable.kind, job.kind),
                eq(MemoryJobTable.job_key, job.job_key),
                eq(MemoryJobTable.status, "running"),
                eq(MemoryJobTable.ownership_token, job.ownership_token!),
              ),
            )
            .returning()
            .get()!
        }),
    { behavior: "immediate" },
  )
}

export function completeStage2Job(input: {
  scope: Scope
  ownershipToken: string
  selectedOutputs: Stage2Selection[]
  selectedNotes: Stage2NoteSelection[]
  completedWatermark: number
  now?: number
}) {
  const now = input.now ?? Date.now()
  return Database.transaction(
    (tx) => {
      const job = tx
        .select()
        .from(MemoryJobTable)
        .where(
          and(
            eq(MemoryJobTable.kind, "stage2"),
            eq(MemoryJobTable.job_key, scopeKey(input.scope)),
            eq(MemoryJobTable.status, "running"),
            eq(MemoryJobTable.ownership_token, input.ownershipToken),
            gt(MemoryJobTable.lease_until, now),
          ),
        )
        .get()
      if (!job) return false
      markStage1SelectedTx(tx, input.scope, input.selectedOutputs)
      markNotesSelectedTx(tx, input.scope, input.selectedNotes)
      const pending =
        (job.input_watermark ?? 0) > input.completedWatermark ||
        tx
          .select({ id: MemoryStage1OutputTable.session_id })
          .from(MemoryStage1OutputTable)
          .where(pendingStage1Where(input.scope))
          .limit(1)
          .get() !== undefined ||
        tx
          .select({ id: MemoryNoteTable.id })
          .from(MemoryNoteTable)
          .where(pendingNoteWhere(input.scope))
          .limit(1)
          .get() !== undefined
      if (!pending) {
        return succeedJobTx(tx, {
          kind: "stage2",
          jobKey: scopeKey(input.scope),
          ownershipToken: input.ownershipToken,
          successWatermark: input.completedWatermark,
          now,
        })
      }
      return (
        tx
          .update(MemoryJobTable)
          .set({
            status: "pending",
            worker_id: null,
            ownership_token: null,
            lease_until: null,
            retry_at: null,
            last_error: null,
            last_success_watermark: Math.max(job.last_success_watermark ?? 0, input.completedWatermark) || null,
            time_finished: null,
            time_updated: now,
          })
          .where(
            and(
              eq(MemoryJobTable.kind, "stage2"),
              eq(MemoryJobTable.job_key, scopeKey(input.scope)),
              eq(MemoryJobTable.status, "running"),
              eq(MemoryJobTable.ownership_token, input.ownershipToken),
              gt(MemoryJobTable.lease_until, now),
            ),
          )
          .returning({ key: MemoryJobTable.job_key })
          .get() !== undefined
      )
    },
    { behavior: "immediate" },
  )
}

export function deleteSessionMemory(input: { sessionID: SessionID; now?: number }) {
  const now = input.now ?? Date.now()
  return Database.transaction(
    (tx) => {
      const output = tx
        .select()
        .from(MemoryStage1OutputTable)
        .where(eq(MemoryStage1OutputTable.session_id, input.sessionID))
        .get()
      const jobs = tx
        .delete(MemoryJobTable)
        .where(and(eq(MemoryJobTable.kind, "stage1"), eq(MemoryJobTable.job_key, input.sessionID)))
        .returning({ key: MemoryJobTable.job_key })
        .all().length
      const states = tx
        .delete(MemorySessionStateTable)
        .where(eq(MemorySessionStateTable.session_id, input.sessionID))
        .returning({ id: MemorySessionStateTable.session_id })
        .all().length
      if (!output) return { output: "missing" as const, jobs, states, rebuild: false }
      if (output.selected_for_stage2_source_updated_at === null) {
        tx.delete(MemoryStage1OutputTable).where(eq(MemoryStage1OutputTable.session_id, input.sessionID)).run()
        return { output: "deleted" as const, jobs, states, rebuild: false }
      }
      tx
        .update(MemoryStage1OutputTable)
        .set({ source_deleted_at: Math.max(output.source_deleted_at ?? 0, now) })
        .where(eq(MemoryStage1OutputTable.session_id, input.sessionID))
        .run()
      const scope = output.payload.scope === "global" ? globalScope() : projectScope(output.project_id!)
      enqueueJobTx(tx, { kind: "stage2", jobKey: scopeKey(scope), inputWatermark: now, now })
      return { output: "tombstoned" as const, jobs, states, rebuild: true, scope }
    },
    { behavior: "immediate" },
  )
}

export function resetScope(scope: Scope) {
  return Database.transaction(
    (tx) => {
      const outputs = tx
        .select({ session_id: MemoryStage1OutputTable.session_id })
        .from(MemoryStage1OutputTable)
        .where(stage1ScopeWhere(scope))
        .all()
      const projectSessions =
        scope.scope === "project"
          ? tx
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.project_id, scope.projectID))
              .all()
          : []
      const sessionIDs = [...new Set([...outputs.map((item) => item.session_id), ...projectSessions.map((item) => item.id)])]
      const notes = tx.delete(MemoryNoteTable).where(noteScopeWhere(scope)).returning({ id: MemoryNoteTable.id }).all().length
      const stage1Outputs = tx
        .delete(MemoryStage1OutputTable)
        .where(stage1ScopeWhere(scope))
        .returning({ id: MemoryStage1OutputTable.session_id })
        .all().length
      const stage1Jobs =
        sessionIDs.length === 0
          ? 0
          : tx
              .delete(MemoryJobTable)
              .where(and(eq(MemoryJobTable.kind, "stage1"), inArray(MemoryJobTable.job_key, sessionIDs)))
              .returning({ key: MemoryJobTable.job_key })
              .all().length
      const stage2Jobs = tx
        .delete(MemoryJobTable)
        .where(and(eq(MemoryJobTable.kind, "stage2"), eq(MemoryJobTable.job_key, scopeKey(scope))))
        .returning({ key: MemoryJobTable.job_key })
        .all().length
      const sessions =
        scope.scope === "project" && sessionIDs.length > 0
          ? tx
              .delete(MemorySessionStateTable)
              .where(inArray(MemorySessionStateTable.session_id, sessionIDs))
              .returning({ id: MemorySessionStateTable.session_id })
              .all().length
          : 0
      return { notes, outputs: stage1Outputs, stage1Jobs, stage2Jobs, sessions }
    },
    { behavior: "immediate" },
  )
}

export function getStats(scope: Scope) {
  return Database.use((db) => {
    const notes = db
      .select({
        total: count(),
        deleted: sql<number>`SUM(CASE WHEN ${MemoryNoteTable.time_deleted} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(MemoryNoteTable)
      .where(noteScopeWhere(scope))
      .get()!
    const outputs = db
      .select({
        total: count(),
        tombstoned: sql<number>`SUM(CASE WHEN ${MemoryStage1OutputTable.source_deleted_at} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(MemoryStage1OutputTable)
      .where(stage1ScopeWhere(scope))
      .get()!
    const jobs = db
      .select({ status: MemoryJobTable.status, total: count() })
      .from(MemoryJobTable)
      .where(and(eq(MemoryJobTable.kind, "stage2"), eq(MemoryJobTable.job_key, scopeKey(scope))))
      .groupBy(MemoryJobTable.status)
      .all()
    return {
      notes: { total: notes.total, active: notes.total - Number(notes.deleted ?? 0), deleted: Number(notes.deleted ?? 0) },
      outputs: {
        total: outputs.total,
        active: outputs.total - Number(outputs.tombstoned ?? 0),
        tombstoned: Number(outputs.tombstoned ?? 0),
      },
      jobs: Object.fromEntries(jobs.map((item) => [item.status, item.total])) as Partial<Record<MemoryJobStatus, number>>,
    }
  })
}

export function listJobs(input?: { kind?: MemoryJobKind; status?: MemoryJobStatus; limit?: number }) {
  const limit = bounded(input?.limit ?? 100, 1_000)
  if (limit === 0) return []
  return Database.use((db) =>
    db
      .select()
      .from(MemoryJobTable)
      .where(
        and(
          input?.kind ? eq(MemoryJobTable.kind, input.kind) : undefined,
          input?.status ? eq(MemoryJobTable.status, input.status) : undefined,
        ),
      )
      .orderBy(desc(MemoryJobTable.time_updated), asc(MemoryJobTable.kind), asc(MemoryJobTable.job_key))
      .limit(limit)
      .all(),
  )
}

export function getJob(ref: JobRef) {
  return Database.use((db) =>
    db
      .select()
      .from(MemoryJobTable)
      .where(and(eq(MemoryJobTable.kind, ref.kind), eq(MemoryJobTable.job_key, ref.jobKey)))
      .get(),
  )
}

export * as MemoryStore from "./store"
