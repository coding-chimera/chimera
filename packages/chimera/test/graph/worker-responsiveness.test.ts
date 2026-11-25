/**
 * Worker responsiveness: a graph write must leave the main thread free to run
 * timers, and a write may enqueue another write (nested indexAll) from its own
 * progress callback without deadlocking the single-writer queue.
 *
 * If the client ever blocked the main thread (Atomics.wait or a synchronous
 * worker handshake), the interval below would not tick while the write runs.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import {
  closeGraphWriter,
  enqueueGraphWrite,
  ensureGraphWriterReady,
  type GraphWriterOutcome,
} from '../../src/graph/worker';

const roots = new Set<string>();

const indexSucceeded = (outcome: GraphWriterOutcome): boolean =>
  'success' in outcome.result && outcome.result.success;

function createProject(fileCount: number): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-responsive-')));
  for (let index = 0; index < fileCount; index++) {
    const target = path.join(dir, 'src', `file-${index}.ts`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `export function fn${index}(value: number) { return value + ${index}; }\nexport const value${index} = fn${index}(${index});\n`,
    );
  }
  CodeGraph.initSync(dir).close();
  roots.add(dir);
  return dir;
}

describe('graph writer responsiveness', () => {
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

  it('keeps main-thread timers ticking while a write runs', async () => {
    const root = createProject(80);
    await ensureGraphWriterReady(root);

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    const startedAt = Date.now();
    try {
      const outcome = await enqueueGraphWrite(root, { kind: 'indexAll' });
      expect(indexSucceeded(await enqueueGraphWrite(root, { kind: 'indexAll' }))).toBe(true);
    } finally {
      clearInterval(timer);
    }

    expect(Date.now() - startedAt).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
  }, 120_000);

  it('supports enqueueing a nested indexAll from a progress callback', async () => {
    const root = createProject(80);
    await ensureGraphWriterReady(root);

    let progressFrames = 0;
    let nested: Promise<GraphWriterOutcome> | undefined;
    const first = enqueueGraphWrite(root, {
      kind: 'indexAll',
      onProgress: () => {
        progressFrames += 1;
        if (!nested) nested = enqueueGraphWrite(root, { kind: 'indexAll' });
      },
    });

    const firstOutcome = await first;
    expect(indexSucceeded(firstOutcome)).toBe(true);
    expect(progressFrames).toBeGreaterThan(0);
    if (!nested) throw new Error('nested indexAll was not enqueued from the progress callback');

    const nestedOutcome = await nested;
    expect(indexSucceeded(nestedOutcome)).toBe(true);
  }, 120_000);
});