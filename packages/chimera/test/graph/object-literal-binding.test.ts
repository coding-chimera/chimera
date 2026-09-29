/**
 * Object-literal members that alias an outer function (#1932).
 *
 * Fork port of the upstream resolution.test.ts describe from 17d09bf.
 * `export const api = { getUser }` / `{ getUser: getUser }` — the API-module
 * shape. The member's function is declared OUTSIDE the literal, so the
 * containment lookup of #1573 found nothing and `api.getUser()` in the
 * literal's own file resolved to no function at all.
 *
 * Fork adaptations:
 * - Callers lists exclude the fork's D2 `stmt@…` statement nodes (fork-only
 *   extraction feature; upstream graphs have no such callers).
 * - The CROSS-FILE expectations (b.ts `api.viaArrow()`, f.ts
 *   `frozen.frozenFn()`) are asserted UNRESOLVED: they travel through
 *   upstream's import-side alias path (resolveObjectLiteralAlias →
 *   resolveAliasBinding, built on the pre-window #1808 alias-binding module
 *   the fork never vendored). The same-file fix — the actual #1932 report —
 *   is fully ported, dual-arm (name-matcher.ts + resolver.rs
 *   resolve_object_literal_binding, with the synthetic import keys primed in
 *   resolve-bridge.ts precomputeExternal).
 */

import { describe, it, expect } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';

const realCallers = (names: string[]) => names.filter((n) => !n.startsWith('stmt@'));

describe('Object-literal members that alias an outer function (#1932)', () => {
  const callersOf = (cg: CodeGraph, name: string, filePath: string): string[] => {
    const target = cg
      .getNodesInFile(filePath)
      .find((n) => n.name === name && (n.kind === 'function' || n.kind === 'method'));
    expect(target, `${filePath}:${name}`).toBeDefined();
    return realCallers(
      cg
        .getIncomingEdges(target!.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)!.name)
    ).sort();
  };

  it('resolves same-file calls through shorthand and identifier-valued members', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1932-'));
    fs.writeFileSync(
      path.join(tmpDir, 'a.ts'),
      `import { imported } from './d';
const viaArrow = async () => 1;
function viaDecl() { return 2; }
const longForm = async () => 3;
function renamed() { return 4; }

export const api = {
  inline() { return 0; },
  viaArrow,
  viaDecl,
  longForm: longForm,
  alias: renamed,
  imported,
};

export function sameFileCaller() {
  return [api.inline(), api.viaArrow(), api.viaDecl(), api.longForm(), api.alias(), api.imported()];
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'b.ts'),
      `import { api } from './a';
export function crossFileCaller() {
  return [api.viaArrow(), api.viaDecl(), api.longForm(), api.alias()];
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'd.ts'), `export function imported() { return 5; }\n`);
    fs.writeFileSync(
      path.join(tmpDir, 'e.ts'),
      `function frozenFn() { return 6; }
export const frozen = Object.freeze({ frozenFn });
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'f.ts'),
      `import { frozen } from './e';
export function frozenCaller() { return frozen.frozenFn(); }
`
    );
    try {
      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
      cg.resolveReferences();

      expect(callersOf(cg, 'inline', 'a.ts')).toEqual(['sameFileCaller']);
      for (const fn of ['viaArrow', 'viaDecl', 'longForm', 'renamed']) {
        // Upstream also expects 'crossFileCaller' here — see the header: the
        // fork lacks the import-side alias path, so cross-file stays dark
        // (never a WRONG caller, which is the safety half of #1932).
        expect(callersOf(cg, fn, 'a.ts')).toEqual(['sameFileCaller']);
      }
      expect(callersOf(cg, 'imported', 'd.ts')).toEqual(['sameFileCaller']);
      // Cross-file frozen wrapper: unresolved in the fork (same gap).
      expect(callersOf(cg, 'frozenFn', 'e.ts')).toEqual([]);
      cg.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);

  it('never follows a property key, a nested object, or a shadowed binding', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1932-'));
    fs.writeFileSync(
      path.join(tmpDir, 'c.ts'),
      `function keyOnly() { return 1; }
function nested() { return 2; }
function shadowed() { return 3; }

export const other = { keyOnly: 1, box: { nested } };

export function useOther() {
  return [other.keyOnly(), other.nested()];
}

export function makeApi(shadowed: () => number) {
  const local = { shadowed };
  return local.shadowed();
}
`
    );
    try {
      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
      cg.resolveReferences();

      expect(callersOf(cg, 'keyOnly', 'c.ts')).toEqual([]);
      expect(callersOf(cg, 'nested', 'c.ts')).toEqual([]);
      expect(callersOf(cg, 'shadowed', 'c.ts')).toEqual([]);
      cg.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});
