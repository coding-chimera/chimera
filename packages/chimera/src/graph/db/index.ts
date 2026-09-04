/**
 * Database Layer
 *
 * Handles SQLite database initialization and connection management.
 */

import { createDatabase, type SqliteDatabase, type SqliteBackend } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { SchemaVersion } from '../types';
import { GraphSchemaMigrationRequiredError } from '../errors';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';
import {
  StorageExtension,
  StorageExtensionMigrationRecord,
  applyStorageExtension,
  getStorageExtensionHistory,
  getStorageExtensionVersion,
} from './extensions';
import { DATABASE_FILENAME, getGraphDataRootInfo } from '../directory';

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

const sqlitePragmaMB = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
};

// Hot/cold OS-level tuning: mmap keeps hot pages resident and lets the OS evict
// cold pages back to disk; cache_size is the per-connection page cache. Defaults
// match upstream codegraph (64MB cache, 256MB mmap) and are env-overridable.
const sqliteCacheKiB = () => Math.max(1024, sqlitePragmaMB('CHIMERA_SQLITE_CACHE_MB', 64) * 1024);
const sqliteMmapBytes = () => sqlitePragmaMB('CHIMERA_SQLITE_MMAP_MB', 256) * 1024 * 1024;
// temp_store stays FILE by default: chimera runs inside an agent runtime where
// large sorts/joins spilling to disk are safer than unbounded memory. Set
// CHIMERA_SQLITE_TEMP_STORE=MEMORY to mirror upstream codegraph's default.
const sqliteTempStore = () => process.env.CHIMERA_SQLITE_TEMP_STORE?.toUpperCase() === 'MEMORY' ? 'MEMORY' : 'FILE';

function configureConnection(db: SqliteDatabase, options: DatabaseOpenOptions = {}): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma(`cache_size = -${sqliteCacheKiB()}`);
  db.pragma(`mmap_size = ${sqliteMmapBytes()}`);
  if (options.readOnly) {
    db.pragma('query_only = ON');
    return;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`temp_store = ${sqliteTempStore()}`);
}

function loadInitialSchema(): string {
  if (typeof CHIMERA_DB_SCHEMA === 'string') return CHIMERA_DB_SCHEMA;
  return fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf-8');
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
    const conn = new DatabaseConnection(db, dbPath, backend);

    try {
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

      for (const extension of options.storageExtensions ?? []) {
        conn.applyStorageExtension(extension);
      }
      return conn;
    } catch (error) {
      try { conn.close(); } catch { }
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
    const conn = new DatabaseConnection(db, dbPath, backend, options.readOnly ?? false);

    try {
      configureConnection(db, options);

      // Check and run migrations if needed
      const currentVersion = getCurrentVersion(db);
      if (currentVersion < CURRENT_SCHEMA_VERSION) {
        if (options.readOnly) {
          throw new GraphSchemaMigrationRequiredError(currentVersion, CURRENT_SCHEMA_VERSION);
        }
        runMigrations(db, currentVersion);
      }

      for (const extension of options.storageExtensions ?? []) {
        conn.applyStorageExtension(extension);
      }

      return conn;
    } catch (error) {
      try { conn.close(); } catch { }
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
   * Current WAL sidecar file size in bytes (0 when absent). Used by the
   * WalCheckpointValve to bound growth while auto-checkpointing is deferred.
   */
  getWalSizeBytes(): number {
    try {
      const walPath = `${this.dbPath}-wal`;
      return fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Current wal_autocheckpoint page count (default 1000).
   */
  getWalAutocheckpoint(): number {
    const row = this.db.pragma('wal_autocheckpoint', { simple: true }) as number | undefined;
    return typeof row === 'number' ? row : 1000;
  }

  /**
   * Override wal_autocheckpoint (0 = fully defer automatic checkpoints).
   */
  setWalAutocheckpoint(pages: number): void {
    this.db.pragma(`wal_autocheckpoint = ${pages}`);
  }

  /**
   * Fold pending WAL frames into the main DB with PRAGMA wal_checkpoint(PASSIVE)
   * on a SEPARATE connection, so the writer connection is never blocked.
   * PASSIVE never blocks writers; the off-connection checkpoint is what the
   * WalCheckpointValve uses to keep a deferred WAL bounded. Runs on the main
   * thread (worker off-loading is a later refinement). Returns the checkpoint
   * row, or null when the checkpoint is unavailable (e.g. non-WAL mode).
   *
   * The checkpoint connection must be WRITABLE: SQLite folds WAL frames by
   * writing them back into the main DB file, so a read-only connection raises
   * SQLITE_READONLY and no frames move (a regression that let the deferred
   * WAL grow unbounded during bulk indexing).
   */
  async checkpointWalPassive(): Promise<{ busy: number; log: number; checkpointed: number } | null> {
    return this.checkpointWal('PASSIVE');
  }

  /**
   * Like {@link checkpointWalPassive} but with PRAGMA wal_checkpoint(TRUNCATE):
   * after folding every frame, TRUNCATE also shrinks the WAL file back to zero
   * bytes, reclaiming the file's high-water size. Use at phase/run boundaries
   * when no readers are pinned; PASSIVE never reclaims file size.
   */
  async checkpointWalTruncate(): Promise<{ busy: number; log: number; checkpointed: number } | null> {
    return this.checkpointWal('TRUNCATE');
  }

  private async checkpointWal(mode: 'PASSIVE' | 'TRUNCATE'): Promise<{ busy: number; log: number; checkpointed: number } | null> {
    try {
      const { db } = createDatabase(this.dbPath);
      try {
        // The checkpoint connection bypasses configureConnection (deliberately:
        // it must stay writable and must not flip journal_mode), so give it the
        // same busy timeout as the writer to avoid instant lock-contention failure.
        db.pragma('busy_timeout = 5000');
        const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
          { busy?: number; log?: number; checkpointed?: number } | undefined;
        if (!row) return null;
        return {
          busy: Number(row.busy ?? 0),
          log: Number(row.log ?? 0),
          checkpointed: Number(row.checkpointed ?? 0),
        };
      } finally {
        db.close();
      }
    } catch (error) {
      // A writable checkpoint can fail transiently (busy writer, read-only
      // filesystem). Return null — the valve treats null as "machinery
      // unavailable" and retries next tick — but surface the reason instead of
      // swallowing it silently.
      console.warn(`wal_checkpoint(${mode}) failed:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Release SQLite memory caches without closing the connection (PRAGMA shrink_memory).
   * Useful for freeing heap after a tool call while keeping the connection open for reuse.
   */
  shrinkMemory(): void {
    this.db.pragma("shrink_memory");
  }


  /**
   * Check if the database connection is open
   */
  isOpen(): boolean {
    return this.db.open;
  }
}

export { DATABASE_FILENAME } from '../directory';

export function getDatabasePath(projectRoot: string): string {
  return getGraphDataRootInfo(projectRoot).databasePath;
}
