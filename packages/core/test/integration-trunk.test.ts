import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Scope } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Integration trunk over an isolated per-run db file (temp dir + dedicated
// chimera-v2 test filename; never the production fork chimera.db). The
// makeLocationNode graph is built through the fork's seam AppNodeBuilder
// without a locationServiceMap hook: no project/git closure is pulled in.
const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())
const file = path.join(tmp.path, "chimera-v2-trunk-integration.db")
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(file)],
  ]),
)

describe("Integration trunk", () => {
  it.effect("registers integration state through the editor and drops it on scope close", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const acme = Integration.ID.make("acme")

      yield* integrations
        .transform((editor) => editor.update(acme, (integration) => (integration.name = "Acme")))
        .pipe(Scope.provide(scope))
      expect(yield* integrations.get(acme)).toEqual(
        new Integration.Info({ id: acme, name: "Acme", methods: [], connections: [] }),
      )
      expect(yield* integrations.list()).toEqual([
        new Integration.Info({ id: acme, name: "Acme", methods: [], connections: [] }),
      ])

      yield* Scope.close(scope, Exit.void)
      expect(yield* integrations.get(acme)).toBeUndefined()
    }),
  )

  it.effect("stores a key connection through the credential trunk", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const acme = Integration.ID.make("acme")

      yield* integrations
        .transform((editor) => {
          editor.update(acme, (integration) => (integration.name = "Acme"))
          editor.method.update({
            integrationID: acme,
            method: { type: "key", label: "API key" },
          })
        })
        .pipe(Scope.provide(scope))

      yield* integrations.connection.key({ integrationID: acme, key: "secret", label: "Work" })
      const active = yield* integrations.connection.active(acme)
      expect(active?.type).toBe("credential")
      if (active?.type !== "credential") return yield* Effect.die("expected credential connection")
      const resolved = yield* integrations.connection.resolve(active)
      expect(resolved).toEqual(Credential.Key.make({ type: "key", key: "secret" }))

      yield* Scope.close(scope, Exit.void)
    }),
  )
})
