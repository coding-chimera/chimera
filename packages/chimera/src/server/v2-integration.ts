// (L5.4b) Wiring seam between the fork server and the vendored upstream core
// integration/credential/catalog trunk (chimera-v2.db, decision L5.0②: the
// upstream TS migration lineage NEVER touches the production fork chimera.db).
//
// The trunk is compiled through the fork's AppNodeBuilder over the core layer
// nodes (Catalog -> Policy/Integration -> Credential/EventV2 -> Database) with
// two seam bindings:
// - Database.node is always replaced with an explicit layerFromPath so the
//   chimera-v2.db location resolves at layer-build time (default: the core
//   Global.Path.data location, matching Database.node's own default) and tests
//   can point it at an isolated temp file.
// - Location.node (L5.1 minimal shim) is bound to the server working directory
//   with the global project id: the fork has no v2 project/location tree, and
//   Policy/Catalog only need a bound Location.Service. Per-directory location
//   semantics arrive with the L6 v2 service surface.
//
// On top of the trunk, the vendored OpencodePlugin is booted through
// PluginHostSeam (provider state assembly hook, decision #7 branding
// untouched): it registers the opencode integration auth methods and maps
// console-provided providers/models into the catalog when a credential exists.
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { PluginHostSeam } from "@opencode-ai/core/plugin/host-seam"
import { OpencodePlugin } from "@opencode-ai/core/plugin/provider/opencode"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectID } from "@opencode-ai/schema/project-id"

const boot = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* PluginHostSeam.make()
    const events = yield* EventV2.Service
    const integration = yield* Integration.Service
    const http = yield* HttpClient.HttpClient
    yield* OpencodePlugin.effect(host).pipe(
      Effect.provideService(EventV2.Service, events),
      Effect.provideService(Integration.Service, integration),
      Effect.provideService(HttpClient.HttpClient, http),
    )
  }),
)

export function layer(dbPath?: string) {
  const directory = AbsolutePath.make(process.cwd())
  return boot.pipe(
    Layer.provideMerge(
      AppNodeBuilder.build(
        LayerNode.group([
          Catalog.node,
          Policy.node,
          Integration.node,
          Credential.node,
          EventV2.node,
          LayerNodePlatform.httpClient,
        ]),
        [
          [
            Database.node,
            // Default target: the isolated chimera-v2.db under the core Global
            // data dir (test preload redirects XDG_DATA_HOME into a per-process
            // tmp dir, so suites never touch a real home). Must never point at
            // the production fork chimera.db (decision L5.0②: separate
            // lineages, separate files).
            Database.layerFromPath(dbPath ?? path.join(Global.Path.data, "chimera-v2.db")),
          ],
          [
            Location.node,
            Layer.succeed(
              Location.Service,
              Location.Service.of({ directory, project: { id: ProjectID.global, directory } }),
            ),
          ],
        ],
      ),
    ),
  )
}

// Built lazily so Global.Path.data reflects env overrides applied after module
// import (test fixtures set XDG data dirs before the first request).
export const defaultLayer = Layer.suspend(() => layer())

export type Services =
  | Catalog.Service
  | Integration.Service
  | Credential.Service
  | EventV2.Service
  | Policy.Service

export * as V2Integration from "./v2-integration"
