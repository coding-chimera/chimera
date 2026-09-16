/**
 * P1 regression: the ordered-commit path in `indexAll` used to freeze its
 * commit cursor the moment `storeExtractionResult` threw (e.g. SQLITE_BUSY
 * when a concurrent writer outlasts the 5s busy_timeout). With the cursor
 * frozen, the feed backpressure loop awaited already-resolved promises
 * forever — a pure microtask cycle that never reaches the event loop's timer
 * phase, so every main-thread watchdog starved and the run hung at ~100% CPU
 * with no log line.
 *
 * These tests exercise the REAL indexAll pipeline on temp-dir fixtures
 * (in-process parsing — no worker pool involved; the bug and the fix are
 * both pool-independent). The injection seam is a prototype spy on the
 * commit call `storeExtractionResult` (instance-method spy style as in
 * resolution.test.ts); everything downstream — flushChain, feed backpressure,
 * the transient whitelist retry with macrotask backoff, the escape, and the
 * real SQLite writes — runs unmocked.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import { ExtractionOrchestrator } from '../../src/graph/extraction';
import { setLogger, defaultLogger } from '../../src/graph/errors';

type StoreFn = (
  filePath: string,
  content: string,
  language: string,
  stats: fs.Stats,
  result: unknown,
) => void;

// `storeExtractionResult` is private but lives on the prototype and is called
// through `this`, so a prototype spy intercepts every commit attempt (each
// retry is one attempt). Tests import the same module instance CodeGraph
// constructs its orchestrator from, so the prototype is shared.
const proto = ExtractionOrchestrator.prototype as unknown as { storeExtractionResult: StoreFn };
const realStore = proto.storeExtractionResult;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-commit-resilience-'));
}

function writeFixture(dir: string, names: string[]): void {
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(
      path.join(srcDir, `${name}.ts`),
      `export function ${name}Fn(): number { return 1; }\n`
    );
  }
}

/**
 * Install the store-failure seam. `hook` runs before each real commit attempt
 * and throws to inject a failure; `counts` records attempts per file path.
 */
function installStoreSpy(hook: (filePath: string, attemptForPath: number, totalAttempts: number) => void) {
  const counts = new Map<string, number>();
  let total = 0;
  const spy = spyOn(proto, 'storeExtractionResult');
  spy.mockImplementation(function (
    this: unknown,
    filePath: string,
    content: string,
    language: string,
    stats: fs.Stats,
    result: unknown
  ) {
    const attempt = (counts.get(filePath) ?? 0) + 1;
    counts.set(filePath, attempt);
    hook(filePath, attempt, ++total);
    return realStore.call(this, filePath, content, language, stats, result);
  });
  return { spy, counts };
}

// Cap below the suite's 30s timeout but far above the post-fix durations
// (escape is immediate, retry budget is 100+500+2000ms): the pre-fix shape
// spun forever and would only ever trip this bound (or the test timeout).
const BOUNDED_REJECT_CAP_MS = 10_000;

describe('indexAll ordered-commit resilience (P1 microtask-spin regression)', () => {
  let tempDir = '';
  let spy: { mockRestore: () => void } | null = null;
  let logged: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];

  beforeEach(() => {
    tempDir = createTempDir();
    logged = [];
    // Capture the flush-error diagnosability line instead of spamming test output.
    setLogger({
      debug: () => {},
      warn: (message, context) => logged.push({ level: 'warn', message, context }),
      error: (message, context) => logged.push({ level: 'error', message, context }),
    });
  });

  afterEach(() => {
    setLogger(defaultLogger);
    spy?.mockRestore();
    spy = null;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('recovers from one transient store failure: retry succeeds, indexAll completes', async () => {
    writeFixture(tempDir, ['alpha', 'beta', 'gamma']);
    const installed = installStoreSpy((filePath, attempt) => {
      if (filePath === 'src/beta.ts' && attempt === 1) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
    });
    spy = installed.spy;

    const cg = CodeGraph.initSync(tempDir);
    const started = Date.now();
    const result = await cg.indexAll();
    const elapsed = Date.now() - started;

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(3);
    // One failed attempt + one successful retry for the target file.
    expect(installed.counts.get('src/beta.ts')).toBe(2);
    // The 100ms backoff was a REAL macrotask sleep (a microtask-chain
    // pseudo-delay would either spin or resolve instantly).
    expect(elapsed).toBeGreaterThanOrEqual(90);
    // The retried file is actually committed to the DB.
    expect(cg.getNodesInFile('src/beta.ts').length).toBeGreaterThanOrEqual(1);
    expect(cg.getFiles().length).toBe(3);
    cg.close();
  });

  it('rejects a non-whitelisted store error within bounded time, with the message surfaced and zero retries', async () => {
    // 12 files so a frozen cursor at sequence 0 has a full backlog behind it
    // — the pre-fix shape spun on feed() of file #2. Targeting the FIRST
    // commit attempt keeps this independent of scan order.
    const names = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    writeFixture(tempDir, names);
    const installed = installStoreSpy((_filePath, _attempt, totalAttempts) => {
      if (totalAttempts === 1) throw new Error('no such column: injected_permanent_failure');
    });
    spy = installed.spy;

    const cg = CodeGraph.initSync(tempDir);
    const started = Date.now();
    await expect(cg.indexAll()).rejects.toThrow('injected_permanent_failure');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(BOUNDED_REJECT_CAP_MS);
    // Conservative whitelist (no retry) + feed-loop escape + dispatch stop:
    // exactly one attempt on one path — the backpressure loop did not keep
    // spinning feeds and nothing behind the frozen cursor was attempted.
    expect(installed.counts.size).toBe(1);
    expect([...installed.counts.values()]).toEqual([1]);
    // Diagnosability: the flush catch logs one line at set-time, containing
    // the injected message (pre-fix: total silence).
    expect(
      logged.some(
        (entry) =>
          entry.message.includes('commit cursor frozen') &&
          String(entry.context?.error ?? '').includes('injected_permanent_failure')
      )
    ).toBe(true);
    cg.close();
  });

  it('retries a persisting transient error exactly 3 times with ~2.6s backoff, then rejects bounded', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    writeFixture(tempDir, names);
    // Every commit attempt fails transiently; the FIRST one (sequence 0)
    // exhausts its retry budget, freezing the cursor while the escape stops
    // dispatch behind it — independent of scan order.
    const installed = installStoreSpy(() => {
      throw new Error('database is locked');
    });
    spy = installed.spy;

    const cg = CodeGraph.initSync(tempDir);
    const started = Date.now();
    await expect(cg.indexAll()).rejects.toThrow('database is locked');
    const elapsed = Date.now() - started;

    // Initial attempt + 3 retries (100/500/2000ms), then the error escapes
    // the retry budget into flushError.
    // Total wall time is bounded by the fixed backoff schedule: the sleeps
    // never fire early, and nothing spins past the cap.
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    expect(elapsed).toBeLessThan(BOUNDED_REJECT_CAP_MS);
    // Each retry logged its intent (attempt + delay) before the final failure line.
    expect(logged.filter((entry) => entry.message.includes('retrying'))).toHaveLength(3);
    expect(logged.some((entry) => entry.message.includes('commit cursor frozen'))).toBe(true);
    // Feed-loop escape: only the failing path was ever attempted.
    expect(installed.counts.size).toBe(1);
    expect([...installed.counts.values()]).toEqual([4]);
    cg.close();
  });
});
