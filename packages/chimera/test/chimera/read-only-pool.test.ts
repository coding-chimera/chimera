/**
 * Read-only graph connection pool (tarn.js/sqlx-shaped, src/chimera/read-only-pool.ts).
 *
 * Unit tests drive the pool directly against a real initialized graph root
 * (so checkout validation's `getDatabasePath` existence check passes) with
 * fake ProjectGraphState objects that count opens and closes. The integration
 * test drives a real CodeGraph connection through Chimera.withProjectGraph's
 * readOnly path and asserts lease registration, warm reuse, and
 * failure-destroy.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Chimera } from "@/chimera/provenance"
import type { ProjectGraphState } from "@/chimera/provenance"
import { ReadOnlyPool } from "@/chimera/read-only-pool"
import { CodeGraph, getDatabasePath } from "@/graph"
import { testEffect } from "../lib/effect"
import { TestInstance, tmpdir } from "../fixture/fixture"

const ENV_KEYS = [
  "CHIMERA_GRAPH_RO_POOL_MAX",
  "CHIMERA_GRAPH_RO_ACQUIRE_TIMEOUT_MS",
  "CHIMERA_GRAPH_RO_MAX_LIFETIME_MS",
  "CHIMERA_GRAPH_RO_IDLE_TTL_MS",
] as const

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void>) {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function fakeState(root: string, closed: string[], counter: { opens: number }): ProjectGraphState {
  counter.opens += 1
  let closedFlag = false
  return {
    graph: {
      close: async () => {
        closedFlag = true
        closed.push(root)
      },
      isClosed: () => closedFlag,
      shrink: () => {},
    } as unknown as ProjectGraphState["graph"],
    projectRoot: root,
    artifact: "",
    storePath: "",
  }
}

function fakeOpen(root: string, closed: string[], counter: { opens: number }) {
  return () => Promise.resolve(fakeState(root, closed, counter))
}

async function initializedRoot(base: string, name: string) {
  const root = path.join(base, name)
  await fs.mkdir(root, { recursive: true })
  const setup = await CodeGraph.init(root, { index: false })
  await setup.close()
  return root
}

afterEach(() => {
  ReadOnlyPool.resetReadOnlyPoolForTest()
})

describe("read-only pool checkout and reuse", () => {
  test("reuses the warm entry across acquire/release without opening a new connection", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "reuse")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({}, async () => {
      const first = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      first.release(true)
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(1)
      expect(ReadOnlyPool.readOnlyPoolStats(root).inUse).toBe(0)

      const second = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      expect(second.state).toBe(first.state)
      expect(counter.opens).toBe(1)
      expect(ReadOnlyPool.readOnlyPoolStats(root).inUse).toBe(1)
      second.release(true)
      expect(closed).toEqual([])
    })
  })

  test("release(false) destroys the entry; the next acquire opens a fresh one", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "destroy")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({}, async () => {
      const first = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      first.release(false)
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(0)
      expect(closed).toEqual([root])

      const second = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      expect(second.state).not.toBe(first.state)
      expect(counter.opens).toBe(2)
      second.release(true)
    })
  })

  test("checkout validation destroys an entry whose connection was closed underneath", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "closed-state")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({}, async () => {
      const first = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      first.release(true)
      // Something outside the pool closed the connection.
      await first.state.graph.close()

      const second = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      expect(second.state).not.toBe(first.state)
      expect(counter.opens).toBe(2)
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(1)
      second.release(true)
    })
  })

  test("checkout validation destroys an entry whose database file disappeared", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "db-gone")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({}, async () => {
      const first = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      first.release(true)
      await fs.rm(getDatabasePath(root))

      const second = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      expect(second.state).not.toBe(first.state)
      expect(counter.opens).toBe(2)
      expect(closed).toContain(root)
      second.release(true)
    })
  })
})

describe("read-only pool sweep (idle TTL + maxLifetime)", () => {
  test("idle TTL: the reap closes idle entries past the TTL and spares fresh ones", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "idle-ttl")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({ CHIMERA_GRAPH_RO_IDLE_TTL_MS: "1000", CHIMERA_GRAPH_RO_MAX_LIFETIME_MS: "0" }, async () => {
      const lease = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      lease.release(true)
      const now = Date.now()
      expect(ReadOnlyPool.ageReadOnlyPoolEntryForTest(root, now, now - 5_000)).toBe(true)

      expect(ReadOnlyPool.reapReadOnlyPool(Date.now())).toBe(1)
      expect(closed).toEqual([root])
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(0)

      const fresh = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      fresh.release(true)
      expect(ReadOnlyPool.reapReadOnlyPool(Date.now())).toBe(0)
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(1)
    })
  })

  test("maxLifetime: the reap retires idle entries past their lifetime; 0 disables", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "lifetime")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({ CHIMERA_GRAPH_RO_IDLE_TTL_MS: "0", CHIMERA_GRAPH_RO_MAX_LIFETIME_MS: "1000" }, async () => {
      const lease = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      lease.release(true)
      const now = Date.now()
      expect(ReadOnlyPool.ageReadOnlyPoolEntryForTest(root, now - 5_000, now)).toBe(true)

      expect(ReadOnlyPool.reapReadOnlyPool(Date.now())).toBe(1)
      expect(closed).toEqual([root])
    })
    await withEnv({ CHIMERA_GRAPH_RO_IDLE_TTL_MS: "0", CHIMERA_GRAPH_RO_MAX_LIFETIME_MS: "0" }, async () => {
      const lease = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      lease.release(true)
      const now = Date.now()
      expect(ReadOnlyPool.ageReadOnlyPoolEntryForTest(root, now - 60 * 60 * 1000, now - 60 * 60 * 1000)).toBe(true)
      expect(ReadOnlyPool.reapReadOnlyPool(Date.now())).toBe(0)
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(1)
    })
  })

  test("checkout retires an entry past maxLifetime even when idle TTL is disabled", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "lifetime-checkout")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({ CHIMERA_GRAPH_RO_IDLE_TTL_MS: "0", CHIMERA_GRAPH_RO_MAX_LIFETIME_MS: "1000" }, async () => {
      const first = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      first.release(true)
      const now = Date.now()
      expect(ReadOnlyPool.ageReadOnlyPoolEntryForTest(root, now - 5_000, now)).toBe(true)

      const second = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      expect(second.state).not.toBe(first.state)
      expect(counter.opens).toBe(2)
      expect(closed).toEqual([root])
      second.release(true)
    })
  })
})

describe("read-only pool contention", () => {
  test("a contending acquire waits and reuses the same connection (no second open)", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "contend")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({}, async () => {
      const holder = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      const waiting = ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      let settled = false
      void waiting.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)

      holder.release(true)
      const served = await waiting
      expect(settled).toBe(true)
      expect(served.state).toBe(holder.state)
      expect(counter.opens).toBe(1)
      served.release(true)
    })
  })

  test("acquire rejects after the timeout while the entry stays held", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "timeout")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({ CHIMERA_GRAPH_RO_ACQUIRE_TIMEOUT_MS: "50" }, async () => {
      const holder = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      const error = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter)).then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : String(error)).toContain("Timed out")
      expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(1)
      holder.release(true)
    })
  })

  test("waiters are served FIFO in arrival order", async () => {
    await using tmp = await tmpdir()
    const root = await initializedRoot(tmp.path, "fifo")
    const closed: string[] = []
    const counter = { opens: 0 }
    await withEnv({}, async () => {
      const holder = await ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter))
      const order: number[] = []
      const first = ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter)).then((lease) => {
        order.push(1)
        return lease
      })
      const second = ReadOnlyPool.acquire(root, fakeOpen(root, closed, counter)).then((lease) => {
        order.push(2)
        return lease
      })

      holder.release(true)
      const firstLease = await first
      expect(order).toEqual([1])
      firstLease.release(true)
      const secondLease = await second
      expect(order).toEqual([1, 2])
      expect(secondLease.state).toBe(holder.state)
      expect(counter.opens).toBe(1)
      secondLease.release(true)
    })
  })
})

const it = testEffect(Layer.empty)

describe("read-only pool integration (withProjectGraph)", () => {
  it.instance("pools the readOnly path: warm reuse, lease registration, failure destroys", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const root = test.directory
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sample.ts"), "export const pooledSample = 1\n"))
      const setup = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: false }))
      yield* Effect.promise(() => setup.close())

      try {
        const open = { readOnly: true, watch: false, sync: false } as const
        const first = yield* Chimera.withProjectGraph(open, (state) =>
          Effect.sync(() => {
            expect(Chimera.readOnlyLeaseForTest(state)).toBeDefined()
            return state.graph
          }),
        )
        // Released back to the pool, not closed: one warm idle entry.
        expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(1)
        expect(ReadOnlyPool.readOnlyPoolStats(root).inUse).toBe(0)

        const second = yield* Chimera.withProjectGraph(open, (state) => Effect.sync(() => state.graph))
        expect(second).toBe(first)

        // A failed use destroys the pooled entry instead of returning it.
        yield* Chimera.withProjectGraph(open, () => Effect.fail(new Error("boom"))).pipe(Effect.ignore)
        expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(0)

        const third = yield* Chimera.withProjectGraph(open, (state) => Effect.sync(() => state.graph))
        expect(third).not.toBe(first)
      } finally {
        ReadOnlyPool.resetReadOnlyPoolForTest()
        yield* Effect.promise(() => Chimera.closeGraphRootForTest(test.directory))
      }
    }),
  )
})
