/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';
import { buildSearchText } from '../search/query-utils';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 11;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description: 'Add file semantic classification table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_semantics (
          path TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          classifier_version INTEGER NOT NULL,
          role TEXT NOT NULL,
          confidence TEXT NOT NULL,
          source TEXT NOT NULL,
          reason TEXT NOT NULL,
          signals_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_file_semantics_role ON file_semantics(role);
        CREATE INDEX IF NOT EXISTS idx_file_semantics_classifier_version ON file_semantics(classifier_version);
        CREATE INDEX IF NOT EXISTS idx_file_semantics_content_hash ON file_semantics(content_hash);
      `);
    },
  },
  {
    version: 6,
    description: 'Add nodes.search_text (split identifier words) and re-index nodes_fts for compound-symbol recall',
    up: (db) => {
      // 1. Add the column. Existing rows get NULL until backfilled below.
      //    `ALTER TABLE ... ADD COLUMN` is a no-op-safe metadata change.
      const columns = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((row) => row.name);
      if (!columns.includes('search_text')) {
        db.exec('ALTER TABLE nodes ADD COLUMN search_text TEXT;');
      }

      // 2. Backfill search_text in TS. The split (camelCase/snake/qualifier)
      //    cannot be expressed in SQLite, so stream rows through buildSearchText.
      //    Drop the FTS sync triggers first so each UPDATE doesn't thrash the
      //    (about-to-be-rebuilt) FTS index; we recreate them afterward.
      db.exec(`
        DROP TRIGGER IF EXISTS nodes_ai;
        DROP TRIGGER IF EXISTS nodes_ad;
        DROP TRIGGER IF EXISTS nodes_au;
      `);
      const update = db.prepare('UPDATE nodes SET search_text = ? WHERE id = ?');
      const rows = db.prepare('SELECT id, name, qualified_name FROM nodes').all() as Array<{
        id: string;
        name: string;
        qualified_name: string | null;
      }>;
      for (const row of rows) {
        update.run(buildSearchText(row.name, row.qualified_name ?? undefined), row.id);
      }

      // 3. Recreate nodes_fts with the new search_text column. FTS5 has no
      //    ADD COLUMN, so drop and recreate the contentless-synced table,
      //    then `rebuild` to repopulate it from the nodes content table.
      db.exec(`
        DROP TABLE IF EXISTS nodes_fts;
        CREATE VIRTUAL TABLE nodes_fts USING fts5(
            id,
            name,
            qualified_name,
            docstring,
            signature,
            search_text,
            content='nodes',
            content_rowid='rowid'
        );
        INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild');

        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, search_text)
            VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.search_text);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, search_text)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.search_text);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, search_text)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.search_text);
            INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, search_text)
            VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.search_text);
        END;
      `);
    },
  },
  {
    // Upstream codegraph v5 (fd03f31, #645), renumbered: chimera's own v5/v6
    // (file_semantics, nodes.search_text) already occupy those numbers.
    version: 7,
    description:
      'Add nodes.return_type — normalized return/result type for receiver-type inference (upstream v5, #645)',
    up: (db) => {
      // ALTER TABLE has no IF NOT EXISTS, so guard for idempotency (same
      // pattern as v10/v11).
      const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'return_type')) {
        db.exec('ALTER TABLE nodes ADD COLUMN return_type TEXT');
      }
    },
  },
  {
    // Upstream codegraph v6 (0da2dce, #1034), renumbered.
    version: 8,
    description:
      'Dedup duplicate edge rows and add a UNIQUE identity index so INSERT OR IGNORE actually dedups (upstream v6, #1034)',
    up: (db) => {
      // `insertEdge` has always used `INSERT OR IGNORE`, but the edges table had
      // no UNIQUE constraint, so nothing conflicted and byte-identical rows
      // accumulated whenever two passes emitted the same edge. Collapse each
      // identity group to its lowest id, then add the constraint that makes
      // `OR IGNORE` keep its promise. IFNULL folds nullable line/col so
      // coordinate-less edges dedup too (SQLite treats each NULL as distinct) —
      // and it MUST match the GROUP BY exactly, or the index creation would
      // fail on a pair the DELETE left behind. Idempotent: the index is
      // `IF NOT EXISTS` and the DELETE is a no-op once the table is unique.
      db.exec(`
        DELETE FROM edges
        WHERE id NOT IN (
          SELECT MIN(id) FROM edges
          GROUP BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
          ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
      `);
    },
  },
  {
    // Upstream codegraph v7 (e699ee9, #1136), renumbered.
    version: 9,
    description:
      'Add name_segment_vocab — prose-word → symbol-name lookup for the prompt hook’s graph-derived gate (upstream v7)',
    up: (db) => {
      // DDL only — instant on any size database (the row-churn hazards of #1067
      // don't apply). The table starts EMPTY on migrated databases; `sync`
      // detects that over a populated graph and backfills batched+yielding
      // (CodeGraph.rebuildNameSegmentVocab), and any full index rebuilds it
      // from scratch. Keep the definition in lockstep with schema.sql.
      db.exec(`
        CREATE TABLE IF NOT EXISTS name_segment_vocab (
          segment TEXT NOT NULL,
          name TEXT NOT NULL,
          PRIMARY KEY (segment, name)
        ) WITHOUT ROWID;
      `);
    },
  },
  {
    // Upstream codegraph v8 (9d0cd3a, #1240), renumbered.
    version: 10,
    description:
      'Track attempted-but-unresolvable refs as status=failed so sync can retry them when a changed file adds a matching symbol (upstream v8, #1240)',
    up: (db) => {
      // DDL only — instant on any size database. No backfill needed: rows are
      // only ever queried by name_tail once they carry status='failed', and
      // both fields are written together by markReferencesFailed. Legacy rows
      // (all 'pending' after this migration) are orphans from interrupted runs
      // that the #1187 sweep grinds down on the next sync, marking survivors
      // failed with their tails as it goes. The tail index is partial: on a
      // healthy index the pending set is empty and the failed set is the only
      // population worth indexing. Keep the definitions in lockstep with
      // schema.sql. Guard each column for idempotency — a database created
      // from current schema.sql already has both.
      const cols = db.prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>;
      const hasColumn = (name: string) => cols.some((c) => c.name === name);
      if (!hasColumn('status')) {
        db.exec("ALTER TABLE unresolved_refs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
      }
      if (!hasColumn('name_tail')) {
        db.exec("ALTER TABLE unresolved_refs ADD COLUMN name_tail TEXT NOT NULL DEFAULT ''");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_unresolved_status ON unresolved_refs(status);
        CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail ON unresolved_refs(name_tail) WHERE status = 'failed';
      `);
    },
  },
  {
    // Upstream codegraph v9 (16e1749, #1500), renumbered.
    version: 11,
    description:
      'Add files.generated — index-time content-header generated-file detection for ranking (upstream v9, #1500)',
    up: (db) => {
      // DDL only — instant on any size database, and NO backfill: the flag is
      // derived from file CONTENT, which this migration has no access to (the
      // files table stores a hash, not the bytes). Migrated rows therefore stay
      // 0 until the next full index re-extracts them, and every reader unions
      // the flag with the path-only check, so an un-backfilled database keeps
      // exactly the pre-#1500 behavior instead of regressing. `sync` heals it
      // file-by-file as files change.
      const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'generated')) {
        db.exec('ALTER TABLE files ADD COLUMN generated INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_files_generated ON files(path) WHERE generated = 1'
      );
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
