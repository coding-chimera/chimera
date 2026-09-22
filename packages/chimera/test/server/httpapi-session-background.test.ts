import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { BackgroundJob } from "../../src/agent/background-job"
import { WithInstance } from "../../src/project/with-instance"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, {
    // Shared module memoMap so jobs started from the test share the same
    // in-memory per-directory registry the route handler reads.
    memoMap,
    disableLogger: true,
  }).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        ExperimentalHttpApiServer.context,
      )
    },
  }
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental session background HttpApi", () => {
  function scenario(
    name: string,
    body: (input: {
      directory: string
      run: <A, E>(fx: Effect.Effect<A, E, BackgroundJob.Service>) => Effect.Effect<A, E>
      startJob: (input: {
        id: string
        ownerSessionId: string
        background: boolean
        gate: Deferred.Deferred<void>
      }) => Effect.Effect<unknown>
      promote: (id: string) => Effect.Effect<unknown>
      startPlainJob: (id: string, ownerSessionId: string, gate: Deferred.Deferred<void>) => Effect.Effect<unknown>
      post: (sessionID: string) => Promise<Response>
      get: (path: string) => Promise<Response>
    }) => Effect.Effect<void, unknown, Scope.Scope>,
    config?: Record<string, unknown>,
  ) {
    test(name, async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false, ...config } })
      const server = app()
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            const ctx = yield* Layer.buildWithMemoMap(BackgroundJob.defaultLayer, memoMap, scope)
            const jobs = Context.get(ctx, BackgroundJob.Service)
            const run = <A, E>(fx: Effect.Effect<A, E, BackgroundJob.Service>) =>
              Effect.promise(async () =>
                WithInstance.provide({
                  directory: tmp.path,
                  fn: () => Effect.runPromise(fx.pipe(Effect.provideService(BackgroundJob.Service, jobs))),
                }),
              )
            const startJob = (input: {
              id: string
              ownerSessionId: string
              background: boolean
              gate: Deferred.Deferred<void>
            }) =>
              run(
                BackgroundJob.Service.use((svc) =>
                  svc.start({
                    id: input.id,
                    type: "task",
                    ownerSessionId: input.ownerSessionId,
                    metadata: { background: input.background },
                    run: Deferred.await(input.gate).pipe(Effect.as("done")),
                  }),
                ),
              )
            const promote = (id: string) => run(BackgroundJob.Service.use((svc) => svc.promote(id)))
            const startPlainJob = (id: string, ownerSessionId: string, gate: Deferred.Deferred<void>) =>
              run(
                BackgroundJob.Service.use((svc) =>
                  svc.start({
                    id,
                    ownerSessionId,
                    run: Deferred.await(gate).pipe(Effect.as("done")),
                  }),
                ),
              )
            const headers = { "x-chimera-directory": tmp.path }
            const post = (sessionID: string) =>
              server.request(pathFor(ExperimentalPaths.sessionBackground, { sessionID }), {
                method: "POST",
                headers,
              })
            const get = (path: string) => server.request(path, { headers })
            return yield* body({ directory: tmp.path, run, startJob, promote, startPlainJob, post, get })
          }),
        ),
      )
    })
  }

  scenario("promotes running foreground task jobs owned by the session", ({ run, startJob, post }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      yield* startJob({ id: "ses_child_fg", ownerSessionId: "ses_parent", background: false, gate })

      const response = yield* Effect.tryPromise(() => post("ses_parent"))
      expect(response.status).toBe(200)
      yield* Effect.tryPromise(async () => {
        expect(await response.json()).toBe(true)
      })

      const promoted = yield* run(BackgroundJob.Service.use((svc) => svc.get("ses_child_fg")))
      expect(promoted?.status).toBe("running")
      expect(promoted?.metadata?.background).toBe(true)

      yield* Deferred.succeed(gate, undefined)
    }),
  )

  scenario("ignores background jobs, other sessions' jobs, and non-task jobs", ({ run, startJob, startPlainJob, post }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      // Already-background job owned by the session.
      yield* startJob({ id: "ses_child_bg", ownerSessionId: "ses_parent", background: true, gate })
      // Foreground job owned by a different session.
      yield* startJob({ id: "ses_other_fg", ownerSessionId: "ses_other", background: false, gate })
      // Non-task foreground job owned by the session (engine-level, no type).
      yield* startPlainJob("plain_job", "ses_parent", gate)

      const response = yield* Effect.tryPromise(() => post("ses_parent"))
      expect(response.status).toBe(200)
      yield* Effect.tryPromise(async () => {
        expect(await response.json()).toBe(false)
      })

      const bg = yield* run(BackgroundJob.Service.use((svc) => svc.get("ses_child_bg")))
      expect(bg?.metadata?.background).toBe(true)
      const other = yield* run(BackgroundJob.Service.use((svc) => svc.get("ses_other_fg")))
      expect(other?.metadata?.background).toBe(false)

      yield* Deferred.succeed(gate, undefined)
    }),
  )

  scenario("returns false when nothing is running and on repeated calls after promotion", ({ startJob, post }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const empty = yield* Effect.tryPromise(() => post("ses_parent"))
      expect(empty.status).toBe(200)
      yield* Effect.tryPromise(async () => {
        expect(await empty.json()).toBe(false)
      })

      yield* startJob({ id: "ses_child_fg2", ownerSessionId: "ses_parent", background: false, gate })
      const first = yield* Effect.tryPromise(() => post("ses_parent"))
      yield* Effect.tryPromise(async () => {
        expect(await first.json()).toBe(true)
      })
      // Second call: the job is background now, nothing left to promote.
      const second = yield* Effect.tryPromise(() => post("ses_parent"))
      yield* Effect.tryPromise(async () => {
        expect(await second.json()).toBe(false)
      })

      yield* Deferred.succeed(gate, undefined)
    }),
  )

  scenario(
    "kill-switch off: returns false and leaves the foreground job untouched",
    ({ run, startJob, post }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        yield* startJob({ id: "ses_child_fg3", ownerSessionId: "ses_parent", background: false, gate })

        const response = yield* Effect.tryPromise(() => post("ses_parent"))
        expect(response.status).toBe(200)
        yield* Effect.tryPromise(async () => {
          expect(await response.json()).toBe(false)
        })

        const job = yield* run(BackgroundJob.Service.use((svc) => svc.get("ses_child_fg3")))
        expect(job?.metadata?.background).toBe(false)

        yield* Deferred.succeed(gate, undefined)
      }),
    { delegation: { background_subagents: false } },
  )

  scenario("capabilities reports backgroundSubagents from the kill-switch", ({ get }) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() => get(ExperimentalPaths.capabilities))
      expect(response.status).toBe(200)
      yield* Effect.tryPromise(async () => {
        expect(await response.json()).toEqual({ backgroundSubagents: true })
      })
    }),
  )

  scenario(
    "capabilities reports backgroundSubagents false when the kill-switch is off",
    ({ get }) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() => get(ExperimentalPaths.capabilities))
        expect(response.status).toBe(200)
        yield* Effect.tryPromise(async () => {
          expect(await response.json()).toEqual({ backgroundSubagents: false })
        })
      }),
    { delegation: { background_subagents: false } },
  )
})
