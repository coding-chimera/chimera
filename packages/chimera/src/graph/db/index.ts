/**
 * Database Layer
 *
 * Handles SQLite database initialization and connection management.
 */

import { createDatabase, type SqliteDatabase, type SqliteBackend } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { SchemaVersion } from '../types';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';
import {
  StorageExtension,
  StorageExtensionMigrationRecord,
  applyStorageExtension,
  getStorageExtensionHistory,
  getStorageExtensionVersion,
} from './extensions';

export type { SqliteDatabase, SqliteBackend } from './sqlite-adapter';
export type {
  StorageExtension,
  StorageExtensionMigration,
  StorageExtensionMigrationRecord,
} from './extensions';
export { getPendingStorageExtensionMigrations } from './extensions';

declare const CHIMERA_DB_SCHEMA: string | undefined;

export interface DatabaseOpenOptions {
  readOnly?: boolean;
  storageExtensions?: readonly StorageExtension[];
}

/**
 * Apply connection-level PRAGMAs. Shared by `initialize` and `open` so the two
 * paths can't drift.
 *
 * `busy_timeout` is set FIRST, before any pragma that might touch the database
 * file (notably `journal_mode`). If another process holds a write lock at open
 * time, the later pragmas — and the connection's first query — then wait out
 * the lock instead of throwing "database is locked" immediately. See issue #238.
 *
 * The 5s window (was 120s) rides out a normal incremental sync; the old
 * 2-minute wait presented as a frozen, hung agent. With WAL, reads never block
 * on a writer, so this timeout only governs cross-process write contention
 * (e.g. the git-hook `chimera sync` running while the MCP server writes).
 */
function configureConnection(db: SqliteDatabase, options: DatabaseOpenOptions = {}): void {
  db.pragma('busy_timeout = 5000');      // MUST be first — see above
  db.pragma('foreign_keys = ON');
  if (options.readOnly) {
    db.pragma('query_only = ON');
    return;
  }
  db.pragma('journal_mode = WAL');       // real SQLite backends support WAL
  db.pragma('synchronous = NORMAL');     // safe with WAL mode
  db.pragma('cache_size = -64000');      // 64 MB page cache
  db.pragma('temp_store = MEMORY');      // temp tables in memory
  db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped I/O
}

function loadInitialSchema(): string {
  if (typeof CHIMERA_DB_SCHEMA === 'string') return CHIMERA_DB_SCHEMA;
  return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
}

/**
 * Database connection wrapper with lifecycle management
 */
export class DatabaseConnection {
  private db: SqliteDatabase;
  private dbPath: string;
  private backend: SqliteBackend;
  private readOnly: boolean;

  private constructor(db: SqliteDatabase, dbPath: string, backend: SqliteBackend, readOnly = false) {
    this.db = db;
    this.dbPath = dbPath;
    this.backend = backend;
    this.readOnly = readOnly;
  }

  /**
   * Initialize a new database at the given path
   */
  static initialize(dbPath: string, options: Pick<DatabaseOpenOptions, 'storageExtensions'> = {}): DatabaseConnection {
    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create and configure database
    const { db, backend } = createDatabase(dbPath);

    configureConnection(db);

    // Run schema initialization
    db.exec(loadInitialSchema());

    // Record current schema version so migrations aren't re-applied on open
    const currentVersion = getCurrentVersion(db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      db.prepare(
        'INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(CURRENT_SCHEMA_VERSION, Date.now(), 'Initial schema includes all migrations');
    }

    const conn = new DatabaseConnection(db, dbPath, backend);
    try {
      for (const extension of options.storageExtensions ?? []) {
        conn.applyStorageExtension(extension);
      }
      return conn;
    } catch (error) {
      conn.close();
      throw error;
    }
  }

  /**
   * Open an existing database
   */
  static open(dbPath: string, options: DatabaseOpenOptions = {}): DatabaseConnection {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }

    const { db, backend } = createDatabase(dbPath, { readOnly: options.readOnly });

    configureConnection(db, options);

    // Check and run migrations if needed
    const conn = new DatabaseConnection(db, dbPath, backend, options.readOnly ?? false);
    const currentVersion = getCurrentVersion(db);

    try {
      if (currentVersion < CURRENT_SCHEMA_VERSION) {
        if (options.readOnly) {
          throw new Error(
            `Database schema version ${currentVersion} requires migration to ${CURRENT_SCHEMA_VERSION}, but the connection is read-only`
          );
        }
        runMigrations(db, currentVersion);
      }

      for (const extension of options.storageExtensions ?? []) {
        conn.applyStorageExtension(extension);
      }

      return conn;
    } catch (error) {
      conn.close();
      throw error;
    }
  }

  /**
   * Get the underlying database instance
   */
  getDb(): SqliteDatabase {
    return this.db;
  }

  /**
   * Get the SQLite backend serving this connection. Per-instance so
   * MCP cross-project queries report the right backend even when
   * multiple project DBs are open in the same process.
   */
  getBackend(): SqliteBackend {
    return this.backend;
  }

  /**
   * Whether this connection was opened in read-only mode.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Get database file path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * The journal mode actually in effect (e.g. 'wal', 'delete').
   *
   * SQLite silently keeps the prior mode if WAL can't be enabled — e.g. on
   * filesystems without shared-memory support (some network/virtualized mounts,
   * WSL2 /mnt), and always on the wasm backend. So the effective mode can differ
   * from what `configureConnection` requested. Surfaced in `chimera status` so
   * a "database is locked" report is triageable: 'wal' ⇒ readers never block on a
   * writer; anything else ⇒ they can. See issue #238.
   */
  getJournalMode(): string {
    const raw = this.db.pragma('journal_mode');
    const row = Array.isArray(raw) ? raw[0] : raw;
    const mode = row && typeof row === 'object'
      ? (row as Record<string, unknown>).journal_mode
      : row;
    return String(mode ?? '').toLowerCase();
  }

  /**
   * Get current schema version
   */
  getSchemaVersion(): SchemaVersion | null {
    const row = this.db
      .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number; description: string | null } | undefined;

    if (!row) return null;

    return {
      version: row.version,
      appliedAt: row.applied_at,
      description: row.description ?? undefined,
    };
  }

  /**
   * Apply a namespaced storage extension to this database.
   */
  applyStorageExtension(extension: StorageExtension): void {
    applyStorageExtension(this.db, extension, { readOnly: this.readOnly });
  }

  /**
   * Get the currently applied version for a storage extension.
   */
  getStorageExtensionVersion(extensionID: string): number {
    return getStorageExtensionVersion(this.db, extensionID);
  }

  /**
   * Get the applied migration history for a storage extension.
   */
  getStorageExtensionHistory(extensionID: string): StorageExtensionMigrationRecord[] {
    return getStorageExtensionHistory(this.db, extensionID);
  }

  /**
   * Execute a function within a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Get database file size in bytes
   */
  getSize(): number {
    const stats = fs.statSync(this.dbPath);
    return stats.size;
  }

  /**
   * Optimize database (vacuum and analyze)
   */
  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  /**
   * Lightweight, non-blocking maintenance to run after bulk writes
   * (indexAll, sync). Two operations:
   *
   *   - `PRAGMA optimize` — incremental ANALYZE; SQLite only re-analyzes
   *     tables whose row counts changed materially since the last
   *     ANALYZE. Without it, the query planner has no statistics on the
   *     freshly-bulk-loaded tables and can pick suboptimal indexes.
   *
   *   - `PRAGMA wal_checkpoint(PASSIVE)` — fold pending WAL pages back
   *     into the main database file so the WAL file doesn't grow
   *     unboundedly between automatic checkpoints (auto-fires at 1000
   *     pages by default; large indexAll runs blow past that).
   *
   * Both operations are silently swallowed on failure — they're a
   * best-effort optimization, never load-bearing for correctness.
   */
  runMaintenance(): void {
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      // ignore
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // ignore (e.g., not in WAL mode)
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Check if the database connection is open
   */
  isOpen(): boolean {
    return this.db.open;
  }
}

/**
 * Default database filename
 */
export const DATABASE_FILENAME = 'codegraph.db';

/**
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', DATABASE_FILENAME);
}
