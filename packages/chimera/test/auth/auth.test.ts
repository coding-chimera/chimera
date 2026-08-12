import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )

  it.live("updates an active auth snapshot and bumps revision only for state changes", () =>
    provideTmpdirInstance(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = "{}"
      return Effect.gen(function* () {
        const auth = yield* Auth.Service
        const start = yield* auth.revision()
        const info = { type: "api" as const, key: "test-key" }
        const setChange = yield* auth.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.yieldNow

        yield* auth.set("phase5", info)
        const afterSet = yield* auth.revision()
        expect(afterSet).toBe(start + 1)
        expect((yield* auth.get("phase5"))).toEqual(info)
        expect(JSON.parse(process.env.OPENCODE_AUTH_CONTENT ?? "{}")).toEqual({ phase5: info })
        expect(Array.from(yield* Fiber.join(setChange))).toEqual([{ revision: afterSet }])

        const removeChange = yield* auth.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.yieldNow
        yield* auth.set("phase5", info)
        expect(yield* auth.revision()).toBe(afterSet)

        yield* auth.remove("phase5")
        const afterRemove = yield* auth.revision()
        expect(afterRemove).toBe(afterSet + 1)
        expect(yield* auth.all()).toEqual({})
        expect(JSON.parse(process.env.OPENCODE_AUTH_CONTENT ?? "{}")).toEqual({})

        yield* auth.remove("phase5")
        expect(yield* auth.revision()).toBe(afterRemove)
        expect(Array.from(yield* Fiber.join(removeChange))).toEqual([{ revision: afterRemove }])
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
            if (previous !== undefined) process.env.OPENCODE_AUTH_CONTENT = previous
          }),
        ),
      )
    }),
  )
})
