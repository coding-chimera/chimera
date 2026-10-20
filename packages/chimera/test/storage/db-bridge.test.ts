import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  BRIDGE_REQUIRED_CAPABILITIES,
  createBridgeClient,
  getBridgeModule,
  resetBridgeForTests,
  setBridgeModuleForTests,
  sqliteBridgeEnabled,
  verifyBridgeContract,
  SQLITE_BRIDGE_ABI_VERSION,
  type BridgeClient,
  type SqliteBridgeModule,
} from "@/storage/db-bridge"
import { init } from "@/storage/db.bun"
import { encodePacked } from "./db-bridge-decode.test"

// Native sqlite_bridge coverage (codegraph-kernel/src/sqlite_bridge.rs +
// src/storage/db-bridge.ts). The bridge is default-OFF: these tests drive it
// through a FRESHLY BUILT target/release binary copied to a temp dir as
// codegraph-kernel.node (never touching codegraph-kernel/prebuilds/, the
// parallel-bench baseline arm) and pointed at via CHIMERA_SQLITE_BRIDGE_PATH
// — the loader.ts env-override precedent. When no built binary exists the
// real-binary suites skip, but the pure-TS arms (kill switch, contract
// failure fallback, both-arms parity on the bun path) always run.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..")

const savedEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function findBuiltBinary(): string | null {
  const explicit = process.env.CHIMERA_SQLITE_BRIDGE_BINARY
  if (explicit && fs.existsSync(explicit)) return explicit
  const candidates = [
    path.join(repoRoot, "codegraph-kernel", "target", "release", "libcodegraph_kernel.dylib"),
    // linux/windows release names, for CI portability
    path.join(repoRoot, "codegraph-kernel", "target", "release", "libcodegraph_kernel.so"),
    path.join(repoRoot, "codegraph-kernel", "target", "release", "codegraph_kernel.dll"),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

// Stage at MODULE scope: test.skipIf conditions are evaluated while the
// describe bodies register, before any beforeAll could run.
let tempDir: string | undefined
const bridgeNodePath: string | undefined = (() => {
  const built = findBuiltBinary()
  if (!built) return undefined
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-sqlite-bridge-"))
  const staged = path.join(tempDir, "codegraph-kernel.node")
  fs.copyFileSync(built, staged)
  setEnv("CHIMERA_SQLITE_BRIDGE_PATH", staged)
  return staged
})()
const hasBinary = bridgeNodePath !== undefined

afterAll(() => {
  setBridgeModuleForTests(null)
  for (const [name, value] of Object.entries(savedEnv)) setEnv(name, value)
  resetBridgeForTests()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

/** Run fn with the opt-in switch armed; env and module cache restored after. */
function withBridgeEnv(fn: () => void) {
  const previous = process.env.CHIMERA_SQLITE_BRIDGE
  setEnv("CHIMERA_SQLITE_BRIDGE", "1")
  resetBridgeForTests()
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env.CHIMERA_SQLITE_BRIDGE
    else process.env.CHIMERA_SQLITE_BRIDGE = previous
    resetBridgeForTests()
  }
}

function tmpDbPath(tag: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chimera-bridge-db-${tag}-`))
  return path.join(dir, "test.db")
}

/** A real bridge client (bridge env must be armed — see withBridgeEnv). */
function realClient(dbPath: string): BridgeClient {
  if (!bridgeNodePath) throw new Error("no staged bridge binary — test should have skipped")
  if (!sqliteBridgeEnabled()) throw new Error("bridge env not enabled — test setup bug")
  const client = createBridgeClient(dbPath)
  if (!client) throw new Error("createBridgeClient returned null with the bridge armed")
  return client
}

// ---------------------------------------------------------------------------
// Loader / kill switch (pure TS — always runs)
// ---------------------------------------------------------------------------

describe("sqlite bridge loader", () => {
  test("kill switch: unset or 0 disables the bridge even with a valid binary", () => {
    setEnv("CHIMERA_SQLITE_BRIDGE", undefined)
    resetBridgeForTests()
    try {
      expect(sqliteBridgeEnabled()).toBe(false)
      expect(createBridgeClient(":memory:")).toBeNull()

      setEnv("CHIMERA_SQLITE_BRIDGE", "0")
      resetBridgeForTests()
      expect(sqliteBridgeEnabled()).toBe(false)
      expect(createBridgeClient(":memory:")).toBeNull()
    } finally {
      delete process.env.CHIMERA_SQLITE_BRIDGE
      resetBridgeForTests()
    }
  })

  test("contract verification: ABI equality and capability subset", () => {
    expect(
      verifyBridgeContract({
        abiVersion: SQLITE_BRIDGE_ABI_VERSION,
        bridgeVersion: "x",
        capabilities: [...BRIDGE_REQUIRED_CAPABILITIES],
      }),
    ).toBe(true)
    expect(
      verifyBridgeContract({
        abiVersion: SQLITE_BRIDGE_ABI_VERSION,
        bridgeVersion: "x",
        capabilities: BRIDGE_REQUIRED_CAPABILITIES.filter((capability) => capability !== "values"),
      }),
    ).toBe(false)
    expect(
      verifyBridgeContract({ abiVersion: 99, bridgeVersion: "x", capabilities: [...BRIDGE_REQUIRED_CAPABILITIES] }),
    ).toBe(false)
  })

  test("a broken/foreign module fails silently: createBridgeClient → null, never throws", () => {
    const fake = {
      sqliteBridgeContractInfo: () => ({
        abiVersion: SQLITE_BRIDGE_ABI_VERSION + 999,
        bridgeVersion: "fake",
        capabilities: [...BRIDGE_REQUIRED_CAPABILITIES],
      }),
      // sqliteBridgeOpen deliberately missing — a contract-failed or
      // half-built module must degrade to the bun:sqlite fallback.
    } as unknown as SqliteBridgeModule
    setBridgeModuleForTests(fake)
    const previous = process.env.CHIMERA_SQLITE_BRIDGE
    setEnv("CHIMERA_SQLITE_BRIDGE", "1")
    try {
      expect(() => createBridgeClient(":memory:")).not.toThrow()
      expect(createBridgeClient(":memory:")).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CHIMERA_SQLITE_BRIDGE
      else process.env.CHIMERA_SQLITE_BRIDGE = previous
      setBridgeModuleForTests(null)
      resetBridgeForTests()
    }
  })
})

// ---------------------------------------------------------------------------
describe("sqlite bridge packed capability probe (pure TS)", () => {
  function fakeModule(withPacked: boolean, calls: string[]): SqliteBridgeModule {
    const mod = {
      sqliteBridgeContractInfo: () => ({
        abiVersion: SQLITE_BRIDGE_ABI_VERSION,
        bridgeVersion: "fake",
        capabilities: [...BRIDGE_REQUIRED_CAPABILITIES],
      }),
      sqliteBridgeOpen: () => ({}),
      sqliteBridgeExec: () => {},
      sqliteBridgeRun: () => ({ changes: 0, lastInsertRowid: 0 }),
      sqliteBridgeGet: () => null,
      sqliteBridgeAll: () => {
        calls.push("all")
        return [{ a: "object" }]
      },
      sqliteBridgeValues: () => {
        calls.push("values")
        return [["object"]]
      },
      sqliteBridgeTransactionBegin: () => {},
      sqliteBridgeTransactionCommit: () => {},
      sqliteBridgeTransactionRollback: () => {},
      sqliteBridgeInTransaction: () => false,
      sqliteBridgePragma: () => null,
      sqliteBridgeClose: () => {},
    } as unknown as SqliteBridgeModule
    if (withPacked) {
      mod.sqliteBridgeAllPacked = () => {
        calls.push("allPacked")
        return encodePacked(["a"], [["packed"]])
      }
      mod.sqliteBridgeValuesPacked = () => {
        calls.push("valuesPacked")
        return encodePacked(null, [["packed"]])
      }
    }
    return mod
  }

  function withFakeModule(mod: SqliteBridgeModule, fn: (client: BridgeClient) => void) {
    const previousBridge = process.env.CHIMERA_SQLITE_BRIDGE
    const previousPacked = process.env.CHIMERA_SQLITE_BRIDGE_PACKED
    setBridgeModuleForTests(mod)
    setEnv("CHIMERA_SQLITE_BRIDGE", "1")
    try {
      const client = createBridgeClient(":memory:")
      if (!client) throw new Error("fake module rejected by createBridgeClient")
      fn(client)
    } finally {
      if (previousBridge === undefined) delete process.env.CHIMERA_SQLITE_BRIDGE
      else process.env.CHIMERA_SQLITE_BRIDGE = previousBridge
      if (previousPacked === undefined) delete process.env.CHIMERA_SQLITE_BRIDGE_PACKED
      else process.env.CHIMERA_SQLITE_BRIDGE_PACKED = previousPacked
      setBridgeModuleForTests(null)
      resetBridgeForTests()
    }
  }

  test("module WITHOUT packed exports keeps the object path (old-binary fallback)", () => {
    const calls: string[] = []
    withFakeModule(fakeModule(false, calls), (client) => {
      expect(client.prepare("SELECT 1").all()).toEqual([{ a: "object" }])
      expect(client.prepare("SELECT 1").values()).toEqual([["object"]])
    })
    expect(calls).toEqual(["all", "values"])
  })

  test("module WITH packed exports routes all/values through the packed wire", () => {
    const calls: string[] = []
    withFakeModule(fakeModule(true, calls), (client) => {
      expect(client.prepare("SELECT 1").all()).toEqual([{ a: "packed" }])
      expect(client.prepare("SELECT 1").values()).toEqual([["packed"]])
    })
    expect(calls).toEqual(["allPacked", "valuesPacked"])
  })

  test("CHIMERA_SQLITE_BRIDGE_PACKED kill switch: 0 forces the object path, unset/1 defaults ON", () => {
    const calls: string[] = []
    withFakeModule(fakeModule(true, calls), (client) => {
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", "0")
      expect(client.prepare("SELECT 1").all()).toEqual([{ a: "object" }])
      expect(client.prepare("SELECT 1").values()).toEqual([["object"]])
      // Per-call flip — no cache invalidation needed (gate discipline).
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", "1")
      expect(client.prepare("SELECT 1").all()).toEqual([{ a: "packed" }])
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      expect(client.prepare("SELECT 1").values()).toEqual([["packed"]]) // unset = default ON
    })
    expect(calls).toEqual(["all", "values", "allPacked", "valuesPacked"])
  })
})

// ---------------------------------------------------------------------------
// Real-binary suites (skip when no built kernel binary is staged)
// ---------------------------------------------------------------------------

describe("sqlite bridge contract (real binary)", () => {
  test.skipIf(!hasBinary)("handshake: module loads, ABI and capabilities verify", () => {
    withBridgeEnv(() => {
      const mod = getBridgeModule()
      expect(mod).not.toBeNull()
      const info = mod!.sqliteBridgeContractInfo()
      expect(info.abiVersion).toBe(SQLITE_BRIDGE_ABI_VERSION)
      expect(info.bridgeVersion.length).toBeGreaterThan(0)
      for (const capability of BRIDGE_REQUIRED_CAPABILITIES) expect(info.capabilities).toContain(capability)
      expect(sqliteBridgeEnabled()).toBe(true)
    })
  })
})

describe("sqlite bridge client semantics (real binary)", () => {
  test.skipIf(!hasBinary)(":memory: opens and round-trips writes/reads", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)")
      const ins = client.prepare("INSERT INTO t (name, score) VALUES (?, ?)")
      expect(ins.run("a", 1.5)).toEqual({ changes: 1, lastInsertRowid: 1 })
      expect(ins.run("b", 2.5)).toEqual({ changes: 1, lastInsertRowid: 2 })

      const row = client.prepare("SELECT id, name, score FROM t WHERE id = ?").get(1)
      expect(row).toEqual({ id: 1, name: "a", score: 1.5 })
      expect(typeof row!.id).toBe("number") // bun default: safe integers as Number
      expect(client.prepare("SELECT id, name FROM t ORDER BY id").all()).toEqual([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ])
      expect(client.prepare("SELECT name FROM t ORDER BY id").values()).toEqual([["a"], ["b"]])
      expect(client.prepare("SELECT * FROM t WHERE id = ?").get(999)).toBeNull()
      client.close()
    })
  })

  test.skipIf(!hasBinary)("WAL mode: the db.ts pragma sequence applies on a file db", () => {
    withBridgeEnv(() => {
      const dbPath = tmpDbPath("wal")
      const client = realClient(dbPath)
      // The exact db.ts Client() sequence (contract item 1).
      client.run("PRAGMA journal_mode = WAL")
      client.run("PRAGMA synchronous = NORMAL")
      client.run("PRAGMA busy_timeout = 5000")
      client.run("PRAGMA cache_size = -16000")
      client.run("PRAGMA foreign_keys = ON")
      client.run(`PRAGMA journal_size_limit = ${64 * 1024 * 1024}`)
      client.run("PRAGMA wal_checkpoint(PASSIVE)")

      expect(client.pragma("journal_mode", { simple: true })).toBe("wal")
      expect(client.pragma("synchronous", { simple: true })).toBe(1) // NORMAL
      expect(client.pragma("busy_timeout", { simple: true })).toBe(5000)
      expect(client.pragma("cache_size", { simple: true })).toBe(-16000)
      expect(client.pragma("foreign_keys", { simple: true })).toBe(1)
      expect(client.pragma("journal_size_limit", { simple: true })).toBe(64 * 1024 * 1024)
      // Non-simple read returns the row object (sqlite-adapter pragma shape).
      expect(client.pragma("journal_mode")).toEqual({ journal_mode: "wal" })
      // The 5-minute checkpoint timer drives this exact statement (contract item 10).
      expect(() => client.run("PRAGMA wal_checkpoint(PASSIVE)")).not.toThrow()
      client.close()
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
    })
  })

  test.skipIf(!hasBinary)("pragma write/read split: write returns undefined, {simple:true} projects", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      expect(client.pragma("busy_timeout = 4321")).toBeUndefined()
      expect(client.pragma("busy_timeout", { simple: true })).toBe(4321)
      // PRAGMA busy_timeout's result column is spelled "timeout" in SQLite.
      expect(client.pragma("busy_timeout")).toEqual({ timeout: 4321 })
      expect(Number(client.pragma("page_size", { simple: true }))).toBeGreaterThan(0)
      client.close()
    })
  })

  test.skipIf(!hasBinary)("positional ? and named @x/$x/:x parameters", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (id INTEGER, name TEXT)")
      client.prepare("INSERT INTO t VALUES (?, ?)").run(1, "positional")
      client.prepare("INSERT INTO t VALUES (@id, :name)").run({ id: 2, name: "named" })
      client.prepare("INSERT INTO t VALUES ($id, $name)").run({ id: 3, name: "dollar" })
      expect(client.prepare("SELECT name FROM t WHERE id = ?").get(2)).toEqual({ name: "named" })
      expect(client.prepare("SELECT name FROM t WHERE id = @id").all({ id: 3 })).toEqual([{ name: "dollar" }])
      expect(client.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 3 })
      // Positional count mismatch throws (bun parity).
      expect(() => client.prepare("SELECT * FROM t WHERE id = ?").all(1, 2)).toThrow()
      client.close()
    })
  })

  test.skipIf(!hasBinary)("value mapping: null/integer/bigint/real/text/blob match bun defaults", () => {
    withBridgeEnv(() => {
      const dbPath = tmpDbPath("types")
      const client = realClient(dbPath)
      client.exec("CREATE TABLE v (n, i, big, r, t, b)")
      const blob = new Uint8Array([0, 1, 254, 255, 7])
      const big = 9007199254740993n // 2^53+1 — above Number.MAX_SAFE_INTEGER
      client.prepare("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?)").run(null, 42, big, 3.25, "漢字🚀", blob)
      const viaBridge = client.prepare("SELECT n, i, big, r, t, b FROM v").get()!
      expect(viaBridge.n).toBeNull()
      expect(viaBridge.i).toBe(42)
      expect(typeof viaBridge.i).toBe("number")
      // bun's NON-STRICT default reads every INTEGER through double (lossy
      // above 2^53) — the bridge reproduces that exactly, so both arms below
      // must agree; the strict-mode BigInt read is deliberately not mimicked.
      expect(viaBridge.big).toBe(Number(big))
      expect(typeof viaBridge.big).toBe("number")
      expect(viaBridge.r).toBe(3.25)
      expect(viaBridge.t).toBe("漢字🚀")
      expect(viaBridge.b).toBeInstanceOf(Uint8Array)
      expect(Array.from(viaBridge.b as Uint8Array)).toEqual([0, 1, 254, 255, 7])

      // Same db through bun:sqlite — default-behavior parity on the same rows.
      client.close()
      const bun = new Database(dbPath, { readonly: true })
      const viaBun = bun.prepare("SELECT n, i, big, r, t, b FROM v").get() as Record<string, unknown>
      expect(viaBridge).toEqual(viaBun)
      expect(typeof viaBun.big).toBe(typeof viaBridge.big)
      bun.close()
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
    })
  })

  test.skipIf(!hasBinary)("transactions: three behaviors, nesting JOINs the outer unit, rollback parity", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (a INTEGER)")

      // Three behavior modes (drizzle calls [behavior](); direct call = deferred).
      client.transaction(() => {
        client.prepare("INSERT INTO t VALUES (1)").run()
      })()
      client.transaction(() => {
        client.prepare("INSERT INTO t VALUES (2)").run()
      }).deferred()
      client.transaction(() => {
        client.prepare("INSERT INTO t VALUES (3)").run()
      }).immediate()
      client.transaction(() => {
        client.prepare("INSERT INTO t VALUES (4)").run()
      }).exclusive()
      expect(client.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 4 })
      expect(client.inTransaction).toBe(false)

      // Nested transaction JOINs the outer unit — no savepoint, one commit.
      client.transaction(() => {
        client.prepare("INSERT INTO t VALUES (5)").run()
        client.transaction(() => {
          client.prepare("INSERT INTO t VALUES (6)").run()
          expect(client.inTransaction).toBe(true)
        }).immediate()
      }).deferred()
      expect(client.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 6 })

      // Inner failure rolls the WHOLE unit back (bun:sqlite / adapter parity).
      expect(() =>
        client.transaction(() => {
          client.prepare("INSERT INTO t VALUES (7)").run()
          client.transaction(() => {
            client.prepare("INSERT INTO t VALUES (8)").run()
            throw new Error("inner boom")
          }).deferred()
        }).deferred(),
      ).toThrow("inner boom")
      expect(client.inTransaction).toBe(false)
      expect(client.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 6 })

      // Outer failure after a successful inner also rolls everything back.
      expect(() =>
        client.transaction(() => {
          client.transaction(() => {
            client.prepare("INSERT INTO t VALUES (9)").run()
          }).deferred()
          throw new Error("outer boom")
        }).deferred(),
      ).toThrow("outer boom")
      expect(client.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 6 })

      // Return values flow through the wrapper (drizzle transaction result).
      const result = client.transaction(() => "tx-result").deferred()
      expect(result).toBe("tx-result")
      client.close()
    })
  })

  test.skipIf(!hasBinary)("close is idempotent and post-close calls fail", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      expect(client.open).toBe(true)
      client.close()
      client.close() // second close: no throw
      expect(client.open).toBe(false)
      expect(() => client.exec("SELECT 1")).toThrow()
    })
  })

  test.skipIf(!hasBinary)("large text and BLOB columns round-trip", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE big (t TEXT, b BLOB)")
      const bigText = "x漢🚀".repeat(300_000) // multi-MB multi-byte text
      const bigBlob = new Uint8Array(2_000_000).map((_, i) => i % 256)
      client.prepare("INSERT INTO big VALUES (?, ?)").run(bigText, bigBlob)
      // SQLite length(TEXT) counts CHARACTERS, not UTF-16 units — compare
      // byte lengths via CAST instead, plus the exact string round-trip.
      const row = client.prepare("SELECT length(CAST(t AS BLOB)) AS tb, length(b) AS bl, t, b FROM big").get()!
      expect(row.tb).toBe(new TextEncoder().encode(bigText).length)
      expect(row.bl).toBe(bigBlob.length)
      expect(row.t).toBe(bigText)
      expect((row.b as Uint8Array).length).toBe(bigBlob.length)
      expect((row.b as Uint8Array)[1_999_999]).toBe(bigBlob[1_999_999]!)
      client.close()
    })
  })

  test.skipIf(!hasBinary)("multi-statement exec runs migration-shaped SQL", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      // The applyMigrations shape: one exec over a multi-statement batch.
      client.exec(`
        CREATE TABLE a (x INTEGER);
        CREATE TABLE b (y INTEGER);
        INSERT INTO a VALUES (1);
        INSERT INTO b SELECT x FROM a;
      `)
      expect(client.prepare("SELECT y FROM b").all()).toEqual([{ y: 1 }])
      client.close()
    })
  })

  test.skipIf(!hasBinary)("prepare cache: repeated SQL through one connection stays correct", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
      const ins = client.prepare("INSERT INTO t (v) VALUES (?)")
      for (let i = 0; i < 300; i++) ins.run(`v${i}`)
      // Churn beyond the LRU 256 limit with distinct SQL texts, then reuse
      // an early shape — evicted entries re-prepare transparently.
      for (let i = 0; i < 300; i++) expect(client.prepare(`SELECT ${i} + 1 AS n`).get()).toEqual({ n: i + 1 })
      expect(client.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 300 })
      expect(client.prepare("SELECT v FROM t WHERE id = ?").get(300)).toEqual({ v: "v299" })
      client.close()
    })
  })
})

// ---------------------------------------------------------------------------
describe("sqlite bridge packed read (real binary)", () => {
  test.skipIf(!hasBinary)("handshake: binary advertises packed-read without an ABI bump", () => {
    withBridgeEnv(() => {
      const mod = getBridgeModule()
      expect(mod).not.toBeNull()
      const info = mod!.sqliteBridgeContractInfo()
      expect(info.abiVersion).toBe(SQLITE_BRIDGE_ABI_VERSION)
      expect(info.capabilities).toContain("packed-read")
      // Optional exports present — the TS probe is export presence.
      expect(typeof mod!.sqliteBridgeAllPacked).toBe("function")
      expect(typeof mod!.sqliteBridgeValuesPacked).toBe("function")
    })
  })

  test.skipIf(!hasBinary)("packed value mapping equals the object path cell for cell", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE v (n, i, big, r, t, b)")
      const blob = new Uint8Array([0, 1, 254, 255, 7])
      const big = 9007199254740993n // 2^53+1 — lossy double on BOTH arms
      client.prepare("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?)").run(null, 42, big, 3.25, "漢字🚀", blob)
      const sql = "SELECT n, i, big, r, t, b FROM v"

      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", "0")
      const objectAll = client.prepare(sql).all()
      const objectValues = client.prepare(sql).values()
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      const packedAll = client.prepare(sql).all()
      const packedValues = client.prepare(sql).values()

      expect(packedAll).toEqual(objectAll)
      expect(packedValues).toEqual(objectValues)
      // The bun non-strict lossy double survives the packed wire (2^53+1).
      expect(typeof packedAll[0]!.big).toBe("number")
      expect(packedAll[0]!.big).toBe(Number(big))
      expect(packedAll[0]!.b).toBeInstanceOf(Uint8Array)
      expect(Array.from(packedAll[0]!.b as Uint8Array)).toEqual([0, 1, 254, 255, 7])
      expect(packedAll[0]!.t).toBe("漢字🚀")
      client.close()
    })
  })

  test.skipIf(!hasBinary)("packed routing is real: object exports untouched while packed is on, get() stays object", () => {
    withBridgeEnv(() => {
      const mod = getBridgeModule()!
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (a INTEGER)")
      client.prepare("INSERT INTO t VALUES (1)").run()
      const realAll = mod.sqliteBridgeAll
      const realValues = mod.sqliteBridgeValues
      mod.sqliteBridgeAll = () => {
        throw new Error("object all() used while packed expected")
      }
      mod.sqliteBridgeValues = () => {
        throw new Error("object values() used while packed expected")
      }
      try {
        expect(client.prepare("SELECT a FROM t").all()).toEqual([{ a: 1 }])
        expect(client.prepare("SELECT a FROM t").values()).toEqual([[1]])
        // get() deliberately keeps the object path (single row — the packed
        // header fixed cost would never amortize).
        expect(client.prepare("SELECT a FROM t").get()).toEqual({ a: 1 })
      } finally {
        mod.sqliteBridgeAll = realAll
        mod.sqliteBridgeValues = realValues
      }
      // PACKED=0 routes back through the object exports.
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", "0")
      try {
        expect(client.prepare("SELECT a FROM t").all()).toEqual([{ a: 1 }])
        expect(client.prepare("SELECT a FROM t").values()).toEqual([[1]])
      } finally {
        setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
        client.close()
      }
    })
  })

  test.skipIf(!hasBinary)("packed TEXT lossy decode is byte-identical to the object path for invalid UTF-8", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (b BLOB)")
      // Invalid sequences: lone 0xFF, lone continuation 0x80, truncated
      // E4 BD, F4 with out-of-range continuation 0x90 then lone 0x80.
      const raw = new Uint8Array([0x61, 0xff, 0x80, 0xe4, 0xbd, 0x61, 0xf4, 0x90, 0x80, 0x7a])
      client.prepare("INSERT INTO t VALUES (?)").run(raw)
      const sql = "SELECT CAST(b AS TEXT) AS s FROM t"
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", "0")
      const viaObject = client.prepare(sql).all()[0]!.s as string
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      const viaPacked = client.prepare(sql).all()[0]!.s as string
      // The whole point of the raw-bytes arena: the TS TextDecoder lossy
      // decode equals the Rust from_utf8_lossy object path byte for byte.
      expect(viaPacked).toBe(viaObject)
      // And both implement the WHATWG/Unicode maximal-subpart rule: six
      // U+FFFD replacements for this exact byte sequence.
      expect(viaPacked).toBe(new TextDecoder().decode(raw))
      expect(Array.from(viaPacked).filter((ch) => ch === "\uFFFD").length).toBe(6)
      client.close()
    })
  })

  test.skipIf(!hasBinary)("large text and BLOB round-trip through the packed wire", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE big (t TEXT, b BLOB)")
      const bigText = "x漢🚀".repeat(300_000) // multi-MB multi-byte
      const bigBlob = new Uint8Array(2_000_000).map((_, i) => i % 256)
      client.prepare("INSERT INTO big VALUES (?, ?)").run(bigText, bigBlob)
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      const row = client.prepare("SELECT t, b FROM big").all()[0]!
      expect(row.t).toBe(bigText)
      expect(row.b).toEqual(bigBlob)
      const positional = client.prepare("SELECT t, b FROM big").values()[0]!
      expect(positional[0]).toBe(bigText)
      expect(positional[1]).toEqual(bigBlob)
      // Object arm agrees on the same payload.
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", "0")
      expect(client.prepare("SELECT t, b FROM big").all()).toEqual([{ t: bigText, b: bigBlob }])
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      client.close()
    })
  })

  test.skipIf(!hasBinary)("empty result sets and non-SELECT all() decode to []", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      client.exec("CREATE TABLE t (a INTEGER, b TEXT)")
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      expect(client.prepare("SELECT a, b FROM t").all()).toEqual([])
      expect(client.prepare("SELECT a, b FROM t").values()).toEqual([])
      // bun parity: a non-SELECT statement through all() yields [] (a
      // 0-column packed buffer — the decoder must not choke on it).
      expect(client.prepare("INSERT INTO t (a) VALUES (1)").all()).toEqual([])
      expect(client.prepare("SELECT a FROM t").values()).toEqual([[1]])
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", undefined)
      client.close()
    })
  })
})

// ---------------------------------------------------------------------------
// drizzle integration + effect deferral (client layer only)
// ---------------------------------------------------------------------------

describe("sqlite bridge under drizzle (real binary)", () => {
  test.skipIf(!hasBinary)("drizzle({ client: bridge }) runs the db.run/get/all + transaction surface", () => {
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      const db = drizzle({ client: client as unknown as Database })
      db.run(sql`CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)`)
      db.run(sql`INSERT INTO kv (k, v) VALUES (${"x"}, ${1})`)
      db.run(sql`INSERT INTO kv (k, v) VALUES (${"y"}, ${2})`)
      expect(db.get(sql`SELECT v FROM kv WHERE k = ${"y"}`) as { v: number } | undefined).toEqual({ v: 2 })
      expect(db.all(sql`SELECT k FROM kv ORDER BY k`)).toEqual([{ k: "x" }, { k: "y" }])

      db.transaction((tx) => {
        tx.run(sql`INSERT INTO kv (k, v) VALUES (${"z"}, ${3})`)
        expect(tx.all(sql`SELECT k FROM kv ORDER BY k`)).toEqual([{ k: "x" }, { k: "y" }, { k: "z" }])
      })
      // Rolled-back transaction leaves no rows behind.
      try {
        db.transaction((tx) => {
          tx.run(sql`INSERT INTO kv (k, v) VALUES (${"rolled"}, ${9})`)
          throw new Error("rollback")
        })
      } catch {}
      expect(db.all(sql`SELECT k FROM kv ORDER BY k`)).toEqual([{ k: "x" }, { k: "y" }, { k: "z" }])
      db.$client.close()
    })
  })

  test.skipIf(!hasBinary)("init() routes through the bridge when CHIMERA_SQLITE_BRIDGE=1", () => {
    withBridgeEnv(() => {
      const dbPath = tmpDbPath("init")
      const db = init(dbPath)
      db.run(sql`CREATE TABLE probe (x INTEGER)`)
      db.run(sql`INSERT INTO probe VALUES (${1})`)
      expect(db.get(sql`SELECT x FROM probe`) as { x: number } | undefined).toEqual({ x: 1 })
      db.$client.close()
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
    })
  })

  test.skipIf(!hasBinary)("kill switch three arms: bun / bridge-object / bridge-packed produce identical drizzle results", () => {
    const scenario = (arm: "bun" | "object" | "packed") => {
      setEnv("CHIMERA_SQLITE_BRIDGE", arm === "bun" ? "0" : "1")
      // object arm: PACKED=0 pins the legacy wire shape; packed arm leaves
      // the switch unset — default ON whenever the binary carries the
      // optional packed exports.
      setEnv("CHIMERA_SQLITE_BRIDGE_PACKED", arm === "object" ? "0" : undefined)
      resetBridgeForTests()
      try {
        const dbPath = tmpDbPath(`arm-${arm}`)
        const db = init(dbPath)
        db.run(sql`PRAGMA journal_mode = WAL`)
        db.run(sql`CREATE TABLE m (id INTEGER PRIMARY KEY, ts INTEGER, name TEXT)`)
        db.run(sql`INSERT INTO m (ts, name) VALUES (${1700000000123}, ${"row"})`)
        db.transaction((tx) => {
          tx.run(sql`INSERT INTO m (ts, name) VALUES (${1700000000456}, ${"tx-row"})`)
        })
        // db.all(sql``) drives Statement.all (the packed-all shape); db.values
        // drives Statement.values (the packed-values shape drizzle's
        // field-mapped ORM reads use under the hood).
        const rows = db.all(sql`SELECT id, ts, name FROM m ORDER BY id`)
        const positional = db.values(sql`SELECT id, ts, name FROM m ORDER BY id`)
        const mode = db.get(sql`PRAGMA journal_mode`)
        db.$client.close()
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
        return { rows, positional, mode }
      } finally {
        delete process.env.CHIMERA_SQLITE_BRIDGE
        delete process.env.CHIMERA_SQLITE_BRIDGE_PACKED
        resetBridgeForTests()
      }
    }
    const off = scenario("bun")
    const object = scenario("object")
    const packed = scenario("packed")
    expect(object).toEqual(off)
    expect(packed).toEqual(off)
    expect(packed.rows).toEqual([
      { id: 1, ts: 1700000000123, name: "row" },
      { id: 2, ts: 1700000000456, name: "tx-row" },
    ])
    expect(packed.positional).toEqual([
      [1, 1700000000123, "row"],
      [2, 1700000000456, "tx-row"],
    ])
    expect(packed.mode).toEqual({ journal_mode: "wal" })
    // timestamp columns: integer round-trips as a plain Number on all arms
    // (drizzle timestamp_ms depends on it).
    expect(typeof (packed.rows as { ts: unknown }[])[0]!.ts).toBe("number")
    if (hasBinary) {
      // The armed arms really did cross the bridge (not a silent fallback).
      setEnv("CHIMERA_SQLITE_BRIDGE", "1")
      resetBridgeForTests()
      try {
        expect(sqliteBridgeEnabled()).toBe(true)
        expect(typeof getBridgeModule()!.sqliteBridgeAllPacked).toBe("function")
      } finally {
        delete process.env.CHIMERA_SQLITE_BRIDGE
        resetBridgeForTests()
      }
    }
  })

  test.skipIf(!hasBinary)("effect deferral semantics stay at the db.ts layer (client sees raw statements only)", () => {
    // Database.effect() defers callbacks until after the transaction commits
    // (db.ts) — that machinery lives ABOVE the client and never routes
    // through the bridge. Assert the client-level invariant the deferral
    // relies on: statements executed inside the transaction callback are
    // visible to reads in the same transaction, and become durable exactly
    // at commit, when the deferred effects run.
    withBridgeEnv(() => {
      const client = realClient(":memory:")
      const db = drizzle({ client: client as unknown as Database })
      db.run(sql`CREATE TABLE e (x INTEGER)`)
      const deferred: (() => void)[] = []
      db.transaction((tx) => {
        tx.run(sql`INSERT INTO e VALUES (${1})`)
        // Effect-style deferred work observes in-tx state on the same connection.
        expect(tx.all(sql`SELECT x FROM e`)).toEqual([{ x: 1 }])
        deferred.push(() => {
          // Runs after commit — outside the tx, the row is now durable.
          expect(db.all(sql`SELECT x FROM e`)).toEqual([{ x: 1 }])
        })
      })
      expect(deferred.length).toBe(1)
      for (const effect of deferred) effect()
      db.$client.close()
    })
  })
})
