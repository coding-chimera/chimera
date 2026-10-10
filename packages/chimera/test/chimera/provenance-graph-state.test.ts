/**
 * graphStates cache bound (R1 A4) + idle reclaim (B1).
 *
 * R1 A4 bounds the module-level graph-state cache with an LRU cap. B1 adds
 * below-cap idle reclaim: a long-lived `chimera web` server that keeps only a
 * few projects open used to hold one connection+watcher per root forever (the
 * cap is never crossed and WebUI presence keeps the owning instances alive, so
 * the instance disposer never fires). The idle sweep now closes any cached root
 * whose graph has been quiet for CHIMERA_GRAPH_STATE_IDLE_TTL_MS, and the
 * normal open path transparently reopens the connection on the next query.
 *
 * The unit tests use the inject/evict seams with fake states; the reopen test
 * drives a real CodeGraph connection through openProjectGraph.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Chimera } from "@/chimera/provenance"
import type { ProjectGraphState } from "@/chimera/provenance"
import { CodeGraph } from "@/graph"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

function fakeState(root: string, closed: string[]): ProjectGraphState {
  return {
    graph: { close: async () => void closed.push(root), shrink: () => {} } as unknown as ProjectGraphState["graph"],
    projectRoot: root,
    artifact: "",
    storePath: "",
  }
}

const savedSweep = process.env.CHIMERA_GRAPH_STATE_IDLE_SWEEP_MS
const savedTtl = process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS

function restoreEnv() {
  if (savedSweep === undefined) delete process.env.CHIMERA_GRAPH_STATE_IDLE_SWEEP_MS
  else process.env.CHIMERA_GRAPH_STATE_IDLE_SWEEP_MS = savedSweep
  if (savedTtl === undefined) delete process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS
  else process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS = savedTtl
}

async function cleanup(roots: string[]) {
  await Promise.all(roots.map((root) => Chimera.closeGraphRootForTest(root)))
}

describe("graphStates cache bound (R1 A4)", () => {
  test("over the cap the coldest idle roots are closed; the fresh root survives", async () => {
    const closed: string[] = []
    const now = Date.now()
    const roots: string[] = []
    // Disable below-cap idle reclaim so this test exercises only the cap ceiling.
    process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS = "0"
    try {
      for (let i = 0; i < 33; i++) {
        const root = `/fake/a4-root-${i}`
        roots.push(root)
        Chimera.injectGraphStateForTest(root, fakeState(root, closed), now - 31 * 60 * 1000 + i)
      }
      const fresh = "/fake/a4-fresh"
      roots.push(fresh)
      Chimera.injectGraphStateForTest(fresh, fakeState(fresh, closed), now)

      await Chimera.evictGraphStatesForTest()

      // 34 entries down to the 32 cap, coldest last-used first.
      expect(Chimera.graphStateCount()).toBeLessThanOrEqual(32)
      expect(closed).toContain("/fake/a4-root-0")
      expect(closed).toContain("/fake/a4-root-1")
      expect(closed).not.toContain(fresh)
    } finally {
      await cleanup(roots)
      restoreEnv()
    }
  })
})

describe("graphStates idle reclaim (B1)", () => {
  test("closes a root idle beyond the TTL below the cap, sparing the fresh one", async () => {
    const closed: string[] = []
    const now = Date.now()
    const roots = ["/fake/b1-idle", "/fake/b1-fresh"]
    process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS = "1000"
    try {
      Chimera.injectGraphStateForTest("/fake/b1-idle", fakeState("/fake/b1-idle", closed), now - 60_000)
      Chimera.injectGraphStateForTest("/fake/b1-fresh", fakeState("/fake/b1-fresh", closed), now)

      await Chimera.sweepIdleGraphStatesForTest()

      expect(closed).toContain("/fake/b1-idle")
      expect(closed).not.toContain("/fake/b1-fresh")
    } finally {
      await cleanup(roots)
      restoreEnv()
    }
  })

  test("the periodic sweep reclaims idle roots once armed", async () => {
    const closed: string[] = []
    const roots = ["/fake/b1-timer"]
    process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS = "1"
    process.env.CHIMERA_GRAPH_STATE_IDLE_SWEEP_MS = "10"
    try {
      Chimera.injectGraphStateForTest("/fake/b1-timer", fakeState("/fake/b1-timer", closed), Date.now() - 1000)
      Chimera.armGraphStateIdleSweepForTest()
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(closed).toContain("/fake/b1-timer")
    } finally {
      Chimera.disarmGraphStateIdleSweepForTest()
      await cleanup(roots)
      restoreEnv()
    }
  })
})

const it = testEffect(Layer.empty)

describe("graphStates idle reclaim + reopen (B1)", () => {
  it.instance("reclaims an idle writer root and transparently reopens it; an in-use root is spared", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sample.ts"), "export const trackedSample = 1\n"))
      const setup = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      setup.close()

      process.env.CHIMERA_GRAPH_STATE_IDLE_TTL_MS = "1"
      try {
        const first = yield* Chimera.openProjectGraph({ sync: false, watch: false })
        expect(yield* Effect.promise(async () => Chimera.graphStateForTest(test.directory))).toBeDefined()

        // Idle past the 1ms TTL, then sweep: the cached connection is closed.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 15)))
        yield* Effect.promise(() => Chimera.sweepIdleGraphStatesForTest())
        expect(yield* Effect.promise(async () => Chimera.graphStateForTest(test.directory))).toBeUndefined()

        // The next query transparently reopens a fresh connection for the same root.
        const second = yield* Chimera.openProjectGraph({ sync: false, watch: false })
        expect(second.projectRoot).toBe(first.projectRoot)
        expect(second.graph).not.toBe(first.graph)
        expect(yield* Effect.promise(async () => Chimera.graphStateForTest(test.directory))).toBeDefined()

        // A root held by an in-flight withProjectGraph is never evicted, even
        // when it is already idle by the TTL.
        yield* Chimera.withProjectGraph({ watch: false }, () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 15)))
            yield* Effect.promise(() => Chimera.sweepIdleGraphStatesForTest())
            expect(yield* Effect.promise(async () => Chimera.graphStateForTest(test.directory))).toBeDefined()
          }),
        )
      } finally {
        restoreEnv()
        yield* Effect.promise(() => Chimera.closeGraphRootForTest(test.directory))
      }
    }),
  )
})