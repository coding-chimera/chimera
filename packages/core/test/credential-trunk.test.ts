import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Credential trunk over an isolated per-run db file (temp dir + dedicated
// chimera-v2 test filename; never the production fork chimera.db). Database.node
// is replaced so the default Global.Path.data location is never touched.
const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())
const file = path.join(tmp.path, "chimera-v2-trunk-credential.db")
const dbLayer = Database.layerFromPath(file)
const it = testEffect(Layer.merge(dbLayer, LayerNode.compile(Credential.node, [[Database.node, dbLayer]])))

describe("Credential trunk", () => {
  it.effect("applies the credential migration to the isolated chimera-v2 db", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const journaled = yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)
      expect(journaled.map((row) => row.id)).toContain("20260611035744_credential")
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'`,
      )
      expect(tables.map((row) => row.name)).toEqual(["credential"])
      expect(file.startsWith(tmp.path)).toBe(true)
    }),
  )

  it.effect("roundtrips credential create, list, update, replace, and remove", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("acme")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      expect(yield* credentials.get(created.id)).toEqual(created)
      expect(yield* credentials.all()).toEqual([created])

      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
})
