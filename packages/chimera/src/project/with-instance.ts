import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { context } from "./instance-context"
import { InstanceStore } from "./instance-store"
import { Effect } from "effect"

export async function provide<R>(input: { directory: string; fn: () => R }): Promise<R> {
  return AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: input.directory },
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) throw new Error("InstanceStore did not provide InstanceRef")
          return yield* Effect.promise(() => Promise.resolve(context.provide(ctx, input.fn)))
        }),
      ),
    ),
  )
}

export * as WithInstance from "./with-instance"
