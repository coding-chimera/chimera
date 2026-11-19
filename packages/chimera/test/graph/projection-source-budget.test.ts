/**
 * Projection source retention is bounded per revision.
 *
 * `ProjectionRevisionCache.sources` keeps the pre/post-edit source text that
 * lets a before/after audit project the before revision without re-reading
 * post-sync state. Retention used to be unbounded for a revision (by design:
 * evicting mid-audit would silently read post-edit source), so a mutation over
 * many large files could pin hundreds of MB across the four retained revisions.
 *
 * These tests pin: (1) the byte budget and per-entry cap, (2) that projections
 * are byte-identical to the unbudgeted path (source is still read for the
 * CURRENT projection; only retention is skipped), and (3) that the 4-revision
 * LRU cap is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';

type SourcesCache = {
  sources: Map<string, string | undefined>;
  sourceBytes: number;
};

const FILES = ['a.ts', 'b.ts', 'c.ts'] as const;

function contentFor(name: string): string {
  // `this.value = value` makes the projection's languageSignals source-derived,
  // so an unretained/incorrect source would change the payload.
  return `export function fn${name.replace(/\W/g, '')}(value: number) {\n  this.value = value;\n  return value;\n}\n`;
}

function writeFixture(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const name of FILES) fs.writeFileSync(path.join(dir, 'src', name), contentFor(name));
}

async function makeGraph(dir: string): Promise<CodeGraph> {
  writeFixture(dir);
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return cg;
}

function nodeFor(cg: CodeGraph, name: string) {
  const node = cg.getNodesByName(`fn${name.replace(/\W/g, '')}`)[0];
  expect(node).toBeTruthy();
  return node!;
}

function sourcesCache(cg: CodeGraph, revision: string): SourcesCache {
  const caches = (cg as unknown as { projectionCaches: Map<string, SourcesCache> }).projectionCaches;
  const cache = caches.get(revision);
  expect(cache).toBeTruthy();
  return cache!;
}

describe('projection source byte budget', () => {
  let dirs: string[] = [];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const name of [
      'CODEGRAPH_PROJECTION_SOURCE_BYTES',
      'CODEGRAPH_PROJECTION_SOURCE_ENTRY_BYTES',
    ]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-projection-budget-'));
    dirs.push(dir);
    return dir;
  }

  it('keeps projection output identical under a tiny budget', async () => {
    process.env.CODEGRAPH_PROJECTION_SOURCE_BYTES = '1';
    const tight = await makeGraph(newDir());
    const tightNode = nodeFor(tight, 'a.ts');
    const tightProjection = tight.projectNode(tightNode, tight.getSnapshot());
    tight.close();

    delete process.env.CODEGRAPH_PROJECTION_SOURCE_BYTES;
    const relaxed = await makeGraph(newDir());
    const relaxedNode = nodeFor(relaxed, 'a.ts');
    const relaxedProjection = relaxed.projectNode(relaxedNode, relaxed.getSnapshot());
    relaxed.close();

    expect(tightProjection).toEqual(relaxedProjection);
    expect(tightProjection?.payload.languageSignals?.map((signal) => signal.kind)).toContain(
      'this_field_write'
    );
  });

  it('retains no source over the byte budget', async () => {
    process.env.CODEGRAPH_PROJECTION_SOURCE_BYTES = '8';
    const cg = await makeGraph(newDir());
    const snapshot = cg.getSnapshot();
    for (const name of FILES) cg.projectNode(nodeFor(cg, name), snapshot);

    const cache = sourcesCache(cg, snapshot.revision);
    expect(cache.sources.size).toBe(0);
    expect(cache.sourceBytes).toBe(0);
    cg.close();
  });

  it('retains source while it fits the budget', async () => {
    process.env.CODEGRAPH_PROJECTION_SOURCE_BYTES = '100000';
    const cg = await makeGraph(newDir());
    const snapshot = cg.getSnapshot();
    for (const name of FILES) cg.projectNode(nodeFor(cg, name), snapshot);

    const cache = sourcesCache(cg, snapshot.revision);
    expect(cache.sources.size).toBe(FILES.length);
    expect(cache.sourceBytes).toBeGreaterThan(0);
    expect(cache.sourceBytes).toBeLessThanOrEqual(100000);
    cg.close();
  });

  it('skips retention for a single file over the per-entry cap without changing output', async () => {
    process.env.CODEGRAPH_PROJECTION_SOURCE_ENTRY_BYTES = '8';
    const capped = await makeGraph(newDir());
    const cappedSnapshot = capped.getSnapshot();
    const cappedProjection = capped.projectNode(nodeFor(capped, 'a.ts'), cappedSnapshot);
    expect(sourcesCache(capped, cappedSnapshot.revision).sources.size).toBe(0);
    capped.close();

    delete process.env.CODEGRAPH_PROJECTION_SOURCE_ENTRY_BYTES;
    const relaxed = await makeGraph(newDir());
    const relaxedProjection = relaxed.projectNode(nodeFor(relaxed, 'a.ts'), relaxed.getSnapshot());
    relaxed.close();

    expect(cappedProjection).toEqual(relaxedProjection);
  });

  it('keeps the four-revision cap', async () => {
    const dir = newDir();
    writeFixture(dir);
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const filePath = path.join(dir, 'src', 'a.ts');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        filePath,
        `export function fnats(value: number) {\n  this.value = value + ${i};\n  return value;\n}\n`
      );
      cg.projectNode(nodeFor(cg, 'a.ts'), cg.getSnapshot());
    }

    const caches = (cg as unknown as { projectionCaches: Map<string, SourcesCache> }).projectionCaches;
    expect(caches.size).toBeLessThanOrEqual(4);
    cg.close();
  });

  it('pins pre-edit source across a warm → edit → before-projection sequence', async () => {
    // Both retention limits reject every entry here, so without the pin the
    // before revision would retain no source and a replay could read the file
    // back from disk AFTER the edit.
    process.env.CODEGRAPH_PROJECTION_SOURCE_BYTES = '1'
    process.env.CODEGRAPH_PROJECTION_SOURCE_ENTRY_BYTES = '1'
    const dir = newDir()
    const cg = await makeGraph(dir)
    const before = cg.getSnapshot()
    const filePath = path.join(dir, 'src', 'a.ts')
    const fnNode = nodeFor(cg, 'a.ts')
    const graphPath = fnNode.filePath
    const container = cg
      .getNodesInFile(graphPath)
      .find((node) => node.kind === 'file' || node.kind === 'module')
    expect(container).toBeTruthy()

    // Warm the before revision exactly like the mutation audit: project one
    // container node per file before the tool effect rewrites source on disk.
    cg.pinProjectionSources(before.revision, [graphPath])
    cg.projectNode(container!, before)
    fs.writeFileSync(filePath, 'export function fnats(value: number) {\n  return value;\n}\n')
    // The pinned pre-edit text is what the before projection reads, so the
    // source-derived signal survives the post-warm disk edit.
    expect(sourcesCache(cg, before.revision).sources.get(graphPath)).toBe(contentFor('a.ts'))
    const pinned = cg.projectNode(fnNode, before)
    expect(pinned?.payload.languageSignals?.map((signal) => signal.kind)).toContain('this_field_write')
    cg.unpinProjectionSources(before.revision, [graphPath])
    cg.close()
  })
})