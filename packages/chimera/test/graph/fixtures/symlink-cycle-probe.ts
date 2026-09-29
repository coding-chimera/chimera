/**
 * Real-chokidar symlink probe (upstream #770/#2025) — spawned as a
 * SUBPROCESS by test/graph/watcher-symlink-cycle.test.ts.
 *
 * The cycle guard lives in the `ignored` crawl predicate, which the in-process
 * EventEmitter chokidar mock (test/graph/__helpers__/chokidar-mock.ts) never
 * exercises — and since `bun test` runs every file in ONE process, the mock
 * registered by watcher.test.ts can leak into any real-chokidar test loaded
 * in the same run. A clean subprocess sidesteps both problems.
 *
 * Prints PROBE PASS / PROBE FAIL and exits non-zero on failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher } from '../../../src/graph/sync/watcher';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symlink-probe-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symlink-target-')));
fs.mkdirSync(path.join(root, 'src'));
fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
fs.mkdirSync(path.join(outside, 'linked-src'));
fs.writeFileSync(path.join(outside, 'linked-src', 'mod.ts'), 'export const y = 1;');
fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
// The cycle: outside/loop points back at the project root. Without the
// realpath dedup, chokidar re-walks root/linked/loop/linked/... until ELOOP
// and floods batches with phantom logical paths.
fs.symlinkSync(root, path.join(outside, 'loop'), 'dir');

const seen: string[] = [];
const watcher = new FileWatcher(
  root,
  async (batch) => {
    seen.push(...batch.files);
    return { filesChanged: batch.files.length, durationMs: 1 };
  },
  { debounceMs: 200 },
);

const started = watcher.start();
await watcher.waitUntilReady(20_000);

// Edit + create inside the symlinked directory (via its REAL target path —
// the OS reports the event, chokidar maps it back to the logical path).
fs.writeFileSync(path.join(outside, 'linked-src', 'mod.ts'), 'export const y = 2;');
fs.writeFileSync(path.join(outside, 'linked-src', 'fresh.ts'), 'export const z = 1;');

const deadline = Date.now() + 15_000;
while (
  Date.now() < deadline &&
  !(seen.includes('linked/linked-src/mod.ts') && seen.includes('linked/linked-src/fresh.ts'))
) {
  await new Promise((r) => setTimeout(r, 100));
}

await watcher.stop();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

const ok =
  started &&
  seen.includes('linked/linked-src/mod.ts') &&
  seen.includes('linked/linked-src/fresh.ts') &&
  seen.every((f) => !f.includes('/loop/'));
console.log(JSON.stringify({ started, seen }));
console.log(ok ? 'PROBE PASS' : 'PROBE FAIL');
process.exit(ok ? 0 : 1);
