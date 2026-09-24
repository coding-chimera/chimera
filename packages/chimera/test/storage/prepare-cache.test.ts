import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import { withPrepareCache } from "@/storage/db.bun"

// (R2) The shim must cut drizzle's per-query re-prepare down to one prepare
// per distinct SQL text, while staying behaviorally identical: statement
// reuse with re-bound params, LRU eviction, transaction parity, and
// passthrough of everything except prepare/close.

function counting(sqlite: Database) {
  const counter = { prepare: 0 }
  const proxy = new Proxy(sqlite, {
    get(target, prop, receiver) {
      if (prop === "prepare")
        return (query: string) => {
          counter.prepare++
          return target.prepare(query)
        }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { proxy, counter }
}

function drizzleWith(sqlite: Database) {
  const harness = counting(sqlite)
  const db = drizzle({ client: withPrepareCache(harness.proxy) })
  return { db, counter: harness.counter }
}

describe("bun:sqlite statement reuse semantics", () => {
  test("one Statement run repeatedly with different params is safe (correctness point 1)", () => {
    const raw = new Database(":memory:")
    raw.run("CREATE TABLE t (a INTEGER, b TEXT)")
    const stmt = raw.prepare("INSERT INTO t VALUES (?, ?)")
    stmt.run(1, "x")
    stmt.run(2, "y")
    stmt.run(3, "z")
    expect(raw.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 3 })
    expect(raw.prepare("SELECT b FROM t WHERE a = ?").all(2)).toEqual([{ b: "y" }])
    raw.close()
  })
})

describe("withPrepareCache", () => {
  test("returns the same Statement instance for the same SQL text", () => {
    const wrapped = withPrepareCache(new Database(":memory:"))
    const a = wrapped.prepare("SELECT 1")
    const b = wrapped.prepare("SELECT 1")
    expect(a).toBe(b)
    wrapped.close()
  })

  test("evicts least-recently-used entries beyond the limit (correctness: bounded cache)", () => {
    const raw = new Database(":memory:")
    const wrapped = withPrepareCache(raw, 2)
    const first = wrapped.prepare("SELECT 1")
    wrapped.prepare("SELECT 2")
    wrapped.prepare("SELECT 3") // evicts "SELECT 1"
    expect(wrapped.prepare("SELECT 1")).not.toBe(first)
    // "SELECT 3" was used most recently and must still be cached.
    const third = wrapped.prepare("SELECT 3")
    expect(wrapped.prepare("SELECT 3")).toBe(third)
    wrapped.close()
  })

  test("passes through non-prepare surface and close()", () => {
    const raw = new Database(":memory:")
    const wrapped = withPrepareCache(raw)
    wrapped.run("CREATE TABLE t (a INTEGER)")
    expect(() => raw.prepare("SELECT a FROM t")).not.toThrow()
    wrapped.close()
    // Post-close prepare must fail on the underlying connection: close passed through.
    expect(() => raw.prepare("SELECT 1")).toThrow()
  })
})

describe("drizzle integration with prepare cache", () => {
  test("prepare count drops to one per distinct SQL across repeated parameterized queries", () => {
    const { db, counter } = drizzleWith(new Database(":memory:"))
    db.run(sql`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`)
    const createPrepares = counter.prepare

    for (const name of ["a", "b", "c", "d", "e"]) db.run(sql`INSERT INTO t (name) VALUES (${name})`)
    // Five inserts share one parameterized SQL text -> exactly one extra prepare.
    expect(counter.prepare).toBe(createPrepares + 1)

    for (let i = 0; i < 5; i++) db.all(sql`SELECT id, name FROM t ORDER BY id`)
    expect(counter.prepare).toBe(createPrepares + 2)

    const rows = db.all(sql`SELECT id, name FROM t ORDER BY id`) as { id: number; name: string }[]
    expect(rows.map((row) => row.name)).toEqual(["a", "b", "c", "d", "e"])
    db.$client.close()
  })

  test("behavioral parity: interleaved queries with different params return correct results", () => {
    const { db } = drizzleWith(new Database(":memory:"))
    db.run(sql`CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)`)
    db.run(sql`INSERT INTO kv (k, v) VALUES (${"x"}, ${1})`)
    db.run(sql`INSERT INTO kv (k, v) VALUES (${"y"}, ${2})`)
    // Interleave the two cached query shapes with re-bound params.
    expect(db.get(sql`SELECT v FROM kv WHERE k = ${"y"}`) as { v: number } | undefined).toEqual({ v: 2 })
    expect(db.get(sql`SELECT v FROM kv WHERE k = ${"x"}`) as { v: number } | undefined).toEqual({ v: 1 })
    expect(db.all(sql`SELECT k FROM kv WHERE v > ${0} ORDER BY k`)).toEqual([{ k: "x" }, { k: "y" }])
    expect(db.get(sql`SELECT v FROM kv WHERE k = ${"missing"}`)).toBeUndefined()
    db.$client.close()
  })

  test("statement reuse is correct across transaction boundaries (correctness point 3)", () => {
    const { db } = drizzleWith(new Database(":memory:"))
    db.run(sql`CREATE TABLE t (name TEXT)`)
    db.run(sql`INSERT INTO t (name) VALUES (${"before"})`)

    db.transaction((tx) => {
      tx.run(sql`INSERT INTO t (name) VALUES (${"inside"})`)
      expect(tx.all(sql`SELECT name FROM t ORDER BY rowid`)).toEqual([{ name: "before" }, { name: "inside" }])
    })

    // Rolled-back transaction must not leak rows through the cached statement.
    try {
      db.transaction((tx) => {
        tx.run(sql`INSERT INTO t (name) VALUES (${"rolled-back"})`)
        throw new Error("rollback")
      })
    } catch {}
    expect(db.all(sql`SELECT name FROM t ORDER BY rowid`)).toEqual([{ name: "before" }, { name: "inside" }])
    db.$client.close()
  })

  test("drizzle-generated SQL is parameterized so cache keys stay stable (correctness point 4)", () => {
    const { db, counter } = drizzleWith(new Database(":memory:"))
    db.run(sql`CREATE TABLE t (name TEXT)`)
    for (const name of ["distinct-literal-1", "distinct-literal-2", "distinct-literal-3"])
      db.run(sql`INSERT INTO t (name) VALUES (${name})`)
    // Values never reach the SQL text: all inserts collapse onto one cache key.
    expect(counter.prepare).toBe(2)
    db.$client.close()
  })
})
