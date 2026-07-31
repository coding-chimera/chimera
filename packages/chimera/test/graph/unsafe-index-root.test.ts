import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unsafeIndexRootReason } from '../../src/graph/directory';

/**
 * Guard for upstream #845: `init`/`index` must refuse the home directory and
 * filesystem roots, which would otherwise index the entire tree (multi-GB
 * index, watcher churn, and pre-1.0 macOS fd exhaustion that crashed the
 * machine). The classic trigger was running the installer from `$HOME`.
 */
describe('unsafeIndexRootReason', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('flags the home directory', () => {
    expect(unsafeIndexRootReason(os.homedir())).toBe('your home directory');
  });

  it('flags a parent of the home directory (broader than home)', () => {
    // dirname(home) is either a parent of home or — for a root-level home like
    // `/root` — the filesystem root; both are unsafe.
    expect(unsafeIndexRootReason(path.dirname(os.homedir()))).toBeTruthy();
  });

  it.runIf(process.platform !== 'win32')('flags the POSIX filesystem root', () => {
    expect(unsafeIndexRootReason('/')).toBe('the filesystem root');
  });

  it('allows a normal project directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-unsafe-'));
    tmpDirs.push(dir);
    expect(unsafeIndexRootReason(dir)).toBeNull();
    // ...and a nested subdir of it.
    const nested = path.join(dir, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    expect(unsafeIndexRootReason(nested)).toBeNull();
  });

  it('matches the home directory case-insensitively on macOS/Windows', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    // The FS is case-insensitive there, so an upper-cased home path must still flag.
    expect(unsafeIndexRootReason(os.homedir().toUpperCase())).toBeTruthy();
  });
});
