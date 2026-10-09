/**
 * WASM runtime flags — the workaround for the V8 turboshaft WASM Zone OOM
 * (`Fatal process out of memory: Zone`) that crashed `chimera index` on large
 * polyglot repos under Node >= 22. See issues #293 and #298.
 *
 * The crash was reproduced with the real indexer on the bundled Node 24 runtime;
 * empirically only `--liftoff-only` prevents it (`--no-wasm-tier-up` /
 * `--no-wasm-dynamic-tiering` do not), and the flag must be on node's command
 * line — `setFlagsFromString`, worker `execArgv`, and `NODE_OPTIONS` all fail.
 * These tests pin that contract so it can't silently regress.
 */
import { describe, it, expect } from './vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WASM_RUNTIME_FLAGS,
  processHasWasmRuntimeFlags,
  buildRelaunchArgv,
} from '../../src/graph/extraction/wasm-runtime-flags';

describe('WASM_RUNTIME_FLAGS', () => {
  it('pins --liftoff-only (the only flag shown to stop the turboshaft Zone OOM)', () => {
    // On Node 24, --no-wasm-tier-up and --no-wasm-dynamic-tiering both still
    // crash; only --liftoff-only forces grammars onto the Liftoff baseline and
    // off the optimizing tier. Pin it so it can't be swapped for an ineffective
    // flag.
    expect(WASM_RUNTIME_FLAGS).toContain('--liftoff-only');
  });

  it('every flag is a real, accepted flag on the running Node/V8 runtime', () => {
    // node rejects unknown CLI flags at startup, so a renamed/removed flag would
    // break the bundled launcher and make the relaunch guard a silent no-op.
    // Prove each flag actually launches node here.
    const res = spawnSync(
      process.execPath,
      [...WASM_RUNTIME_FLAGS, '-e', 'process.exit(0)'],
      { encoding: 'utf8' }
    );
    expect(res.status, `node rejected ${WASM_RUNTIME_FLAGS.join(' ')}:\n${res.stderr}`).toBe(0);
  });
});

describe('processHasWasmRuntimeFlags', () => {
  it('is true only when every required flag is present', () => {
    expect(processHasWasmRuntimeFlags(['--liftoff-only'])).toBe(true);
    expect(processHasWasmRuntimeFlags(['--liftoff-only', '--enable-source-maps'])).toBe(true);
  });

  it('is false when the flags are absent', () => {
    expect(processHasWasmRuntimeFlags([])).toBe(false);
    expect(processHasWasmRuntimeFlags(['--max-old-space-size=4096'])).toBe(false);
  });
});

describe('buildRelaunchArgv', () => {
  it('places the wasm flags first, then the script and its args', () => {
    expect(buildRelaunchArgv('/x/codegraph.js', ['index', '/repo'], [])).toEqual([
      '--liftoff-only',
      '/x/codegraph.js',
      'index',
      '/repo',
    ]);
  });

  it('preserves other existing node flags without duplicating ours', () => {
    expect(
      buildRelaunchArgv('/x/codegraph.js', ['status'], ['--liftoff-only', '--enable-source-maps'])
    ).toEqual(['--liftoff-only', '--enable-source-maps', '/x/codegraph.js', 'status']);
  });

  it('produces an argv that actually launches node WITH the flag applied', () => {
    // End-to-end proof of the delivery mechanism without needing the crash:
    // run the constructed argv and confirm the child sees the flag in execArgv.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-relaunch-'));
    try {
      const harness = path.join(dir, 'harness.cjs');
      fs.writeFileSync(harness, 'process.stdout.write(JSON.stringify(process.execArgv));');
      const res = spawnSync(process.execPath, buildRelaunchArgv(harness, []), { encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toContain('--liftoff-only');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Runtime split: Bun must be skipped, Node must keep the re-exec.
//
// `chimera graph` is also run under Bun (`bun run src/index.ts graph ...`), and
// Bun (a) impersonates Node in `process.versions.node`, (b) embeds its own V8,
// so the turboshaft Zone OOM the flag exists to prevent does not apply, and
// (c) parses its own argv before the script path, which turns the flag-first
// re-exec into a routing failure (`error: unknown command 'graph'`).
//
// Each case runs in a child process, because the split reads process-level
// state: `process.versions` is stubbed to simulate the runtime and
// `process.execPath` is pointed at /bin/echo, so the argv a re-exec *would*
// use is recorded on stdout instead of launching anything.
// =============================================================================

const modulePath = path.join(import.meta.dir, '..', '..', 'src', 'graph', 'extraction', 'wasm-runtime-flags.ts');

type HarnessRun = { status: number | null; output: string; relaunchedArgv: string };

function runRelaunchHarness(versions: Record<string, string>): HarnessRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-relaunch-runtime-'));
  try {
    const harness = path.join(dir, 'harness.ts');
    // The script the relaunch would re-invoke; echoed back by the fake execPath so
    // the recorded argv can be inspected.
    const scriptPath = path.join(dir, 'cli.ts');
    fs.writeFileSync(
      harness,
      [
        `import { relaunchWithWasmRuntimeFlagsIfNeeded } from ${JSON.stringify(modulePath)};`,
        'const hostExecPath = process.execPath;',
        `Object.defineProperty(process, 'versions', { value: ${JSON.stringify(versions)}, configurable: true, writable: true });`,
        "Object.defineProperty(process, 'execArgv', { value: [], configurable: true, writable: true });",
        "Object.defineProperty(process, 'execPath', { value: '/bin/echo', configurable: true, writable: true });",
        `relaunchWithWasmRuntimeFlagsIfNeeded(${JSON.stringify(scriptPath)});`,
        "process.stdout.write('RETURNED:' + hostExecPath);",
      ].join('\n'),
    );
    // The re-exec guard envs would each suppress the relaunch on their own; the
    // harness has to start from a clean slate to prove the runtime branch.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CODEGRAPH_WASM_RELAUNCHED;
    delete env.CODEGRAPH_NO_RELAUNCH;
    const res = spawnSync(process.execPath, [harness], { encoding: 'utf8', env, timeout: 60_000 });
    return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`, relaunchedArgv: scriptPath };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('relaunchWithWasmRuntimeFlagsIfNeeded runtime split', () => {
  // /bin/echo is POSIX-only and is what the harness uses as the fake relaunch target.
  const posix = process.platform !== 'win32';

  it.runIf(posix)('skips the re-exec under Bun (no flag in argv, caller continues)', () => {
    const run = runRelaunchHarness({ node: '26.3.0', bun: '1.4.0' });
    expect(run.status).toBe(0);
    // Bun impersonates Node 26 in process.versions.node, so without the skip this
    // argv would launch `bun --liftoff-only <script> ...` and die on routing.
    expect(run.output).toContain('RETURNED:');
    expect(run.output).not.toContain('--liftoff-only');
  });

  it.runIf(posix)('still re-execs with the WASM flags when the runtime is Node', () => {
    const run = runRelaunchHarness({ node: '24.0.0' });
    expect(run.status).toBe(0);
    // The recorded argv proves the flag-first re-exec still fires on Node, and the
    // missing marker proves the caller did not continue in-process.
    expect(run.output).toContain(`${WASM_RUNTIME_FLAGS[0]} ${run.relaunchedArgv}`);
    expect(run.output).not.toContain('RETURNED:');
  });
});
