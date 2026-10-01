/**
 * Depth-limited walks must not lose dependents within the depth limit to edge
 * order — port of upstream 52df4d2 (#1974/#2000). getImpactRadius, getCallers
 * and getCallees are depth-limited DFS walks; pre-fix, a node first reached
 * through a longer path at the depth limit was marked visited without being
 * expanded, so when a shorter path reached it later it was skipped and its own
 * dependents within the limit were lost. The walk now records the shallowest
 * depth each node was expanded at and re-expands it when a nearer path arrives;
 * results and edges are still reported once.
 *
 * Drives GraphTraverser directly against an in-memory graph (upstream's
 * approach) so the exact edge-order topology is deterministic without
 * round-tripping through extraction.
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

describe('Traversal depth-limit re-expansion (#1974, upstream 52df4d2)', () => {
  // The issue's graph: a→t, b→a, b→t, c→b. Edge order sends the walk to b
  // through a first, at the depth limit, before the direct b→t edge.
  const depthNodes = ['t', 'a', 'b', 'c'].map((n) => tNode(n));
  const depthEdges: Edge[] = [
    { source: 'a', target: 't', kind: 'calls', line: 1 },
    { source: 'b', target: 'a', kind: 'calls', line: 2 },
    { source: 'b', target: 't', kind: 'calls', line: 3 },
    { source: 'c', target: 'b', kind: 'calls', line: 4 },
  ];

  it('getImpactRadius finds a dependent within the depth even when a longer path reaches its parent first', () => {
    const sub = tGraph(depthNodes, depthEdges).getImpactRadius('t', 2);
    // c → b → t is two hops. Pre-fix: b was first reached via a at depth 2 and
    // never expanded again, so c was missing.
    expect([...sub.nodes.keys()].sort()).toEqual(['a', 'b', 'c', 't']);
    expect(sub.edges.some((e) => e.source === 'c' && e.target === 'b')).toBe(true);
    // Re-expanding b does not record its incoming edges twice.
    const keys = sub.edges.map((e) => `${e.source}>${e.target}:${e.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('getCallers at depth N finds every caller within N hops, each once', () => {
    const callers = tGraph(depthNodes, depthEdges).getCallers('t', 2);
    expect(callers.map((c) => c.node.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('getCallees at depth N finds every callee within N hops, each once', () => {
    // Mirror image: t→a, a→b, t→b, b→c. From t, b is 1 hop and c is 2.
    const edges: Edge[] = [
      { source: 't', target: 'a', kind: 'calls', line: 1 },
      { source: 'a', target: 'b', kind: 'calls', line: 2 },
      { source: 't', target: 'b', kind: 'calls', line: 3 },
      { source: 'b', target: 'c', kind: 'calls', line: 4 },
    ];
    const callees = tGraph(depthNodes, edges).getCallees('t', 2);
    expect(callees.map((c) => c.node.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
