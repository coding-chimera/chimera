import { afterEach, describe, expect, it } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/graph/index';
import { ToolHandler } from '../../src/graph/mcp/tools';

/**
 * NL-stopword guard on handleExplore's named-symbol seeder (bare-token path).
 *
 * The seeder treats every ≥3-char identifier-shaped query token as "a symbol
 * the agent named" and resolves it via getNodesByName. The FTS side drops
 * English function words (STOP_WORDS in search/query-utils), but the seeder
 * did not — so a natural-language query ("check the throttle…") exact-matched
 * a same-named callable (`function the()`), which earned the +50 named-seed
 * score and the named-file sort tier and displaced the real answer.
 *
 * Fork adaptation of upstream v1.6.1: upstream guards the seeder with a
 * shape-precise test plus fileNameSets/corroboration (mcp/tools.ts); the fork
 * does not carry the corroboration system, so bare lowercase tokens hitting
 * the union of the fork's search-side STOP_WORDS (query-utils — carries the
 * 3-char function words like "the"/"for" that upstream's list never sees
 * because its prose path filters sub-4-char words earlier) and upstream's
 * ENGLISH_PROSE_STOPWORDS (search/identifier-segments.ts) are excluded from
 * seeding. Precise-shaped tokens (camelCase, PascalCase,
 * snake_case, qualified) and bare words outside the lists seed unchanged.
 */

let dir: string;
let cg: CodeGraph;

async function index(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-seeder-stopwords-'));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}

async function explore(query: string) {
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query });
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text;
}

afterEach(() => {
  cg?.destroy();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = {
  // A callable named after an English function word — the collision bait.
  // FTS never surfaces it (STOP_WORDS drops "the"); only the seeder's
  // getNodesByName path can.
  'noise.ts': 'export function the() { return 1; }\n',
  'throttle.ts': 'export function throttleSignup() { return 1; }\n',
  'state.ts': 'export class OrderState {\n  transition(): boolean { return true; }\n}\n',
  'zebra.ts': 'export function zebraQuirk() { return 1; }\n',
};

describe('named-symbol seeder NL-stopword guard', () => {
  it('does not seed bare lowercase stopwords as symbol names', async () => {
    await index(fixture);
    const text = await explore('the throttle signup');
    // The real answer is still found (search_text split: "throttle signup").
    expect(text).toContain('throttleSignup');
    // Pre-fix, "the" exact-matched noise.ts's `the()`, earned the +50
    // named-seed score, and the file was rendered; the guard drops it.
    expect(text).not.toContain('noise.ts');
  });

  it('still seeds precise-shaped tokens (camelCase / PascalCase)', async () => {
    await index(fixture);
    expect(await explore('throttleSignup')).toContain('throttleSignup');
    expect(await explore('OrderState transition')).toContain('OrderState');
  });

  it('still seeds bare lowercase words outside the stopword list', async () => {
    // "frobnicate" is a bare lowercase word (not precise-shaped) outside the
    // stopword list — proof the guard is a LIST, not a blanket bare-word ban.
    await index({ ...fixture, 'handler.ts': 'export function frobnicate() { return 1; }\n' });
    expect(await explore('frobnicate')).toContain('frobnicate');
  });
});
