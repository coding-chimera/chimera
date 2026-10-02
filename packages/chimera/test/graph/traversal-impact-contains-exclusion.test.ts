/**
 * Impact must not climb the structural `contains` edge — port of upstream
 * ddb1a8f (#536). A container "contains" its members but does not *depend*
 * on them, so following that edge upward from a leaf method pulls in the
 * parent class, whose container descent then re-expands every sibling
 * member and explodes the impact set. Upstream anchors this on a real index
 * (DerivedClass/getName in graph.test.ts); the fork test family drives
 * GraphTraverser over an in-memory graph so the topology is deterministic
 * without round-tripping through extraction.
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

describe('getImpactRadius contains exclusion (#536, upstream ddb1a8f)', () => {
  // Class C contains leaf method M1 and sibling M2; X calls M1.
  const nodes = [tNode('C', 'class'), tNode('M1', 'method'), tNode('M2', 'method'), tNode('X')];
  const edges: Edge[] = [
    { source: 'C', target: 'M1', kind: 'contains' },
    { source: 'C', target: 'M2', kind: 'contains' },
    { source: 'X', target: 'M1', kind: 'calls', line: 1 },
  ];

  it('does not drag in the containing class or sibling members via the structural contains edge', () => {
    const impact = tGraph(nodes, edges).getImpactRadius('M1', 3);
    // The real dependent is collected.
    expect(impact.nodes.has('X')).toBe(true);
    expect(impact.nodes.has('M1')).toBe(true);
    // Pre-fix: the C→M1 contains edge climbed to C, whose container descent
    // re-expanded every sibling — C and M2 both landed in the impact set.
    expect(impact.nodes.has('C')).toBe(false);
    expect(impact.nodes.has('M2')).toBe(false);
    expect(impact.edges.some((e) => e.kind === 'contains')).toBe(false);
  });
});
