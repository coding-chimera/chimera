import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"

/**
 * Durable projection of the in-memory BackgroundJob registry (R1 A3).
 *
 * The live registry (`src/agent/background-job.ts`) stays the authority for
 * running jobs — fibers, Deferreds, and delivery state cannot survive a
 * restart by construction. This table is a write-through snapshot of every
 * job's latest Info, scoped by the instance directory that owns the registry:
 *
 * - `get`/`list` fall back to it for ids the live registry does not hold, so
 *   status survives process restart and owner-scope closure (the 14:34-class
 *   "registry lost" incident);
 * - rows recorded as `running` by a previous process are reconciled to an
 *   interrupted terminal state when a registry opens, because their fibers are
 *   provably gone — phase 2's rebuild-from-child-session semantics keep
 *   ownership of any deeper recovery;
 * - settled live entries evicted from the memory cap remain readable here.
 */
export const BackgroundJobTable = sqliteTable(
  "background_job",
  {
    /** Job id, supplied by the caller (phase 2 passes the child session id). */
    id: text().notNull(),
    /** Instance directory of the registry that owns the job. */
    instance_directory: text().notNull(),
    /** Run generation on this id (see Info.generation); monotonic across restarts. */
    generation: integer().notNull(),
    /** Last persisted status: running | completed | error | cancelled. */
    status: text().notNull(),
    /** Full Info snapshot as JSON. */
    data: text().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instance_directory, table.id] }),
    index("background_job_instance_updated_idx").on(table.instance_directory, table.updated_at),
  ],
)
