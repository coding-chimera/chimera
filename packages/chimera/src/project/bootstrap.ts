import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share/share-next"
import { Cause, Effect, Fiber, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Memory } from "@/memory/memory"
import { MCP } from "@/mcp"
import { registerDisposer } from "@/effect/instance-registry"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const memory = yield* Memory.Service
    const mcp = yield* MCP.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, file, fileWatcher, vcs, snapshot, project, memory],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      // MCP servers can take seconds to handshake. Warm the per-instance MCP state in the
      // background so instance boot and first-paint routes never wait on it. The warm-up
      // fiber is registered with the per-directory instance disposer, so disposal
      // interrupts it immediately instead of letting late lookups start new connections;
      // the InstanceState cache still dedupes concurrent callers.
      const warmup = mcp.ensure().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("mcp init failed", { cause }),
        ),
      )
      const fiber = yield* warmup.pipe(Effect.forkDetach({ startImmediately: true }))
      const off = registerDisposer(async (directory) => {
        if (directory !== ctx.directory) return
        await Effect.runPromise(Fiber.interrupt(fiber))
      }, "mcp-warmup")
      // Unregister once the warm-up settles so re-boots do not accumulate disposers.
      yield* Fiber.join(fiber).pipe(Effect.ensuring(Effect.sync(off)), Effect.forkDetach({ startImmediately: true }))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    Memory.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
    MCP.defaultLayer,
  ]),
)

export * as InstanceBootstrap from "./bootstrap"
