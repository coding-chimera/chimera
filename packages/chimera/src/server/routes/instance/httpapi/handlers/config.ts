import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ConfigModelSelection } from "@/config/model-selection"
import { Provider } from "@/provider/provider"
import { RemoteCompaction } from "@/session/remote-compaction"
import { Session } from "@/session/session"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal, markInstanceForReload } from "../lifecycle"

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

    const remoteCompaction = yield* RemoteCompaction.Service
    const sessions = yield* Session.Service

    const remoteCompactionEligibilityList = Effect.fn("ConfigHttpApi.remoteCompactionEligibilityList")(function* () {
      return RemoteCompaction.eligibilityList(yield* providerSvc.list())
    })

    const remoteCompactionEligibilityUpdate = Effect.fn("ConfigHttpApi.remoteCompactionEligibilityUpdate")(function* (ctx) {
      const failure = (reason: RemoteCompaction.EligibilityErrorReason) =>
        new RemoteCompaction.EligibilityError({
          name: "RemoteCompactionEligibilityError",
          data: { providerID: ctx.payload.providerID, modelID: ctx.payload.modelID, reason },
        })
      if (Object.keys(ctx.payload).some((key) => !["providerID", "modelID", "enabled", "protocols"].includes(key)))
        return yield* failure("unknown_field")
      const providers = yield* providerSvc.list()
      const provider = providers[ctx.payload.providerID]
      if (!provider) return yield* failure("unknown_provider")
      const model = provider.models[ctx.payload.modelID]
      if (!model) return yield* failure("unknown_model")
      const eligibility = RemoteCompaction.eligibility(provider, model, ctx.payload)
      if (!eligibility.configurable) return yield* failure("not_configurable")
      yield* configSvc.update(RemoteCompaction.eligibilityConfigPatch(ctx.payload))
      const instance = yield* InstanceState.context
      yield* markInstanceForReload(instance, {
        directory: instance.directory,
        worktree: instance.directory,
        project: instance.project,
      })
      return eligibility
    })

    const remoteCompactionStatus = Effect.fn("ConfigHttpApi.remoteCompactionStatus")(function* (ctx) {
      const model = yield* providerSvc
        .getModel(ctx.query.providerID, ctx.query.modelID)
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      if (!ctx.query.sessionID) return yield* remoteCompaction.resolve({ model })
      return yield* remoteCompaction.resolve({
        model,
        session: {
          sessionID: ctx.query.sessionID,
          lock: yield* sessions.remoteCompactionLock(ctx.query.sessionID),
        },
      })
    })

    const remoteCompactionUpdate = Effect.fn("ConfigHttpApi.remoteCompactionUpdate")(function* (ctx) {
      if (Object.keys(ctx.payload).some((key) => key !== "remote" && key !== "remote_protocol"))
        return yield* new HttpApiError.BadRequest({})
      const current = yield* configSvc.get()
      yield* configSvc.update({ compaction: ctx.payload })
      const instance = yield* InstanceState.context
      yield* markInstanceForReload(instance, {
        directory: instance.directory,
        worktree: instance.directory,
        project: instance.project,
      })
      return {
        remote: ctx.payload.remote ?? current.compaction?.remote ?? "auto",
        remote_protocol: ctx.payload.remote_protocol ?? current.compaction?.remote_protocol ?? "auto",
      }
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
      .handle("remoteCompactionEligibilityList", remoteCompactionEligibilityList)
      .handle("remoteCompactionEligibilityUpdate", remoteCompactionEligibilityUpdate)
      .handle("remoteCompactionStatus", remoteCompactionStatus)
      .handle("remoteCompactionUpdate", remoteCompactionUpdate)
      .handle("modelSelectionGet", modelSelectionGet)
      .handle("modelSelectionUpdate", modelSelectionUpdate)
      .handle("providers", providers)
  }),
)
