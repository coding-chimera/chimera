/**
 * Legacy daemon-lock preservation (fork slice of upstream 1e4612375, #1834).
 *
 * Two hardenings, both about never mistaking a LIVE lock for a stale one:
 *
 *  - decodeLockInfo's legacy plain-PID fallback used Number(), which also
 *    swallows '0x10', '1e5', ' 12' and '12.0' — a garbage "pid" that happens
 *    to look alive wedges the takeover loop, and a dead-looking one gets its
 *    lock cleared. Strict decimal integers + Number.isSafeInteger now.
 *  - clearStaleDaemonLock is a compare-and-delete, but the comparison used to
 *    be pid-only: a record REPLACED between the caller's inspection and the
 *    clear (same reused PID advertising a freshly-bound socket) still passed
 *    the pid check and got deleted. tryAcquireDaemonLock now returns the EXACT
 *    taken contents and the clear refuses any record that differs.
 *
 * The upstream commit's other surfaces (daemon-registry cleanup fencing,
 * daemon-manager 'unverified' stop outcomes, socket-hello identity probes,
 * proxy-fallback legacy-daemon guard) have no fork host: this tree has no
 * daemon-registry.ts / daemon-manager.ts / probeDaemonIdentity — the fork's
 * takeover path never clears a live PID (isProcessAlive guards every branch),
 * which is the same fail-closed posture the upstream fix restores.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeLockInfo, encodeLockInfo, getDaemonPidPath } from '../../src/graph/mcp/daemon-paths';
import { clearStaleDaemonLock, tryAcquireDaemonLock } from '../../src/graph/mcp/daemon';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-lock-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A pid that cannot belong to a live process on any supported OS. */
const DEAD_PID = 0x7ffffffe;

function writePidFile(contents: string): string {
  const pidPath = getDaemonPidPath(tmpDir);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, contents, { mode: 0o600 });
  return pidPath;
}

describe('decodeLockInfo legacy plain-PID hardening (upstream 1e4612375)', () => {
  it('accepts a strict decimal pid as a legacy record', () => {
    expect(decodeLockInfo('12345\n')).toEqual({ pid: 12345, version: 'unknown', socketPath: '', startedAt: 0 });
  });

  it('rejects loose numeric forms Number() would swallow', () => {
    for (const raw of ['0x10', '1e5', '012', '12.0', '-12', '0', '+12', '12 34', 'Infinity', 'NaN']) {
      expect(decodeLockInfo(raw)).toBeNull();
    }
  });

  it('rejects unsafe integers', () => {
    expect(decodeLockInfo('99999999999999999999999')).toBeNull();
    expect(decodeLockInfo(String(Number.MAX_SAFE_INTEGER + 2))).toBeNull();
  });

  it('still decodes the full JSON record', () => {
    const info = { pid: 4242, version: '1.2.3', socketPath: '/tmp/x.sock', startedAt: 123 };
    expect(decodeLockInfo(encodeLockInfo(info))).toEqual(info);
  });
});

describe('clearStaleDaemonLock snapshot comparison (upstream 1e4612375)', () => {
  it('refuses to clear a record replaced after the caller inspected it, even with the same pid', () => {
    const inspected = encodeLockInfo({ pid: DEAD_PID, version: '0.0.1', socketPath: '', startedAt: 1 });
    const pidPath = writePidFile(inspected);
    // Between inspect and clear the pid got REUSED by a fresh daemon-elect
    // that rewrote the record (new socket, new startedAt). The pid check
    // alone passes; only the snapshot comparison catches the replacement.
    const replacement = encodeLockInfo({ pid: DEAD_PID, version: '0.0.2', socketPath: '/tmp/fresh.sock', startedAt: 2 });
    fs.writeFileSync(pidPath, replacement, { mode: 0o600 });

    expect(clearStaleDaemonLock(pidPath, DEAD_PID, { expectedLockContents: inspected })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(replacement); // preserved
  });

  it('clears a genuinely stale record whose snapshot matches', () => {
    const stale = encodeLockInfo({ pid: DEAD_PID, version: '0.0.1', socketPath: '', startedAt: 1 });
    const pidPath = writePidFile(stale);
    expect(clearStaleDaemonLock(pidPath, DEAD_PID, { expectedLockContents: stale })).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('never clears a live pid even with a matching snapshot', () => {
    const live = encodeLockInfo({ pid: process.pid, version: '0.0.1', socketPath: '/tmp/live.sock', startedAt: 1 });
    const pidPath = writePidFile(live);
    expect(clearStaleDaemonLock(pidPath, process.pid, { expectedLockContents: live })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(live);
  });

  it('treats an already-gone pidfile as cleared', () => {
    const pidPath = getDaemonPidPath(tmpDir);
    expect(clearStaleDaemonLock(pidPath, DEAD_PID, { expectedLockContents: 'anything' })).toBe(true);
  });

  it('keeps the legacy pid-only form working (no snapshot supplied)', () => {
    const stale = String(DEAD_PID);
    const pidPath = writePidFile(stale);
    expect(clearStaleDaemonLock(pidPath, DEAD_PID)).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});

describe('tryAcquireDaemonLock taken-record contents (upstream 1e4612375)', () => {
  it('returns the exact record it read when the lock is taken', () => {
    const first = tryAcquireDaemonLock(tmpDir);
    expect(first.kind).toBe('acquired');
    try {
      const second = tryAcquireDaemonLock(tmpDir);
      expect(second.kind).toBe('taken');
      if (second.kind === 'taken') {
        expect(second.lockContents).not.toBeNull();
        expect(second.existing?.pid).toBe(process.pid);
        expect(decodeLockInfo(second.lockContents!)).toEqual(
          first.kind === 'acquired' ? first.info : null
        );
      }
    } finally {
      fs.rmSync(getDaemonPidPath(tmpDir), { force: true });
    }
  });

  it('reports unreadable lockfiles as taken with null contents', () => {
    const pidPath = writePidFile('\u0000garbage\u0000');
    const result = tryAcquireDaemonLock(tmpDir);
    expect(result.kind).toBe('taken');
    if (result.kind === 'taken') {
      expect(result.lockContents).toBe('\u0000garbage\u0000');
      expect(result.existing).toBeNull(); // corrupt body decodes to null
    }
    fs.rmSync(pidPath, { force: true });
  });
});
