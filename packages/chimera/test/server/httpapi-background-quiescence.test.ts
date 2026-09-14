import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { BackgroundJob, type BackgroundJobLimitError } from "../../src/agent/background-job"
import { WithInstance } from "../../src/project/with-instance"
import { Session } from "../../src/session/session"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

type Quiescence = { quiescent: boolean; running: number; pendingDeliveries: number }

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

function json<T>(response: Response) {
  if (response.status !== 200) throw new Error(`expected 200, got ${response.status}: ${response.statusText}`)
  return response.json() as Promise<T>
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("session background quiescence HttpApi", () => {
  // Runs an async test with a fresh tmpdir, then the scenario body inside an
  // Effect scope that builds Session.defaultLayer through the SHARED module
  // memoMap (the one the app routes use). Jobs started here land in the same
  // in-memory per-directory registry the route handler reads.
  function scenario(
    name: string,
    body: (input: {
      directory: string
      server: ReturnType<typeof app>
      run: <A, E>(fx: Effect.Effect<A, E, BackgroundJob.Service>) => Effect.Effect<A, E>
      startJob: (id: string, ownerSessionId: string, gate: Deferred.Deferred<void>) => Effect.Effect<unknown, BackgroundJobLimitError>
      markDelivered: (id: string) => Effect.Effect<unknown>
      getQuiescence: (sessionID: string, timeout?: number) => Effect.Effect<Quiescence, unknown>
      request: (path: string) => Promise<Response>
    }) => Effect.Effect<void, unknown, Scope.Scope>,
  ) {
    test(name, async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
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
            const startJob = (id: string, ownerSessionId: string, gate: Deferred.Deferred<void>) =>
              run(
                BackgroundJob.Service.use((jobsService) =>
                  jobsService.start({
                    id,
                    ownerSessionId,
                    run: Deferred.await(gate).pipe(Effect.as("done")),
                  }),
                ),
              )
            const markDelivered = (id: string) =>
              run(BackgroundJob.Service.use((jobsService) => jobsService.markDelivered(id)))
            const headers = { "x-chimera-directory": tmp.path }
            const request = (path: string) => server.request(path, { headers })
            const getQuiescence = (sessionID: string, timeout?: number) =>
              Effect.tryPromise(async () => {
                const path =
                  pathFor(SessionPaths.backgroundQuiescence, { sessionID }) +
                  (timeout === undefined ? "" : `?timeout=${timeout}`)
                const response = await server.request(path, { headers })
                if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`)
                return json<Quiescence>(response)
              })
            return yield* body({ directory: tmp.path, server, run, startJob, markDelivered, getQuiescence, request })
          }),
        ),
      )
    })
  }

  scenario("returns quiescent immediately when the session owns no background jobs", ({ getQuiescence }) =>
    Effect.gen(function* () {
      expect(yield* getQuiescence("ses-owner")).toEqual({ quiescent: true, running: 0, pendingDeliveries: 0 })
    }),
  )

  scenario("tracks a running owned job through settle to delivered", ({ startJob, markDelivered, getQuiescence }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()

      // Owned running job -> quiescent:false with a running count.
      yield* startJob("job-1", "ses-owner", gate)
      expect(yield* getQuiescence("ses-owner", 50)).toEqual({ quiescent: false, running: 1, pendingDeliveries: 0 })

      // Settle the job but leave delivery pending: still not quiescent
      // (the key settle-to-delivered window).
      yield* Deferred.succeed(gate, void 0)
      yield* Effect.sleep("50 millis")
      expect(yield* getQuiescence("ses-owner", 50)).toEqual({ quiescent: false, running: 0, pendingDeliveries: 1 })

      // Delivery completes -> quiescent.
      yield* markDelivered("job-1")
      expect(yield* getQuiescence("ses-owner", 1000)).toEqual({ quiescent: true, running: 0, pendingDeliveries: 0 })
    }),
  )

  scenario("ignores background jobs owned by other sessions", ({ startJob, getQuiescence }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      yield* startJob("job-other", "ses-other", gate)
      // A running job owned by another session must not block this owner.
      expect(yield* getQuiescence("ses-owner", 100)).toEqual({ quiescent: true, running: 0, pendingDeliveries: 0 })
    }),
  )

  scenario("clamps very small timeouts and rejects non-numeric timeouts", ({ startJob, request }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      yield* startJob("job-clamp", "ses-owner", gate)
      const path = pathFor(SessionPaths.backgroundQuiescence, { sessionID: "ses-owner" })

      // timeout=0 clamps to the 1ms floor: returns immediately, never blocks.
      yield* Effect.tryPromise(async () => {
        const clamped = await json<Quiescence>(await request(`${path}?timeout=0`))
        expect(clamped).toEqual({ quiescent: false, running: 1, pendingDeliveries: 0 })
      })
      // Negative timeouts clamp the same way (no 400, no hang).
      yield* Effect.tryPromise(async () => {
        const negative = await request(`${path}?timeout=-5`)
        expect(negative.status).toBe(200)
      })
      // Non-numeric timeouts decode to NaN and are treated as an immediate
      // (clamped) timeout: no 500, no hang, well-formed body.
      yield* Effect.tryPromise(async () => {
        const invalid = await request(`${path}?timeout=abc`)
        expect(invalid.status).toBe(200)
        const body = await json<Quiescence>(invalid)
        expect(body.quiescent).toBe(false)
        expect(body.running).toBe(1)
        expect(body.pendingDeliveries).toBe(0)
      })
    }),
  )
})