/**
 * findPath must enqueue each target once — port of upstream f4a9af2
 * (#1359/#2016). Path search marked nodes visited only on dequeue, allowing
 * pending targets to be queued repeatedly with copied paths (quadratic queue
 * churn on dense fan-in). Track enqueued nodes from the starting node and
 * exclude them from target lookups and subsequent pushes; shortest-path and
 * edge-filter semantics are unchanged.
 *
 * Real-SQLite coverage (upstream's approach): seeds nodes/edges directly
 * through the query layer and counts actual queue insertions, without timing
 * thresholds or replacing SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { Node, Edge } from '../../src/graph/types';

/** Minimal Node stub — the store only needs the shape, traversal reads id/kind/name. */
function tNode(id: string, kind: Node['kind'] = 'function'): Node {
  return {
    id,
    kind,
    name: id,
    qualifiedName: id,
    filePath: 'graph.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
  } as unknown as Node;
}

describe('findPath enqueue-once (#1359, upstream f4a9af2)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-findpath-'));
    fs.writeFileSync(path.join(testDir, 'graph.ts'), 'export function start() {}\n');
    cg = CodeGraph.initSync(testDir);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  function seed(ids: string[], edges: Edge[]) {
    for (const id of ids) {
      cg['queries'].insertNode(tNode(id));
    }
    edges.forEach((edge, i) => cg['queries'].insertEdge({ ...edge, line: i + 1 }));
  }

  it('enqueues each dense fan-in target once while preserving the shortest path', () => {
    const layerA = Array.from({ length: 16 }, (_, i) => `a${i}`);
    const layerB = Array.from({ length: 16 }, (_, i) => `b${i}`);
    const ids = ['start', ...layerA, ...layerB, 'end'];
    const edges: Edge[] = [];
    for (const a of layerA) {
      edges.push({ source: 'start', target: a, kind: 'calls' });
      for (const b of layerB) edges.push({ source: a, target: b, kind: 'calls' });
    }
    for (const b of layerB) edges.push({ source: b, target: 'end', kind: 'calls' });
    seed(ids, edges);

    // Count actual queue insertions, without timing thresholds or replacing SQLite.
    const counts = new Map<string, number>();
    const push = Array.prototype.push;
    let result: ReturnType<CodeGraph['findPath']>;
    try {
      Array.prototype.push = function (...items: unknown[]) {
        for (const item of items) {
          if (item && typeof item === 'object' && typeof (item as { nodeId?: unknown }).nodeId === 'string' && Array.isArray((item as { path?: unknown }).path)) {
            const nodeId = (item as { nodeId: string }).nodeId;
            counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
          }
        }
        // eslint-disable-next-line prefer-rest-params
        return Reflect.apply(push, this, items);
      };
      result = cg.findPath('start', 'end', ['calls']);
    } finally {
      Array.prototype.push = push;
    }
    expect(result?.map((step) => step.node.id)).toEqual(['start', 'a0', 'b0', 'end']);
    expect(result?.slice(1).every((step) => step.edge?.kind === 'calls')).toBe(true);
    // Pre-fix: every b node was queued once per incoming a edge (16x each).
    expect(counts).toEqual(new Map(ids.slice(1).map((id) => [id, 1])));
  });

  it('preserves shortest paths and edge filters with cycles and parallel edges', () => {
    seed(['start', 'a', 'b', 'end', 'isolated'], [
      { source: 'start', target: 'start', kind: 'calls' },
      { source: 'start', target: 'a', kind: 'calls' },
      { source: 'start', target: 'a', kind: 'calls' },
      { source: 'a', target: 'start', kind: 'calls' },
      { source: 'a', target: 'b', kind: 'calls' },
      { source: 'b', target: 'end', kind: 'calls' },
      { source: 'start', target: 'end', kind: 'references' },
    ]);
    const result = cg.findPath('start', 'end', ['calls']);
    expect(result?.map((step) => step.node.id)).toEqual(['start', 'a', 'b', 'end']);
    expect(result?.[1]!.edge?.line).toBe(2);
    expect(cg.findPath('start', 'end')?.map((step) => step.node.id)).toEqual(['start', 'end']);
    expect(cg.findPath('start', 'start')?.map((step) => step.node.id)).toEqual(['start']);
    expect(cg.findPath('start', 'isolated')).toBeNull();
    expect(cg.findPath('missing', 'end')).toBeNull();
    expect(cg.findPath('start', 'missing')).toBeNull();
    expect(cg.findPath('missing', 'missing')).toBeNull();
    expect(cg.findPath('start', 'end', ['imports'])).toBeNull();
  });
});
