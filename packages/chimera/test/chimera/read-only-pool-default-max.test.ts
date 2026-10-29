import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { ProjectGraphState } from "@/chimera/provenance"
import { ReadOnlyPool } from "@/chimera/read-only-pool"
import { CodeGraph } from "@/graph"

function withEnv(value: string | undefined, run: () => Promise<void>) {
  const saved = process.env.CHIMERA_GRAPH_RO_POOL_MAX
  if (value === undefined) delete process.env.CHIMERA_GRAPH_RO_POOL_MAX
  else process.env.CHIMERA_GRAPH_RO_POOL_MAX = value
  return run().finally(() => {
    if (saved === undefined) delete process.env.CHIMERA_GRAPH_RO_POOL_MAX
    else process.env.CHIMERA_GRAPH_RO_POOL_MAX = saved
  })
}

function fakeOpen(root: string, counter: { opens: number }) {
  return () => {
    counter.opens += 1
    let closed = false
    const state = {
      graph: {
        close: async () => {
          closed = true
        },
        isClosed: () => closed,
        shrink: () => {},
      } as unknown as ProjectGraphState["graph"],
      projectRoot: root,
      artifact: "",
      storePath: "",
    }
    return Promise.resolve(state)
  }
}

async function initializedRoot(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `chimera-pool-${name}-`))
  const setup = await CodeGraph.init(root, { index: false })
  await setup.close()
  return root
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  ReadOnlyPool.resetReadOnlyPoolForTest()
})

describe("read-only pool default capacity", () => {
  test("four concurrent acquires each open a connection; the fifth queues", async () => {
    const root = await initializedRoot("default-max")
    const counter = { opens: 0 }
    try {
      await withEnv(undefined, async () => {
        const open = fakeOpen(root, counter)
        const leases = await Promise.all([0, 1, 2, 3].map(() => ReadOnlyPool.acquire(root, open)))
        expect(counter.opens).toBe(4)
        expect(ReadOnlyPool.readOnlyPoolStats(root).size).toBe(4)
        expect(ReadOnlyPool.readOnlyPoolStats(root).inUse).toBe(4)

        // The fifth acquire queues instead of opening a fifth connection.
        let settled = false
        const fifth = ReadOnlyPool.acquire(root, open).then((lease) => {
          settled = true
          return lease
        })
        await wait(20)
        expect(settled).toBe(false)
        expect(counter.opens).toBe(4)

        for (const lease of leases) lease.release(true)
        const fifthLease = await fifth
        expect(counter.opens).toBe(4)
        fifthLease.release(true)
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("CHIMERA_GRAPH_RO_POOL_MAX still overrides the default", async () => {
    const root = await initializedRoot("env-override")
    const counter = { opens: 0 }
    try {
      await withEnv("1", async () => {
        const open = fakeOpen(root, counter)
        const holder = await ReadOnlyPool.acquire(root, open)

        let settled = false
        const waiting = ReadOnlyPool.acquire(root, open).then((lease) => {
          settled = true
          return lease
        })
        await wait(20)
        expect(settled).toBe(false)
        expect(counter.opens).toBe(1)

        holder.release(true)
        const second = await waiting
        expect(second.state).toBe(holder.state)
        expect(counter.opens).toBe(1)
        second.release(true)
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})