/**
 * Stale-extraction-semantics rebuild on the Chimera RUNTIME writer-open face
 * (openProjectGraph / openGraphState / refreshProjectGraph) — the counterpart
 * of the MCP daemon catch-up pinned in test/graph/mcp-stale-rebuild.test.ts
 * (6d7dd50a5, upstream v1.6.1 #2034 port).
 *
 * Pins the contract points:
 *  - a stale stamp on a writer open triggers exactly one background
 *    `indexAll()` and re-stamps the database, so the next writer open is a
 *    no-op (one-shot; never loops);
 *  - a READ-ONLY open never triggers the rebuild and never touches the stamp
 *    (the read side stays report-only);
 *  - a failed rebuild keeps serving the stale content, is throttled against
 *    per-refresh relaunch, and retries on a later writer refresh;
 *  - a current stamp does zero rebuild work.
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Chimera } from "../../src/chimera/provenance"
import { CodeGraph } from "../../src/graph"
import { getDatabasePath } from "../../src/graph/db"
import { createDatabase } from "../../src/graph/db/sqlite-adapter"
import { EXTRACTION_SEMANTICS_METADATA_KEY, EXTRACTION_SEMANTICS_VERSION } from "../../src/graph/db/extraction-version"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(Layer.empty)

function stampVersion(dir: string): number | null {
  const raw = createDatabase(getDatabasePath(dir))
  try {
    const row = raw.db
      .prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(EXTRACTION_SEMANTICS_METADATA_KEY) as { value: string } | undefined
    if (!row) return null
    return (JSON.parse(row.value) as { version?: number }).version ?? null
  } finally {
    raw.db.close()
  }
}

function writeStamp(dir: string, version: number): void {
  const raw = createDatabase(getDatabasePath(dir))
  try {
    raw.db
      .prepare(
        "INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(EXTRACTION_SEMANTICS_METADATA_KEY, JSON.stringify({ version, codegraphVersion: "stale-rebuild-runtime-test" }), Date.now())
  } finally {
    raw.db.close()
  }
}

const originalIndexAll = CodeGraph.prototype.indexAll

function patchIndexAll(options: { failNext?: boolean } = {}) {
  let count = 0
  let failNext = options.failNext ?? false
  CodeGraph.prototype.indexAll = async function (this: CodeGraph, ...args: Parameters<typeof originalIndexAll>) {
    count++
    if (failNext) {
      failNext = false
      throw new Error("simulated rebuild failure")
    }
    return originalIndexAll.apply(this, args)
  }
  return {
    count: () => count,
    restore: () => {
      CodeGraph.prototype.indexAll = originalIndexAll
    },
  }
}

/** Await the state's last background rebuild attempt (settles, never rejects). */
async function rebuildSettled(root: string) {
  const state = await Chimera.graphStateForTest(root)
  await state?.staleRebuildPromise
}

async function settleWindow() {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

describe("chimera.provenance stale-extraction rebuild on runtime writer open", () => {
  it.instance("rebuilds a stale-stamped index once and re-stamps it; the next writer open is a no-op", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sample.ts"), "export const trackedSample = 1\n"))
      const setup = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      setup.close()
      writeStamp(test.directory, EXTRACTION_SEMANTICS_VERSION - 1)

      const calls = patchIndexAll()
      try {
        yield* Chimera.openProjectGraph({ sync: true, watch: false })
        yield* Effect.promise(() => rebuildSettled(test.directory))
        expect(calls.count()).toBe(1)
        expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION)

        // One-shot: the stamp now matches, so a second syncing writer open
        // does no rebuild work (cached state, quiet status check).
        yield* Chimera.openProjectGraph({ sync: true, watch: false })
        yield* Effect.promise(() => settleWindow())
        expect(calls.count()).toBe(1)
        expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION)
      } finally {
        calls.restore()
        yield* Effect.promise(() => Chimera.closeGraphRootForTest(test.directory))
      }
    }),
  )

  it.instance("a read-only open never triggers the rebuild and leaves the stale stamp untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sample.ts"), "export const trackedSample = 1\n"))
      const setup = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      setup.close()
      writeStamp(test.directory, EXTRACTION_SEMANTICS_VERSION - 1)

      const calls = patchIndexAll()
      try {
        yield* Chimera.withProjectGraph({ readOnly: true, watch: false }, () => Effect.void)
        // Give any erroneously-scheduled async rebuild a window to land.
        yield* Effect.promise(() => settleWindow())
        expect(calls.count()).toBe(0)
        expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION - 1)
        // Read-only opens are not cached as writer graph states at all.
        expect(yield* Effect.promise(async () => Chimera.graphStateForTest(test.directory))).toBeUndefined()
      } finally {
        calls.restore()
      }
    }),
  )

  it.instance("a failed rebuild keeps serving stale content, is throttled, and retries on a later writer refresh", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sample.ts"), "export const trackedSample = 1\n"))
      const setup = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      setup.close()
      writeStamp(test.directory, EXTRACTION_SEMANTICS_VERSION - 1)

      const calls = patchIndexAll({ failNext: true })
      try {
        // First attempt throws; the open still succeeds against stale content.
        yield* Chimera.openProjectGraph({ sync: true, watch: false })
        yield* Effect.promise(() => rebuildSettled(test.directory))
        expect(calls.count()).toBe(1)
        expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION - 1)

        // Within the retry throttle (STALE_REBUILD_RETRY_MS) a further writer
        // refresh must not relaunch the failing rebuild.
        yield* Chimera.openProjectGraph({ sync: true, watch: false })
        yield* Effect.promise(() => settleWindow())
        expect(calls.count()).toBe(1)

        // Once the throttle expires, the next writer refresh retries and the
        // successful indexAll re-stamps the database.
        yield* Effect.promise(async () => {
          const state = await Chimera.graphStateForTest(test.directory)
          state!.staleRebuildLastAttemptAt = Date.now() - 31_000
        })
        yield* Chimera.openProjectGraph({ sync: true, watch: false })
        yield* Effect.promise(() => rebuildSettled(test.directory))
        expect(calls.count()).toBe(2)
        expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION)
      } finally {
        calls.restore()
        yield* Effect.promise(() => Chimera.closeGraphRootForTest(test.directory))
      }
    }),
  )

  it.instance("does zero rebuild work when the stamp is current", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sample.ts"), "export const trackedSample = 1\n"))
      const setup = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      setup.close()
      expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION)

      const calls = patchIndexAll()
      try {
        yield* Chimera.openProjectGraph({ sync: true, watch: false })
        yield* Effect.promise(() => settleWindow())
        expect(calls.count()).toBe(0)
        expect(stampVersion(test.directory)).toBe(EXTRACTION_SEMANTICS_VERSION)
        const state = yield* Effect.promise(async () => Chimera.graphStateForTest(test.directory))
        expect(state?.staleRebuildInFlight).toBeUndefined()
        expect(state?.staleRebuildPromise).toBeUndefined()
      } finally {
        calls.restore()
        yield* Effect.promise(() => Chimera.closeGraphRootForTest(test.directory))
      }
    }),
  )
})
