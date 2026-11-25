/**
 * Graph write queue: serial execution, explicit backpressure, dedupe, RPC
 * result/error/progress, abort semantics, crash cleanup, and drain+close.
 *
 * These tests drive the real worker_threads writer (one per root) against a
 * real on-disk graph; nothing here mocks the queue or the CodeGraph handle.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { getCodeGraphDir } from '../../src/graph/directory';
import { FileLock } from '../../src/graph/utils';
import type { IndexResult, SyncResult } from '../../src/graph/extraction';
import {
  __crashGraphWriterForTest,
  busyGraphWriter,
  closeGraphWriter,
  drainGraphWriter,
  enqueueGraphWrite,
  ensureGraphWriterReady,
  GraphWriterAbortError,
  GraphWriterBackpressureError,
  GraphWriterCrashError,
  graphWriterCountForTest,
  graphWriterLiveCountForTest,
  graphWriterSpawnCountForTest,
  hasGraphWriterForTest,
  type GraphWriterOutcome,
} from '../../src/graph/worker';
import { GRAPH_WRITER_MAX_PENDING } from '../../src/graph/worker/protocol';

const roots = new Set<string>();

function createProject(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-writer-')));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  CodeGraph.initSync(dir).close();
  roots.add(dir);
  return dir;
}

function writeMany(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    files[`src/file-${index}.ts`] = `export function fn${index}(value: number) { return value + ${index}; }\n`;
  }
  return files;
}

const isSyncResult = (result: IndexResult | SyncResult): result is SyncResult => 'filesAdded' in result;

describe('graph write queue', () => {
  beforeEach(() => {
    roots.clear();
  });

  afterEach(async () => {
    for (const root of roots) {
      await closeGraphWriter(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  it('runs writes for one root serially and in enqueue order', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    await ensureGraphWriterReady(root);

    const completed: string[] = [];
    const track = (label: string) => (outcome: GraphWriterOutcome) => {
      completed.push(label);
      return outcome;
    };

    const outcomes = await Promise.all([
      enqueueGraphWrite(root, { kind: 'syncFiles', files: ['src/a.ts'] }).then(track('syncFiles')),
      enqueueGraphWrite(root, { kind: 'sync' }).then(track('sync')),
      enqueueGraphWrite(root, { kind: 'indexFiles', files: ['src/a.ts'] }).then(track('indexFiles')),
      enqueueGraphWrite(root, { kind: 'indexAll' }).then(track('indexAll')),
    ]);

    expect(completed).toEqual(['syncFiles', 'sync', 'indexFiles', 'indexAll']);
    for (const outcome of outcomes) expect(typeof outcome.databaseReplaced).toBe('boolean');
    expect(busyGraphWriter(root)).toBe(false);
  }, 120_000);

  it('rejects past GRAPH_WRITER_MAX_PENDING with explicit backpressure', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    await ensureGraphWriterReady(root);

    const accepted: Array<Promise<GraphWriterOutcome>> = [];
    for (let index = 0; index < GRAPH_WRITER_MAX_PENDING; index++) {
      accepted.push(enqueueGraphWrite(root, { kind: 'indexFiles', files: [] }));
    }
    await expect(enqueueGraphWrite(root, { kind: 'indexFiles', files: [] })).rejects.toBeInstanceOf(
      GraphWriterBackpressureError,
    );
    expect(busyGraphWriter(root)).toBe(true);

    await drainGraphWriter(root);
    await Promise.all(accepted);
    expect(busyGraphWriter(root)).toBe(false);
  }, 120_000);

  it('rejects an already-aborted write and drops a queued write on abort', async () => {
    const root = createProject(writeMany(40));
    await ensureGraphWriterReady(root);

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      enqueueGraphWrite(root, { kind: 'sync', signal: preAborted.signal }),
    ).rejects.toBeInstanceOf(GraphWriterAbortError);

    const first = enqueueGraphWrite(root, { kind: 'indexAll' });
    const queuedController = new AbortController();
    const queued = enqueueGraphWrite(root, {
      kind: 'syncFiles',
      files: ['src/file-0.ts'],
      signal: queuedController.signal,
    });
    queuedController.abort();

    await expect(queued).rejects.toBeInstanceOf(GraphWriterAbortError);
    const firstOutcome = await first;
    expect(firstOutcome.result).toBeDefined();
    await drainGraphWriter(root);
    expect(busyGraphWriter(root)).toBe(false);
  }, 120_000);

  it('rejects an in-flight write on abort and ignores its late result', async () => {
    const root = createProject(writeMany(40));
    await ensureGraphWriterReady(root);

    const controller = new AbortController();
    const pending = enqueueGraphWrite(root, { kind: 'indexAll', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(GraphWriterAbortError);
    await drainGraphWriter(root);
    expect(busyGraphWriter(root)).toBe(false);

    // The worker slot is free and usable after the aborted write unwinds.
    const after = await enqueueGraphWrite(root, { kind: 'syncFiles', files: ['src/file-0.ts'] });
    expect(after.result).toBeDefined();
  }, 120_000);

  it('surfaces a worker-side error through the RPC error frame', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    await ensureGraphWriterReady(root);

    const lock = new FileLock(path.join(getCodeGraphDir(root), 'codegraph.lock'));
    lock.acquire();
    let error: unknown;
    try {
      await enqueueGraphWrite(root, { kind: 'syncFiles', files: ['src/a.ts'] });
    } catch (caught) {
      error = caught;
    } finally {
      lock.release();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.toLowerCase()).toContain('lock');
    await drainGraphWriter(root);
  }, 120_000);

  it('dedupes files and really syncs them into the graph', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    await ensureGraphWriterReady(root);

    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function alpha() { return 2; }\n');
    const outcome = await enqueueGraphWrite(root, {
      kind: 'syncFiles',
      files: ['src/a.ts', 'src/a.ts', 'src/a.ts'],
    });
    expect(isSyncResult(outcome.result)).toBe(true);
    expect((outcome.result as SyncResult).filesAdded).toBe(1);
    expect(outcome.databaseReplaced).toBe(false);

    const reader = await CodeGraph.open(root, { readOnly: true });
    try {
      expect(reader.getNodesByName('alpha').length).toBeGreaterThan(0);
    } finally {
      await reader.close();
    }
  }, 120_000);

  it('rejects outstanding writes and respawns after a worker crash', async () => {
    const root = createProject(writeMany(80));
    await ensureGraphWriterReady(root);

    const pending = enqueueGraphWrite(root, { kind: 'indexAll' });
    expect(__crashGraphWriterForTest(root)).toBe(true);

    await expect(pending).rejects.toBeInstanceOf(GraphWriterCrashError);
    expect(busyGraphWriter(root)).toBe(false);

    const handle = await ensureGraphWriterReady(root);
    expect(handle.root).toBe(root);
    const outcome = await enqueueGraphWrite(root, { kind: 'syncFiles', files: ['src/file-0.ts'] });
    expect(outcome.result).toBeDefined();
  }, 120_000);

  it('drains then closes the graph and terminates the worker', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    await ensureGraphWriterReady(root);

    const pending = enqueueGraphWrite(root, { kind: 'indexAll' });
    await closeGraphWriter(root);
    await pending;

    expect(busyGraphWriter(root)).toBe(false);
    await expect(enqueueGraphWrite(root, { kind: 'sync' })).rejects.toBeInstanceOf(Error);
    await drainGraphWriter(root);

    // A closed writer can be replaced by a fresh one.
    await ensureGraphWriterReady(root);
    const outcome = await enqueueGraphWrite(root, { kind: 'syncFiles', files: ['src/a.ts'] });
    expect(outcome.result).toBeDefined();
    await closeGraphWriter(root);
    // close is idempotent
    await closeGraphWriter(root);
  }, 120_000);

  it('ensure × close concurrency spawns exactly one replacement worker', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    await ensureGraphWriterReady(root);
    const spawnedBefore = graphWriterSpawnCountForTest();

    // Both ensures park on the same closePromise. Before the recheck loop
    // they would each spawn a replacement after the close resolved, and the
    // second worker would be orphaned behind the writers map.
    const closing = closeGraphWriter(root);
    const first = ensureGraphWriterReady(root);
    const second = ensureGraphWriterReady(root);
    await closing;
    const [a, b] = await Promise.all([first, second]);

    expect(a.root).toBe(root);
    expect(b.root).toBe(root);
    expect(graphWriterSpawnCountForTest() - spawnedBefore).toBe(1);
    expect(graphWriterCountForTest(root)).toBe(1);
    expect(hasGraphWriterForTest(root)).toBe(true);

    await closeGraphWriter(root);
    expect(hasGraphWriterForTest(root)).toBe(false);
    expect(graphWriterCountForTest(root)).toBe(0);
    expect(graphWriterLiveCountForTest()).toBe(0);
  }, 120_000);
});