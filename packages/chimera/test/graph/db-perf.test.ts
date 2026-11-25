/**
 * DB Performance / Correctness Tests
 *
 * Regression tests for three changes:
 *   1. Batch `getNodesByIds` collapses graph-traversal N+1 reads.
 *   2. `insertNode` invalidates the LRU cache so INSERT OR REPLACE
 *      doesn't serve a stale cached row on next `getNodeById`.
 *   3. `runMaintenance` runs `PRAGMA optimize` + `wal_checkpoint(PASSIVE)`
 *      after indexAll/sync without throwing.
 *   4. `insertEdges` validates endpoints from the DB, not stale node cache.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';
import { Edge, Node } from '../../src/graph/types';

function makeNode(id: string, name = id): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('getNodesByIds (batch lookup)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-batch-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a Map keyed by id, with one entry per existing node', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2'), makeNode('n3')]);
    const out = q.getNodesByIds(['n1', 'n2', 'n3']);
    expect(out.size).toBe(3);
    expect(out.get('n1')!.name).toBe('n1');
    expect(out.get('n3')!.name).toBe('n3');
  });

  it('omits missing IDs from the result map (no nulls, no exceptions)', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    const out = q.getNodesByIds(['n1', 'missing', 'n2']);
    expect(out.size).toBe(2);
    expect(out.has('missing')).toBe(false);
    expect(out.has('n1')).toBe(true);
    expect(out.has('n2')).toBe(true);
  });

  it('handles an empty input array', () => {
    expect(q.getNodesByIds([]).size).toBe(0);
  });

  it('handles batches over the SQLite parameter limit (chunking)', () => {
    // Insert 1500 nodes; the helper chunks at 500 internally.
    const nodes = Array.from({ length: 1500 }, (_, i) => makeNode(`n${i}`));
    q.insertNodes(nodes);
    const ids = nodes.map((n) => n.id);
    const out = q.getNodesByIds(ids);
    expect(out.size).toBe(1500);
    // Spot-check a few from the first / middle / last chunk.
    expect(out.has('n0')).toBe(true);
    expect(out.has('n750')).toBe(true);
    expect(out.has('n1499')).toBe(true);
  });

  it('serves a repeated lookup from the in-memory cache', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    const first = q.getNodeById('n1')!;
    // A cache hit returns the same decoded object; a SQL round-trip would
    // build a new one.
    expect(q.getNodeById('n1')).toBe(first);
    expect(q.getNodesByIds(['n1']).get('n1')).toBe(first);
  });

  it('drops a warmed entry when the row changes (change-stamp invalidation)', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    q.getNodeById('n1'); // warm
    db.getDb().prepare('UPDATE nodes SET name = ? WHERE id = ?').run('changed', 'n1');
    // total_changes() moved, so the cache is dropped instead of serving 'n1'.
    const out = q.getNodesByIds(['n1', 'n2']);
    expect(out.get('n1')!.name).toBe('changed');
    expect(out.get('n2')!.name).toBe('n2');
  });

  it('evicts the oldest entry at the maxCacheSize boundary (LRU)', () => {
    // maxCacheSize is 1000 — warming 1001 distinct nodes evicts the
    // least-recently-used (oldest) entry, so its next read re-decodes.
    const nodes = Array.from({ length: 1001 }, (_, i) => makeNode(`evict${i}`));
    q.insertNodes(nodes);
    const warmed = q.getNodesByIds(nodes.map((n) => n.id)); // evict0 is oldest
    expect(q.getNodeById('evict1')).toBe(warmed.get('evict1') ?? null); // still cached
    expect(q.getNodeById('evict0')).not.toBe(warmed.get('evict0')); // evicted → fresh
  });

  it('touching a cached node refreshes its LRU position', () => {
    const nodes = Array.from({ length: 1001 }, (_, i) => makeNode(`lru${i}`));
    q.insertNodes(nodes);
    const warmed = q.getNodesByIds(nodes.map((n) => n.id)); // lru0 evicted, lru1 oldest
    const touched = q.getNodeById('lru0')!; // reinserted as newest (evicts lru1)
    // No write happened in between, so the cache is intact: the touched entry
    // survives, and the entry it displaced is now a miss.
    expect(q.getNodeById('lru0')).toBe(touched);
    expect(q.getNodeById('lru1')).not.toBe(warmed.get('lru1'));
  });

  it('invalidates the cache entry on deleteNode', () => {
    q.insertNodes([makeNode('del1')]);
    q.getNodeById('del1'); // warm
    q.deleteNode('del1');
    expect(q.getNodeById('del1')).toBeNull(); // stale cache would leak the row
  });
});

describe('insertNode cache invalidation', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-cache-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not serve a stale cached node after INSERT OR REPLACE', () => {
    // Regression: insertNode (which uses INSERT OR REPLACE) used to skip
    // cache invalidation, so the next getNodeById returned the pre-replace
    // version until LRU eviction.
    const original = makeNode('n1', 'oldName');
    q.insertNode(original);
    const beforeReplace = q.getNodeById('n1');
    expect(beforeReplace!.name).toBe('oldName');

    // Replace via insertNode (the bug path).
    q.insertNode({ ...original, name: 'newName', updatedAt: Date.now() });
    const afterReplace = q.getNodeById('n1');
    expect(afterReplace!.name).toBe('newName');
  });
});

describe('insertEdges endpoint validation', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-edges-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips edges with missing endpoints instead of failing the whole batch', () => {
    q.insertNodes([makeNode('source'), makeNode('target'), makeNode('other')]);

    expect(() =>
      q.insertEdges([
        { source: 'source', target: 'target', kind: 'calls' },
        { source: 'source', target: 'missing-target', kind: 'calls' },
        { source: 'missing-source', target: 'other', kind: 'references' },
      ])
    ).not.toThrow();

    const edges = q.getOutgoingEdges('source');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'source', target: 'target', kind: 'calls' });
  });

  it('does not trust stale cached nodes when validating edge endpoints', () => {
    q.insertNodes([makeNode('source'), makeNode('target')]);
    expect(q.getNodeById('target')!.id).toBe('target');

    db.getDb().prepare('DELETE FROM nodes WHERE id = ?').run('target');

    expect(() =>
      q.insertEdges([{ source: 'source', target: 'target', kind: 'calls' }])
    ).not.toThrow();
    expect(q.getOutgoingEdges('source')).toEqual([]);
  });
});

describe('runMaintenance', () => {
  let dir: string;
  let db: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-maint-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs without throwing on a fresh database', () => {
    expect(() => db.runMaintenance()).not.toThrow();
  });

  it('runs without throwing after writes', () => {
    const q = new QueryBuilder(db.getDb());
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    expect(() => db.runMaintenance()).not.toThrow();
  });

  it('swallows failures rather than propagating (best-effort)', () => {
    // Close the DB so the underlying handle would normally throw on any
    // exec(). runMaintenance must still not propagate.
    db.close();
    expect(() => db.runMaintenance()).not.toThrow();
  });
});

describe('edge traversal order (#2038)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-edge-order-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    q.insertNodes(['hub', 'file:a', 'function:b', 'function:z'].map((id) => makeNode(id)));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['incoming', 'outgoing'] as const)(
    'keeps calls ahead of imports with deterministic %s ties across rewrites', (direction) => {
      const peerKey = direction === 'incoming' ? 'source' : 'target';
      const hubKey = direction === 'incoming' ? 'target' : 'source';
      const shapes: Array<[string, Edge['kind'], number, number]> = [
        ['function:z', 'calls', 4, 2],
        ['file:a', 'imports', 1, 0],
        ['function:b', 'calls', 7, 2],
        ['file:a', 'references', 2, 0],
        ['function:b', 'calls', 3, 2],
        ['function:b', 'calls', 3, 1],
      ];
      const edges: Edge[] = shapes.map(([peer, kind, line, column]) => ({
        source: '', target: '', [hubKey]: 'hub', [peerKey]: peer,
        kind, line, column, provenance: 'tree-sitter',
      }));
      // kind FIRST (calls < imports < references), then endpoint, line, col:
      // source-first ordering would put the opaque `file:a` ID ahead of every
      // `function:*` caller and consume a capped caller list with imports.
      const expected = [shapes[5], shapes[4], shapes[2], shapes[0], shapes[1], shapes[3]];
      for (const insertionOrder of [edges, [...edges].reverse()]) {
        db.getDb().exec('DELETE FROM edges');
        q.insertEdges(insertionOrder);
        // Exercise both the cached unfiltered query and the dynamic filtered one.
        for (const kinds of [undefined, ['references', 'imports', 'calls'] as Edge['kind'][]]) {
          const result = direction === 'incoming'
            ? q.getIncomingEdges('hub', kinds) : q.getOutgoingEdges('hub', kinds);
          expect(result.map((edge) => [edge[peerKey], edge.kind, edge.line, edge.column])).toEqual(expected);
        }
        if (direction === 'outgoing') {
          expect(q.getOutgoingEdges('hub', undefined, 'tree-sitter')
            .map((edge) => [edge[peerKey], edge.kind, edge.line, edge.column])).toEqual(expected);
        }
      }
    }
  );
});
