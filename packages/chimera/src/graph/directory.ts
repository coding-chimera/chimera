/**
 * Directory Management
 *
 * Manages the Chimera project-local graph data directory structure.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDatabase } from './db/sqlite-adapter';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from './db/migrations';
import { FileLock, isProcessAlive } from './utils';

export const CHIMERA_DIR = '.chimera';
export const LEGACY_CODEGRAPH_DIR = '.codegraph';
export const CODEGRAPH_DIR = CHIMERA_DIR;
export const DATABASE_FILENAME = 'codegraph.db';
export const INDEX_JOB_FILENAME = 'index-job.json';

export type GraphDataRootStatus = 'uninitialized' | 'current' | 'legacy' | 'mixed' | 'custom';

export type GraphJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type GraphJobKind = 'init' | 'index' | 'sync';

export type LegacyGraphDataProbeStatus = 'missing' | 'compatible-chimera-legacy' | 'incompatible-original-codegraph' | 'unknown-or-corrupt';
export type GraphDataMigrationMode = 'copy' | 'move';

export interface LegacyGraphDataProbe {
  status: LegacyGraphDataProbeStatus;
  legacyRoot: string;
  databasePath: string;
  schemaVersion?: number;
  tables?: string[];
  missingTables?: string[];
  missingColumns?: Record<string, string[]>;
  reason: string;
}

export interface GraphDataMigrationVerification {
  databasePath: string;
  schemaVersion: number;
  integrityCheck: string;
}

export interface GraphDataMigrationResult {
  success: boolean;
  dryRun: boolean;
  mode: GraphDataMigrationMode;
  sourceRoot: string;
  targetRoot: string;
  probe: LegacyGraphDataProbe;
  copiedFiles: string[];
  verification?: GraphDataMigrationVerification;
  migrationPath?: string;
  movedLegacyTo?: string;
  reason?: string;
}
export interface GraphJobState {
  schemaVersion: 1;
  id: string;
  kind: GraphJobKind;
  status: GraphJobStatus;
  pid: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  phase?: string;
  current?: number;
  total?: number;
  currentFile?: string;
  message?: string;
  error?: string;
}

export interface GraphDataRootInfo {
  projectRoot: string;
  dataRoot: string;
  dataRootStatus: GraphDataRootStatus;
  currentRoot: string;
  legacyRoot: string;
  databasePath: string;
  hasCurrent: boolean;
  hasLegacy: boolean;
  explicit: boolean;
}

function configuredDataRoot(projectRoot: string): string | undefined {
  const configured = process.env.CHIMERA_DATA_DIR || process.env.CODEGRAPH_DATA_DIR;
  if (!configured) return undefined;
  return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
}

function hasDatabase(dataRoot: string): boolean {
  return fs.existsSync(path.join(dataRoot, DATABASE_FILENAME));
}

function dataRootStatus(input: { explicit: boolean; hasCurrent: boolean; hasLegacy: boolean }): GraphDataRootStatus {
  if (input.explicit) return 'custom';
  if (input.hasCurrent && input.hasLegacy) return 'mixed';
  if (input.hasCurrent) return 'current';
  if (input.hasLegacy) return 'legacy';
  return 'uninitialized';
}

export function getCurrentCodeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, CHIMERA_DIR);
}

export function getLegacyCodeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, LEGACY_CODEGRAPH_DIR);
}

export function getGraphDataRootInfo(projectRoot: string): GraphDataRootInfo {
  const root = path.resolve(projectRoot);
  const explicitRoot = configuredDataRoot(root);
  const currentRoot = getCurrentCodeGraphDir(root);
  const legacyRoot = getLegacyCodeGraphDir(root);
  const hasCurrent = hasDatabase(currentRoot);
  const hasLegacy = hasDatabase(legacyRoot);
  const dataRoot = explicitRoot ?? (hasCurrent ? currentRoot : hasLegacy ? legacyRoot : currentRoot);
  return {
    projectRoot: root,
    dataRoot,
    dataRootStatus: dataRootStatus({ explicit: Boolean(explicitRoot), hasCurrent, hasLegacy }),
    currentRoot,
    legacyRoot,
    databasePath: path.join(dataRoot, DATABASE_FILENAME),
    hasCurrent,
    hasLegacy,
    explicit: Boolean(explicitRoot),
  };
}

export function getCodeGraphDir(projectRoot: string): string {
  return getGraphDataRootInfo(projectRoot).dataRoot;
}

export function getIndexJobPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), INDEX_JOB_FILENAME);
}

export function readIndexJob(projectRoot: string): GraphJobState | undefined {
  const jobPath = getIndexJobPath(projectRoot);
  if (!fs.existsSync(jobPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as GraphJobState;
    if (parsed.schemaVersion !== 1) return undefined;
    if (parsed.status === 'running' && parsed.pid !== process.pid && !isProcessAlive(parsed.pid)) {
      const interruptedDetail = parsed.message ? `; ${parsed.message}` : '';
      return {
        ...parsed,
        status: 'failed' as const,
        message: `interrupted: process ${parsed.pid} exited before completion${interruptedDetail}`,
      };
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeIndexJob(projectRoot: string, job: GraphJobState): void {
  const dataRoot = getCodeGraphDir(projectRoot);
  const jobPath = getIndexJobPath(projectRoot);
  const temporaryPath = `${jobPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(dataRoot, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(job, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(temporaryPath, jobPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* ignore */ }
  }
}

export function startIndexJob(projectRoot: string, kind: GraphJobKind, message?: string): GraphJobState {
  const now = new Date().toISOString();
  const job: GraphJobState = {
    schemaVersion: 1,
    id: `${kind}:${process.pid}:${Date.now()}`,
    kind,
    status: 'running',
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    message,
  };
  writeIndexJob(projectRoot, job);
  return job;
}

export function updateIndexJob(projectRoot: string, job: GraphJobState, update: Partial<Pick<GraphJobState, 'phase' | 'current' | 'total' | 'currentFile' | 'message'>>): GraphJobState {
  const next: GraphJobState = {
    ...job,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  writeIndexJob(projectRoot, next);
  return next;
}

export function finishIndexJob(projectRoot: string, job: GraphJobState, status: Extract<GraphJobStatus, 'succeeded' | 'failed'>, update: Partial<Pick<GraphJobState, 'phase' | 'current' | 'total' | 'message' | 'error'>> = {}): GraphJobState {
  const now = new Date().toISOString();
  const next: GraphJobState = {
    ...job,
    ...update,
    status,
    updatedAt: now,
    finishedAt: now,
  };
  writeIndexJob(projectRoot, next);
  return next;
}

/**
 * Check if a project has been initialized with a Chimera graph.
 *
 * Requires the database file to exist AND to carry the graph schema. A file
 * that merely exists — empty, or a SQLite database with no tables, as an
 * interrupted `init` or a stray `touch` leaves behind — used to count as
 * initialized, so one such file in an ANCESTOR directory (worst case: $HOME)
 * captured the upward resolution of every project beneath it and made their
 * real indexes unreachable (upstream #1895/#2083).
 *
 * The probe is cheap and gated so hot callers (prompt-context loading, MCP
 * root resolution on every call) pay one `stat`: file size first, then a
 * read-only SQLite `sqlite_master` lookup, memoized per path + mtime + size
 * so an unchanged db is never reopened. A database that cannot be inspected
 * counts as initialized (fail open, see probeSchema) — only a proven-absent
 * schema, or a file SQLite refuses as not a database, says no.
 */
export function isInitialized(projectRoot: string): boolean {
  const info = getGraphDataRootInfo(projectRoot);
  if (!hasDatabase(info.dataRoot)) return false;
  let st: fs.Stats;
  try {
    st = fs.statSync(info.databasePath);
  } catch {
    return false;
  }
  return hasGraphSchema(st, info.databasePath);
}

/** A SQLite file header is 100 bytes; anything shorter cannot hold a schema. */
const SQLITE_HEADER_SIZE = 100;
/** SQLITE_NOTADB: SQLite read the file and it is not a database. */
const SQLITE_NOTADB = 26;
const schemaProbeCache = new Map<string, { mtimeMs: number; size: number; ok: boolean }>();

function hasGraphSchema(st: fs.Stats, dbPath: string): boolean {
  if (!st.isFile() || st.size < SQLITE_HEADER_SIZE) return false;
  const cached = schemaProbeCache.get(dbPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.ok;
  const probe = probeSchema(dbPath);
  const ok = probe === 'schema' || probe === 'unknown';
  schemaProbeCache.set(dbPath, { mtimeMs: st.mtimeMs, size: st.size, ok });
  return ok;
}

/**
 * What the database file holds, asked of SQLite itself through a read-only
 * connection: the graph schema, a database without it, not a database at all
 * (SQLITE_NOTADB), or `unknown` — locked, busy, a WAL db where `-shm` cannot
 * be created (read-only checkout, mount, another user's tree), disk I/O.
 * Callers treat `unknown` as initialized: the pre-existing behaviour for a
 * database we cannot inspect (upstream #1895 review hardening).
 *
 * The file is never read through a descriptor of our own, not even for its
 * header: closing ANY descriptor on a database file drops every POSIX lock
 * this process holds on it, including those of a connection it already has
 * open (sqlite.org/howtocorrupt.html §2.2.1) — and the MCP server resolves
 * projects through isInitialized on every call while it holds the index as
 * its writer. SQLite's own connections share one lock table per file, so a
 * second connection opened and closed here leaves the first one's locks
 * alone.
 */
function probeSchema(dbPath: string): 'schema' | 'no-schema' | 'not-sqlite' | 'unknown' {
  try {
    const connection = createDatabase(dbPath, { readOnly: true });
    try {
      const row = connection.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get();
      return row !== undefined && row !== null ? 'schema' : 'no-schema';
    } finally {
      // Never hold the handle: Windows file locking would block the owner.
      try { connection.db.close(); } catch { /* already closed */ }
    }
  } catch (error) {
    const err = error as { errcode?: number; code?: string | number };
    return err?.errcode === SQLITE_NOTADB || err?.code === SQLITE_NOTADB || err?.code === 'SQLITE_NOTADB'
      ? 'not-sqlite'
      : 'unknown';
  }
}

/**
 * The graph database exists at `projectRoot` but does not carry the schema,
 * and `init` can add it in place (the schema is idempotent CREATE ... IF NOT
 * EXISTS): an empty file, or a SQLite database without the graph tables
 * (upstream #1895/#2083). A file that is not SQLite at all is NOT this case —
 * see {@link hasForeignDbFile}.
 */
export function hasSchemalessDb(projectRoot: string): boolean {
  const dbPath = getGraphDataRootInfo(projectRoot).databasePath;
  let st: fs.Stats;
  try { st = fs.statSync(dbPath); } catch { return false; }
  if (!st.isFile() || isInitialized(projectRoot)) return false;
  return st.size === 0 || probeSchema(dbPath) === 'no-schema';
}

/**
 * The graph database exists at `projectRoot` and is not a SQLite database:
 * SQLite refuses to open it, so `init` cannot rebuild it in place. The caller
 * must say so rather than promise a repair; nothing here deletes the file.
 */
export function hasForeignDbFile(projectRoot: string): boolean {
  const dbPath = getGraphDataRootInfo(projectRoot).databasePath;
  let st: fs.Stats;
  try { st = fs.statSync(dbPath); } catch { return false; }
  return st.isFile() && st.size > 0 && probeSchema(dbPath) === 'not-sqlite';
}

export function findNearestCodeGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (isInitialized(current)) return current;
  return null;
}

/**
 * Reason a directory is unsafe to use as an index ROOT, or null when it's fine.
 *
 * Indexing your home directory or a filesystem root drags in caches, every
 * other project, etc. — a multi-GB index and constant file-watcher churn
 * (upstream #845). These are never intended project roots, so `init`/`index`
 * refuse them (overridable with `--force`).
 *
 * Pure-ish (reads only `os.homedir()` + realpath) so it's easy to unit-test.
 * The returned string is a human phrase that slots into "… looks like {reason}".
 */
export function unsafeIndexRootReason(projectRoot: string): string | null {
  const resolve = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = resolve(projectRoot);

  // Filesystem root: `/` on POSIX, a drive root like `C:\` on Windows.
  if (path.parse(resolved).root === resolved) {
    return 'the filesystem root';
  }

  const home = resolve(os.homedir());
  // Case-insensitive on macOS/Windows (case-preserving but case-insensitive FS).
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  const r = norm(resolved);
  const h = norm(home);

  if (r === h) {
    return 'your home directory';
  }
  // An ancestor of home (e.g. `/Users`, `/home`) — even broader than home.
  if (h.startsWith(r + path.sep)) {
    return 'a parent of your home directory';
  }
  return null;
}

function getGitDir(projectRoot: string): string | null {
  const gitPath = path.join(projectRoot, '.git');
  if (!fs.existsSync(gitPath)) return null;

  const stat = fs.lstatSync(gitPath);
  if (stat.isDirectory()) return gitPath;
  if (!stat.isFile()) return null;

  const match = fs.readFileSync(gitPath, 'utf-8').match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) return null;

  return path.resolve(projectRoot, match[1]);
}

function excludeCodeGraphFromGit(projectRoot: string): void {
  try {
    const gitDir = getGitDir(projectRoot);
    if (!gitDir) return;

    const infoDir = path.join(gitDir, 'info');
    const excludePath = path.join(infoDir, 'exclude');
    fs.mkdirSync(infoDir, { recursive: true });

    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    const lines = existing.split(/\r?\n/).map((line) => line.trim());
    const missing = [CHIMERA_DIR, LEGACY_CODEGRAPH_DIR].filter((dir) => !lines.includes(dir) && !lines.includes(`${dir}/`));
    if (missing.length === 0) return;

    fs.appendFileSync(
      excludePath,
      `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}# Chimera local graph index\n${missing.map((dir) => `${dir}/`).join('\n')}\n`,
      'utf-8',
    );
  } catch {
  }
}

function gitignoreContent(): string {
  return `# Chimera local graph data
# These files are local to each machine and should not be committed

# Database
*.db
*.db-wal
*.db-shm

# Cache
cache/

# Logs
*.log

# Jobs
${INDEX_JOB_FILENAME}

# Hook markers
.dirty

# Config
node_modules
package.json
package-lock.json
bun.lock
.gitignore
`;
}

/**
 * Ensure the graph data root's .gitignore carries the graph rules and is
 * convergent with the config-side writer (which only writes when missing):
 * re-write as the superset template plus any custom lines when graph rules
 * are absent, leave a file that already has them untouched.
 */
function ensureGraphGitignore(dataRoot: string): void {
  const gitignorePath = path.join(dataRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, gitignoreContent(), 'utf-8');
    return;
  }
  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  if (existing.includes('*.db')) return;
  const templateLines = new Set(gitignoreContent().split('\n').map((line) => line.trim()));
  const customLines = existing.split(/\r?\n/).filter((line) => line.trim() !== '' && !templateLines.has(line.trim()));
  const preserved = customLines.length > 0 ? `\n# Preserved custom entries\n${customLines.join('\n')}\n` : '';
  fs.writeFileSync(gitignorePath, gitignoreContent() + preserved, 'utf-8');
}
const REQUIRED_CHIMERA_TABLES = ['schema_versions', 'nodes', 'edges', 'files', 'unresolved_refs'] as const;

const REQUIRED_CHIMERA_COLUMNS: Record<string, readonly string[]> = {
  schema_versions: ['version', 'applied_at', 'description'],
  nodes: ['id', 'kind', 'name', 'qualified_name', 'file_path', 'language', 'start_line', 'end_line', 'start_column', 'end_column', 'updated_at'],
  edges: ['id', 'source', 'target', 'kind', 'metadata', 'line', 'col'],
  files: ['path', 'content_hash', 'language', 'size', 'modified_at', 'indexed_at', 'node_count', 'errors'],
  unresolved_refs: ['id', 'from_node_id', 'reference_name', 'reference_kind', 'line', 'col'],
};

function readTableNames(dbPath: string) {
  const connection = createDatabase(dbPath, { readOnly: true });
  try {
    const tables = (connection.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>).map((row) => row.name);
    const version = tables.includes('schema_versions')
      ? connection.db.prepare('SELECT MAX(version) AS version FROM schema_versions').get() as { version: number | null } | undefined
      : undefined;
    const missingTables = REQUIRED_CHIMERA_TABLES.filter((table) => !tables.includes(table));
    const missingColumns = Object.fromEntries(
      Object.entries(REQUIRED_CHIMERA_COLUMNS).flatMap(([table, required]) => {
        if (!tables.includes(table)) return [];
        const columns = (connection.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
        const missing = required.filter((column) => !columns.includes(column));
        return missing.length ? [[table, missing]] : [];
      }),
    );
    return { tables, schemaVersion: version?.version ?? 0, missingTables, missingColumns };
  } finally {
    connection.db.close();
  }
}

function quickCheckResult(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entry = record.quick_check ?? record.integrity_check;
    if (typeof entry === 'string') return entry;
  }
  return String(value ?? 'unknown');
}

function verifyMigratedGraphDataRoot(targetRoot: string): GraphDataMigrationVerification {
  const databasePath = path.join(targetRoot, DATABASE_FILENAME);
  if (!fs.existsSync(databasePath)) throw new Error(`migrated ${DATABASE_FILENAME} is missing`);
  const connection = createDatabase(databasePath);
  try {
    const currentVersion = getCurrentVersion(connection.db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) runMigrations(connection.db, currentVersion);
    const integrityCheck = quickCheckResult(connection.db.prepare('PRAGMA quick_check').get());
    if (integrityCheck !== 'ok') throw new Error(`quick_check returned ${integrityCheck}`);
  } finally {
    connection.db.close();
  }

  const probe = readTableNames(databasePath);
  if (probe.schemaVersion <= 0) throw new Error('database does not contain Chimera schema_versions metadata');
  if (probe.missingTables.length > 0 || Object.keys(probe.missingColumns).length > 0) {
    throw new Error('database schema does not match Chimera graph schema after migration');
  }

  return {
    databasePath,
    schemaVersion: probe.schemaVersion,
    integrityCheck: 'ok',
  };
}

function nonEmptyDirectory(dir: string) {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

function copyGraphDataDirectory(source: string, target: string, prefix = ''): string[] {
  const copied: string[] = [];
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'codegraph.lock') continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copied.push(...copyGraphDataDirectory(sourcePath, targetPath, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied.push(relativePath);
  }
  return copied;
}

function timestampSlug(input: string) {
  return input.replace(/[^0-9]/g, '').slice(0, 14) || String(Date.now());
}

function uniqueLegacyBackupPath(legacyRoot: string, now: string) {
  const base = `${legacyRoot}.legacy-${timestampSlug(now)}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate legacy backup path for ${legacyRoot}`);
}

export function probeLegacyGraphDataRoot(projectRoot: string): LegacyGraphDataProbe {
  const root = path.resolve(projectRoot);
  const legacyRoot = getLegacyCodeGraphDir(root);
  const databasePath = path.join(legacyRoot, DATABASE_FILENAME);
  if (!fs.existsSync(databasePath)) {
    return {
      status: 'missing',
      legacyRoot,
      databasePath,
      reason: `No legacy ${LEGACY_CODEGRAPH_DIR}/${DATABASE_FILENAME} found`,
    };
  }

  try {
    const probe = readTableNames(databasePath);
    if (probe.schemaVersion <= 0) {
      return {
        status: 'incompatible-original-codegraph',
        legacyRoot,
        databasePath,
        schemaVersion: probe.schemaVersion,
        tables: probe.tables,
        reason: 'database does not contain Chimera schema_versions metadata',
      };
    }
    if (probe.schemaVersion > CURRENT_SCHEMA_VERSION) {
      return {
        status: 'unknown-or-corrupt',
        legacyRoot,
        databasePath,
        schemaVersion: probe.schemaVersion,
        tables: probe.tables,
        reason: `database schema version ${probe.schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`,
      };
    }
    if (probe.missingTables.length > 0 || Object.keys(probe.missingColumns).length > 0) {
      return {
        status: 'incompatible-original-codegraph',
        legacyRoot,
        databasePath,
        schemaVersion: probe.schemaVersion,
        tables: probe.tables,
        missingTables: probe.missingTables,
        missingColumns: probe.missingColumns,
        reason: 'database schema does not match Chimera graph schema; refusing to migrate possible original CodeGraph data',
      };
    }
    return {
      status: 'compatible-chimera-legacy',
      legacyRoot,
      databasePath,
      schemaVersion: probe.schemaVersion,
      tables: probe.tables,
      reason: 'legacy .codegraph database matches Chimera graph schema',
    };
  } catch (error) {
    return {
      status: 'unknown-or-corrupt',
      legacyRoot,
      databasePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function migrateLegacyGraphData(projectRoot: string, options: { dryRun?: boolean; mode?: GraphDataMigrationMode; force?: boolean; now?: string } = {}): GraphDataMigrationResult {
  const root = path.resolve(projectRoot);
  const probe = probeLegacyGraphDataRoot(root);
  const mode = options.mode ?? 'copy';
  const dryRun = options.dryRun ?? false;
  const targetRoot = getCurrentCodeGraphDir(root);
  const baseResult = {
    dryRun,
    mode,
    sourceRoot: probe.legacyRoot,
    targetRoot,
    probe,
    copiedFiles: [] as string[],
  };
  if (probe.status !== 'compatible-chimera-legacy') {
    return {
      ...baseResult,
      success: false,
      reason: probe.reason,
    };
  }
  if (nonEmptyDirectory(targetRoot) && !options.force) {
    return {
      ...baseResult,
      success: false,
      reason: `${CHIMERA_DIR} already exists and is not empty; pass --force to replace it`,
    };
  }
  if (dryRun) return { ...baseResult, success: true, reason: 'dry run only; no files copied' };

  const lock = new FileLock(path.join(probe.legacyRoot, 'codegraph.lock'));
  let copiedFiles: string[] = [];
  lock.acquire();
  try {
    if (fs.existsSync(targetRoot) && options.force) fs.rmSync(targetRoot, { recursive: true, force: true });
    copiedFiles = copyGraphDataDirectory(probe.legacyRoot, targetRoot);
  } finally {
    lock.release();
  }

  let verification: GraphDataMigrationVerification;
  try {
    verification = verifyMigratedGraphDataRoot(targetRoot);
  } catch (error) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    return {
      ...baseResult,
      success: false,
      copiedFiles,
      reason: `Migrated data verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const now = options.now ?? new Date().toISOString();
  const movedLegacyTo = mode === 'move' ? uniqueLegacyBackupPath(probe.legacyRoot, now) : undefined;
  if (movedLegacyTo) fs.renameSync(probe.legacyRoot, movedLegacyTo);
  const migrationPath = path.join(targetRoot, 'migration.json');
  fs.writeFileSync(
    migrationPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceRoot: probe.legacyRoot,
      targetRoot,
      mode,
      migratedAt: now,
      movedLegacyTo,
      probe,
      copiedFiles,
      verification,
    }, null, 2) + '\n',
    'utf-8',
  );
  excludeCodeGraphFromGit(root);

  return {
    ...baseResult,
    success: true,
    copiedFiles,
    verification,
    migrationPath,
    movedLegacyTo,
  };
}

export function createDirectory(projectRoot: string): void {
  const info = getGraphDataRootInfo(projectRoot);
  const dataRoot = info.explicit ? info.dataRoot : info.currentRoot;
  const dbPath = path.join(dataRoot, DATABASE_FILENAME);

  if (fs.existsSync(dbPath)) {
    // An existing file only blocks init when it is a live graph database.
    // A schema-less db (an interrupted init, a stray touch) is repaired in
    // place — the schema applies with CREATE ... IF NOT EXISTS — and a
    // non-SQLite file is refused by name; nothing is deleted automatically
    // (upstream #1895/#2083). A db we cannot inspect fails open as
    // initialized, matching isInitialized.
    let st: fs.Stats | null = null;
    try { st = fs.statSync(dbPath); } catch { /* vanished mid-check */ }
    if (st) {
      const probe = st.isFile() && st.size >= SQLITE_HEADER_SIZE ? probeSchema(dbPath) : 'no-schema';
      if (probe === 'not-sqlite') {
        throw new Error(`${dbPath} is not a SQLite database; move or delete it before initializing`);
      }
      if (probe === 'schema' || probe === 'unknown') {
        throw new Error(`Chimera graph already initialized in ${projectRoot}`);
      }
    }
  }

  fs.mkdirSync(dataRoot, { recursive: true });
  excludeCodeGraphFromGit(projectRoot);
  ensureGraphGitignore(dataRoot);
}

export function removeDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return;
  }

  const lstat = fs.lstatSync(codegraphDir);
  if (lstat.isSymbolicLink()) {
    fs.unlinkSync(codegraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    fs.unlinkSync(codegraphDir);
    return;
  }

  fs.rmSync(codegraphDir, { recursive: true, force: true });
}

export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
        continue;
      }
      files.push(relativePath);
    }
  }

  walkDir(codegraphDir);
  return files;
}

export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }
      const stats = fs.statSync(fullPath);
      totalSize += stats.size;
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

export function validateDirectory(projectRoot: string, options: { repair?: boolean } = {}): {
  valid: boolean;
  errors: string[];
} {
  const repair = options.repair ?? true;
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('Chimera graph data directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push(`${path.basename(codegraphDir)} exists but is not a directory`);
    return { valid: false, errors };
  }

  if (repair) {
    try {
      ensureGraphGitignore(codegraphDir);
    } catch {
      errors.push(`.gitignore in ${path.basename(codegraphDir)} directory could not be created or updated`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
