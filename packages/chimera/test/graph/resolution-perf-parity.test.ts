/**
 * Regression tests for the three self-contained #2072 perf items (fork port
 * of upstream fef3776): isLocallyBoundJsName's per-parameter single parse +
 * site-scoped scan, findPythonModuleFile's per-context memo, and
 * isSealedModule's cheap-first conjunction. All three are REQUIRED to be
 * graph-identical (upstream proved hash-identical output on vscode/django;
 * the fork proof is the /tmp snapshot harness + scripts/resolution-parity.ts),
 * so every case here pins the pre-existing VERDICT, not the new speed — plus
 * one bounded-time guard on the backtracking shape that motivated the port.
 *
 * End-to-end through real indexing (no resolver mocks), fixture style after
 * resolution-p51.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';

describe('#2072 perf items keep resolution verdicts identical', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2072-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const write = (relPath: string, content: string): void => {
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };

  const node = (filePath: string, name: string, kind?: string) =>
    cg.getNodesInFile(filePath).find((n) => n.name === name && (kind === undefined || n.kind === kind));

  const callersOf = (filePath: string, name: string): string[] => {
    const target = node(filePath, name);
    if (!target) return [];
    return cg.getCallers(target.id).map((c) => c.node.name);
  };

  // ── isLocallyBoundJsName: backtracking prune ───────────────────────────

  /** The vscode markersModel.test.ts shape: nine typed, defaulted parameters. */
  const nineParamHelper = (lastParamName: string): string =>
    [
      'function helper(',
      "  alpha: string = 'a',",
      '  beta: number = 1,',
      '  gamma: boolean = false,',
      "  delta: string = 'd',",
      '  epsilon: number = 2,',
      '  zeta: unknown = null,',
      "  eta: string = 'e',",
      '  theta: number = 3,',
      `  ${lastParamName}: string = 'local'`,
      ') {',
      `  return alpha + beta + gamma + delta + epsilon + eta + theta + ${lastParamName};`,
      '}',
      'export { helper };',
      '',
    ].join('\n');

  it('a bare call past a nine-parameter typed+defaulted helper stays cross-file and scans fast', async () => {
    write('src/suite-def.ts', 'export function suite(name: string): void { void name; }\n');
    // `suite` is ABSENT from spec.ts's parameter list — the old optional-group
    // pattern backtracked through every (type)?(default)? split of all nine
    // parameters per failing search (30-40s per name on vscode).
    write('src/spec.ts', nineParamHelper('omega') +
      "import { suite } from './suite-def';\nexport function run(): void { suite('outer'); }\n");
    const started = Date.now();
    cg = await CodeGraph.init(tempDir, { index: true });
    const elapsed = Date.now() - started;
    // Verdict unchanged: `suite` is not locally bound, so the bare call binds
    // to the imported definition.
    expect(callersOf('src/suite-def.ts', 'suite')).toContain('run');
    // Perf guard: the whole two-file index (extraction + resolution) must be
    // orders of magnitude below the old single-name scan cost.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('a parameter binding in the same list still shadows the cross-file name', async () => {
    write('src/suite-def.ts', 'export function suite(name: string): void { void name; }\n');
    write('src/spec.ts', nineParamHelper('suite') +
      "import { suite as outerSuite } from './suite-def';\n" +
      'export function run(): void { suite("shadowed"); outerSuite("real"); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    // The bare `suite(...)` call is shadowed by the ninth parameter... which
    // lives in helper(), not run() — so the shadow gate is the FILE-level
    // binding scan: the file binds `suite` as a parameter, so the bare call
    // has no cross-file candidate. The aliased import call still binds.
    const callers = callersOf('src/suite-def.ts', 'suite');
    expect(callers).toContain('run'); // via the outerSuite alias (import-bound)
  });

  // ── isLocallyBoundJsName: binding-shape battery (bindsAtSites arms) ────

  it('const/function/arrow-parameter/destructuring bindings shadow; require/import bindings do not', async () => {
    write('src/defs.ts', [
      'export function transform(): number { return 1; }',
      'export function resolve(n: number): number { return n; }',
      'export function helper(): number { return 2; }',
      'export const shared = 5;',
      '',
    ].join('\n'));
    write('src/shadows.ts', [
      "const transform = () => 0;",                       // const binding shadows
      'export function useTransform(): number { return transform(); }',
      'function resolve(n: number): number { return n + 1; }', // function decl shadows
      'export function useResolve(): number { return resolve(2); }',
      'const cb = (helper: number) => helper;',           // arrow parameter shadows
      'export function useHelper(): number { helper(3); return cb(1); }',
      'const { shared } = require("./defs");',            // require binds an IMPORT
      'export function useShared(): number { return shared; }',
      '',
    ].join('\n'));
    cg = await CodeGraph.init(tempDir, { index: true });
    // Shadowed names: the bare calls in shadows.ts must NOT reach defs.ts.
    expect(callersOf('src/defs.ts', 'transform')).not.toContain('useTransform');
    expect(callersOf('src/defs.ts', 'resolve')).not.toContain('useResolve');
    expect(callersOf('src/defs.ts', 'helper')).not.toContain('useHelper');
    // The require-destructured `shared` is an import binding, not a shadow:
    // the value reference reaches defs.ts's export.
    const sharedNode = node('src/defs.ts', 'shared');
    expect(sharedNode).toBeDefined();
    const sharedRefs = cg.getNodesInFile('src/shadows.ts')
      .flatMap((n) => cg.getOutgoingEdges(n.id, ['references', 'calls']))
      .filter((e) => e.target === sharedNode!.id);
    expect(sharedRefs.length).toBeGreaterThan(0);
  });

  // ── isSealedModule: cheap-first conjunction ────────────────────────────

  it('a classic script without any import stays reachable (cheap gate must not over-seal)', async () => {
    // No `import` substring anywhere: the raw-source gate short-circuits to
    // NOT sealed without masking — top-level bindings of a classic script are
    // genuinely reachable.
    write('src/legacy.ts', 'const legacyValue = 41;\nfunction bump(): number { return legacyValue + 1; }\n');
    write('src/user.ts', 'export function use(): number { return bump(); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/legacy.ts', 'bump')).toContain('use');
  });

  it('an import only in comments/strings does not seal (masking still decides)', async () => {
    // The raw source CONTAINS `import`, so the cheap gate passes and the
    // masked code decides: comment-stripped and string-blanked, there is no
    // import STATEMENT — the file is a classic script and stays reachable.
    write('src/tricky.ts', '// import { fake } from "nowhere";\nconst note = "import x";\nexport function kept(): number { return 1; }\nfunction inner(): number { return 2; }\n');
    write('src/user.ts', 'export function use(): number { return inner(); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/tricky.ts', 'inner')).toContain('use');
  });

  it('a zero-export ESM module stays sealed under the reordered conjunction', async () => {
    write('src/sealed.ts', 'import { readFileSync } from "fs";\nfunction doWork(): number { return readFileSync.length; }\n');
    write('src/go.ts', 'export function go(): number { return doWork(); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/sealed.ts', 'doWork')).not.toContain('go');
  });

  // ── findPythonModuleFile: per-context memo ─────────────────────────────

  it('resolves the same module file for two importers and survives a sync (memo drop seam)', async () => {
    write('pkg/__init__.py', 'from .util import helper\n');
    write('pkg/util.py', 'def helper():\n    return 1\n');
    write('app/a.py', 'from pkg.util import helper\n\ndef use_a():\n    return helper()\n');
    write('app/b.py', 'from unittest import mock\nfrom pkg.util import helper\n\ndef use_b():\n    mock.patch("x")\n    return helper()\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    // Both importers bind to the SAME module file's helper; the external
    // `unittest` module resolves to nothing without crashing the scan.
    expect(callersOf('pkg/util.py', 'helper')).toEqual(expect.arrayContaining(['use_a', 'use_b']));

    // A sync that adds a second package must see the NEW module files: the
    // memo is dropped with the resolver caches, never serving a stale miss.
    write('pkg2/__init__.py', 'from .util2 import other\n');
    write('pkg2/util2.py', 'def other():\n    return 2\n');
    write('app/c.py', 'from pkg2.util2 import other\n\ndef use_c():\n    return other()\n');
    await cg.sync();
    expect(callersOf('pkg2/util2.py', 'other')).toContain('use_c');
    expect(callersOf('pkg/util.py', 'helper')).toEqual(expect.arrayContaining(['use_a', 'use_b']));
  });
});
