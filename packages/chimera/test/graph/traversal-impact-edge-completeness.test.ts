/**
 * getImpactRadius must keep a direct dependency edge into a node already
 * collected via another path — port of upstream 43a6fa6 (#1089), in its
 * terminal 52df4d2 shape. The `!nodes.has(...)` collection gate also gated
 * edge recording, so a second incoming edge into an already-collected node
 * was silently dropped from the edge set even though it is a real
 * dependency. The terminal shape records each expanded node's incoming
 * edges unconditionally on its first expansion only (`expanded` set), which
 * keeps the #1974 nearer-depth re-expansion from recording them twice.
 *
 * Drives GraphTraverser directly against an in-memory graph (upstream's
 * approach) so the exact topology is deterministic without round-tripping
 * through extraction.
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

describe('getImpactRadius edge completeness (#1089, upstream 43a6fa6)', () => {
  it('keeps a direct edge into a node already collected via another path', () => {
    // Class P contains method M. Q calls both M and P. Reaching M first collects
    // Q; the pre-fix `!nodes.has()` gate then dropped the direct Q→P edge.
    const nodes = [tNode('P', 'class'), tNode('M', 'method'), tNode('Q')];
    const edges: Edge[] = [
      { source: 'P', target: 'M', kind: 'contains' },
      { source: 'Q', target: 'M', kind: 'calls', line: 1 },
      { source: 'Q', target: 'P', kind: 'calls', line: 2 },
    ];
    const sub = tGraph(nodes, edges).getImpactRadius('P', 2);

    expect(sub.nodes.has('Q')).toBe(true);
    expect(sub.edges.some((e) => e.source === 'Q' && e.target === 'M' && e.kind === 'calls')).toBe(true);
    // The regression: this direct dependency edge used to vanish.
    expect(sub.edges.some((e) => e.source === 'Q' && e.target === 'P' && e.kind === 'calls')).toBe(true);
    // Unconditional recording must not duplicate edges either: each node's
    // incoming edges land once, on its first expansion (terminal 52df4d2 shape).
    const keys = sub.edges.map((e) => `${e.source}>${e.target}:${e.kind}:${e.line ?? -1}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
