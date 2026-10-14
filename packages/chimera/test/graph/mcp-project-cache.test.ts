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

const savedTtl = process.env.CODEGRAPH_MCP_PROJECT_CACHE_IDLE_TTL_MS;

function restoreTtl() {
  if (savedTtl === undefined) delete process.env.CODEGRAPH_MCP_PROJECT_CACHE_IDLE_TTL_MS;
  else process.env.CODEGRAPH_MCP_PROJECT_CACHE_IDLE_TTL_MS = savedTtl;
}

function lastUsed(handler: ToolHandler) {
  return (handler as unknown as { projectCacheLastUsed: Map<FakeGraph, number> }).projectCacheLastUsed;
}

function evictIdle(handler: ToolHandler, now: number) {
  (handler as unknown as { evictIdleProjectCache: (now?: number) => void }).evictIdleProjectCache(now);
}

describe('ToolHandler projectCache idle TTL (B1-MCP)', () => {
  test('closes instances idle beyond the TTL, sparing recently used ones', () => {
    const handler = new ToolHandler(null);
    const closed: string[] = [];
    const stale = fake('stale', closed);
    const fresh = fake('fresh', closed);
    injectCache(handler, [['/stale', stale], ['/fresh', fresh]]);
    const now = Date.now();
    lastUsed(handler).set(stale, now - 60 * 60 * 1000);
    lastUsed(handler).set(fresh, now);

    evictIdle(handler, now);

    const cache = (handler as unknown as { projectCache: Map<string, CodeGraphType> }).projectCache;
    expect(closed).toEqual(['stale']);
    expect(cache.has('/stale')).toBe(false);
    expect(cache.has('/fresh')).toBe(true);
  });

  test('never idle-evicts the server-owned default instance', () => {
    const closed: string[] = [];
    const dflt = fake('default', closed);
    const handler = new ToolHandler(dflt as unknown as CodeGraphType);
    injectCache(handler, [['/default', dflt]]);
    lastUsed(handler).set(dflt, Date.now() - 60 * 60 * 1000);

    evictIdle(handler, Date.now());

    const cache = (handler as unknown as { projectCache: Map<string, CodeGraphType> }).projectCache;
    expect(closed).toEqual([]);
    expect(cache.has('/default')).toBe(true);
  });

  test('0 disables idle eviction', () => {
    process.env.CODEGRAPH_MCP_PROJECT_CACHE_IDLE_TTL_MS = '0';
    try {
      const handler = new ToolHandler(null);
      const closed: string[] = [];
      const stale = fake('stale', closed);
      injectCache(handler, [['/stale', stale]]);
      lastUsed(handler).set(stale, Date.now() - 60 * 60 * 1000);

      evictIdle(handler, Date.now());

      expect(closed).toEqual([]);
    } finally {
      restoreTtl();
    }
  });

  test('an entry with no recorded last-use is left alone', () => {
    const handler = new ToolHandler(null);
    const closed: string[] = [];
    const untracked = fake('untracked', closed);
    injectCache(handler, [['/untracked', untracked]]);

    evictIdle(handler, Date.now() + 10 * 60 * 1000);

    expect(closed).toEqual([]);
  });
});
