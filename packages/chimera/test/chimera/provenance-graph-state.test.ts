/**
 * (R1 A4) graphStates cache bound: the module-level graph-state cache is
 * LRU-capped at 32 roots, and only roots idle beyond the 30-minute window are
 * eviction candidates. Uses the test seams to inject fake states instead of
 * opening real CodeGraph connections.
 *
 * Single test on purpose: the cache is module-global, so phases share state —
 * phase 2 asserts on the exact survivors including phase 1's entry.
 */
import { describe, expect, test } from "bun:test"
import { Chimera } from "@/chimera/provenance"
import type { ProjectGraphState } from "@/chimera/provenance"

function fakeState(root: string, closed: string[]): ProjectGraphState {
  return {
    graph: { close: async () => void closed.push(root) } as unknown as ProjectGraphState["graph"],
    projectRoot: root,
    artifact: "",
    storePath: "",
  }
}

describe("graphStates cache bound (R1 A4)", () => {
  test("idle roots survive under the cap; over the cap the coldest idle roots are closed", async () => {
    const closed: string[] = []
    const now = Date.now()

    // Phase 1: under the cap — nothing is evicted even when long idle.
    Chimera.injectGraphStateForTest("/fake/a4-quiet", fakeState("/fake/a4-quiet", closed), now - 60 * 60 * 1000)
    expect(await Chimera.evictGraphStatesForTest()).toBe(0)
    expect(closed).toEqual([])

    // Phase 2: push the cache over the 32-root cap: 1 (phase 1) + 33 idle + 1 fresh = 35.
    const idle = now - 31 * 60 * 1000
    for (let i = 0; i < 33; i++) {
      Chimera.injectGraphStateForTest(`/fake/a4-root-${i}`, fakeState(`/fake/a4-root-${i}`, closed), idle + i)
    }
    Chimera.injectGraphStateForTest("/fake/a4-fresh", fakeState("/fake/a4-fresh", closed), now)

    const evicted = await Chimera.evictGraphStatesForTest()

    // 35 entries down to the 32 cap, coldest last-used first:
    // a4-quiet (-60min), then a4-root-0 and a4-root-1 (-31min, insertion order).
    expect(evicted).toBe(3)
    expect(closed).toEqual(["/fake/a4-quiet", "/fake/a4-root-0", "/fake/a4-root-1"])
    expect(Chimera.graphStateCount()).toBeLessThanOrEqual(32)
    // The freshly used root is never a candidate regardless of cache pressure.
    expect(closed).not.toContain("/fake/a4-fresh")
  })
})
