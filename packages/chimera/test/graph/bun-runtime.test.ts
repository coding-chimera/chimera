/**
 * `chimera graph` must work when launched with Bun (`bun run src/index.ts graph ...`).
 *
 * Regression this pins (bench-measured): two Node-only boot guards broke every
 * Bun launch.
 *   1. The Node version guard read `process.versions.node`, which Bun populates
 *      with its Node-API compatibility target ("26.3.0" on Bun 1.4), so it hard
 *      exited with the "Unsupported Node.js version" banner.
 *   2. The `--liftoff-only` re-exec put a V8 flag ahead of the script path; Bun
 *      parses its own argv there and answered `error: unknown command 'graph'`.
 *
 * Each case spawns the real CLI with the guard-override env vars stripped, so a
 * regression surfaces as a banner or a routing error instead of a green run. The
 * cwd must be the package root: Bun resolves its tsconfig from the cwd, and the
 * CLI entry pulls in the TUI `.tsx` graph, which needs this package's
 * `jsxImportSource` (@opentui/solid) to compile at all.
 */
import { describe, it, expect, beforeAll, afterAll } from './vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isBunRuntime } from '../../src/graph/runtime';

const packageRoot = path.resolve(import.meta.dir, '..', '..');

/** Any of these would disable a guard on its own and mask the bug. */
const GUARD_OVERRIDE_ENV = [
  'CHIMERA_ALLOW_UNSAFE_NODE',
  'CODEGRAPH_ALLOW_UNSAFE_NODE',
  'CODEGRAPH_NO_RELAUNCH',
  'CODEGRAPH_WASM_RELAUNCHED',
];

function runCli(args: readonly string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  for (const key of GUARD_OVERRIDE_ENV) delete env[key];
  const res = spawnSync('bun', ['src/index.ts', ...args], {
    cwd: packageRoot,
    env,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** The two signatures of the bug, never allowed on a Bun launch. */
function expectNoBootGuards(output: string): void {
  expect(output).not.toContain('Unsupported Node.js version');
  expect(output).not.toContain('unknown command');
}

describe.runIf(isBunRuntime())('chimera graph CLI under Bun', () => {
  let project = '';

  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bun-cli-'));
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'src', 'greet.ts'),
      'export function greet(name: string) {\n  return `hi ${name}`\n}\n'
    );
    fs.writeFileSync(
      path.join(project, 'src', 'greeter.ts'),
      'import { greet } from "./greet"\n\nexport class Greeter {\n  say(name: string): string {\n    return greet(name)\n  }\n}\n'
    );
  });

  afterAll(() => {
    if (project) fs.rmSync(project, { recursive: true, force: true });
  });

  it('`graph init` succeeds with no override env vars', () => {
    const init = runCli(['graph', 'init', project]);
    expectNoBootGuards(init.output);
    expect(init.status, init.output).toBe(0);
    expect(init.output).toContain('Initialized graph data');
    expect(fs.existsSync(path.join(project, '.chimera'))).toBe(true);
  });

  it('`graph index` runs the extractor and reports the work', () => {
    const index = runCli(['graph', 'index', project]);
    expectNoBootGuards(index.output);
    expect(index.status, index.output).toBe(0);
    expect(index.output).toContain('Indexed 2 files');
  });

  it('`graph status` reads back the Bun-built index', () => {
    const status = runCli(['graph', 'status', '-j', project]);
    expectNoBootGuards(status.output);
    expect(status.status, status.output).toBe(0);
    const json = JSON.parse(status.output.slice(status.output.indexOf('{'), status.output.lastIndexOf('}') + 1));
    expect(json.initialized).toBe(true);
    expect(json.fileCount).toBe(2);
    expect(json.nodeCount).toBeGreaterThan(0);
    expect(json.edgeCount).toBeGreaterThan(0);
  });

  it('the WASM fallback extractor works under Bun with the native kernel off', () => {
    const index = runCli(['graph', 'index', '--force', project], { CODEGRAPH_KERNEL: '0' });
    expectNoBootGuards(index.output);
    expect(index.status, index.output).toBe(0);
    expect(index.output).toContain('Indexed 2 files');
    // The tree-sitter WASM grammars are the path that needed --liftoff-only on
    // Node; under Bun they must extract with no flag and no re-exec at all.
    const nodes = parseInt(index.output.match(/(\d+) nodes/)?.[1] ?? '0', 10);
    expect(nodes).toBeGreaterThan(0);
  });
});
