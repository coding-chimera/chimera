/**
 * Per-project MCP writer lock (fork port of upstream 7440d2c47, #1740/#1744).
 *
 * One live writer (shared daemon OR direct-mode / in-process fallback engine
 * owning the FileWatcher) per project. The lock unit tests run in-process;
 * the two-server fail-fast E2E spawns real `serve --mcp` processes and is
 * gated on CODEGRAPH_WASM_RELAUNCHED — the same sanctioned source-run env the
 * existing mcp-daemon E2E needs — so default-env runs skip it exactly like
 * they already skip-or-fail the daemon spawns (known baseline).
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCodeGraphDir } from '../../src/graph/directory';
import {
  decodeWriterLockInfo,
  getWriterPidPath,
  readWriterLock,
  releaseWriterLock,
  tryAcquireWriterLock,
  writerLockHeldMessage,
} from '../../src/graph/mcp/writer-lock';
import { MCPEngine } from '../../src/graph/mcp/engine';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-writer-lock-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A pid that cannot belong to a live process on any supported OS. */
const DEAD_PID = 0x7ffffffe;

function writeLock(contents: string): string {
  const pidPath = getWriterPidPath(tmpDir);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, contents, { mode: 0o600 });
  return pidPath;
}

describe('writer lock primitives (upstream 7440d2c47)', () => {
  it('acquires on a fresh project and writes the full record atomically', () => {
    const result = tryAcquireWriterLock(tmpDir, 'direct');
    expect(result.kind).toBe('acquired');
    const info = readWriterLock(tmpDir);
    expect(info).toEqual({ pid: process.pid, mode: 'direct', startedAt: expect.any(Number) });
    releaseWriterLock(tmpDir);
    expect(readWriterLock(tmpDir)).toBeNull();
  });

  it('is re-entrant for the same pid (daemon holds it, its engine re-acquires)', () => {
    const first = tryAcquireWriterLock(tmpDir, 'daemon');
    expect(first.kind).toBe('acquired');
    const second = tryAcquireWriterLock(tmpDir, 'fallback');
    expect(second.kind).toBe('acquired');
    releaseWriterLock(tmpDir);
    expect(readWriterLock(tmpDir)).toBeNull();
  });

  it('refuses to steal from a live foreign holder and reports it', () => {
    const pidPath = writeLock(JSON.stringify({ pid: 1, mode: 'direct', startedAt: Date.now() }) + '\n');
    const result = tryAcquireWriterLock(tmpDir, 'daemon');
    expect(result.kind).toBe('taken');
    if (result.kind === 'taken') {
      expect(result.existing?.pid).toBe(1);
      expect(result.existing?.mode).toBe('direct');
      const msg = writerLockHeldMessage(result.existing, result.pidPath);
      expect(msg).toContain('PID 1');
      expect(msg).toContain('direct mode');
      expect(msg).toContain(pidPath);
    }
  });

  it('clears a dead holder (re-verified) and retries once', () => {
    writeLock(JSON.stringify({ pid: DEAD_PID, mode: 'daemon', startedAt: 1 }) + '\n');
    const result = tryAcquireWriterLock(tmpDir, 'direct');
    expect(result.kind).toBe('acquired');
    expect(readWriterLock(tmpDir)?.pid).toBe(process.pid);
    releaseWriterLock(tmpDir);
  });

  it('treats a corrupt lockfile as stale and recovers the slot', () => {
    writeLock('not json at all');
    const result = tryAcquireWriterLock(tmpDir, 'fallback');
    expect(result.kind).toBe('acquired');
    releaseWriterLock(tmpDir);
  });

  it('never releases a foreign holder', () => {
    const live = JSON.stringify({ pid: 1, mode: 'direct', startedAt: Date.now() }) + '\n';
    writeLock(live);
    releaseWriterLock(tmpDir); // our pid does not match — must be a no-op
    expect(fs.readFileSync(getWriterPidPath(tmpDir), 'utf8')).toBe(live);
  });

  it('decodes strictly: pid and mode required, startedAt defaults to 0', () => {
    expect(decodeWriterLockInfo('garbage')).toBeNull();
    expect(decodeWriterLockInfo(JSON.stringify({ mode: 'direct' }))).toBeNull();
    expect(decodeWriterLockInfo(JSON.stringify({ pid: 7 }))).toBeNull();
    expect(decodeWriterLockInfo(JSON.stringify({ pid: 7, mode: 'direct' }))).toEqual({
      pid: 7, mode: 'direct', startedAt: 0,
    });
    expect(readWriterLock(path.join(tmpDir, 'nowhere'))).toBeNull();
  });
});

describe('MCPEngine fallback writer fencing (upstream 1e4612375 engine hunk)', () => {
  it('throws actionable guidance when constructed with a held writerLockRoot', () => {
    writeLock(JSON.stringify({ pid: 1, mode: 'direct', startedAt: Date.now() }) + '\n');
    let err: Error | null = null;
    try {
      const engine = new MCPEngine({ writerLockRoot: tmpDir });
      engine.stop();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('writer lock held by PID 1');
  });

  it('acquires the slot when constructed with a free writerLockRoot and releases on stop', () => {
    const engine = new MCPEngine({ writerLockRoot: tmpDir, watch: false });
    expect(readWriterLock(tmpDir)?.pid).toBe(process.pid);
    engine.stop();
    expect(readWriterLock(tmpDir)).toBeNull();
  });
});

// Two direct-mode servers on one project: the second must fail fast with
// guidance instead of starting a competing watcher (DoD: second-writer
// fail-fast). Gated on the sanctioned source-run env like the daemon E2E.
const describeSpawn = process.env.CODEGRAPH_WASM_RELAUNCHED ? describe : describe.skip;

describeSpawn('second direct-mode writer fail-fast E2E (upstream 7440d2c47 #1740)', () => {
  const BIN = path.resolve(__dirname, 'fixtures/graph-cli.ts');

  function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    }) as ChildProcessWithoutNullStreams;
    child.on('error', () => { /* ignore */ });
    child.stdin.on('error', () => { /* ignore */ });
    return child;
  }

  it('exits(1) with the held-lock message when another direct writer is live', async () => {
    // Minimal initialized project so resolveDaemonRoot finds a data root.
    const { CodeGraph } = await import('../../src/graph');
    CodeGraph.initSync(tmpDir).close();

    const a = spawnServer(tmpDir);
    let b: ChildProcessWithoutNullStreams | null = null;
    try {
      // Wait for A to claim writer.pid (startDirect acquires before serving).
      const pidPath = getWriterPidPath(tmpDir);
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(pidPath)) {
        if (Date.now() > deadline) throw new Error('server A never claimed writer.pid');
        if (a.exitCode !== null) throw new Error(`server A exited early (code ${a.exitCode})`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const holder = readWriterLock(tmpDir);
      expect(holder?.mode).toBe('direct');
      expect(holder?.pid).toBe(a.pid);

      // Second direct writer on the same project: fail fast.
      b = spawnServer(tmpDir);
      const stderr: string[] = [];
      b.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk.toString('utf8')); });
      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 30_000);
        b!.on('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      expect(exitCode).toBe(1);
      expect(stderr.join('')).toContain('writer lock held by');
      expect(stderr.join('')).toContain(`PID ${a.pid}`);

      // A still owns the slot — B never stole or deleted it.
      expect(readWriterLock(tmpDir)?.pid).toBe(a.pid);
    } finally {
      for (const child of [b, a]) {
        if (child && child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise((r) => setTimeout(r, 100));
          if (child.exitCode === null) child.kill('SIGKILL');
        }
      }
    }
  }, 90_000);
});
