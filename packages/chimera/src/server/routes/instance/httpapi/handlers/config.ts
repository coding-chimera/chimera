import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ConfigModelSelection } from "@/config/model-selection"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const modelSelectionGet = Effect.fn("ConfigHttpApi.modelSelectionGet")(function* () {
      return yield* Effect.promise(() => ConfigModelSelection.read())
    })

    const modelSelectionUpdate = Effect.fn("ConfigHttpApi.modelSelectionUpdate")(function* (ctx) {
      const next = yield* Effect.promise(() => ConfigModelSelection.update(ctx.payload))
      yield* bus.publish(ConfigModelSelection.Updated, next)
      return next
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("modelSelectionGet", modelSelectionGet)
      .handle("modelSelectionUpdate", modelSelectionUpdate)
      .handle("providers", providers)
  }),
)
