/**
 * Symlinked-directory auto-sync + cycle guard (upstream #770 / #2025).
 *
 * The fork already followed directory symlinks before this port (chokidar
 * `followSymlinks` defaults to true); what upstream #2025 adds — and what
 * this pins — is the realpath dedup that keeps a symlink cycle
 * (root/linked -> outside, outside/loop -> root) from re-walking the same
 * tree until ELOOP and flooding sync batches with phantom logical paths.
 *
 * The guard lives in the real chokidar crawl, which the in-process chokidar
 * mock cannot exercise (and whose module mock can leak across files in bun's
 * single-process test run), so the actual behavior is asserted by spawning
 * `fixtures/symlink-cycle-probe.ts` in a clean subprocess.
 *
 * POSIX-only: `fs.symlinkSync(..., 'dir')` without elevated privileges on
 * Windows is out of scope for this suite.
 */

import { describe, it, expect } from './vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';

const posixOnly = it.skipIf(process.platform === 'win32');

describe('FileWatcher symlinked directories (upstream #770/#2025)', () => {
  posixOnly('delivers edits inside a symlinked dir and cuts the cycle (real chokidar subprocess)', () => {
    const out = execFileSync(
      process.execPath,
      [path.join(import.meta.dirname, 'fixtures', 'symlink-cycle-probe.ts')],
      { encoding: 'utf8', timeout: 90_000 },
    );
    expect(out).toContain('PROBE PASS');
    expect(out).not.toContain('/loop/');
  }, 120_000);
});
