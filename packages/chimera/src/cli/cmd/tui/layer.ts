import { Effect, Layer, ManagedRuntime } from "effect"
import { TuiConfig } from "./config/tui"
import { Npm } from "@opencode-ai/core/npm"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Observability } from "@opencode-ai/core/effect/observability"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { attach } from "@/effect/run-service"

export const CliLayer = Observability.layer.pipe(
  Layer.merge(TuiConfig.layer),
  Layer.provideMerge(Npm.defaultLayer),
  Layer.provideMerge(AppFileSystem.defaultLayer),
  Layer.provideMerge(EffectFlock.defaultLayer),
)

const runtime = ManagedRuntime.make(CliLayer, { memoMap })

export const TuiRuntime = {
  runPromise<A, E>(
    effect: Effect.Effect<A, E, TuiConfig.Service | Npm.Service | EffectFlock.Service>,
    options?: Effect.RunOptions,
  ) {
    return runtime.runPromise(attach(effect), options)
  },
  dispose: () => runtime.dispose(),
}
