/**
 * Simple LRU cache backed by JavaScript's insertion-ordered Map.
 *
 * Used by ReferenceResolver to bound the per-resolver caches that
 * previously grew without limit and OOM'd on large codebases (20k+
 * files). Each cache is sized independently — see `index.ts` for
 * the chosen limits per cache type.
 *
 * Eviction is plain LRU: on `set`, if the cache is full, the
 * least-recently-used entry (the first one in iteration order) is
 * evicted. Touching via `get` moves the entry to the most-recently-used
 * position so hot keys survive eviction passes.
 *
 * Optional byte ceiling: entry count alone does not bound memory when the
 * cached values are whole file contents (or their split line arrays), so the
 * content caches pass a `maxBytes` + `sizeOf` pair as well. A value whose own
 * weight exceeds `maxBytes` is still stored (alone) so the cache never goes
 * permanently empty and the caller keeps its single-entry fast path.
 */
export interface LRUCacheOptions<V> {
  /** Soft byte ceiling for the retained values. 0/undefined = count-only. */
  maxBytes?: number;
  /** Byte weight of one value. Defaults to 0 (count-only caches). */
  sizeOf?: (value: V) => number;
}

export class LRUCache<K, V> {
  private readonly max: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;
  private readonly store = new Map<K, V>();
  private usedBytes = 0;

  constructor(max: number, options: LRUCacheOptions<V> = {}) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`LRUCache max must be a positive finite number, got ${max}`);
    }
    this.max = Math.floor(max);
    this.maxBytes =
      Number.isFinite(options.maxBytes) && (options.maxBytes ?? 0) > 0
        ? Math.floor(options.maxBytes!)
        : 0;
    this.sizeOf = options.sizeOf ?? (() => 0);
  }

  get size(): number {
    return this.store.size;
  }

  /** Sum of `sizeOf` over the retained values (0 for count-only caches). */
  get bytes(): number {
    return this.usedBytes;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      // Distinguish "missing" from "stored undefined" by checking has().
      // We don't store undefined in practice, but be defensive.
      return this.store.has(key) ? value : undefined;
    }
    // Refresh recency by re-inserting.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    const size = Math.max(0, this.sizeOf(value));
    if (this.store.has(key)) {
      // Overwrite: drop the old weight before deciding on eviction so a larger
      // replacement cannot be counted twice.
      this.usedBytes -= Math.max(0, this.sizeOf(this.store.get(key) as V));
      this.store.delete(key);
    }
    // Evict the oldest entries until BOTH caps admit the incoming value. The
    // byte loop stops at an empty cache, so one oversize value is stored alone.
    while (
      this.store.size > 0 &&
      (this.store.size >= this.max ||
        (this.maxBytes > 0 && this.usedBytes + size > this.maxBytes))
    ) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.usedBytes -= Math.max(0, this.sizeOf(this.store.get(oldest) as V));
      this.store.delete(oldest);
    }
    this.store.set(key, value);
    this.usedBytes += size;
  }

  clear(): void {
    this.store.clear();
    this.usedBytes = 0;
  }
}
