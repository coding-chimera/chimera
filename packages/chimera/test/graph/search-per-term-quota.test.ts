/**
 * Per-term quota search tests.
 *
 * Multi-word FTS queries used to be flattened into a single OR prefix
 * query, so a high-frequency token could crowd a rare token's matches out
 * of the over-fetch window before post-hoc rescoring ever saw them. These
 * tests pin the per-term guaranteed-quota merge, the pre-slice path:/name:
 * hard filters, and the searchNodesDetailed telemetry shape.
 */

import { describe, it, expect, beforeAll, afterAll } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph';

let nodeSqliteAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node:sqlite');
  nodeSqliteAvailable = true;
} catch {
  nodeSqliteAvailable = false;
}

const COMMON_COUNT = 60;
const FILTERED_COUNT = 10;
// Nodes literally named `handler` — each earns the +60 exact-token
// nameMatchBonus in multi-word queries, globally outranking any rare
// token's prefix-only match. The strict quota case below needs enough
// of them to fill a small limit window on their own.
const EXACT_COUNT = 6;

describe.skipIf(!nodeSqliteAvailable)('searchNodes per-term quota', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perterm-'));
    // One rare token: a single symbol whose name starts with `qxz`.
    fs.writeFileSync(
      path.join(dir, 'rare.ts'),
      'export function qxzRareMarker(): number { return 1; }\n'
    );
    // A second rare token whose ONLY match is a long compound name —
    // no exact/prefix nameMatchBonus against a multi-word query, so it
    // can never outscore an exact-name `handler` node on its own.
    fs.writeFileSync(
      path.join(dir, 'rare2.ts'),
      'export function qxwUltraRareCompoundSymbol(): number { return 2; }\n'
    );
    // High-frequency token with exact same-name nodes.
    fs.mkdirSync(path.join(dir, 'exact'));
    for (let i = 0; i < EXACT_COUNT; i++) {
      fs.writeFileSync(
        path.join(dir, 'exact', `e${i}.ts`),
        `export function handler(): number { return ${i}; }\n`
      );
    }
    // High-frequency token: 60 symbols whose names start with `handler`.
    fs.mkdirSync(path.join(dir, 'common'));
    fs.writeFileSync(
      path.join(dir, 'common', 'a.ts'),
      Array.from(
        { length: COMMON_COUNT },
        (_, i) => `export function handlerCommon${i}(): number { return ${i}; }`
      ).join('\n') + '\n'
    );
    // Same token matched mid-name in a separate directory, so these rank
    // below the handlerCommon* prefix matches after rescoring.
    fs.mkdirSync(path.join(dir, 'filtered'));
    fs.writeFileSync(
      path.join(dir, 'filtered', 'b.ts'),
      Array.from(
        { length: FILTERED_COUNT },
        (_, i) => `export function processHandler${i}(): number { return ${i}; }`
      ).join('\n') + '\n'
    );
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a rare token match in a small-limit multi-word query', () => {
    const results = cg.searchNodes('qxz handler', { limit: 5 });
    expect(results.map(r => r.node.name)).toContain('qxzRareMarker');
  });

  it('searchNodes returns exactly searchNodesDetailed(...).results', () => {
    const detailed = cg.searchNodesDetailed('qxz handler', { limit: 5 });
    expect(cg.searchNodes('qxz handler', { limit: 5 })).toEqual(detailed.results);
  });

  it('reports real per-term hit counts and the pre-slice pool size', () => {
    const detailed = cg.searchNodesDetailed('qxz handler', { limit: 5 });
    const byTerm = new Map(detailed.terms.map(t => [t.term, t.count]));
    expect(byTerm.get('qxz')).toBe(1);
    expect(byTerm.get('handler')).toBe(COMMON_COUNT + FILTERED_COUNT + EXACT_COUNT);
    expect(detailed.total).toBe(COMMON_COUNT + FILTERED_COUNT + EXACT_COUNT + 1);
    expect(detailed.results.length).toBe(5);
  });

  it('single-token behaviour is unchanged (one term entry, same results)', () => {
    const results = cg.searchNodes('handler', { limit: 10 });
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.node.name.toLowerCase()).toContain('handler');
    }
    const detailed = cg.searchNodesDetailed('handler', { limit: 10 });
    expect(detailed.terms).toEqual([{ term: 'handler', count: COMMON_COUNT + FILTERED_COUNT + EXACT_COUNT }]);
    expect(detailed.results).toEqual(results);
  });

  it('applies path: filters before the final limit slice', () => {
    // Without the pre-slice filter the top-5 window is all handlerCommon*
    // (prefix name bonus), leaving nothing under filtered/ after filtering.
    const results = cg.searchNodes('handler path:filtered', { limit: 5 });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.node.filePath).toContain('filtered');
      expect(r.node.name).toMatch(/^processHandler/);
    }
  });

  it('applies name: filters before the final limit slice', () => {
    const results = cg.searchNodes('handler name:processhandler', { limit: 5 });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.node.name).toMatch(/^processHandler/);
    }
  });

  it('keeps a rare token in the final window when a common token has exact-name matches', () => {
    // The EXACT_COUNT nodes literally named `handler` each earn the +60
    // exact-token nameMatchBonus; `qxwUltraRareCompoundSymbol` gets no
    // nameMatchBonus against the two-word query at all, so global
    // rescoring alone would evict it. Only the final-window per-term
    // quota keeps it visible.
    const results = cg.searchNodes('qxw handler', { limit: 5 });
    expect(results.map(r => r.node.name)).toContain('qxwUltraRareCompoundSymbol');

    const detailed = cg.searchNodesDetailed('qxw handler', { limit: 5 });
    const byTerm = new Map(detailed.terms.map(t => [t.term, t.count]));
    expect(byTerm.get('qxw')).toBe(1);
    expect(byTerm.get('handler')).toBe(COMMON_COUNT + FILTERED_COUNT + EXACT_COUNT);
  });
});
