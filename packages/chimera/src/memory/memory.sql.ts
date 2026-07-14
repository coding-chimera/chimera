import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ProjectID } from "../project/schema"
import type { MessageID, SessionID } from "../session/schema"
import { Timestamps } from "../storage/schema.sql"

export type MemoryScope = "global" | "project"
export type MemoryNoteSourceKind = "explicit" | "automatic" | "manual" | "legacy_import"
export type MemoryStage1Payload = {
  outcome: "memory" | "no_output"
  scope: MemoryScope
  items: Array<{
    kind: "fact" | "workflow" | "correction"
    text: string
  }>
}
export type MemoryJobKind = "stage1" | "stage2"
export type MemoryJobStatus = "pending" | "running" | "succeeded" | "failed"
export type MemorySessionMode = "enabled" | "disabled" | "polluted"

export const MemoryNoteTable = sqliteTable(
  "memory_note",
  {
    id: text().primaryKey(),
    scope: text().$type<MemoryScope>().notNull(),
    project_id: text().$type<ProjectID>(),
    text: text().notNull(),
    source_kind: text().$type<MemoryNoteSourceKind>().notNull(),
    source_session_id: text().$type<SessionID>(),
    source_message_id: text().$type<MessageID>(),
    content_checksum: text().notNull(),
    usage_count: integer().notNull().default(0),
    last_usage: integer(),
    selected_for_stage2_time_updated: integer(),
    ...Timestamps,
    time_deleted: integer(),
  },
  (table) => [
    index("memory_note_scope_project_time_deleted_idx").on(table.scope, table.project_id, table.time_deleted),
    index("memory_note_source_session_idx").on(table.source_session_id),
    index("memory_note_content_checksum_idx").on(table.content_checksum),
    index("memory_note_selected_for_stage2_idx").on(table.selected_for_stage2_time_updated),
  ],
)

export const MemoryStage1OutputTable = sqliteTable(
  "memory_stage1_output",
  {
    session_id: text().$type<SessionID>().primaryKey(),
    project_id: text().$type<ProjectID>(),
    source_updated_at: integer().notNull(),
    source_deleted_at: integer(),
    payload: text({ mode: "json" }).notNull().$type<MemoryStage1Payload>(),
    rollout_summary: text().notNull(),
    rollout_slug: text(),
    generated_at: integer().notNull(),
    usage_count: integer().notNull().default(0),
    last_usage: integer(),
    selected_for_stage2_source_updated_at: integer(),
  },
  (table) => [
    index("memory_stage1_output_source_updated_at_idx").on(table.source_updated_at, table.session_id),
    index("memory_stage1_output_project_generated_at_idx").on(table.project_id, table.generated_at),
    index("memory_stage1_output_selected_for_stage2_idx").on(table.selected_for_stage2_source_updated_at),
  ],
)

export const MemoryJobTable = sqliteTable(
  "memory_job",
  {
    kind: text().$type<MemoryJobKind>().notNull(),
    job_key: text().notNull(),
    status: text().$type<MemoryJobStatus>().notNull(),
    worker_id: text(),
    ownership_token: text(),
    lease_until: integer(),
    retry_at: integer(),
    retry_remaining: integer().notNull().default(0),
    last_error: text(),
    input_watermark: integer(),
    last_success_watermark: integer(),
    time_started: integer(),
    time_finished: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.job_key] }),
    index("memory_job_kind_status_retry_lease_idx").on(table.kind, table.status, table.retry_at, table.lease_until),
  ],
)

export const MemorySessionStateTable = sqliteTable(
  "memory_session_state",
  {
    session_id: text().$type<SessionID>().primaryKey(),
    mode: text().$type<MemorySessionMode>().notNull(),
    pollution_reason: text(),
    time_polluted: integer(),
    created_watermark: integer().notNull(),
    updated_watermark: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("memory_session_state_mode_updated_watermark_idx").on(table.mode, table.updated_watermark),
  ],
)
