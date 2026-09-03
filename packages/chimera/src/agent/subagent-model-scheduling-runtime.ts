export * as SubagentModelSchedulingRuntime from "./subagent-model-scheduling-runtime"

import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigSubagentRouting } from "@/config/subagent-routing"
import { Permission } from "@/permission"
import { ProjectID } from "@/project/schema"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Effect } from "effect"
import { SubagentModelCatalog } from "./subagent-model-catalog"
import { buildSchedulingView, resolveArchetypes, selectionForWorkload, validateWorkload } from "./subagent-model-scheduling"
import { SubagentSpeedEvidence, type RouteSpeedEvidence } from "./subagent-speed-evidence"

const log = Log.create({ service: "subagent-model-scheduling-runtime" })

export interface CurrentViewInput {
  ruleset: Permission.Ruleset
  projectID: ProjectID
  limit?: number
}

export const make = Effect.gen(function* () {
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const auth = yield* Auth.Service
  const routing = yield* ConfigSubagentRouting.Service

  const currentSnapshot = Effect.fn("SubagentModelSchedulingRuntime.currentSnapshot")(function* (input: CurrentViewInput) {
    const cfg = yield* config.get()
    const providers = yield* provider.list()
    const catalog = yield* SubagentModelCatalog.withPreferences(
      SubagentModelCatalog.visible(
        SubagentModelCatalog.buildSnapshot({
          providers,
          configuredProviders: cfg.provider,
        }),
        input.ruleset,
      ),
      input.projectID,
      routing,
    )
    const archetypes = resolveArchetypes(cfg.delegation?.scheduling)
    if (cfg.delegation?.scheduling?.enabled === false) return { catalog, view: undefined, archetypes }
    const auths = yield* auth.all().pipe(Effect.catchTag("AuthError", () => Effect.succeed({})))
    const speedEvidence = yield* SubagentSpeedEvidence.recentSpeedEvidence({ projectID: input.projectID }).pipe(
      Effect.catchCause((cause) => {
        log.warn("speed evidence unavailable; falling back to static speed norms", { cause: Cause.pretty(cause) })
        return Effect.succeed(new Map<string, RouteSpeedEvidence>())
      }),
    )
    const view = buildSchedulingView({
      routes: catalog.routes,
      config: cfg.delegation?.scheduling,
      authTypes: Object.fromEntries(Object.entries(auths).map(([providerID, info]) => [providerID, info.type])),
      pricing: Object.fromEntries(
        catalog.routes.flatMap((route) => {
          const cost = providers[ProviderID.make(route.providerID)]?.models[ModelID.make(route.modelID)]?.cost
          return cost ? [[route.model, cost]] : []
        }),
      ),
      speedEvidence: Object.fromEntries(speedEvidence),
      topTierDisabledMinSizeClass: cfg.delegation?.scheduling?.topTierDisabledMinSizeClass,
      limit: input.limit,
    })
    return { catalog, view, archetypes: view.archetypes }
  })

  const currentView = Effect.fn("SubagentModelSchedulingRuntime.currentView")(function* (input: CurrentViewInput) {
    return (yield* currentSnapshot(input)).view
  })

  const resolveWorkload = Effect.fn("SubagentModelSchedulingRuntime.resolveWorkload")(function* (
    input: CurrentViewInput & { workload: string; select: boolean },
  ) {
    const snapshot = yield* currentSnapshot(input)
    const view = snapshot.view
    if (!view) {
      if (input.select) return yield* Effect.fail(new Error("Subagent workload scheduling is disabled"))
      const error = validateWorkload(input.workload, snapshot.archetypes)
      if (error) return yield* Effect.fail(error)
      return { view, workload: input.workload, selection: undefined }
    }
    const error = validateWorkload(input.workload, view.archetypes)
    if (error) return yield* Effect.fail(error)
    if (!input.select) return { view, workload: input.workload, selection: undefined }
    const selection = selectionForWorkload(view, input.workload)
    if (selection.error) return yield* Effect.fail(selection.error)
    return { view, workload: input.workload, selection }
  })

  const selectWorkload = Effect.fn("SubagentModelSchedulingRuntime.selectWorkload")(function* (
    input: CurrentViewInput & { workload: string },
  ) {
    const resolved = yield* resolveWorkload({ ...input, select: true })
    return { view: resolved.view, ...resolved.selection! }
  })

  return { currentSnapshot, currentView, resolveWorkload, selectWorkload }
})
