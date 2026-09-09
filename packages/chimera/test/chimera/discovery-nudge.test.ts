import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as fs from "fs/promises"
import { DiscoveryNudge } from "../../src/chimera/discovery-nudge"
import { CodeGraph } from "../../src/graph"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
const it = testEffect(Layer.empty)

describe("chimera.discovery-nudge", () => {
  it.instance("hints exactly on the 4th text call and only once for an initialized project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "file.ts"), "export const value = 1\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const sessionID = SessionID.make("nudge-once")

      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBe(DiscoveryNudge.GRAPH_DISCOVERY_HINT)
      // Already hinted: no second emission even past the threshold.
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
    }),
  )

  it.instance("does not hint without a root directory to probe", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "file.ts"), "export const value = 1\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const sessionID = SessionID.make("nudge-no-root")

      expect(yield* DiscoveryNudge.noteTextTool(sessionID)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID)).toBeUndefined()
    }),
  )

  it.instance("never hints on an uninitialized project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = SessionID.make("nudge-uninitialized")

      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
    }),
  )

  it.instance("treats an invalid root probe as not initialized", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("nudge-bad-root")

      expect(yield* DiscoveryNudge.noteTextTool(sessionID, path.join("definitely", "missing"))).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, path.join("definitely", "missing"))).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, path.join("definitely", "missing"))).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, path.join("definitely", "missing"))).toBeUndefined()
    }),
  )

  it.instance("noteGraphQuery permanently suppresses the hint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "file.ts"), "export const value = 1\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const sessionID = SessionID.make("nudge-suppressed")

      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      yield* DiscoveryNudge.noteGraphQuery(sessionID)
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
    }),
  )

  it.instance("one graph query before the threshold also suppresses later hints", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "file.ts"), "export const value = 1\n"))
      const graph = yield* Effect.promise(() => CodeGraph.init(test.directory, { index: true }))
      graph.close()
      const sessionID = SessionID.make("nudge-suppressed-early")

      yield* DiscoveryNudge.noteGraphQuery(sessionID)
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
      expect(yield* DiscoveryNudge.noteTextTool(sessionID, test.directory)).toBeUndefined()
    }),
  )
})