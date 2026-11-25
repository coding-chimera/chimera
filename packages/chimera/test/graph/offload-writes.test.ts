/**
 * Offload write integration: a CodeGraph handle opened with `offload: true`
 * keeps reads local but routes every write through the per-root graph writer
 * worker.
 *
 * These tests drive the real worker thread against real on-disk graphs:
 * inline/offload result parity, read-your-writes on the main read handle,
 * main-thread responsiveness and FileLock absence, replaced-database reopen,
 * close draining before the main handle closes, and nested indexAll.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { CodeGraphAdapter } from '../../src/chimera/codegraph-adapter';
import { busyGraphWriter, closeGraphWriter } from '../../src/graph/worker';
import { hasInlineWriteLockForTest } from '../../src/graph/worker/inline-write-guard';
import type { SyncResult } from '../../src/graph/extraction';

const roots = new Set<string>();

function createProject(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-offload-')));
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

const isSyncResult = (result: SyncResult): boolean => 'filesAdded' in result;

describe('offload writes', () => {
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

  it('matches inline syncFiles results and serves read-your-writes', async () => {
    const inlineRoot = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    const offloadRoot = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    const changed = 'export function gamma() { return 3; }\n';
    fs.writeFileSync(path.join(inlineRoot, 'src/a.ts'), changed);
    fs.writeFileSync(path.join(offloadRoot, 'src/a.ts'), changed);

    const inline = await CodeGraph.open(inlineRoot);
    const offload = await CodeGraph.open(offloadRoot, { readOnly: true, offload: true });
    try {
      const inlineResult = await inline.syncFiles([path.join(inlineRoot, 'src/a.ts')]);
      const offloadResult = await offload.syncFiles([path.join(offloadRoot, 'src/a.ts')]);

      expect(isSyncResult(offloadResult)).toBe(true);
      expect(offloadResult.filesChecked).toBe(inlineResult.filesChecked);
      expect(offloadResult.filesAdded).toBe(inlineResult.filesAdded);
      expect(offloadResult.filesModified).toBe(inlineResult.filesModified);
      expect(offloadResult.filesRemoved).toBe(inlineResult.filesRemoved);
      expect(offloadResult.nodesUpdated).toBe(inlineResult.nodesUpdated);

      // The main handle is read-only but reads the worker's committed write.
      expect(offload.getNodesByName('gamma').length).toBeGreaterThan(0);
      expect(offload.getNodesByName('alpha').length).toBe(0);
    } finally {
      await inline.close();
      await offload.close();
    }
  }, 120_000);

  it('keeps the main thread free and never acquires the inline FileLock', async () => {
    const root = createProject(writeMany(150));
    const graph = await CodeGraph.open(root, { readOnly: true, offload: true });

    const intervalMs = 5;
    let ticks = 0;
    let sawWorkerBusy = false;
    const timer = setInterval(() => {
      ticks += 1;
    }, intervalMs);
    let elapsedMs = 0;
    try {
      const startedAt = Date.now();
      const result = await graph.indexAll({
        onProgress: () => {
          // The main thread must not register an inline write lock while the
          // worker owns the only read-write handle.
          expect(hasInlineWriteLockForTest(root)).toBe(false);
          if (busyGraphWriter(root)) sawWorkerBusy = true;
        },
      });
      elapsedMs = Date.now() - startedAt;
      expect(result.success).toBe(true);
    } finally {
      clearInterval(timer);
    }

    expect(sawWorkerBusy).toBe(true);
    expect(elapsedMs).toBeGreaterThan(0);
    // Proportional rather than `> 0`: the main thread must keep ticking at a
    // rate within 10x of the configured interval for the whole write.
    const minimumTicks = Math.max(1, Math.floor(elapsedMs / (intervalMs * 10)));
    expect(ticks).toBeGreaterThanOrEqual(minimumTicks);
    // Read-your-writes through the main read-only handle.
    expect(graph.getNodesByName('fn0').length).toBeGreaterThan(0);
    await graph.close();
  }, 120_000);

  it('follows an externally replaced database and reads the new content', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    const graph = await CodeGraph.open(root, { readOnly: true, offload: true });
    try {
      await graph.syncFiles([path.join(root, 'src/a.ts')]);
      expect(graph.getNodesByName('alpha').length).toBeGreaterThan(0);

      // Full rebuild at the same path: unlink the data root, replace the source
      // set, create a new DB, then write through the offloaded handle. A full
      // indexAll is the reconcile path a fresh (empty) database needs.
      fs.rmSync(path.join(root, '.chimera'), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'src/a.ts'), { force: true });
      fs.writeFileSync(path.join(root, 'src/b.ts'), 'export function beta() { return 2; }\n');
      CodeGraph.initSync(root).close();

      const result = await graph.indexAll();
      expect(result.success).toBe(true);

      expect(graph.getNodesByName('beta').length).toBeGreaterThan(0);
      expect(graph.getNodesByName('alpha').length).toBe(0);
    } finally {
      await graph.close();
    }
  }, 120_000);

  it('drains the writer before closing the main handle', async () => {
    const root = createProject(writeMany(80));
    const graph = await CodeGraph.open(root, { readOnly: true, offload: true });

    const pending = graph.indexAll();
    const closing = graph.close();
    const result = await pending;
    await closing;

    expect(result.success).toBe(true);
    expect(busyGraphWriter(root)).toBe(false);
  }, 120_000);

  it('still supports enqueueing a nested indexAll from a progress callback', async () => {
    const root = createProject(writeMany(40));
    const graph = await CodeGraph.open(root, { readOnly: true, offload: true });
    try {
      let nested: ReturnType<typeof graph.indexAll> | undefined;
      const first = await graph.indexAll({
        onProgress: () => {
          if (!nested) nested = graph.indexAll();
        },
      });
      expect(first.success).toBe(true);
      if (!nested) throw new Error('nested indexAll was not enqueued');
      expect((await nested).success).toBe(true);
    } finally {
      await graph.close();
    }
  }, 120_000);

  it('rejects offload without readOnly on open and openSync', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });

    await expect(CodeGraph.open(root, { offload: true })).rejects.toThrow(/offload:true requires readOnly:true/);
    expect(() => CodeGraph.openSync(root, { offload: true })).toThrow(/offload:true requires readOnly:true/);
  });

  it('rejects adapter.optimize on an offloaded read-only handle', async () => {
    const root = createProject({ 'src/a.ts': 'export function alpha() { return 1; }\n' });
    const adapter = await CodeGraphAdapter.open(root, { offload: true });
    try {
      expect(() => adapter.optimize()).toThrow(/unavailable on an offloaded read-only handle/);
    } finally {
      await adapter.close();
    }
  }, 120_000);
});