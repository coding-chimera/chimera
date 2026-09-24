import { Database, type Statement } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

// (R2) drizzle-orm's bun-sqlite session re-prepares every query
// (`new PreparedQuery(this.client.prepare(query.sql), ...)` in
// drizzle-orm/bun-sqlite/session.js) with no statement cache, bypassing
// bun:sqlite's own `db.query()` cache. drizzle is a catalog dependency and
// must not be patched in node_modules, so we hand it a per-instance proxy
// that caches prepared statements by SQL text instead.
//
// Safety notes:
// - drizzle never calls finalize()/free() on statements (run/get/all/values
//   only), so cached statements are never released behind our back.
// - Evicted statements are NOT explicitly finalized: drizzle's public
//   `.prepare()` lets callers hold a PreparedQuery past eviction, and
//   bun:sqlite finalizes statements via GC / on db.close().
// - Statements are connection-scoped, not transaction-scoped; reusing one
//   across transactions on the same connection is exactly what bun's own
//   db.query() cache does, so WAL/lock semantics are unchanged.
// - Cache is keyed by SQL text; drizzle emits parameterized SQL (? placeholders),
//   so key cardinality is bounded by query shapes, not values.
const PREPARE_CACHE_LIMIT = 256

export function withPrepareCache(sqlite: Database, limit = PREPARE_CACHE_LIMIT): Database {
  const cache = new Map<string, Statement>()
  return new Proxy(sqlite, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const cached = cache.get(sql)
          if (cached) {
            // Refresh LRU position on hit.
            cache.delete(sql)
            cache.set(sql, cached)
            return cached
          }
          const stmt = target.prepare(sql)
          cache.set(sql, stmt)
          while (cache.size > limit) {
            const oldest = cache.keys().next()
            if (oldest.done) break
            cache.delete(oldest.value)
          }
          return stmt
        }
      }
      if (prop === "close") {
        return () => {
          cache.clear()
          target.close()
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export function init(path: string) {
  const sqlite = withPrepareCache(new Database(path, { create: true }))
  const db = drizzle({ client: sqlite })
  return db
}
