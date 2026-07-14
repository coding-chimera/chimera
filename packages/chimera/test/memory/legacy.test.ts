import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { MemoryLegacy } from "@/memory/legacy"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const validNote = {
  id: "note_1",
  text: "Prefer focused tests.",
  scope: "project",
  source: {
    kind: "explicit-user-directive",
    sessionID: "session_1",
    messageID: "message_1",
  },
  time_created: 1_700_000_000_000,
} as const

describe("legacy memory notes", () => {
  it.effect("parses schemaVersion 1 and drops malformed notes", () =>
    Effect.sync(() => {
      expect(
        MemoryLegacy.parseLegacyNotes({
          schemaVersion: 1,
          notes: [validNote, { ...validNote, id: "" }, { ...validNote, scope: "other" }],
        }),
      ).toEqual({ schemaVersion: 1, notes: [validNote] })
      expect(MemoryLegacy.parseLegacyNotes({ schemaVersion: 2, notes: [validNote] })).toBeUndefined()
      expect(MemoryLegacy.decodeLegacyNotes("not json")).toBeUndefined()
    }),
  )

  it.effect("decodes legacy notes into import-only records", () =>
    Effect.sync(() => {
      expect(
        MemoryLegacy.decodeLegacyImport({
          schemaVersion: 1,
          notes: [validNote, { id: "bad" }],
        }),
      ).toEqual({
        schemaVersion: 1,
        notes: [
          {
            id: "note_1",
            text: "Prefer focused tests.",
            scope: "project",
            sourceKind: "explicit-user-directive",
            sourceSessionID: "session_1",
            sourceMessageID: "message_1",
            createdAt: 1_700_000_000_000,
          },
        ],
        skipped: 1,
      })
      expect(
        MemoryLegacy.decodeLegacyImport(JSON.stringify({ schemaVersion: 1, notes: [validNote, { id: "bad" }] }))?.skipped,
      ).toBe(1)
    }),
  )


  it.effect("exports a strict shared schema for API and SDK generation", () =>
    Effect.sync(() => {
      expect(MemoryLegacy.LegacyFile.zod.safeParse({ schemaVersion: 1, notes: [validNote] }).success).toBe(true)
      expect(MemoryLegacy.LegacyFile.zod.safeParse({ schemaVersion: 1, notes: [{ id: "bad" }] }).success).toBe(false)
    }),
  )

  it.instance("reads legacy JSON without modifying or deleting it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "notes.json")
      const source = `${JSON.stringify({ schemaVersion: 1, notes: [validNote] }, null, 2)}\n`
      yield* Effect.promise(() => Bun.write(filePath, source))

      const first = yield* Effect.promise(() => MemoryLegacy.readLegacyNotes(filePath))
      const second = yield* Effect.promise(() => MemoryLegacy.readLegacyNotes(filePath))
      expect(first).toEqual({ schemaVersion: 1, notes: [validNote] })
      expect(second).toEqual(first)
      expect(yield* Effect.promise(() => Bun.file(filePath).text())).toBe(source)
      expect(yield* Effect.promise(() => fs.stat(filePath).then(() => true))).toBe(true)
    }),
  )
})
