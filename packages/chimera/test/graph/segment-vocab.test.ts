import { afterEach, describe, expect, it } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/graph/index';
import { splitIdentifierSegments } from '../../src/graph/search/identifier-segments';

/**
 * name_segment_vocab populate flow (upstream v1.6.1 port). The fork's
 * migration created the table but never filled it, leaving the empty-explore
 * diagnostics' vocab arm (getExploreMissDiagnostics) dead. Upstream populates
 * on the node write path, clears the table at the start of a full index (the
 * orphan-cleanup pass), and heals vocab-empty databases on sync.
 */

let dir: string;
let cg: CodeGraph;

function vocabRows(): Array<{ segment: string; name: string }> {
  return (cg as any).db.db
    .prepare('SELECT segment, name FROM name_segment_vocab ORDER BY segment, name')
    .all() as Array<{ segment: string; name: string }>;
}

async function index(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-segment-vocab-'));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}

afterEach(() => {
  cg?.destroy();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = {
  // The import names a symbol no file defines, so an import-node vocab row
  // would be visible as a lone `Zebra` name.
  'src/state-machine.ts':
    'import { Zebra } from "./zebra";\nexport class OrderStateMachine {\n  transition(): boolean { return true; }\n}\n',
};

describe('splitIdentifierSegments (upstream v1.6.1 port)', () => {
  it('splits camelCase, PascalCase, acronym runs, and separators', () => {
    expect(splitIdentifierSegments('OrderStateMachine')).toEqual(['order', 'state', 'machine']);
    expect(splitIdentifierSegments('HTMLParser')).toEqual(['html', 'parser']);
    expect(splitIdentifierSegments('base64Encode')).toEqual(['base64', 'encode']);
    expect(splitIdentifierSegments('state-machine.ts')).toEqual(['state', 'machine', 'ts']);
  });

  it('keeps Unicode words and drops degenerate fragments', () => {
    expect(splitIdentifierSegments('flowCafé')).toEqual(['flow', 'café']);
    expect(splitIdentifierSegments('42')).toEqual([]); // digit-only
    expect(splitIdentifierSegments('ATool')).toEqual(['tool']); // 1-char part dropped
    expect(splitIdentifierSegments('')).toEqual([]);
  });

  it('caps segments per name so minified identifiers cannot bloat the vocab', () => {
    const name = Array.from({ length: 20 }, (_, i) => `word${i}Hump`).join('');
    expect(splitIdentifierSegments(name).length).toBeLessThanOrEqual(12);
  });
});

describe('name_segment_vocab populate flow', () => {
  it('populates on the node write path during a full index', async () => {
    await index(fixture);
    const rows = vocabRows();
    expect(rows).toContainEqual({ segment: 'machine', name: 'OrderStateMachine' });
    expect(rows).toContainEqual({ segment: 'order', name: 'OrderStateMachine' });
    expect(rows).toContainEqual({ segment: 'state', name: 'OrderStateMachine' });
    expect(rows).toContainEqual({ segment: 'transition', name: 'transition' });
  });

  it('excludes file basenames and import specifiers (upstream #1144)', async () => {
    await index(fixture);
    const names = new Set(vocabRows().map((r) => r.name));
    expect(names.has('state-machine.ts')).toBe(false);
    expect(names.has('Zebra')).toBe(false);
  });

  it('prunes orphan rows on a full index while unchanged files keep their vocab', async () => {
    // Fork adaptation vs upstream's clear-at-start: the contentHash
    // skip-guard leaves unchanged files unrewritten on a re-index, so the
    // full index PRUNES names whose definitions are gone instead of wiping
    // and repopulating the whole table. Removals themselves are a sync's
    // job (fork indexAll does not reconcile removed files); deletes
    // intentionally leave orphan vocab rows until the next full index.
    await index({ ...fixture, 'src/gone.ts': 'export function zebraQuirk(): void {}\n' });
    expect(vocabRows().some((r) => r.name === 'zebraQuirk')).toBe(true);
    fs.unlinkSync(path.join(dir, 'src/gone.ts'));
    await cg.sync();
    expect(vocabRows().some((r) => r.name === 'zebraQuirk')).toBe(true); // orphan tolerated
    await cg.indexAll();
    expect(vocabRows().some((r) => r.name === 'zebraQuirk')).toBe(false);
    expect(vocabRows().some((r) => r.name === 'OrderStateMachine')).toBe(true);
  });

  it('heals an empty vocabulary on sync (upgrade path for pre-vocab indexes)', async () => {
    await index(fixture);
    (cg as any).db.db.exec('DELETE FROM name_segment_vocab');
    await cg.sync();
    expect(
      vocabRows().some((r) => r.segment === 'machine' && r.name === 'OrderStateMachine')
    ).toBe(true);
  });
});
