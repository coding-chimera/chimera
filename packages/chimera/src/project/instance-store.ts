import { GlobalBus } from "@/bus/global"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Deferred, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Lease {
  readonly ctx: InstanceContext
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly lease: (input: LoadInput) => Effect.Effect<Lease>
  readonly pin: (ctx: InstanceContext) => Effect.Effect<Lease>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
  ctx?: InstanceContext
  disposed: Deferred.Deferred<void>
  lastUsedAt: number
  active: number
  disposing: boolean
}

type ReadyEntry = Entry & { ctx: InstanceContext }

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000
const DEFAULT_IDLE_SWEEP_MS = 60 * 1000
const DEFAULT_MAX_ACTIVE_INSTANCES = 4

function envPositiveNumber(names: string[], fallback: number) {
  const raw = names.map((name) => process.env[name]).find((value) => value)
  const parsed = raw ? Number(raw) : fallback
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function settings() {
  return {
    idleTtlMs: envPositiveNumber(["CHIMERA_INSTANCE_IDLE_TTL_MS", "OPENCODE_INSTANCE_IDLE_TTL_MS"], DEFAULT_IDLE_TTL_MS),
    sweepMs: envPositiveNumber(["CHIMERA_INSTANCE_IDLE_SWEEP_MS", "OPENCODE_INSTANCE_IDLE_SWEEP_MS"], DEFAULT_IDLE_SWEEP_MS),
    maxActiveInstances: Math.max(
      1,
      Math.floor(
        envPositiveNumber(
          ["CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES", "OPENCODE_INSTANCE_MAX_ACTIVE_INSTANCES"],
          DEFAULT_MAX_ACTIVE_INSTANCES,
        ),
      ),
    ),
  }
}

function makeEntry(now = Date.now()): Entry {
  return {
    deferred: Deferred.makeUnsafe<InstanceContext>(),
    disposed: Deferred.makeUnsafe<void>(),
    lastUsedAt: now,
    active: 0,
    disposing: false,
  }
}

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    const options = settings()

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const runInstanceDisposers = Effect.fnUntraced(function* (directory: string) {
      const results = yield* Effect.promise(() => runDisposers(directory))
      for (const result of results) {
        if (result.status === "fulfilled") continue
        yield* Effect.logWarning("instance disposer did not complete", {
          directory,
          disposer: result.name,
          disposerID: result.id,
          status: result.status,
          elapsed: result.elapsed,
          error: result.error,
        })
      }
      return results
    })

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (
      ctx: InstanceContext,
      reason?: string,
    ) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory, reason })
      yield* runInstanceDisposers(ctx.directory)
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (
      directory: string,
      entry: ReadyEntry,
      reason: string,
      options: { force?: boolean } = {},
    ) {
      if (cache.get(directory) !== entry) return false
      if (entry.disposing) {
        yield* Deferred.await(entry.disposed).pipe(Effect.ignore)
        return false
      }
      if (!options.force && entry.active > 0) return false
      entry.disposing = true
      yield* Effect.gen(function* () {
        yield* disposeContext(entry.ctx, reason)
        if (cache.get(directory) === entry) cache.delete(directory)
      }).pipe(Effect.ensuring(Deferred.succeed(entry.disposed, undefined).pipe(Effect.ignore)))
      return true
    })

    const readyEntries = () =>
      [...cache.entries()].flatMap(([directory, entry]) =>
        entry.ctx ? [{ directory, entry: entry as ReadyEntry }] : [],
      )

    const collectIdleCandidates = (now: number) => {
      const ready = readyEntries()
      const idle = ready.filter(
        (item) =>
          !item.entry.disposing &&
          item.entry.active === 0 &&
          now - item.entry.lastUsedAt >= options.idleTtlMs,
      )
      const idleDirectories = new Set(idle.map((item) => item.directory))
      const overflow = ready
        .filter(
          (item) =>
            !idleDirectories.has(item.directory) && !item.entry.disposing && item.entry.active === 0,
        )
        .toSorted((a, b) => a.entry.lastUsedAt - b.entry.lastUsedAt)
        .slice(0, Math.max(0, ready.length - options.maxActiveInstances - idle.length))
      return [...idle, ...overflow]
    }

    const sweepIdle = Effect.fn("InstanceStore.sweepIdle")(function* (reason: string) {
      const candidates = collectIdleCandidates(Date.now())
      if (candidates.length === 0) return
      yield* Effect.logInfo("disposing idle instances", {
        reason,
        count: candidates.length,
        maxActiveInstances: options.maxActiveInstances,
        idleTtlMs: options.idleTtlMs,
      })
      yield* Effect.forEach(
        candidates,
        (item) => disposeEntry(item.directory, item.entry, reason),
        { discard: true },
      )
    })

    const requestSweep = (reason: string) =>
      sweepIdle(reason).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) {
          yield* removeEntry(directory, entry)
          yield* Deferred.succeed(entry.disposed, undefined).pipe(Effect.ignore)
        } else {
          entry.ctx = exit.value
          entry.lastUsedAt = Date.now()
        }
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
        if (Exit.isSuccess(exit)) yield* requestSweep("post-load-lru")
      })

    const loadEntry = (input: LoadInput): Effect.Effect<{ directory: string; entry: ReadyEntry }> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) {
            existing.lastUsedAt = Date.now()
            if (existing.disposing) {
              yield* restore(Deferred.await(existing.disposed))
              return yield* restore(loadEntry(input))
            }
            yield* restore(Deferred.await(existing.deferred))
            existing.lastUsedAt = Date.now()
            return { directory, entry: existing as ReadyEntry }
          }

          const entry = makeEntry()
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          yield* restore(Deferred.await(entry.deferred))
          entry.lastUsedAt = Date.now()
          return { directory, entry: entry as ReadyEntry }
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const acquireEntry = (loaded: { directory: string; entry: ReadyEntry }): Lease => {
      loaded.entry.active++
      loaded.entry.lastUsedAt = Date.now()
      let released = false
      return {
        ctx: loaded.entry.ctx,
        release: Effect.gen(function* () {
          if (released) return
          released = true
          yield* Effect.sync(() => {
            if (cache.get(loaded.directory) !== loaded.entry) return
            loaded.entry.active = Math.max(0, loaded.entry.active - 1)
            loaded.entry.lastUsedAt = Date.now()
          })
          yield* requestSweep("post-request-lru")
        }),
      }
    }

    const lease = (input: LoadInput): Effect.Effect<Lease> => loadEntry(input).pipe(Effect.map(acquireEntry))

    const pin = (ctx: InstanceContext): Effect.Effect<Lease> =>
      Effect.gen(function* () {
        const directory = AppFileSystem.resolve(ctx.directory)
        const entry = cache.get(directory)
        if (!entry || entry.disposing) return yield* Effect.die(new Error("Cannot pin inactive instance"))
        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit) || exit.value !== ctx || cache.get(directory) !== entry) {
          return yield* Effect.die(new Error("Cannot pin stale instance"))
        }
        return acquireEntry({ directory, entry: entry as ReadyEntry })
      })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> =>
      loadEntry(input).pipe(Effect.map((loaded) => loaded.entry.ctx))

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          const entry = makeEntry()
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory })
            if (previous) {
              previous.disposing = true
              yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
              yield* runInstanceDisposers(directory)
              yield* emitDisposed({ directory, project: input.project?.id ?? previous.ctx?.project.id })
              yield* Deferred.succeed(previous.disposed, undefined).pipe(Effect.ignore)
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          yield* restore(Deferred.await(entry.deferred))
          entry.lastUsedAt = Date.now()
          return entry.ctx!
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx, "explicit")

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry as ReadyEntry, "explicit", { force: true }).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              yield* Deferred.succeed(item[1].disposed, undefined).pipe(Effect.ignore)
              return
            }
            yield* disposeEntry(item[0], item[1] as ReadyEntry, "dispose-all", { force: true })
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        lease(input),
        (acquired) => effect.pipe(Effect.provideService(InstanceRef, acquired.ctx)),
        (acquired) => acquired.release,
      )

    yield* sweepIdle("idle-sweep").pipe(
      Effect.repeat(Schedule.spaced(`${options.sweepMs} millis`)),
      Effect.delay(`${options.sweepMs} millis`),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.ignore,
    )
    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      lease,
      pin,
      reload,
      dispose,
      disposeAll,
      provide,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
