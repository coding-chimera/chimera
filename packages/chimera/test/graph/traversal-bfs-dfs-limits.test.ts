/**
 * traverseBFS/traverseDFS edge completeness and node-limit precision — port
 * of upstream 43a6fa6 (#1087, #1088, #1090).
 *
 * - #1090: the enqueue guard was `visited` alone, so a target reachable via
 *   two edges was queued twice; the second dequeue hit `visited.has →
 *   continue` and its edge was never recorded — parallel edges (calls AND
 *   references, or two `calls` on different lines) went missing. The fix
 *   records every distinct edge on the adjacency scan (deduped on edge
 *   identity) and enqueues each node exactly once via a separate `enqueued`
 *   set.
 * - #1087/#1088: `opts.limit` was only checked per-frame (outer `while` for
 *   BFS, top of dfsRecursive for DFS), so one high-degree node overshot the
 *   limit by its full fan-out. Both walks now cap per-add.
 *
 * Drives GraphTraverser directly against an in-memory graph (upstream's
 * approach) so the exact parallel-edge / high-degree topologies are
 * deterministic without round-tripping through extraction.
 */

import { describe, it, expect } from './vitest';
import { Node, Edge } from '../../src/graph/types';
import { GraphTraverser } from '../../src/graph/graph/traversal';

/** Minimal Node stub — the traversal code only reads id/kind/name. */
function tNode(id: string, kind: Node['kind'] = 'function'): Node {
  return {
    id,
    kind,
    name: id,
    qualifiedName: id,
    filePath: `src/${id}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
  } as unknown as Node;
}

/** Build a GraphTraverser over a fixed node/edge set, honoring the `kinds` filter. */
function tGraph(nodes: Node[], edges: Edge[]): GraphTraverser {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const q = {
    getNodeById: (id: string) => byId.get(id) ?? null,
    getNodesByIds: (ids: readonly string[]) => {
      const m = new Map<string, Node>();
      for (const id of ids) {
        const n = byId.get(id);
        if (n) m.set(id, n);
      }
      return m;
    },
    getOutgoingEdges: (source: string, kinds?: string[]) =>
      edges.filter((e) => e.source === source && (!kinds || kinds.includes(e.kind))),
    getIncomingEdges: (target: string, kinds?: string[]) =>
      edges.filter((e) => e.target === target && (!kinds || kinds.includes(e.kind))),
  };
  return new GraphTraverser(q as never);
}

describe('traverseBFS edge completeness & limits (#1087, #1090, upstream 43a6fa6)', () => {
  it('traverseBFS keeps every parallel edge to the same target (#1090)', () => {
    // A reaches B via both `calls` and `references` — two distinct edges.
    const edges: Edge[] = [
      { source: 'A', target: 'B', kind: 'calls', line: 1 },
      { source: 'A', target: 'B', kind: 'references', line: 2 },
    ];
    const sub = tGraph([tNode('A'), tNode('B')], edges).traverseBFS('A', { direction: 'outgoing' });

    const ab = sub.edges.filter((e) => e.source === 'A' && e.target === 'B');
    // Pre-fix: only the higher-priority `calls` edge survived; `references` was dropped.
    expect(ab.map((e) => e.kind).sort()).toEqual(['calls', 'references']);
    expect(sub.nodes.has('B')).toBe(true);
  });

  it('traverseBFS keeps two same-kind edges on different lines (#1090)', () => {
    const edges: Edge[] = [
      { source: 'A', target: 'B', kind: 'calls', line: 3 },
      { source: 'A', target: 'B', kind: 'calls', line: 7 },
    ];
    const sub = tGraph([tNode('A'), tNode('B')], edges).traverseBFS('A', { direction: 'outgoing' });
    expect(sub.edges.filter((e) => e.source === 'A' && e.target === 'B')).toHaveLength(2);
  });

  it('traverseBFS records each edge once under direction:both', () => {
    // A `both` scan encounters A→B from both endpoints; edge-identity dedup
    // keeps it a single entry (part of the #1090 fix's seenEdges guard).
    const edges: Edge[] = [{ source: 'A', target: 'B', kind: 'calls', line: 1 }];
    const sub = tGraph([tNode('A'), tNode('B')], edges).traverseBFS('A', { direction: 'both' });
    expect(sub.edges.filter((e) => e.source === 'A' && e.target === 'B')).toHaveLength(1);
  });

  it('traverseBFS does not overshoot opts.limit on a high-degree node (#1087)', () => {
    const neighbors = ['B', 'C', 'D', 'E', 'F'];
    const nodes = [tNode('A'), ...neighbors.map((n) => tNode(n))];
    const edges: Edge[] = neighbors.map((n) => ({ source: 'A', target: n, kind: 'calls' as const }));
    const sub = tGraph(nodes, edges).traverseBFS('A', { limit: 3, direction: 'outgoing' });
    // Pre-fix: all 5 neighbors were added in one pass → 6 nodes despite limit 3.
    expect(sub.nodes.size).toBeLessThanOrEqual(3);
  });
});

describe('traverseDFS node-limit precision (#1088, upstream 43a6fa6)', () => {
  it('traverseDFS does not overshoot opts.limit on a high-degree node (#1088)', () => {
    const neighbors = ['B', 'C', 'D', 'E', 'F'];
    const nodes = [tNode('A'), ...neighbors.map((n) => tNode(n))];
    const edges: Edge[] = neighbors.map((n) => ({ source: 'A', target: n, kind: 'calls' as const }));
    const sub = tGraph(nodes, edges).traverseDFS('A', { limit: 2, direction: 'outgoing' });
    // Pre-fix: the top-of-frame guard only stopped the next recursion, so all
    // 5 siblings of the first over-budget child still got inserted.
    expect(sub.nodes.size).toBeLessThanOrEqual(2);
  });
});
