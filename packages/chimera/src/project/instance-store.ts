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
  /** Refreshes WebUI presence pins (TTL-bounded `pinnedUntil`) for already-loaded directories. */
  readonly presence: (directories: readonly string[]) => Effect.Effect<void>
  /** Registers the session-side authority used by sweeps to reconcile dangling pins. */
  readonly registerPinReconciler: (reconciler: PinReconciler) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

/** Session-side truth about pin holders for one directory, returned by a registered {@link PinReconciler}. */
export interface PinReconciliation {
  /** How many session pins should currently be held for the directory (busy session runners). */
  readonly expectedPins: number
  /** Non-idle sessions in session status storage; diagnostic context for mismatch warnings. */
  readonly busyStatuses: number
}

/**
 * Queried during sweeps with the target instance's {@link InstanceRef} provided as fiber context.
 * Returning `undefined` means "unknown" and skips correction for that directory.
 */
export type PinReconciler = () => Effect.Effect<PinReconciliation | undefined>

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
  ctx?: InstanceContext
  disposed: Deferred.Deferred<void>
  bootedAt: number
  lastUsedAt: number
  active: number
  /** Subset of `active` acquired through {@link Interface.pin} (session-run pins); reconciled during sweeps. */
  pins: number
  disposing: boolean
}

type ReadyEntry = Entry & { ctx: InstanceContext }

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000
const DEFAULT_IDLE_SWEEP_MS = 60 * 1000
/** Retired count cap: 0 = disabled. An explicit env/config value still acts as a safety valve. */
const DEFAULT_MAX_ACTIVE_INSTANCES = 0
const DEFAULT_BOOT_GRACE_MS = 60 * 1000
const DEFAULT_SWEEP_DEBOUNCE_MS = 5 * 1000
const DEFAULT_OSCILLATION_WINDOW_MS = 30 * 1000
const DEFAULT_OSCILLATION_PIN_MS = 2 * 60 * 1000
const DEFAULT_PRESENCE_TTL_MS = 90 * 1000
const DEFAULT_MEMORY_BUDGET_MB = 1024
/** User-approved acceptable maximum for the RSS budget (2026-09-17); above this is not recommended. */
const MAX_RECOMMENDED_MEMORY_BUDGET_MB = 2048
/** Pressure eviction stops once RSS is back at or below this fraction of the budget. */
const MEMORY_PRESSURE_WATERMARK = 0.8
/** Defensive cap on one presence heartbeat payload so a huge array cannot block the event loop. */
const MAX_PRESENCE_DIRECTORIES = 512

/** Disposed reasons emitted for LRU-driven sweeps; clients use these to tell eviction apart from reloads. */
export const LRU_DISPOSE_REASONS = ["idle-sweep", "post-load-lru", "post-request-lru", "memory-pressure"] as const


function envPositiveNumber(names: string[], fallback: number) {
  const raw = names.map((name) => process.env[name]).find((value) => value)
  const parsed = raw ? Number(raw) : fallback
  // 0 is a valid explicit value (disables grace/debounce-style knobs); only negative/NaN falls back.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

let configDefaults: { maxActiveInstances?: number; memoryBudgetMb?: number } = {}

/** Applies `server.*` config-file values as defaults. Explicit env vars still win over config. */
export function applyServerInstanceDefaults(input: { maxActiveInstances?: number; memoryBudgetMb?: number }) {
  configDefaults = { ...configDefaults, ...input }
}

let memoryRssBytes: () => number = () => process.memoryUsage().rss

/** Test seam: overrides the RSS probe used by memory-pressure eviction. `undefined` restores the real probe. */
export function setInstanceMemoryRssProbe(probe: (() => number) | undefined) {
  memoryRssBytes = probe ?? (() => process.memoryUsage().rss)
}

function settings() {
  return {
    idleTtlMs: envPositiveNumber(["CHIMERA_INSTANCE_IDLE_TTL_MS", "OPENCODE_INSTANCE_IDLE_TTL_MS"], DEFAULT_IDLE_TTL_MS),
    sweepMs: envPositiveNumber(["CHIMERA_INSTANCE_IDLE_SWEEP_MS", "OPENCODE_INSTANCE_IDLE_SWEEP_MS"], DEFAULT_IDLE_SWEEP_MS),
    bootGraceMs: envPositiveNumber(["CHIMERA_INSTANCE_BOOT_GRACE_MS"], DEFAULT_BOOT_GRACE_MS),
    sweepDebounceMs: envPositiveNumber(["CHIMERA_INSTANCE_SWEEP_DEBOUNCE_MS"], DEFAULT_SWEEP_DEBOUNCE_MS),
    oscillationWindowMs: envPositiveNumber(["CHIMERA_INSTANCE_OSCILLATION_WINDOW_MS"], DEFAULT_OSCILLATION_WINDOW_MS),
    oscillationPinMs: envPositiveNumber(["CHIMERA_INSTANCE_OSCILLATION_PIN_MS"], DEFAULT_OSCILLATION_PIN_MS),
    presenceTtlMs: envPositiveNumber(["CHIMERA_INSTANCE_PRESENCE_TTL_MS"], DEFAULT_PRESENCE_TTL_MS),
    memoryBudgetMb: envPositiveNumber(["CHIMERA_INSTANCE_MEMORY_BUDGET_MB"], configDefaults.memoryBudgetMb ?? DEFAULT_MEMORY_BUDGET_MB),
    // Retired knob (W1): default 0 = no count cap. An explicit positive value keeps the legacy
    // overflow-eviction semantics as an opt-in safety valve.
    maxActiveInstances: Math.max(
      0,
      Math.floor(
        envPositiveNumber(
          ["CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES", "OPENCODE_INSTANCE_MAX_ACTIVE_INSTANCES"],
          configDefaults.maxActiveInstances ?? DEFAULT_MAX_ACTIVE_INSTANCES,
        ),
      ),
    ),
  }
}

function makeEntry(now = Date.now()): Entry {
  return {
    deferred: Deferred.makeUnsafe<InstanceContext>(),
    disposed: Deferred.makeUnsafe<void>(),
    bootedAt: now,
    lastUsedAt: now,
    active: 0,
    pins: 0,
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
    const lastDisposedAt = new Map<string, number>()
    const pinnedUntil = new Map<string, number>()
    let pinReconciler: PinReconciler | undefined
    // Two-strike confirmation for pin reconciliation: a mismatch must be observed by two
    // consecutive sweeps before correction, because a pin acquired mid-transition (onBusy
    // between the store-side counter bump and the session-side bookkeeping) is a false positive.
    const suspectedPinMismatch = new Map<string, string>()

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

    const emitDisposed = (input: { directory: string; project?: string; reason?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
              reason: input.reason,
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
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id, reason })
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
        lastDisposedAt.set(directory, Date.now())
        if (cache.get(directory) === entry) cache.delete(directory)
      }).pipe(Effect.ensuring(Deferred.succeed(entry.disposed, undefined).pipe(Effect.ignore)))
      return true
    })

    const readyEntries = () =>
      [...cache.entries()].flatMap(([directory, entry]) =>
        entry.ctx ? [{ directory, entry: entry as ReadyEntry }] : [],
      )

    const isPinned = (directory: string, now: number) => (pinnedUntil.get(directory) ?? 0) > now

    /**
     * Zero-consumer guard shared by every eviction path: no request lease, no session pin,
     * no presence/oscillation pin, and the boot grace has elapsed. Consumer signals are the
     * unit of protection (W1); the retired count cap only trims instances passing this guard.
     */
    const isEvictable = (item: { directory: string; entry: ReadyEntry }, now: number) =>
      !item.entry.disposing &&
      item.entry.active === 0 &&
      !isPinned(item.directory, now) &&
      now - item.entry.bootedAt >= options.bootGraceMs

    const collectIdleCandidates = (now: number) => {
      const ready = readyEntries()
      // Steady-state reclamation: zero consumers (leases, session pins, presence pins)
      // and idle beyond the TTL. Presence heartbeats keep `pinnedUntil` fresh, so a
      // directory the WebUI still reports is never idle-evicted.
      const idle = ready.filter(
        (item) =>
          !item.entry.disposing &&
          item.entry.active === 0 &&
          !isPinned(item.directory, now) &&
          now - item.entry.lastUsedAt >= options.idleTtlMs,
      )
      const idleDirectories = new Set(idle.map((item) => item.directory))
      // Retired count cap: only enforced when explicitly configured (>0) as a safety valve.
      const overflow =
        options.maxActiveInstances > 0
          ? ready
              .filter((item) => !idleDirectories.has(item.directory) && isEvictable(item, now))
              .toSorted((a, b) => a.entry.lastUsedAt - b.entry.lastUsedAt)
              .slice(0, Math.max(0, ready.length - options.maxActiveInstances - idle.length))
          : []
      return [...idle, ...overflow]
    }

    const collectPressureCandidates = (now: number) =>
      readyEntries()
        .filter((item) => isEvictable(item, now))
        .toSorted((a, b) => a.entry.lastUsedAt - b.entry.lastUsedAt)

    // Pin-leak backstop (W1 design point 4): reconcile store-side pin counters against the
    // session-side authority (busy runners + session status storage) and correct dangling
    // pins with a warning, so a leaked pin cannot make an instance permanently unevictable.
    const reconcilePins = Effect.fnUntraced(function* () {
      const reconciler = pinReconciler
      if (!reconciler) return
      for (const { directory, entry } of readyEntries()) {
        if (entry.pins === 0 || entry.disposing) {
          suspectedPinMismatch.delete(directory)
          continue
        }
        const exit = yield* reconciler().pipe(Effect.provideService(InstanceRef, entry.ctx), Effect.exit)
        if (Exit.isFailure(exit)) {
          yield* Effect.logWarning("pin reconciliation failed", { directory, cause: exit.cause })
          continue
        }
        const reconciliation = exit.value
        if (reconciliation === undefined || entry.pins <= reconciliation.expectedPins) {
          suspectedPinMismatch.delete(directory)
          continue
        }
        const observed = `${entry.pins}:${reconciliation.expectedPins}`
        if (suspectedPinMismatch.get(directory) !== observed) {
          suspectedPinMismatch.set(directory, observed)
          continue
        }
        suspectedPinMismatch.delete(directory)
        const dangling = entry.pins - reconciliation.expectedPins
        yield* Effect.logWarning("correcting dangling instance pins", {
          directory,
          pins: entry.pins,
          expectedPins: reconciliation.expectedPins,
          busyStatuses: reconciliation.busyStatuses,
          dangling,
        })
        entry.pins = reconciliation.expectedPins
        entry.active = Math.max(0, entry.active - dangling)
      }
    })

    // Pressure reclamation: only when the process RSS exceeds the budget, evict zero-consumer
    // instances coldest-first until RSS is back at the watermark (or candidates run out).
    // Presence-pinned and freshly booted instances are protected by `isEvictable`.
    const sweepMemoryPressure = Effect.fnUntraced(function* () {
      if (options.memoryBudgetMb <= 0) return
      const budgetBytes = options.memoryBudgetMb * 1024 * 1024
      const initialRss = memoryRssBytes()
      if (initialRss <= budgetBytes) return
      const watermarkBytes = Math.floor(budgetBytes * MEMORY_PRESSURE_WATERMARK)
      const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024)
      yield* Effect.logWarning("instance memory budget exceeded; evicting coldest consumer-free instances", {
        rssMB: toMB(initialRss),
        budgetMB: options.memoryBudgetMb,
        watermarkMB: toMB(watermarkBytes),
      })
      let evicted = 0
      for (const item of collectPressureCandidates(Date.now())) {
        if (memoryRssBytes() <= watermarkBytes) break
        if (yield* disposeEntry(item.directory, item.entry, "memory-pressure")) evicted++
      }
      if (evicted > 0)
        yield* Effect.logInfo("memory-pressure eviction finished", {
          evicted,
          rssMB: toMB(memoryRssBytes()),
          budgetMB: options.memoryBudgetMb,
        })
    })

    const sweepIdle = Effect.fn("InstanceStore.sweepIdle")(function* (reason: string) {
      const now = Date.now()
      for (const [directory, until] of pinnedUntil) if (until <= now) pinnedUntil.delete(directory)
      for (const [directory, at] of lastDisposedAt) if (now - at > options.oscillationWindowMs) lastDisposedAt.delete(directory)
      yield* reconcilePins()
      const candidates = collectIdleCandidates(Date.now())
      if (candidates.length > 0) {
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
      }
      yield* sweepMemoryPressure()
    })

    // Debounced LRU sweep: every boot/release used to sweep immediately, which let a
    // dispose -> client resync -> re-boot cycle amplify into a dispose storm.
    // Trailing semantics: requests arriving while a sweep is scheduled mark the
    // state dirty and get their own sweep pass, so no eviction check is dropped.
    let sweepScheduled = false
    let sweepDirty = false
    const requestSweep = (reason: string) => {
      if (sweepScheduled) {
        sweepDirty = true
        return Effect.void
      }
      sweepScheduled = true
      return Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(`${options.sweepDebounceMs} millis`)
          sweepDirty = false
          yield* sweepIdle(reason)
          if (!sweepDirty) break
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            sweepScheduled = false
            sweepDirty = false
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
    }

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) {
          yield* removeEntry(directory, entry)
          yield* Deferred.succeed(entry.disposed, undefined).pipe(Effect.ignore)
        } else {
          entry.ctx = exit.value
          const now = Date.now()
          entry.bootedAt = now
          entry.lastUsedAt = now
          const lastDispose = lastDisposedAt.get(directory)
          if (lastDispose !== undefined && now - lastDispose <= options.oscillationWindowMs) {
            pinnedUntil.set(directory, now + options.oscillationPinMs)
            yield* Effect.logWarning("instance re-booted shortly after LRU dispose; pinning to break oscillation", {
              directory,
              oscillationPinMs: options.oscillationPinMs,
            })
          }
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

    const acquireEntry = (loaded: { directory: string; entry: ReadyEntry }, kind: "lease" | "pin" = "lease"): Lease => {
      loaded.entry.active++
      if (kind === "pin") loaded.entry.pins++
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
            if (kind === "pin") loaded.entry.pins = Math.max(0, loaded.entry.pins - 1)
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
        return acquireEntry({ directory, entry: entry as ReadyEntry }, "pin")
      })

    // WebUI presence heartbeat (W1): each report extends `pinnedUntil` for already-loaded
    // directories, protecting them from idle-TTL and pressure eviction while the UI is open.
    // Directories without a live entry are ignored — presence must never boot an instance.
    const presence = Effect.fn("InstanceStore.presence")(function* (directories: readonly string[]) {
      const until = Date.now() + options.presenceTtlMs
      yield* Effect.sync(() => {
        for (const directory of directories.slice(0, MAX_PRESENCE_DIRECTORIES)) {
          if (!directory) continue
          const resolved = AppFileSystem.resolve(directory)
          const entry = cache.get(resolved)
          if (!entry || entry.disposing) continue
          pinnedUntil.set(resolved, Math.max(pinnedUntil.get(resolved) ?? 0, until))
        }
      })
    })

    const registerPinReconciler = Effect.fn("InstanceStore.registerPinReconciler")(function* (reconciler: PinReconciler) {
      yield* Effect.sync(() => {
        pinReconciler = reconciler
      })
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
              yield* emitDisposed({ directory, project: input.project?.id ?? previous.ctx?.project.id, reason: "reload" })
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

    if (options.memoryBudgetMb > MAX_RECOMMENDED_MEMORY_BUDGET_MB)
      yield* Effect.logWarning("instance memory budget is above the recommended maximum", {
        memoryBudgetMb: options.memoryBudgetMb,
        recommendedMaxMb: MAX_RECOMMENDED_MEMORY_BUDGET_MB,
      })

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
      presence,
      registerPinReconciler,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
