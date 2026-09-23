// (L5.4b) Fork adaptation of upstream packages/server/src/handlers/credential.ts
// (connector auth dac0dd5309 lineage). Credentials are managed through the
// core Integration connection surface over the isolated chimera-v2.db
// credential runtime (L5.2).
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Integration } from "@opencode-ai/core/integration"
import { InstanceHttpApi } from "../../api"

export const credentialHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.credential", (handlers) =>
  Effect.gen(function* () {
    const service = yield* Integration.Service

    return handlers
      .handle(
        "update",
        Effect.fn(function* (ctx) {
          yield* service.connection.update(ctx.params.credentialID, { label: ctx.payload.label })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "remove",
        Effect.fn(function* (ctx) {
          yield* service.connection.remove(ctx.params.credentialID)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
