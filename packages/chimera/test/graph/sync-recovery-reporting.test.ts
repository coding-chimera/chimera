/**
 * Sync reporting + lock-contention contract (upstream #1360/#2024 and
 * #1361/#2014).
 *
 * #2024: the orphan-sweep outcome rides on SyncResult (pendingRefsProcessed/
 * Resolved/Unresolved) so the CLI can report a pending-reference recovery
 * even when no file changed — previously the sweep discarded its resolver
 * statistics and a recovery looked like a no-op.
 *
 * #2014: a sync that cannot take the cross-process write lock THROWS
 * LockUnavailableError instead of returning an all-zero result that is
 * indistinguishable from a clean, up-to-date index. The watcher recognizes
 * the typed error (keeps pending files, retries); the CLI reports failure.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
const { default: CodeGraph } = await import('../../src/graph/index');
const { LockUnavailableError } = await import('../../src/graph/sync/watcher');
const { FileLock } = await import('../../src/graph/utils');
const { getCodeGraphDir } = await import('../../src/graph/directory');
const { QueryBuilder } = await import('../../src/graph/db/queries');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('sync reporting and lock contention (upstream #2024/#2014)', () => {
  let testDir: string;
  let cg: import('../../src/graph/index').default | null = null;

  beforeEach(async () => {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-reporting-')));
    fs.writeFileSync(
      path.join(testDir, 'index.ts'),
      'export function caller() { return target(); }\nexport function target() { return 1; }\n',
    );
    cg = await CodeGraph.init(testDir, { index: true });
  });

  afterEach(async () => {
    if (cg) {
      try { await cg.close(); } catch { /* best-effort */ }
      cg = null;
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const queries = () => (cg as unknown as { queries: InstanceType<typeof QueryBuilder> }).queries;

  it.each([true, false])('reports sweep outcomes without file changes (resolvable=%s)', async (resolvable) => {
    const caller = cg!.searchNodes('caller').find((r) => r.node.name === 'caller')!.node;
    queries().insertUnresolvedRef({
      fromNodeId: caller.id,
      referenceName: resolvable ? 'target' : 'missingTarget',
      referenceKind: 'calls',
      line: 1,
      column: 35,
      filePath: 'index.ts',
      language: 'typescript',
    } as never);
    expect(queries().getUnresolvedReferencesCount()).toBe(1);

    const result = await cg!.sync();
    expect(result.filesAdded).toBe(0);
    expect(result.filesModified).toBe(0);
    expect(result.filesRemoved).toBe(0);
    expect(result.pendingRefsProcessed).toBe(1);
    expect(result.pendingRefsResolved).toBe(resolvable ? 1 : 0);
    expect(result.pendingRefsUnresolved).toBe(resolvable ? 0 : 1);
    // Resolved rows leave the pending set; unresolvable ones park as failed.
    expect(queries().getUnresolvedReferencesCount()).toBe(0);

    // A genuine no-op reports zero counters (the CLI keeps saying
    // "Already up to date" for this shape).
    const unchanged = await cg!.sync();
    expect(unchanged.pendingRefsProcessed).toBe(0);
    expect(unchanged.pendingRefsResolved).toBe(0);
    expect(unchanged.pendingRefsUnresolved).toBe(0);
  }, 60_000);

  it('sync() and syncFiles() throw LockUnavailableError under external lock contention', async () => {
    const lock = new FileLock(path.join(getCodeGraphDir(testDir), 'codegraph.lock'));
    lock.acquire();
    try {
      let syncErr: unknown;
      try {
        await cg!.sync();
      } catch (err) {
        syncErr = err;
      }
      expect(syncErr).toBeInstanceOf(LockUnavailableError);

      let scopedErr: unknown;
      try {
        await cg!.syncFiles(['index.ts']);
      } catch (err) {
        scopedErr = err;
      }
      expect(scopedErr).toBeInstanceOf(LockUnavailableError);
    } finally {
      lock.release();
    }

    // After release the same instance syncs cleanly again.
    const recovered = await cg!.sync();
    expect(recovered.filesChecked).toBeGreaterThan(0);
  }, 60_000);
});
