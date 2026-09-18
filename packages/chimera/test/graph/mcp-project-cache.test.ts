/**
 * (R1 A5) ToolHandler.projectCache eviction: distinct cached CodeGraph
 * instances are LRU-capped at 8; victims are closed and all of their alias
 * keys removed; the server-owned default instance is never evicted.
 *
 * Uses fake CodeGraph objects injected into the private cache so the test
 * stays fast and never opens a real SQLite connection.
 */
import { describe, expect, test } from 'bun:test';
import { ToolHandler } from '@/graph/mcp/tools';
import type CodeGraphType from '@/graph/index';

type FakeGraph = { name: string; close: () => void };

function fake(name: string, closed: string[]): FakeGraph {
  return { name, close: () => closed.push(name) };
}

function injectCache(handler: ToolHandler, entries: Array<[string, FakeGraph]>) {
  const cache = (handler as unknown as { projectCache: Map<string, CodeGraphType> }).projectCache;
  for (const [key, cg] of entries) cache.set(key, cg as unknown as CodeGraphType);
}

function evict(handler: ToolHandler) {
  (handler as unknown as { evictProjectCacheOverflow: () => void }).evictProjectCacheOverflow();
}

describe('ToolHandler projectCache eviction (R1 A5)', () => {
  test('closes coldest distinct instances beyond the cap and removes alias keys', () => {
    const handler = new ToolHandler(null);
    const closed: string[] = [];
    const entries: Array<[string, FakeGraph]> = [];
    for (let i = 0; i < 10; i++) {
      const cg = fake(`p${i}`, closed);
      entries.push([`/root/${i}`, cg]);
      entries.push([`/alias/${i}`, cg]);
    }
    injectCache(handler, entries);

    evict(handler);

    const cache = (handler as unknown as { projectCache: Map<string, CodeGraphType> }).projectCache;
    expect(new Set(cache.values()).size).toBe(8);
    expect(closed).toEqual(['p0', 'p1']);
    expect(cache.has('/root/0')).toBe(false);
    expect(cache.has('/alias/0')).toBe(false);
    expect(cache.has('/root/1')).toBe(false);
    expect(cache.has('/root/9')).toBe(true);
    expect(cache.has('/alias/9')).toBe(true);
  });

  test('never evicts the server-owned default instance', () => {
    const closed: string[] = [];
    const dflt = fake('default', closed);
    const handler = new ToolHandler(dflt as unknown as CodeGraphType);
    const entries: Array<[string, FakeGraph]> = [['/default', dflt]];
    for (let i = 0; i < 10; i++) entries.push([`/root/${i}`, fake(`p${i}`, closed)]);
    injectCache(handler, entries);

    evict(handler);

    const cache = (handler as unknown as { projectCache: Map<string, CodeGraphType> }).projectCache;
    expect(cache.has('/default')).toBe(true);
    expect(closed).toEqual(['p0', 'p1']);
  });

  test('below-cap caches are untouched', () => {
    const handler = new ToolHandler(null);
    const closed: string[] = [];
    injectCache(handler, [
      ['/a', fake('a', closed)],
      ['/b', fake('b', closed)],
    ]);

    evict(handler);

    const cache = (handler as unknown as { projectCache: Map<string, CodeGraphType> }).projectCache;
    expect(cache.size).toBe(2);
    expect(closed).toEqual([]);
  });
});
