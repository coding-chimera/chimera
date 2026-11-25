/**
 * syncFiles phase timing: one `logDebug('syncFiles timing', context)` line per
 * call exit (success, failure, widened full reconcile). The line must be
 * numbers/status only — no file paths or source payload — so a slow scoped
 * sync can be attributed to dependent expansion / extraction / resolution /
 * failed-ref retry / synthesis refresh / maintenance without leaking content.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { defaultLogger, setLogger } from '../../src/graph/errors';
import { FileLock } from '../../src/graph/utils';
import { getCodeGraphDir } from '../../src/graph/directory';

const PHASE_KEYS = [
  'dependents',
  'dependentsIndex',
  'extract',
  'failedRefRetry',
  'lock',
  'maintenance',
  'postExtract',
  'rebind',
  'reopen',
  'resolve',
  'synthesisCheck',
  'synthesisRefresh',
].sort();

type TimingContext = {
  files: number;
  dependents: number;
  ok: boolean;
  totalMs: number;
  phases: Record<string, number>;
  widened?: boolean;
  widenMs?: number;
  failedPhase?: string;
  failedPhaseMs?: number;
};

describe('syncFiles phase timing', () => {
  let testDir: string;
  let cg: CodeGraph;
  let logged: Array<{ message: string; context?: Record<string, unknown> }>;

  const timings = (): TimingContext[] =>
    logged.filter((entry) => entry.message === 'syncFiles timing').map((entry) => entry.context as TimingContext);

  const expectShape = (timing: TimingContext) => {
    expect(timing.files).toBe(1);
    expect(typeof timing.dependents).toBe('number');
    expect(timing.dependents).toBeGreaterThanOrEqual(0);
    expect(typeof timing.totalMs).toBe('number');
    expect(timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(timing.phases).sort()).toEqual(PHASE_KEYS);
    for (const ms of Object.values(timing.phases)) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    // Status/numbers only: no file paths or source text ride along.
    expect(timing).not.toHaveProperty('filePaths');
    expect(timing).not.toHaveProperty('changedFilePaths');
    const serialized = JSON.stringify(timing);
    expect(serialized).not.toContain('index.ts');
    expect(serialized).not.toContain('function caller');
  };

  beforeEach(async () => {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-timing-')));
    fs.writeFileSync(
      path.join(testDir, 'index.ts'),
      'export function caller() { return target(); }\nexport function target() { return 1; }\n',
    );
    logged = [];
    setLogger({
      debug: (message, context) => logged.push({ message, context }),
      warn: () => {},
      error: () => {},
    });
    cg = await CodeGraph.init(testDir, { index: true });
    logged = [];
  });

  afterEach(async () => {
    setLogger(defaultLogger);
    try {
      await cg.close();
    } catch {
      // best-effort
    }
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('records one success line with every phase key and no file payload', async () => {
    fs.writeFileSync(
      path.join(testDir, 'index.ts'),
      'export function caller() { return target(); }\nexport function target() { return 2; }\n',
    );
    await cg.syncFiles(['index.ts']);

    const entries = timings();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(true);
    expect(entries[0].widened).toBeUndefined();
    expect(entries[0].failedPhase).toBeUndefined();
    expectShape(entries[0]);
  }, 60_000);

  it('records an early lock failure with the unfinished phase identified', async () => {
    const lock = new FileLock(path.join(getCodeGraphDir(testDir), 'codegraph.lock'));
    lock.acquire();
    let error: unknown;
    try {
      await cg.syncFiles(['index.ts']);
    } catch (err) {
      error = err;
    } finally {
      lock.release();
    }
    expect(error).toBeDefined();

    const entries = timings();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].failedPhase).toBe('lock');
    expect(typeof entries[0].failedPhaseMs).toBe('number');
    expectShape(entries[0]);
  }, 60_000);

  it('marks a pending-full-reconcile widen with widened/totalMs', async () => {
    (cg as unknown as { pendingFullReconcile: boolean }).pendingFullReconcile = true;
    await cg.syncFiles(['index.ts']);

    const entries = timings();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(true);
    expect(entries[0].widened).toBe(true);
    expect(typeof entries[0].widenMs).toBe('number');
    expect(entries[0].widenMs).toBeGreaterThanOrEqual(0);
    expect(entries[0].totalMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(entries[0].phases).sort()).toEqual(PHASE_KEYS);
  }, 60_000);

  it('serializes through the index mutex and reports exactly once', async () => {
    // Controllable wrapper (no implementation copy): proves syncFiles still
    // enters the index mutex critical section, not just its own body.
    const mutex = (cg as unknown as {
      indexMutex: { withLock: <T>(fn: () => Promise<T>) => Promise<T> };
    }).indexMutex;
    const original = mutex.withLock.bind(mutex);
    let wrapped = 0;
    mutex.withLock = <T>(fn: () => Promise<T>) => {
      wrapped += 1;
      return original(fn);
    };

    await cg.syncFiles(['index.ts']);

    expect(wrapped).toBe(1);
    expect(timings()).toHaveLength(1);
    expect(timings()[0].ok).toBe(true);
  }, 60_000);

  it('a throwing debug logger cannot turn a successful sync into a rejection', async () => {
    setLogger({ debug: () => { throw new Error('logger boom'); }, warn: () => {}, error: () => {} });
    fs.writeFileSync(
      path.join(testDir, 'index.ts'),
      'export function caller() { return target(); }\nexport function target() { return 3; }\n',
    );

    const result = await cg.syncFiles(['index.ts']);

    expect(result.filesModified).toBe(1);
    expect(result.filesChecked).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('a throwing debug logger cannot replace the original sync failure', async () => {
    setLogger({ debug: () => { throw new Error('logger boom'); }, warn: () => {}, error: () => {} });
    const boom = new Error('extract exploded');
    const orchestrator = (cg as unknown as {
      orchestrator: { syncFiles: () => Promise<never> };
    }).orchestrator;
    orchestrator.syncFiles = async () => {
      throw boom;
    };

    let caught: unknown;
    try {
      await cg.syncFiles(['index.ts']);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom);
    expect((caught as Error).message).toBe('extract exploded');
  }, 60_000);

  it('records a failed widen with failedPhase widen and preserves the error', async () => {
    (cg as unknown as { pendingFullReconcile: boolean }).pendingFullReconcile = true;
    const boom = new Error('full reconcile exploded');
    (cg as unknown as { syncLocked: () => Promise<never> }).syncLocked = async () => {
      throw boom;
    };

    let caught: unknown;
    try {
      await cg.syncFiles(['index.ts']);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom);
    const entries = timings();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].widened).toBe(true);
    expect(entries[0].failedPhase).toBe('widen');
    expect(typeof entries[0].failedPhaseMs).toBe('number');
    expect(entries[0].totalMs).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('records a mid-pipeline failure with the active phase and original error', async () => {
    const boom = new Error('extract exploded');
    const orchestrator = (cg as unknown as {
      orchestrator: { syncFiles: () => Promise<never> };
    }).orchestrator;
    orchestrator.syncFiles = async () => {
      throw boom;
    };

    let caught: unknown;
    try {
      await cg.syncFiles(['index.ts']);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom);
    const entries = timings();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].widened).toBeUndefined();
    expect(entries[0].failedPhase).toBe('extract');
    expect(typeof entries[0].failedPhaseMs).toBe('number');
    expectShape(entries[0]);
  }, 60_000);
});