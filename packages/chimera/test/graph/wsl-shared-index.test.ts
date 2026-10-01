/**
 * Windows + WSL sharing one index on a Windows drive (upstream #995, #2061).
 *
 * When Windows-native Chimera and WSL Chimera both open the same graph
 * database under `/mnt/<drive>/`, SQLite's locking and `-shm` shared memory
 * don't hold across the 9p/DrvFs bridge and WSL fails with a bare "disk I/O
 * error". These tests pin both halves of the fork port:
 *
 *  - a fresh WSL index there gets its own `.chimera-wsl`, while an index
 *    already in `.chimera` (or legacy `.codegraph`) stays where it is (no
 *    silent re-index), and
 *  - such an error is rewritten into the `CHIMERA_DATA_DIR=.chimera-wsl`
 *    instruction — only on WSL, only under `/mnt/<drive>`, only for the
 *    default-named index dirs — which MCP answers SUCCESS-shaped (never
 *    `isError`, which would teach the agent to abandon the graph tools).
 *
 * Verification boundary: WSL detection is INJECTED (the way the watch-policy
 * tests inject it), so these run on any host. No real WSL `/mnt/<drive>` path
 * is exercised here — that needs a Windows machine with WSL (see the report's
 * manual-check list). The end-to-end cases raise a REAL SQLite I/O error by
 * planting a FIFO where SQLite expects the `-shm` file: its lock calls fail
 * exactly like a cross-OS lock does.
 */

import { afterEach, beforeEach, describe, expect, it } from './vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/graph/index';
import { DatabaseConnection } from '../../src/graph/db';
import { WslSharedIndexError, isSqliteIoError, toWslSharedIndexError } from '../../src/graph/db/wsl-shared-index';
import { findNearestCodeGraphRoot, getCodeGraphDir, isInitialized, WSL_CHIMERA_DIR } from '../../src/graph/directory';
import { __setWslWindowsDriveForTests, isWslWindowsDrive } from '../../src/graph/sync/watch-policy';
import { ToolHandler } from '../../src/graph/mcp/tools';
import { MCPEngine } from '../../src/graph/mcp/engine';

/** Every path counts as a Windows drive seen from WSL. */
const onWslDrive = (): boolean => true;

const SHARED_DB = '/mnt/c/src/app/.chimera/codegraph.db';

/** A node:sqlite-shaped I/O error (SQLITE_IOERR_LOCK). */
function ioError(): Error {
  return Object.assign(new Error('disk I/O error'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 3850,
    errstr: 'disk I/O error',
  });
}

function sharedIndexError(): WslSharedIndexError {
  return toWslSharedIndexError(ioError(), SHARED_DB, { isWsl: true })!;
}

describe('isSqliteIoError', () => {
  it('matches the whole SQLITE_IOERR family by its extended code', () => {
    for (const errcode of [10, 522, 3850, 4618, 5130]) {
      expect(isSqliteIoError(Object.assign(new Error('x'), { errcode }))).toBe(true);
    }
  });

  it('matches bun:sqlite-shaped string codes', () => {
    expect(isSqliteIoError(Object.assign(new Error('x'), { code: 'SQLITE_IOERR' }))).toBe(true);
    expect(isSqliteIoError(Object.assign(new Error('x'), { code: 'SQLITE_IOERR_LOCK' }))).toBe(true);
    expect(isSqliteIoError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBe(false);
  });

  it('does not match other SQLite failures', () => {
    // BUSY, CORRUPT, CANTOPEN, UNIQUE constraint
    for (const errcode of [5, 11, 14, 2067]) {
      expect(isSqliteIoError(Object.assign(new Error('disk I/O error'), { errcode }))).toBe(false);
    }
  });

  it('falls back to the message when no code survived', () => {
    expect(isSqliteIoError(new Error('disk I/O error'))).toBe(true);
    expect(isSqliteIoError(new Error('database is locked'))).toBe(false);
    expect(isSqliteIoError('disk I/O error')).toBe(false);
    expect(isSqliteIoError(null)).toBe(false);
  });
});

describe('toWslSharedIndexError', () => {
  it('rewrites an I/O error on the default index of a WSL /mnt/<drive> project', () => {
    const original = ioError();
    const err = toWslSharedIndexError(original, SHARED_DB, { isWsl: true });
    expect(err).toBeInstanceOf(WslSharedIndexError);
    expect(err!.name).toBe('WslSharedIndexError');
    expect(err!.message).toContain('disk I/O error on the Chimera graph index at /mnt/c/src/app/.chimera\n');
    expect(err!.message).toContain("Windows and WSL can't share one index on a Windows drive");
    expect(err!.message).toContain('CHIMERA_DATA_DIR=.chimera-wsl');
    expect(err!.message).toContain('chimera graph init');
    // The original stays reachable, and its SQLite codes still read the same.
    expect(err!.cause).toBe(original);
    expect(err!.errcode).toBe(3850);
    expect(err!.code).toBe('ERR_SQLITE_ERROR');
  });

  it('rewrites for the legacy .codegraph index too — Windows opens that name as well', () => {
    const err = toWslSharedIndexError(ioError(), '/mnt/c/src/app/.codegraph/codegraph.db', { isWsl: true });
    expect(err).toBeInstanceOf(WslSharedIndexError);
  });

  it('is idempotent', () => {
    const err = sharedIndexError();
    expect(toWslSharedIndexError(err, SHARED_DB, { isWsl: true })).toBe(err);
  });

  it('leaves the error alone off WSL', () => {
    expect(toWslSharedIndexError(ioError(), SHARED_DB, { isWsl: false })).toBeNull();
  });

  it('leaves the error alone on a native WSL path', () => {
    expect(toWslSharedIndexError(ioError(), '/home/me/app/.chimera/codegraph.db', { isWsl: true })).toBeNull();
  });

  it('does not treat /mnt/wsl (a Linux mount) as a Windows drive', () => {
    expect(toWslSharedIndexError(ioError(), '/mnt/wsl/app/.chimera/codegraph.db', { isWsl: true })).toBeNull();
  });

  it('leaves the error alone when WSL already has its own index directory', () => {
    // The advice would be wrong: CHIMERA_DATA_DIR is already split.
    expect(toWslSharedIndexError(ioError(), '/mnt/c/src/app/.chimera-wsl/codegraph.db', { isWsl: true })).toBeNull();
  });

  it('leaves other SQLite errors alone', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    expect(toWslSharedIndexError(busy, SHARED_DB, { isWsl: true })).toBeNull();
  });

  // Real detection: WSL is a Linux kernel, so on any other host the rewrite
  // can never fire, whatever the path looks like.
  it.runIf(process.platform !== 'linux')('never fires off Linux with real detection', () => {
    expect(toWslSharedIndexError(ioError(), SHARED_DB)).toBeNull();
  });
});

async function makeProject(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sample.ts'), 'export function parseToken() { return 1; }\n');
  await (await CodeGraph.init(dir, { index: true })).close();
}

describe('the data directory on a Windows drive under WSL', () => {
  let root: string;
  const prevChimeraDir = process.env.CHIMERA_DATA_DIR;
  const prevCodegraphDir = process.env.CODEGRAPH_DATA_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-wsl-dir-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function parseToken() { return 1; }\n');
    delete process.env.CHIMERA_DATA_DIR;
    delete process.env.CODEGRAPH_DATA_DIR;
  });

  afterEach(() => {
    __setWslWindowsDriveForTests(null);
    if (prevChimeraDir === undefined) delete process.env.CHIMERA_DATA_DIR;
    else process.env.CHIMERA_DATA_DIR = prevChimeraDir;
    if (prevCodegraphDir === undefined) delete process.env.CODEGRAPH_DATA_DIR;
    else process.env.CODEGRAPH_DATA_DIR = prevCodegraphDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives a fresh project its own .chimera-wsl', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    expect(getCodeGraphDir(root)).toBe(path.join(root, WSL_CHIMERA_DIR));
    const cg = await CodeGraph.init(root, { index: true });
    await cg.close();
    expect(fs.existsSync(path.join(root, '.chimera-wsl', 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.chimera'))).toBe(false);
    // It keeps itself out of git like .chimera does.
    expect(fs.readFileSync(path.join(root, '.chimera-wsl', '.gitignore'), 'utf8')).toContain('*.db');
    expect(findNearestCodeGraphRoot(path.join(root, 'src'))).toBe(path.resolve(root));
  });

  it('keeps an index already built in .chimera, without a re-index', async () => {
    const built = await CodeGraph.init(root, { index: true });
    const nodes = built.getStats().nodeCount;
    await built.close();
    __setWslWindowsDriveForTests(onWslDrive);
    expect(getCodeGraphDir(root)).toBe(path.join(root, '.chimera'));
    expect(isInitialized(root)).toBe(true);
    const reopened = CodeGraph.openSync(root);
    expect(reopened.getStats().nodeCount).toBe(nodes);
    await reopened.close();
    expect(fs.existsSync(path.join(root, '.chimera-wsl'))).toBe(false);
  });

  it('stays on .chimera-wsl after Windows builds a .chimera beside it', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    await (await CodeGraph.init(root, { index: true })).close();
    // Windows-native Chimera indexes the same tree afterwards.
    __setWslWindowsDriveForTests(() => false);
    await (await CodeGraph.init(root, { index: true })).close();
    expect(fs.existsSync(path.join(root, '.chimera', 'codegraph.db'))).toBe(true);
    __setWslWindowsDriveForTests(onWslDrive);
    expect(getCodeGraphDir(root)).toBe(path.join(root, WSL_CHIMERA_DIR));
  });

  it('does not count a .chimera with no database as an index', () => {
    __setWslWindowsDriveForTests(onWslDrive);
    fs.mkdirSync(path.join(root, '.chimera'));
    expect(getCodeGraphDir(root)).toBe(path.join(root, WSL_CHIMERA_DIR));
  });

  it('lets CHIMERA_DATA_DIR decide', () => {
    __setWslWindowsDriveForTests(onWslDrive);
    process.env.CHIMERA_DATA_DIR = '.chimera-custom';
    expect(getCodeGraphDir(root)).toBe(path.join(root, '.chimera-custom'));
    process.env.CHIMERA_DATA_DIR = '.chimera';
    expect(getCodeGraphDir(root)).toBe(path.join(root, '.chimera'));
  });

  it('keeps .chimera off a Windows drive', () => {
    __setWslWindowsDriveForTests(() => false);
    expect(getCodeGraphDir(root)).toBe(path.join(root, '.chimera'));
  });

  // Real detection: only a Linux kernel can be WSL.
  it.runIf(process.platform !== 'linux')('keeps .chimera off Linux with real detection', () => {
    expect(isWslWindowsDrive('/mnt/c/src/app')).toBe(false);
    expect(getCodeGraphDir(root)).toBe(path.join(root, '.chimera'));
  });
});

/** Replace the index's `-shm` with a FIFO: SQLite's first read then fails with a real SQLITE_IOERR. */
function breakSharedMemory(dbPath: string): void {
  fs.rmSync(`${dbPath}-shm`, { force: true });
  execFileSync('mkfifo', [`${dbPath}-shm`]);
}

/** Open like the MCP/CLI paths do, and force the first real read. */
function openAndRead(dbPath: string): void {
  const conn = DatabaseConnection.open(dbPath);
  try {
    conn.getDb().prepare('SELECT count(*) AS n FROM sqlite_master').get();
  } finally {
    try { conn.close(); } catch { /* already failed */ }
  }
}

// mkfifo is POSIX-only.
describe.runIf(process.platform !== 'win32')('a real SQLite I/O error on open', () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-wsl-shared-'));
    await makeProject(root);
    dbPath = path.join(root, '.chimera', 'codegraph.db');
    breakSharedMemory(dbPath);
  });

  afterEach(() => {
    __setWslWindowsDriveForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('surfaces as the actionable message on WSL + /mnt/<drive>', () => {
    __setWslWindowsDriveForTests(onWslDrive);
    let thrown: unknown;
    try {
      openAndRead(dbPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WslSharedIndexError);
    expect((thrown as Error).message).toContain('CHIMERA_DATA_DIR=.chimera-wsl');
    expect((thrown as Error).message).toContain('chimera graph init');
  });

  it('stays a raw SQLite error everywhere else', () => {
    __setWslWindowsDriveForTests(() => false);
    let thrown: unknown;
    try {
      openAndRead(dbPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WslSharedIndexError);
  });

  it('reports the default-project open failure through the MCP engine, not "no project loaded"', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    const engine = new MCPEngine({ watch: false });
    try {
      await engine.ensureInitialized(root);
      const result = await engine.getToolHandler().execute('codegraph_search', { query: 'parseToken' });
      expect(result.isError).not.toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('CHIMERA_DATA_DIR=.chimera-wsl');
      expect(text).toContain('If you are an AI agent');
      expect(text).not.toContain('No CodeGraph project is loaded');
    } finally {
      engine.stop();
    }
  });

  it('keeps the fix on the per-call retry path', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    const engine = new MCPEngine({ watch: false });
    try {
      engine.retryInitializeSync(root);
      const result = await engine.getToolHandler().execute('codegraph_search', { query: 'parseToken' });
      expect(result.isError).not.toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('CHIMERA_DATA_DIR=.chimera-wsl');
    } finally {
      engine.stop();
    }
  });
});

describe('ToolHandler answers the shared-index error success-shaped', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-wsl-tools-'));
    await makeProject(root);
    cg = CodeGraph.openSync(root);
  });

  afterEach(async () => {
    await cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('when a query fails mid-session', async () => {
    cg.searchNodes = () => { throw sharedIndexError(); };
    const result = await new ToolHandler(cg).execute('codegraph_search', { query: 'parseToken' });
    expect(result.isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('CHIMERA_DATA_DIR=.chimera-wsl');
  });

  it('when an explicit projectPath open fails', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    try {
      breakSharedMemory(path.join(root, '.chimera', 'codegraph.db'));
      const handler = new ToolHandler(null);
      const result = await handler.execute('codegraph_search', { query: 'parseToken', projectPath: root });
      expect(result.isError).not.toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('CHIMERA_DATA_DIR=.chimera-wsl');
      handler.closeAll();
    } finally {
      __setWslWindowsDriveForTests(null);
    }
  });

  it('keeps a genuine malfunction an error', async () => {
    cg.searchNodes = () => { throw new Error('disk I/O error'); };
    const result = await new ToolHandler(cg).execute('codegraph_search', { query: 'parseToken' });
    expect(result.isError).toBe(true);
  });

  it('forgets a recorded open failure once a default project loads', async () => {
    const handler = new ToolHandler(null);
    handler.setDefaultOpenFailure(sharedIndexError());
    expect(((await handler.execute('codegraph_search', { query: 'parseToken' })).content[0] as { text: string }).text)
      .toContain('CHIMERA_DATA_DIR=.chimera-wsl');
    handler.setDefaultCodeGraph(cg);
    const result = await handler.execute('codegraph_search', { query: 'parseToken' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('CHIMERA_DATA_DIR');
    expect(text).toContain('parseToken');
  });
});
