/**
 * SQLite Adapter
 *
 * Thin wrappers over the host runtime's built-in SQLite implementation,
 * exposed through a small better-sqlite3-shaped interface so the rest of the
 * codebase is storage-agnostic.
 *
 * CodeGraph ships with a bundled Node runtime, so `node:sqlite` (real SQLite,
 * with WAL + FTS5) is normally available — there is no native build step and no
 * wasm fallback. Coding Chimera also runs CodeGraph inside opencode's Bun
 * runtime, where `node:sqlite` is not available but `bun:sqlite` is.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * The active SQLite backend. Kept as a named type so `chimera status` and the
 * per-instance reporting have a stable shape across embedded runtimes.
 */
export type SqliteBackend = 'node-sqlite' | 'bun-sqlite';

export interface CreateDatabaseOptions {
  readOnly?: boolean;
}

type NamedParameterMap = Record<string, unknown>;

function isPlainParameterMap(value: unknown): value is NamedParameterMap {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function expandNamedParameters(value: unknown): unknown {
  if (!isPlainParameterMap(value)) return value;

  const expanded: NamedParameterMap = { ...value };
  for (const [rawKey, paramValue] of Object.entries(value)) {
    const key = rawKey.match(/^[@$:](.+)$/)?.[1] ?? rawKey;
    if (!Object.prototype.hasOwnProperty.call(expanded, key)) {
      expanded[key] = paramValue;
    }
    if (!Object.prototype.hasOwnProperty.call(expanded, `@${key}`)) {
      expanded[`@${key}`] = paramValue;
    }
    if (!Object.prototype.hasOwnProperty.call(expanded, `$${key}`)) {
      expanded[`$${key}`] = paramValue;
    }
    if (!Object.prototype.hasOwnProperty.call(expanded, `:${key}`)) {
      expanded[`:${key}`] = paramValue;
    }
  }

  return expanded;
}

function normalizeStatementParams(params: any[]): any[] {
  return params.map(expandNamedParameters);
}

function simplePragmaValue(row: unknown): unknown {
  return row && typeof row === 'object' ? Object.values(row)[0] : row;
}

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface the rest of the code expects.
 *
 * node:sqlite is real SQLite compiled into Node, so it supports WAL, FTS5,
 * mmap, and `@named` params natively — the only shims needed are the
 * better-sqlite3 conveniences node:sqlite omits: a `.pragma()` helper, a
 * `.transaction()` helper, and `open` (node:sqlite exposes `isOpen`).
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;

  constructor(dbPath: string, options: CreateDatabaseOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._db = options.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    // node:sqlite matches better-sqlite3's calling convention (variadic
    // positional args, or a single object for @named params), so params forward
    // through unchanged.
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    // Write pragma ("key = value"): node:sqlite is real SQLite, so every pragma
    // (WAL, mmap, synchronous, …) applies as-is.
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    // Read pragma. Default: the row object (e.g. { journal_mode: 'wal' }).
    // `{ simple: true }` returns just the single column value, like better-sqlite3.
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return simplePragmaValue(row);
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    // node:sqlite's DatabaseSync.close() throws if already closed; make it
    // idempotent to match better-sqlite3 (callers may close more than once).
    if (this._db.isOpen) this._db.close();
  }
}

/**
 * Wraps Bun's built-in `bun:sqlite` to match the same better-sqlite3-shaped
 * surface as NodeSqliteAdapter.
 *
 * Bun's named parameter binding is stricter than node:sqlite/better-sqlite3:
 * SQL parameters like `@id` require object keys named `@id`, while CodeGraph's
 * query layer passes `{ id: value }`. The statement wrapper expands named
 * parameter objects so the query layer remains backend-agnostic.
 */
class BunSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private _open = true;

  constructor(dbPath: string, options: CreateDatabaseOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite');
    this._db = new Database(dbPath, options.readOnly ? { readonly: true } : undefined);
  }

  get open(): boolean {
    return this._open;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...normalizeStatementParams(params));
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...normalizeStatementParams(params));
      },
      all(...params: any[]) {
        return stmt.all(...normalizeStatementParams(params));
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }

    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return simplePragmaValue(row);
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    if (!this._open) return;
    this._db.close();
    this._open = false;
  }
}

function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).bun === 'string';
}

/**
 * Create a database connection backed by the current runtime's built-in SQLite.
 *
 * Returns the active backend alongside the db so each `DatabaseConnection` can
 * report it per-instance — MCP can open multiple project DBs in one process, so
 * a process-global would race.
 */
export function createDatabase(
  dbPath: string,
  options: CreateDatabaseOptions = {}
): { db: SqliteDatabase; backend: SqliteBackend } {
  const attempts: Array<{
    backend: SqliteBackend;
    open: () => SqliteDatabase;
  }> = isBunRuntime()
    ? [
      { backend: 'bun-sqlite', open: () => new BunSqliteAdapter(dbPath, options) },
      { backend: 'node-sqlite', open: () => new NodeSqliteAdapter(dbPath, options) },
    ]
    : [
      { backend: 'node-sqlite', open: () => new NodeSqliteAdapter(dbPath, options) },
      { backend: 'bun-sqlite', open: () => new BunSqliteAdapter(dbPath, options) },
    ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return { db: attempt.open(), backend: attempt.backend };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${attempt.backend}: ${msg}`);
    }
  }

  throw new Error(
    'Failed to open SQLite via a built-in runtime backend.\n' +
    'CodeGraph requires node:sqlite (Node.js 22.5+) or bun:sqlite when embedded in Bun.\n' +
    `Underlying errors:\n${errors.map((msg) => `- ${msg}`).join('\n')}`
  );
}
