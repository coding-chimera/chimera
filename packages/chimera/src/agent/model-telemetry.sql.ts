import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { ProjectID } from "../project/schema"
import { Timestamps } from "../storage/schema.sql"
import { SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"
import type { DelegationTelemetryEvent } from "./model-telemetry"

type EventField<Name extends PropertyKey> = Name extends keyof DelegationTelemetryEvent
  ? NonNullable<DelegationTelemetryEvent[Name]>
  : Record<string, unknown>

export const ModelTelemetryEventTable = sqliteTable(
  "model_telemetry_event",
  {
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    event_id: text().notNull(),
    content_checksum: text().notNull(),
    schema_version: integer().$type<EventField<"schemaVersion">>().notNull(),
    event_type: text().$type<EventField<"eventType">>().notNull(),
    episode_id: text().notNull(),
    decision_id: text(),
    delegation_id: text(),
    parent_delegation_id: text(),
    attempt_index: integer(),
    workload: text().notNull(),
    workload_context: text({ mode: "json" }).$type<EventField<"workloadContext">>(),
    action: text({ mode: "json" }).$type<EventField<"action">>(),
    policy: text({ mode: "json" }).$type<EventField<"policy">>(),
    execution: text({ mode: "json" }).$type<EventField<"execution">>(),
    usage: text({ mode: "json" }).$type<EventField<"usage">>(),
    quota: text({ mode: "json" }).$type<EventField<"quota">>(),
    verification: text({ mode: "json" }).$type<EventField<"verification">>(),
    feedback: text({ mode: "json" }).$type<EventField<"feedback">>(),
    fanout: text({ mode: "json" }).$type<EventField<"fanout">>(),
    time_occurred: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.event_id] }),
    index("model_telemetry_event_project_time_occurred_event_id_idx").on(
      table.project_id,
      table.time_occurred,
      table.event_id,
    ),
    index("model_telemetry_event_project_episode_time_occurred_idx").on(
      table.project_id,
      table.episode_id,
      table.time_occurred,
    ),
    index("model_telemetry_event_project_delegation_time_occurred_idx").on(
      table.project_id,
      table.delegation_id,
      table.time_occurred,
    ),
    index("model_telemetry_event_project_event_type_time_occurred_idx").on(
      table.project_id,
      table.event_type,
      table.time_occurred,
    ),
  ],
)

export const ModelTelemetryTombstoneTable = sqliteTable(
  "model_telemetry_tombstone",
  {
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    event_id: text().notNull(),
    content_checksum: text().notNull(),
    time_compacted: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.event_id] }),
    index("model_telemetry_tombstone_time_compacted_idx").on(table.time_compacted),
  ],
)


export const ModelTelemetrySessionBindingTable = sqliteTable(
  "model_telemetry_session_binding",
  {
    project_id: text().$type<ProjectID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    episode_id: text().notNull(),
    parent_delegation_id: text(),
    next_attempt_index: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.session_id] }),
    index("model_telemetry_session_binding_project_episode_idx").on(table.project_id, table.episode_id),
  ],
)

export const ModelTelemetryDelegationTable = sqliteTable(
  "model_telemetry_delegation",
  {
    project_id: text().$type<ProjectID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    episode_id: text().notNull(),
    decision_id: text().notNull(),
    delegation_id: text().notNull(),
    parent_delegation_id: text(),
    attempt_index: integer().notNull(),
    workload: text().notNull(),
    action: text({ mode: "json" }).notNull(),
    fanout: text({ mode: "json" }),
    terminal_event_type: text(),
    terminal_event_id: text(),
    terminal_checksum: text(),
    terminal_time: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.delegation_id] }),
    index("model_telemetry_delegation_project_session_attempt_idx").on(table.project_id, table.session_id, table.attempt_index),
  ],
)

export const ModelTelemetryOracleLinkTable = sqliteTable(
  "model_telemetry_oracle_link",
  {
    project_id: text().$type<ProjectID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    oracle_key: text().notNull(),
    session_id: text().$type<SessionID>().notNull(),
    delegation_id: text().notNull(),
    episode_id: text().notNull(),
    attempt_index: integer().notNull(),
    verification_event_id: text().notNull(),
    verification_kind: text().notNull(),
    status: text().notNull(),
    trusted: integer({ mode: "boolean" }).notNull(),
    time_occurred: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.oracle_key] }),
    index("model_telemetry_oracle_link_project_session_idx").on(table.project_id, table.session_id),
    index("model_telemetry_oracle_link_project_delegation_idx").on(table.project_id, table.delegation_id),
  ],
)
