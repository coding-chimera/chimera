/**
 * Replaced-database follow tests (upstream #1902 / #1917).
 *
 * A long-lived CodeGraph instance (the MCP daemon's watcher) holds an open
 * handle on `.chimera/codegraph.db`. A full rebuild in another process
 * removes the data root and creates a NEW database file at the same path —
 * the old handle now writes into an unlinked inode and nothing it records
 * reaches disk. These tests pin the fork's semantic port:
 *
 *   - sync() follows the replaced file (one stat under the index mutex),
 *     reopens in place, and reconciles the whole tree once;
 *   - a sync landing in the rebuild gap (fresh file, nothing indexed yet)
 *     reports LockUnavailableError so the watcher keeps its pending files
 *     and retries instead of counting the step-aside as a clean sync;
 *   - once the rebuild finishes, the retry reconciles successfully.
 *
 * POSIX-only: the dev/ino replacement check never fires on Windows (an open
 * file can't be unlinked there, and st_ino is unreliable) — same boundary
 * upstream draws.
 */

import { describe, it, expect, afterEach } from './vitest';
const { default: CodeGraph } = await import('../../src/graph/index');
const { LockUnavailableError } = await import('../../src/graph/sync/watcher');
const { getCodeGraphDir } = await import('../../src/graph/directory');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const posixOnly = it.skipIf(process.platform === 'win32');

describe('CodeGraph follows a replaced database (upstream #1902/#1917)', () => {
  let testDir: string;
  let daemon: InstanceType<typeof CodeGraph> | null = null;

  afterEach(async () => {
    if (daemon) {
      try { await daemon.close(); } catch { /* best-effort */ }
      daemon = null;
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function makeProject(): string {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-replaced-db-')));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), 'export const a = 1;');
    return testDir;
  }

  /** Wipe the data root and rebuild a fresh, fully indexed database at the same path. */
  async function rebuildWithDataRootRecreated(extraFile = true): Promise<void> {
    fs.rmSync(getCodeGraphDir(testDir), { recursive: true, force: true });
    if (extraFile) {
      fs.writeFileSync(path.join(testDir, 'src', 'second.ts'), 'export const b = 2;');
    }
    const rebuilder = await CodeGraph.init(testDir, { index: true });
    await rebuilder.close();
  }

  posixOnly('sync() reopens a database replaced on disk and sees the rebuilt content', async () => {
    makeProject();
    daemon = await CodeGraph.init(testDir, { index: true });
    expect(daemon.searchNodes('a').length).toBeGreaterThan(0);

    await rebuildWithDataRootRecreated();

    // The daemon still holds the OLD (unlinked) handle. sync() must follow
    // the replaced file instead of writing into the dead inode.
    const result = await daemon.sync();
    expect(result.filesChecked).toBeGreaterThan(0);

    // Full catch-up reconcile: the file the rebuild indexed is visible
    // through the reopened handle.
    expect(daemon.searchNodes('b').length).toBeGreaterThan(0);
  }, 60_000);

  posixOnly('sync() reports lock contention during the rebuild gap, then reconciles once done', async () => {
    makeProject();
    daemon = await CodeGraph.init(testDir, { index: true });

    // Recreate the data root but leave the fresh database UNindexed — this is
    // the gap between "index recreated the file" and "indexAll took the lock".
    fs.rmSync(getCodeGraphDir(testDir), { recursive: true, force: true });
    fs.writeFileSync(path.join(testDir, 'src', 'second.ts'), 'export const b = 2;');
    const rebuilder = await CodeGraph.init(testDir);

    // A sync landing in the gap steps aside as lock contention (the watcher
    // keeps its pending files and retries) instead of reconciling an empty
    // file and holding the lock the rebuild is about to request.
    let caught: unknown;
    try {
      await daemon.sync();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockUnavailableError);

    // Finish the rebuild; the retry now follows the new file and reconciles.
    await rebuilder.indexAll();
    await rebuilder.close();

    const result = await daemon.sync();
    expect(result.filesChecked).toBeGreaterThan(0);
    expect(daemon.searchNodes('b').length).toBeGreaterThan(0);
  }, 60_000);

  posixOnly('reopenIfReplaced() self-heals the tool-call path and is idempotent afterwards', async () => {
    makeProject();
    daemon = await CodeGraph.init(testDir, { index: true });

    await rebuildWithDataRootRecreated();

    // No sync in flight: the tool-call self-heal follows the replaced file.
    expect(daemon.reopenIfReplaced()).toBe(true);
    // A second call is a no-op — the live file is already followed.
    expect(daemon.reopenIfReplaced()).toBe(false);
    expect(daemon.searchNodes('b').length).toBeGreaterThan(0);
  }, 60_000);
});
