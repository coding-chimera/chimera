/**
 * LRUCache unit tests
 *
 * Covers the eviction guarantees that the resolver relies on:
 *   - capacity is enforced (never exceeds max)
 *   - LRU ordering: hot keys survive eviction passes
 *   - has()/get()/set()/clear() behave like the original Map shape
 *   - null values are storable (the fileCache uses null for "failed read")
 */

import { describe, it, expect } from '../vitest';
import { LRUCache } from '../../../src/graph/resolution/lru-cache';

describe('LRUCache', () => {
  it('enforces capacity by evicting the oldest entry on overflow', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // evicts 'a'

    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('promotes touched keys to most-recent so they survive eviction', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Touch 'a' — it should now be most-recent.
    expect(cache.get('a')).toBe(1);

    cache.set('d', 4); // evicts the LRU, which is now 'b' (not 'a')

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('overwriting an existing key refreshes its recency but does not grow size', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99); // 'a' is now most-recent

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(99);

    cache.set('c', 3); // should evict 'b', not 'a'

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('stores null values (used by the file content cache)', () => {
    const cache = new LRUCache<string, string | null>(2);
    cache.set('missing.ts', null);
    expect(cache.has('missing.ts')).toBe(true);
    expect(cache.get('missing.ts')).toBeNull();
  });

  it('clear() resets the cache', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new LRUCache(0)).toThrow();
    expect(() => new LRUCache(-1)).toThrow();
    expect(() => new LRUCache(NaN)).toThrow();
  });

  it('stays bounded under heavy churn (regression for OOM scenario)', () => {
    const cache = new LRUCache<string, number>(100);
    for (let i = 0; i < 10_000; i++) {
      cache.set(`key${i}`, i);
    }
    expect(cache.size).toBe(100);
    // The last 100 keys should still be present, the rest evicted.
    expect(cache.has('key9999')).toBe(true);
    expect(cache.has('key9900')).toBe(true);
    expect(cache.has('key0')).toBe(false);
  });

  describe('byte budget', () => {
    it('evicts by bytes before the entry cap is reached', () => {
      // 4-entry cap, 10-byte budget: three 4-byte values fit, the fourth evicts
      // the oldest even though the count cap would still admit it.
      const cache = new LRUCache<string, string>(4, {
        maxBytes: 10,
        sizeOf: (value) => value.length,
      });
      cache.set('a', 'aaaa');
      cache.set('b', 'bbbb');
      expect(cache.bytes).toBe(8);
      cache.set('c', 'cccc');
      expect(cache.bytes).toBe(8);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
    });

    it('keeps both caps independent: the smaller one wins', () => {
      const cache = new LRUCache<string, string>(2, {
        maxBytes: 1_000,
        sizeOf: (value) => value.length,
      });
      cache.set('a', 'aaaa');
      cache.set('b', 'bbbb');
      cache.set('c', 'cccc');
      expect(cache.size).toBe(2);
      expect(cache.has('a')).toBe(false);
      expect(cache.bytes).toBe(8);
    });

    it('overwrite replaces the old weight instead of double-counting it', () => {
      const cache = new LRUCache<string, string>(4, {
        maxBytes: 100,
        sizeOf: (value) => value.length,
      });
      cache.set('a', 'aaaa');
      cache.set('b', 'bbbb');
      cache.set('a', 'aaaaaaaa');
      expect(cache.bytes).toBe(12);
      expect(cache.size).toBe(2);
    });

    it('stores a single over-budget value alone so the cache is never empty', () => {
      const cache = new LRUCache<string, string>(4, {
        maxBytes: 3,
        sizeOf: (value) => value.length,
      });
      cache.set('a', 'aaaa');
      cache.set('b', 'bbbb');
      expect(cache.size).toBe(1);
      expect(cache.has('b')).toBe(true);
      expect(cache.bytes).toBe(4);
    });

    it('clear() resets the byte accounting', () => {
      const cache = new LRUCache<string, string>(4, {
        maxBytes: 100,
        sizeOf: (value) => value.length,
      });
      cache.set('a', 'aaaa');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.bytes).toBe(0);
    });

    it('defaults to count-only accounting when no sizeOf is given', () => {
      const cache = new LRUCache<string, string>(2, { maxBytes: 1 });
      cache.set('a', 'aaaa');
      cache.set('b', 'bbbb');
      expect(cache.size).toBe(2);
      expect(cache.bytes).toBe(0);
    });
  });
});
