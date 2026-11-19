/**
 * Resolver content caches are bounded by BYTES as well as entry count.
 *
 * `fileCache` (full file text) and `linesCache` (split line arrays) were
 * LRU-bounded by entry count only: 1000 retained 1 MiB files still pinned up to
 * ~1 GiB per cache. These tests pin the byte ceiling (`CODEGRAPH_RESOLVER_CACHE_BYTES`),
 * the untouched read-miss (`null`) caching, and that `clearCaches()` resets the
 * byte accounting. The TS arm is exercised explicitly (CODEGRAPH_CTX=0); the
 * native ctx bridge keeps its own entry-count LRU, which is out of scope here.
 */

import { afterEach, beforeEach, describe, expect, it } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { ReferenceResolver } from '../../src/graph/resolution';
import type { ResolutionContext } from '../../src/graph/resolution/types';
import { resetKernelForTests } from '../../src/graph/extraction/kernel';

type ContentCache = {
  bytes: number;
  size: number;
  has(key: string): boolean;
  get(key: string): unknown;
};

describe('resolver content cache byte budget', () => {
  let root: string;
  let cg: CodeGraph;
  let savedBytes: string | undefined;
  let savedCtx: string | undefined;

  beforeEach(() => {
    savedBytes = process.env.CODEGRAPH_RESOLVER_CACHE_BYTES;
    savedCtx = process.env.CODEGRAPH_CTX;
    process.env.CODEGRAPH_CTX = '0';
    resetKernelForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolver-budget-'));
    cg = CodeGraph.initSync(root);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    if (savedBytes === undefined) delete process.env.CODEGRAPH_RESOLVER_CACHE_BYTES;
    else process.env.CODEGRAPH_RESOLVER_CACHE_BYTES = savedBytes;
    if (savedCtx === undefined) delete process.env.CODEGRAPH_CTX;
    else process.env.CODEGRAPH_CTX = savedCtx;
    resetKernelForTests();
  });

  function makeResolver(): { resolver: ReferenceResolver; context: ResolutionContext } {
    const resolver = new ReferenceResolver(root, (cg as unknown as { queries: never }).queries);
    return { resolver, context: (resolver as unknown as { context: ResolutionContext }).context };
  }

  function fileCache(resolver: ReferenceResolver): ContentCache {
    return (resolver as unknown as { fileCache: ContentCache }).fileCache;
  }

  function linesCache(resolver: ReferenceResolver): ContentCache {
    return (resolver as unknown as { linesCache: ContentCache }).linesCache;
  }

  it('evicts file content by bytes before the entry cap is reached', () => {
    process.env.CODEGRAPH_RESOLVER_CACHE_BYTES = '10';
    const { resolver, context } = makeResolver();
    for (const [name, content] of [['a.ts', 'aaaa'], ['b.ts', 'bbbb'], ['c.ts', 'cccc']] as const) {
      fs.writeFileSync(path.join(root, name), content);
    }

    expect(context.readFile('a.ts')).toBe('aaaa');
    expect(context.readFile('b.ts')).toBe('bbbb');
    expect(context.readFile('c.ts')).toBe('cccc');

    const cache = fileCache(resolver);
    expect(cache.bytes).toBeLessThanOrEqual(10);
    expect(cache.size).toBe(2);
    expect(cache.has('a.ts')).toBe(false);
    expect(cache.has('c.ts')).toBe(true);

    // An evicted entry is re-read (never a stale/empty answer).
    expect(context.readFile('a.ts')).toBe('aaaa');
    resolver.dispose();
  });

  it('evicts split line arrays by bytes and keeps read-miss (null) entries', () => {
    process.env.CODEGRAPH_RESOLVER_CACHE_BYTES = '10';
    const { resolver, context } = makeResolver();
    for (const [name, content] of [['a.ts', 'aa\naa'], ['b.ts', 'bb\nbb'], ['c.ts', 'cc\ncc']] as const) {
      fs.writeFileSync(path.join(root, name), content);
    }

    // Optional on ResolutionContext so fixtures compile without it; the production
    // resolver wires it, so its absence here is a real regression, not a skip.
    const getFileLines = context.getFileLines
    if (!getFileLines) throw new Error('resolver context must expose getFileLines')
    expect(getFileLines('a.ts')).toEqual(['aa', 'aa'])
    expect(getFileLines('b.ts')).toEqual(['bb', 'bb'])
    expect(getFileLines('c.ts')).toEqual(['cc', 'cc'])

    const cache = linesCache(resolver);
    expect(cache.bytes).toBeLessThanOrEqual(10);
    expect(cache.size).toBe(2);
    expect(cache.has('a.ts')).toBe(false);

    // Read misses still cache as null and are not retried.
    expect(context.readFile('missing.ts')).toBeNull();
    expect(context.readFile('missing.ts')).toBeNull();
    expect(fileCache(resolver).has('missing.ts')).toBe(true);
    resolver.dispose();
  });

  it('clearCaches() resets byte accounting and re-reads fresh content', () => {
    process.env.CODEGRAPH_RESOLVER_CACHE_BYTES = '100';
    const { resolver, context } = makeResolver();
    fs.writeFileSync(path.join(root, 'a.ts'), 'aaaa');
    expect(context.readFile('a.ts')).toBe('aaaa');
    expect(fileCache(resolver).bytes).toBe(4);

    resolver.clearCaches();
    expect(fileCache(resolver).size).toBe(0);
    expect(fileCache(resolver).bytes).toBe(0);
    expect(linesCache(resolver).bytes).toBe(0);

    fs.writeFileSync(path.join(root, 'a.ts'), 'aaaaaaaa');
    expect(context.readFile('a.ts')).toBe('aaaaaaaa');
    expect(fileCache(resolver).bytes).toBe(8);
    resolver.dispose();
  });

  it('does not change read results under a tiny budget', () => {
    process.env.CODEGRAPH_RESOLVER_CACHE_BYTES = '1';
    const { resolver, context } = makeResolver();
    const content = 'export const answer = 42;\n';
    fs.writeFileSync(path.join(root, 'a.ts'), content);
    for (let i = 0; i < 5; i++) expect(context.readFile('a.ts')).toBe(content);
    // A single over-budget value is still stored alone (the cache never goes
    // empty), so the budget is a soft ceiling — results stay correct either way.
    expect(fileCache(resolver).size).toBeLessThanOrEqual(1);
    expect(fileCache(resolver).bytes).toBeLessThanOrEqual(content.length);
    resolver.dispose();
  });
});