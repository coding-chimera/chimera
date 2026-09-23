export * as PluginHostSeam from "./host-seam"

// (L5.4b) Minimal-seam shim of upstream core's plugin/host.ts — NOT a byte vendor.
// Upstream PluginHost.make requires the AgentV2/AISDK/CommandV2/Reference/SkillV2/
// PluginV2 v2 service tree, which this fork has not vendored (see
// UPSTREAM_V2_MIGRATION_PLAN.md "L5 细分计划"; vendoring that tree is L6-scale).
// The vendored provider plugins (plugin/provider/*.ts) only consume the `catalog`
// and `integration` hooks, so this seam carries those two adapters copied from
// upstream host.ts, and stubs every other hook domain as a loud Effect.die:
// unsupported plugin usage fails fast instead of silently no-oping. When the full
// upstream plugin host tree is vendored, host.ts is a drop-in replacement and this
// file can be deleted.

import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { Effect, Schema } from "effect"
import { Catalog } from "../catalog"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import type { DeepMutable } from "../schema"

const mutable = <T>(value: T) => value as DeepMutable<T>

const unsupported = (domain: string) =>
  Effect.die(
    new Error(
      `PluginHostSeam: hook domain "${domain}" is not available in the L5.4b seam; vendor the upstream plugin host tree first`,
    ),
  )

export const make = Effect.fn("PluginHostSeam.make")(function* () {
  const catalog = yield* Catalog.Service
  const integration = yield* Integration.Service

  return {
    options: {},
    agent: {
      reload: () => unsupported("agent.reload"),
      transform: () => unsupported("agent.transform"),
    },
    aisdk: {
      sdk: () => unsupported("aisdk.sdk"),
      language: () => unsupported("aisdk.language"),
    },
    catalog: {
      reload: catalog.reload,
      transform: (callback) =>
        catalog.transform((draft) =>
          callback({
            provider: {
              list: () => mutable(draft.provider.list()),
              get: (id) => mutable(draft.provider.get(ProviderV2.ID.make(id))),
              update: (id, update) => draft.provider.update(ProviderV2.ID.make(id), update),
              remove: (id) => draft.provider.remove(ProviderV2.ID.make(id)),
            },
            model: {
              get: (providerID, modelID) =>
                mutable(draft.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))),
              update: (providerID, modelID, update) =>
                draft.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), update),
              remove: (providerID, modelID) =>
                draft.model.remove(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              default: {
                get: draft.model.default.get,
                set: (providerID, modelID) =>
                  draft.model.default.set(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              },
            },
          }),
        ),
    },
    command: {
      reload: () => unsupported("command.reload"),
      transform: () => unsupported("command.transform"),
    },
    integration: {
      reload: integration.reload,
      connection: {
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        resolve: (connection) =>
          integration.connection.resolve(
            connection.type === "credential" ? { ...connection, id: Credential.ID.make(connection.id) } : connection,
          ),
      },
      transform: (callback) =>
        integration.transform((draft) =>
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(Integration.ID.make(id))),
            update: (id, update) => draft.update(Integration.ID.make(id), update),
            remove: (id) => draft.remove(Integration.ID.make(id)),
            method: {
              list: (id) => mutable(draft.method.list(Integration.ID.make(id))),
              update: (input) => {
                if ("authorize" in input) {
                  const methodID = Integration.MethodID.make(input.method.id)
                  const refresh = input.refresh
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { ...input.method, id: methodID },
                    authorize: (inputs) =>
                      input.authorize(inputs).pipe(
                        Effect.map((authorization) => {
                          if (authorization.mode === "auto") {
                            return {
                              ...authorization,
                              callback: authorization.callback.pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(credential.methodID),
                                  }),
                                ),
                              ),
                            }
                          }
                          return {
                            ...authorization,
                            callback: (code: string) =>
                              authorization.callback(code).pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(credential.methodID),
                                  }),
                                ),
                              ),
                          }
                        }),
                      ),
                    ...(refresh
                      ? {
                          refresh: (value: Credential.OAuth) =>
                            refresh(value).pipe(
                              Effect.map((next) =>
                                Credential.OAuth.make({
                                  ...next,
                                  methodID: Integration.MethodID.make(next.methodID),
                                }),
                              ),
                            ),
                        }
                      : {}),
                    ...(input.label ? { label: input.label } : {}),
                  })
                  return
                }
                if (input.method.type === "env") {
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { type: "env", names: input.method.names },
                  })
                  return
                }
                draft.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: { type: "key", label: input.method.label },
                })
              },
              remove: (id, method) =>
                draft.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
            },
          }),
        ),
    },
    plugin: {
      add: () => unsupported("plugin.add"),
      remove: () => unsupported("plugin.remove"),
    },
    reference: {
      reload: () => unsupported("reference.reload"),
      transform: () => unsupported("reference.transform"),
    },
    skill: {
      reload: () => unsupported("skill.reload"),
      transform: () => unsupported("skill.transform"),
    },
  } satisfies PluginContext
})
