/**
 * Schema migration v6 → v11 tests.
 *
 * Chimera's v5/v6 (file_semantics, nodes.search_text) occupy the same numbers
 * as upstream codegraph's v5/v6 (nodes.return_type, edges identity dedup), so
 * the five upstream migrations are appended renumbered as chimera v7–v11.
 * These tests pin: a fresh database carries every object; an old chimera v6
 * database upgrades forward without rebuild or data loss; and the guarded
 * migrations are idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../../src/graph/db';
import { GraphSchemaMigrationRequiredError } from '../../src/graph/errors';
import { createDatabase } from '../../src/graph/db/sqlite-adapter';
import {
  CURRENT_SCHEMA_VERSION,
  getCurrentVersion,
  runMigrations,
} from '../../src/graph/db/migrations';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-db-migrations-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function dbPath(): string {
  return path.join(tmpDir, 'test.db');
}

function tableColumns(db: { prepare: (sql: string) => { all: () => unknown } }, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function objectNames(db: { prepare: (sql: string) => { all: () => unknown } }, type: string): string[] {
  return (db
    .prepare(`SELECT name FROM sqlite_master WHERE type = '${type}'`)
    .all() as Array<{ name: string }>).map((r) => r.name);
}

function expectV11Objects(db: { prepare: (sql: string) => { all: () => unknown } }): void {
  // Fork lineage retained
  expect(tableColumns(db, 'nodes')).toContain('search_text');
  expect(objectNames(db, 'table')).toContain('file_semantics');
  // v7: upstream v5
  expect(tableColumns(db, 'nodes')).toContain('return_type');
  // v8: upstream v6
  expect(objectNames(db, 'index')).toContain('idx_edges_identity');
  // v9: upstream v7
  expect(objectNames(db, 'table')).toContain('name_segment_vocab');
  // v10: upstream v8
  const refCols = tableColumns(db, 'unresolved_refs');
  expect(refCols).toContain('status');
  expect(refCols).toContain('name_tail');
  expect(objectNames(db, 'index')).toContain('idx_unresolved_status');
  expect(objectNames(db, 'index')).toContain('idx_unresolved_failed_tail');
  // v11: upstream v9
  expect(tableColumns(db, 'files')).toContain('generated');
  expect(objectNames(db, 'index')).toContain('idx_files_generated');
}

/** The chimera v6 shape: pre-v7 columns only (search_text/file_semantics present). */
const OLD_V6_SHAPE = `
  CREATE TABLE schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
  );
  INSERT INTO schema_versions (version, applied_at, description) VALUES (6, 0, 'chimera v6');

  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    is_abstract INTEGER DEFAULT 0,
    decorators TEXT,
    type_parameters TEXT,
    search_text TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT,
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT NULL
  );

  CREATE TABLE files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT
  );

  CREATE TABLE file_semantics (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    classifier_version INTEGER NOT NULL,
    role TEXT NOT NULL,
    confidence TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT,
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown'
  );

  CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

describe('read-only open with outdated schema', () => {
  function downgradeSchemaVersion(version: number): void {
    const conn = DatabaseConnection.initialize(dbPath());
    try {
      conn.getDb().exec('DELETE FROM schema_versions');
      conn
        .getDb()
        .prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
        .run(version, Date.now(), 'test downgrade');
    } finally {
      conn.close();
    }
  }

  function recordedVersion(): number {
    const raw = createDatabase(dbPath());
    try {
      return getCurrentVersion(raw.db);
    } finally {
      raw.db.close();
    }
  }

  it('throws a typed migration-required error with repair guidance and does not migrate', () => {
    downgradeSchemaVersion(6);

    let caught: unknown;
    try {
      DatabaseConnection.open(dbPath(), { readOnly: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphSchemaMigrationRequiredError);
    const error = caught as GraphSchemaMigrationRequiredError;
    expect(error.currentVersion).toBe(6);
    expect(error.requiredVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(error.message).toContain('chimera graph index');
    expect(recordedVersion()).toBe(6);
  });

  it('still auto-migrates on a writable open', () => {
    downgradeSchemaVersion(6);

    const conn = DatabaseConnection.open(dbPath());
    try {
      expect(getCurrentVersion(conn.getDb())).toBe(CURRENT_SCHEMA_VERSION);
      expectV11Objects(conn.getDb());
    } finally {
      conn.close();
    }
  });

  it('opens a current-version database read-only without error', () => {
    DatabaseConnection.initialize(dbPath()).close();

    const conn = DatabaseConnection.open(dbPath(), { readOnly: true });
    try {
      expect(conn.isReadOnly()).toBe(true);
      expect(getCurrentVersion(conn.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
  });
});

describe('schema v11', () => {
  it('fresh database carries all objects and reports the current version', () => {
    const conn = DatabaseConnection.initialize(dbPath());
    try {
      expect(getCurrentVersion(conn.getDb())).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBe(11);
      expectV11Objects(conn.getDb());
    } finally {
      conn.close();
    }
  });
});

describe('migration from chimera v6', () => {
  it('upgrades forward, dedups edges, and preserves existing data', () => {
    // Build an old-shape database and seed it with data, including a
    // byte-identical duplicate edge that pre-dedup indexing could accumulate.
    const raw = createDatabase(dbPath());
    try {
      raw.db.exec(OLD_V6_SHAPE);
      raw.db
        .prepare(
          `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, 1, 0)`
        )
        .run('n1', 'function', 'a', 'a', 'a.ts', 'typescript');
      raw.db
        .prepare(
          `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 2, 2, 0, 1, 0)`
        )
        .run('n2', 'function', 'b', 'b', 'a.ts', 'typescript');
      const insertEdge = raw.db.prepare(
        `INSERT INTO edges (source, target, kind, line, col) VALUES ('n1', 'n2', 'call', 1, 5)`
      );
      insertEdge.run();
      insertEdge.run();
      raw.db
        .prepare(
          `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count)
           VALUES ('a.ts', 'hash', 'typescript', 10, 0, 0, 2)`
        )
        .run();
      raw.db
        .prepare(
          `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col)
           VALUES ('n1', 'util.greet', 'call', 1, 5)`
        )
        .run();
    } finally {
      raw.db.close();
    }

    const conn = DatabaseConnection.open(dbPath());
    try {
      const db = conn.getDb();
      expect(getCurrentVersion(db)).toBe(11);
      expectV11Objects(db);

      // Duplicate edge collapsed by the v8 dedup, and the UNIQUE index now
      // makes INSERT OR IGNORE a real dedup.
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n
      ).toBe(1);
      db.prepare(
        `INSERT OR IGNORE INTO edges (source, target, kind, line, col) VALUES ('n1', 'n2', 'call', 1, 5)`
      ).run();
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n
      ).toBe(1);

      // Existing rows survive with the new defaults.
      const ref = db
        .prepare('SELECT status, name_tail FROM unresolved_refs')
        .get() as { status: string; name_tail: string };
      expect(ref.status).toBe('pending');
      expect(ref.name_tail).toBe('');
      expect(
        (db.prepare('SELECT generated FROM files').get() as { generated: number }).generated
      ).toBe(0);
      expect(
        (db.prepare('SELECT name, search_text FROM nodes WHERE id = ?').get('n1') as {
          name: string;
        }).name
      ).toBe('a');
    } finally {
      conn.close();
    }
  });

  it('is idempotent when re-run from an older recorded version', () => {
    // The guarded scenario: a database that already carries the v7-v11
    // objects (created from current schema.sql) but is recorded at an older
    // version. Re-running must no-op the DDL instead of failing on duplicate
    // columns.
    const raw = createDatabase(dbPath());
    try {
      raw.db.exec(OLD_V6_SHAPE);
      runMigrations(raw.db, 6);
      raw.db.exec('DELETE FROM schema_versions WHERE version > 6');
      runMigrations(raw.db, 6);
      expect(getCurrentVersion(raw.db)).toBe(11);
      expectV11Objects(raw.db);
    } finally {
      raw.db.close();
    }
  });
});
