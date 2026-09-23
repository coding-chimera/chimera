// (L5.4b) Fork adaptation of upstream packages/server/src/handlers/integration.ts
// (connector auth dac0dd5309 lineage). Deviations: no Location.response
// envelope (see groups/v2/integration.ts), and domain errors are translated to
// the fork's declared HttpApiError.BadRequest at the handler boundary per
// httpapi AGENTS.md, instead of the upstream protocol InvalidRequestError.
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { Integration } from "@opencode-ai/core/integration"
import { InstanceHttpApi } from "../../api"

const authorize = <A, E extends Integration.Error>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))

export const integrationHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.integration", (handlers) =>
  Effect.gen(function* () {
    const service = yield* Integration.Service

    return handlers
      .handle("list", () => service.list())
      .handle(
        "get",
        Effect.fn(function* (ctx) {
          return yield* service.get(ctx.params.integrationID)
        }),
      )
      .handle(
        "connectKey",
        Effect.fn(function* (ctx) {
          yield* authorize(
            service.connection.key({
              integrationID: ctx.params.integrationID,
              key: ctx.payload.key,
              label: ctx.payload.label,
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "connectOauth",
        Effect.fn(function* (ctx) {
          return yield* authorize(
            service.connection.oauth({
              integrationID: ctx.params.integrationID,
              methodID: ctx.payload.methodID,
              inputs: ctx.payload.inputs,
              label: ctx.payload.label,
            }),
          )
        }),
      )
      .handle(
        "attemptStatus",
        Effect.fn(function* (ctx) {
          return yield* service.attempt.status(ctx.params.attemptID)
        }),
      )
      .handle(
        "attemptComplete",
        Effect.fn(function* (ctx) {
          yield* authorize(
            service.attempt.complete({ attemptID: ctx.params.attemptID, code: ctx.payload.code }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "attemptCancel",
        Effect.fn(function* (ctx) {
          yield* service.attempt.cancel(ctx.params.attemptID)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
