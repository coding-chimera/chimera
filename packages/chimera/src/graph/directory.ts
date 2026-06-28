/**
 * Directory Management
 *
 * Manages the Chimera project-local graph data directory structure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createDatabase } from './db/sqlite-adapter';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from './db/migrations';
import { FileLock } from './utils';

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
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeIndexJob(projectRoot: string, job: GraphJobState): void {
  const dataRoot = getCodeGraphDir(projectRoot);
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(getIndexJobPath(projectRoot), JSON.stringify(job, null, 2) + '\n', 'utf-8');
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

export function isInitialized(projectRoot: string): boolean {
  const info = getGraphDataRootInfo(projectRoot);
  return hasDatabase(info.dataRoot);
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
`;
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
    throw new Error(`Chimera graph already initialized in ${projectRoot}`);
  }

  fs.mkdirSync(dataRoot, { recursive: true });
  excludeCodeGraphFromGit(projectRoot);

  const gitignorePath = path.join(dataRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, gitignoreContent(), 'utf-8');
  }
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

  const gitignorePath = path.join(codegraphDir, '.gitignore');
  if (!fs.existsSync(gitignorePath) && repair) {
    try {
      fs.writeFileSync(gitignorePath, gitignoreContent(), 'utf-8');
    } catch {
      errors.push(`.gitignore missing in ${path.basename(codegraphDir)} directory and could not be created`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
