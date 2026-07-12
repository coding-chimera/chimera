import { afterEach, describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Fiber, Layer } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { disposeInstance, registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const instanceStoreLayer = Layer.mergeAll(InstanceStore.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(
  Layer.provide(noopBootstrap),
)

const it = testEffect(instanceStoreLayer)

const runIsolatedStore = <A>(effect: Effect.Effect<A, never, InstanceStore.Service>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(instanceStoreLayer)))

function withInstanceStoreEnv(values: Record<string, string>) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterEach(async () => {
  bootstrapRun = Effect.void
  await disposeAllInstances()
})

describe("InstanceStore", () => {
  it.live("loads instance context without installing ALS for the caller", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
      expect(() => Instance.current).toThrow()
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      bootstrapRun = Effect.gen(function* () {
        initializedDirectory = (yield* InstanceRef)?.directory
      })
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
      expect(() => Instance.current).toThrow()
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      bootstrapRun = Effect.sync(() => {
        initialized++
      })
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let initialized = 0

      bootstrapRun = Effect.promise(async () => {
        initialized++
        started.resolve()
        await release.promise
      })
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Effect.promise(() => started.promise)

      bootstrapRun = Effect.sync(() => {
        initialized++
      })
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      release.resolve()

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      bootstrapRun = Effect.sync(() => {
        attempts++
        throw new Error("init failed")
      })
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      bootstrapRun = Effect.sync(() => {
        attempts++
      })
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = Promise.withResolvers<void>()
      const releaseReload = Promise.withResolvers<void>()
      const disposed: Array<string> = []
      const off = registerDisposer(async (directory) => {
        disposed.push(directory)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const first = yield* store.load({ directory: dir })
      bootstrapRun = Effect.promise(async () => {
        reloading.resolve()
        await releaseReload.promise
      })
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Effect.promise(() => reloading.promise)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      releaseReload.resolve()

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = Promise.withResolvers<void>()
      const releaseDispose = Promise.withResolvers<void>()
      const disposed: Array<string> = []
      const off = registerDisposer(async (directory) => {
        disposed.push(directory)
        disposing.resolve()
        await releaseDispose.promise
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Effect.promise(() => disposing.promise)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      releaseDispose.resolve()
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  test("idle sweeper disposes inactive instances after TTL", async () => {
    const restore = withInstanceStoreEnv({
      CHIMERA_INSTANCE_IDLE_TTL_MS: "5",
      CHIMERA_INSTANCE_IDLE_SWEEP_MS: "5",
      CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES: "10",
    })
    const disposed: string[] = []
    const off = registerDisposer(async (directory) => {
      disposed.push(directory)
    }, "test-idle-instance-disposer")
    try {
      await using dir = await tmpdir({ git: true })
      await runIsolatedStore(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          yield* store.load({ directory: dir.path })
          yield* Effect.sleep("50 millis")
          expect(disposed).toContain(dir.path)
        }),
      )
    } finally {
      off()
      restore()
    }
  })

  test("LRU evicts inactive instances beyond active cap", async () => {
    const restore = withInstanceStoreEnv({
      CHIMERA_INSTANCE_IDLE_TTL_MS: "600000",
      CHIMERA_INSTANCE_IDLE_SWEEP_MS: "600000",
      CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES: "2",
    })
    const disposed: string[] = []
    const off = registerDisposer(async (directory) => {
      disposed.push(directory)
    }, "test-lru-instance-disposer")
    try {
      await using dir1 = await tmpdir({ git: true })
      await using dir2 = await tmpdir({ git: true })
      await using dir3 = await tmpdir({ git: true })
      await using dir4 = await tmpdir({ git: true })
      await runIsolatedStore(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          yield* store.load({ directory: dir1.path })
          yield* store.load({ directory: dir2.path })
          yield* store.load({ directory: dir3.path })
          yield* store.load({ directory: dir4.path })
          yield* Effect.sleep("50 millis")
          expect(disposed).toContain(dir1.path)
          expect(disposed).toContain(dir2.path)
          expect(disposed).not.toContain(dir4.path)
        }),
      )
    } finally {
      off()
      restore()
    }
  })

  test("active provide lease is not evicted by LRU", async () => {
    const restore = withInstanceStoreEnv({
      CHIMERA_INSTANCE_IDLE_TTL_MS: "600000",
      CHIMERA_INSTANCE_IDLE_SWEEP_MS: "600000",
      CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES: "1",
    })
    const disposed: string[] = []
    const off = registerDisposer(async (directory) => {
      disposed.push(directory)
    }, "test-active-instance-disposer")
    try {
      await using active = await tmpdir({ git: true })
      await using inactive = await tmpdir({ git: true })
      await runIsolatedStore(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          yield* store.provide(
            { directory: active.path },
            Effect.gen(function* () {
              yield* store.load({ directory: inactive.path })
              yield* Effect.sleep("50 millis")
              expect(disposed).toContain(inactive.path)
              expect(disposed).not.toContain(active.path)
            }),
          )
        }),
      )
    } finally {
      off()
      restore()
    }
  })

  test("active lease is not disposed by TTL", async () => {
    const restore = withInstanceStoreEnv({
      CHIMERA_INSTANCE_IDLE_TTL_MS: "5",
      CHIMERA_INSTANCE_IDLE_SWEEP_MS: "5",
      CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES: "10",
    })
    const disposed: string[] = []
    const off = registerDisposer(async (directory) => {
      disposed.push(directory)
    }, "test-leased-ttl-instance-disposer")
    try {
      await using dir = await tmpdir({ git: true })
      await runIsolatedStore(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          const lease = yield* store.lease({ directory: dir.path })
          yield* Effect.sleep("50 millis")
          expect(disposed).not.toContain(dir.path)

          yield* lease.release
          yield* lease.release
          yield* Effect.sleep("50 millis")
          expect(disposed).toContain(dir.path)
        }),
      )
    } finally {
      off()
      restore()
    }
  })

  test("stale lease release does not unpin a reloaded replacement", async () => {
    const restore = withInstanceStoreEnv({
      CHIMERA_INSTANCE_IDLE_TTL_MS: "600000",
      CHIMERA_INSTANCE_IDLE_SWEEP_MS: "600000",
      CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES: "1",
    })
    const disposed: string[] = []
    const off = registerDisposer(async (directory) => {
      disposed.push(directory)
    }, "test-reload-lease-instance-disposer")
    try {
      await using active = await tmpdir({ git: true })
      await using inactive = await tmpdir({ git: true })
      await runIsolatedStore(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          const stale = yield* store.lease({ directory: active.path })
          const replacement = yield* store.reload({ directory: active.path })
          const current = yield* store.pin(replacement)
          const reloadDisposals = disposed.filter((directory) => directory === active.path).length

          yield* stale.release
          yield* stale.release
          yield* store.load({ directory: inactive.path })
          yield* Effect.sleep("50 millis")

          expect(yield* store.load({ directory: active.path })).toBe(replacement)
          expect(disposed.filter((directory) => directory === active.path)).toHaveLength(reloadDisposals)
          expect(disposed).toContain(inactive.path)
          yield* current.release
        }),
      )
    } finally {
      off()
      restore()
    }
  })

  it.live("reports failing instance disposers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const off = registerDisposer(async () => {
        throw new Error("dispose failed")
      }, "test-failing-disposer")
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const results = yield* Effect.promise(() => disposeInstance(dir, { timeoutMs: 100 }))
      const result = results.find((item) => item.name === "test-failing-disposer")

      expect(result?.status).toBe("rejected")
      expect(result?.error).toBe("dispose failed")
      expect(result?.directory).toBe(dir)
    }),
  )

  it.live("times out hanging instance disposers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const off = registerDisposer(() => new Promise<void>(() => {}), "test-hanging-disposer")
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const started = Date.now()
      const results = yield* Effect.promise(() => disposeInstance(dir, { timeoutMs: 20 }))
      const result = results.find((item) => item.name === "test-hanging-disposer")

      expect(Date.now() - started).toBeLessThan(500)
      expect(result?.status).toBe("timed_out")
      expect(result?.error).toBe("Timed out after 20ms")
      expect(result?.directory).toBe(dir)
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      const off = registerDisposer(async (directory) => {
        disposed.push(directory)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )

  it.live("provides legacy Promise callers with instance ALS", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const directory = yield* Effect.promise(() =>
        WithInstance.provide({
          directory: dir,
          fn: () => Instance.directory,
        }),
      )

      expect(directory).toBe(dir)
      expect(() => Instance.current).toThrow()
    }),
  )
})
