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
export const CURRENT_SCHEMA_VERSION = 6;

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
