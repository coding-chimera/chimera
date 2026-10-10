import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import { Permission } from "../../src/permission"
import { PermissionPersist } from "../../src/permission/persist"
import { PermissionID } from "../../src/permission/schema"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/contracts/session-ids"
import { disposeAllInstances, provideInstance, reloadTestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(Permission.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

afterEach(async () => {
  await disposeAllInstances()
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

const createSession = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({})
})

const sessionPermission = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const info = yield* sessions.get(sessionID)
    return info.permission ?? []
  })

/** Mirrors the ask-side consumption in SessionPrompt: the persisted session
 * permission column is merged into the ruleset passed to Permission.ask. */
const askWithSessionRules = (sessionID: SessionID, permission: string, patterns: string[]) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const rules = yield* sessionPermission(sessionID)
    return yield* svc.ask({
      sessionID,
      permission,
      patterns,
      metadata: {},
      always: patterns,
      ruleset: Permission.merge([], rules),
    })
  })

describe("permission always-approval persistence", () => {
  it.live("always reply persists to session slots and survives an instance reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const run = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))

      const session = yield* createSession.pipe(run)
      const requestID = PermissionID.ascending()
      const fiber = yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        return yield* permission.ask({
          id: requestID,
          sessionID: session.id,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: ["ls"],
          ruleset: [],
        })
      }).pipe(run, Effect.forkScoped)

      yield* waitForPending(1).pipe(run)
      yield* PermissionPersist.replyAndPersist({ requestID, reply: "always" }).pipe(run)
      yield* Fiber.join(fiber)

      expect(yield* sessionPermission(session.id).pipe(run)).toEqual([
        { permission: "bash", pattern: "ls", action: "allow" },
      ])

      // Simulated restart: drop all per-directory instance state so the
      // in-memory approved ruleset is rebuilt (empty) from scratch.
      yield* Effect.promise(() => reloadTestInstance({ directory: dir }))

      const result = yield* askWithSessionRules(session.id, "bash", ["ls"]).pipe(run)
      expect(result).toBeUndefined()
      expect(yield* waitForPending(0).pipe(run)).toHaveLength(0)
    }),
  )

  it.live("once reply resolves the ask without persisting", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const run = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))

      const session = yield* createSession.pipe(run)
      const requestID = PermissionID.ascending()
      const fiber = yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        return yield* permission.ask({
          id: requestID,
          sessionID: session.id,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: ["ls"],
          ruleset: [],
        })
      }).pipe(run, Effect.forkScoped)

      yield* waitForPending(1).pipe(run)
      yield* PermissionPersist.replyAndPersist({ requestID, reply: "once" }).pipe(run)
      yield* Fiber.join(fiber)

      expect(yield* sessionPermission(session.id).pipe(run)).toEqual([])

      yield* Effect.promise(() => reloadTestInstance({ directory: dir }))

      // Same pattern asks again after the reload: nothing was persisted.
      const again = yield* askWithSessionRules(session.id, "bash", ["ls"]).pipe(run, Effect.forkScoped)
      const pending = yield* waitForPending(1).pipe(run)
      expect(pending.map((item) => item.id)).not.toContain(requestID)
      yield* PermissionPersist.replyAndPersist({ requestID: pending[0].id, reply: "reject" }).pipe(run)
      yield* Fiber.await(again)
    }),
  )

  it.live("reject reply still fails the ask and persists nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const run = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))

      const session = yield* createSession.pipe(run)
      const requestID = PermissionID.ascending()
      const fiber = yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        return yield* permission.ask({
          id: requestID,
          sessionID: session.id,
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: ["rm -rf /"],
          ruleset: [],
        })
      }).pipe(run, Effect.forkScoped)

      yield* waitForPending(1).pipe(run)
      yield* PermissionPersist.replyAndPersist({ requestID, reply: "reject", message: "too dangerous" }).pipe(run)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.CorrectedError)
      expect(yield* sessionPermission(session.id).pipe(run)).toEqual([])
    }),
  )

  it.live("replyAndPersist is a no-op for an unknown request id", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const run = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))

      const session = yield* createSession.pipe(run)
      yield* PermissionPersist.replyAndPersist({ requestID: PermissionID.ascending(), reply: "always" }).pipe(run)
      expect(yield* sessionPermission(session.id).pipe(run)).toEqual([])
    }),
  )
})
