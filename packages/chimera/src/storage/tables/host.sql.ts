import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { ProjectID } from "../../project/schema"
import type { SessionID, MessageID } from "@/contracts/session-ids"
import type { WorkspaceID } from "../../control-plane/schema"
import { Timestamps } from "../schema.sql"

/**
 * Host-owned control-plane tables (H1, see specs/rust-host/recovery-matrix.md §8).
 *
 * These tables are written only by the Rust host during H1. The Bun worker keeps
 * writing session/message/part/background_job/session_turn_lease. `host_command_replay`
 * is IPC-owned and intentionally not declared here.
 */

export const HostWorkerTable = sqliteTable(
  "host_worker",
  {
    worker_id: text().primaryKey(), // host-assigned, ULID
    workspace_id: text().$type<WorkspaceID>().notNull(),
    generation: integer().notNull(), // monotonic per workspace
    boot_id: text().notNull(), // host process identity
    pid: integer().notNull(),
    pgid: integer(),
    status: text().notNull(), // spawned|handshaking|ready|busy|draining|exited|crashed|killed|unresponsive
    protocol_version: text().notNull(),
    capabilities: text({ mode: "json" }).notNull(),
    started_at: integer().notNull(),
    heartbeat_at: integer(),
    drain_requested_at: integer(),
    exited_at: integer(),
    exit_reason: text(),
    last_error: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("host_worker_workspace_generation_idx").on(table.workspace_id, table.generation),
    // Partial unique index: at most one non-terminal worker per workspace.
    uniqueIndex("host_worker_active_idx")
      .on(table.workspace_id)
      .where(sql`status NOT IN ('exited', 'crashed', 'killed')`),
    index("host_worker_status_heartbeat_idx").on(table.status, table.heartbeat_at),
    index("host_worker_workspace_status_idx").on(table.workspace_id, table.status),
  ],
)

export const HostStateTable = sqliteTable("host_state", {
  scope: text().primaryKey(), // 'global' or workspace_id
  schema_version: integer().notNull(),
  host_generation: integer().notNull(),
  next_worker_generation: integer().notNull(),
  next_event_seq: integer().notNull(),
  boot_id: text(),
  updated_at: integer().notNull(),
})

export const SessionTurnCheckpointTable = sqliteTable(
  "session_turn_checkpoint",
  {
    session_id: text().$type<SessionID>().notNull(),
    turn_id: text().notNull(),
    turn_seq: integer().notNull(),
    generation: integer().notNull(), // canonical name: turn_generation (ipc-v0 §1.2)
    worker_id: text(),
    worker_generation: integer(),
    status: text().notNull(), // accepted|running|waiting_permission|waiting_question|waiting_tool|cancelling|cancelled|completed|failed|interrupted
    commit_state: text().notNull(), // uncommitted|committed_unconfirmed|confirmed
    commit_token: text(), // idempotency key for worker commit confirmation
    completion_source: text(), // worker_confirmed|recovered_confirmation|host_derived
    terminal_source: text(), // worker|cancel|crash_sweep|recovery
    intent: text({ mode: "json" }).notNull(), // bounded JSON: prompt/agent/model/part refs
    resume_policy: text().notNull(), // none|retry_safe|manual
    side_effect_state: text().notNull(), // none|committed|unknown
    last_message_id: text().$type<MessageID>(),
    last_event_seq: integer(),
    cancel_requested_at: integer(),
    error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.turn_id] }),
    index("session_turn_checkpoint_session_status_idx").on(table.session_id, table.status),
    index("session_turn_checkpoint_worker_idx").on(table.worker_id, table.worker_generation),
    // Partial unique index: at most one non-terminal turn per session.
    uniqueIndex("session_turn_checkpoint_active_idx")
      .on(table.session_id)
      .where(
        sql`status IN ('accepted', 'running', 'waiting_permission', 'waiting_question', 'waiting_tool', 'cancelling')`,
      ),
  ],
)

export const PendingRequestTable = sqliteTable(
  "pending_request",
  {
    request_id: text().primaryKey(), // stable for the request lifetime; republish keeps it
    request_key: text().notNull(), // host idempotency key: kind:turn_id:tool_call_id or kind:turn_id:ask_seq
    kind: text().notNull(), // permission|question
    session_id: text().$type<SessionID>().notNull(),
    turn_id: text(),
    worker_id: text(),
    worker_generation: integer(), // worker generation of the current publish
    tool_call_id: text(), // nullable
    status: text().notNull(), // pending|answered|rejected|expired|orphaned
    payload: text({ mode: "json" }).notNull(), // question/permission mode/metadata
    answer: text({ mode: "json" }),
    generation: integer().notNull(), // republish attempt generation, starting at 1
    expires_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    // Non-terminal uniqueness: tool_call_id is nullable, so a bare UNIQUE would not apply.
    uniqueIndex("pending_request_active_key_idx")
      .on(table.session_id, table.request_key)
      .where(sql`status = 'pending'`),
    index("pending_request_session_status_idx").on(table.session_id, table.status),
    index("pending_request_status_expires_idx").on(table.status, table.expires_at),
  ],
)

export const RequestIdempotencyTable = sqliteTable(
  "request_idempotency",
  {
    scope: text().notNull(), // workspace/session/instance
    idempotency_key: text().notNull(),
    request_hash: text().notNull(), // guards same key with a different body
    operation: text().notNull(), // prompt|job.start|permission.reply|...
    status: text().notNull(), // in_flight|completed|failed
    response_ref: text(), // turn_id/job_id/request_id
    response_body: text(),
    generation: integer(), // diagnostics only; never a write gate
    owner_session_id: text().$type<SessionID>(), // job.start visibility owner
    created_at: integer().notNull(),
    expires_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.idempotency_key] }),
    index("request_idempotency_expires_idx").on(table.expires_at),
  ],
)

export const HostEventTable = sqliteTable(
  "host_event",
  {
    seq: integer().primaryKey(), // global durable cursor, SSE Last-Event-ID
    event_id: text().notNull().unique(), // stable event id
    dedupe_key: text().notNull().unique(), // idempotency key, e.g. turn:<turn_id>:completed
    workspace_id: text().$type<WorkspaceID>(),
    project_id: text().$type<ProjectID>(),
    aggregate_id: text().notNull(), // session/job/worker id
    aggregate_seq: integer(), // per-aggregate durable order
    type: text().notNull(),
    worker_id: text(),
    worker_generation: integer(),
    payload: text({ mode: "json" }).notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("host_event_aggregate_seq_idx")
      .on(table.aggregate_id, table.aggregate_seq)
      .where(sql`aggregate_seq IS NOT NULL`),
    index("host_event_created_idx").on(table.created_at),
  ],
)