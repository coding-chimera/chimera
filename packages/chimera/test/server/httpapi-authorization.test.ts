import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"
import { PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "../../src/server/shared/pty-ticket"

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
    )
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({}))),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationRouterMiddleware.layer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })
const secretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "opencode" })
const colonSecretLayer = ServerAuth.Config.layer({ password: Option.some("secret:with:colon"), username: "opencode" })
const unicodeSecretLayer = ServerAuth.Config.layer({ password: Option.some("päss🔐"), username: "opencode" })
const kitSecretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "kit" })

const it = testEffect(apiLayer.pipe(Layer.provide(noAuthLayer)))
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))
const itColonSecret = testEffect(apiLayer.pipe(Layer.provide(colonSecretLayer)))
const itUnicodeSecret = testEffect(apiLayer.pipe(Layer.provide(unicodeSecretLayer)))
const itKitSecret = testEffect(apiLayer.pipe(Layer.provide(kitSecretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

// A raw connect route registered with the same constant used by dispatch, a
// static decoy whose URL pathname matches the legacy connect regex but whose
// matched route is a different path, and a catch-all so variant paths still
// reach a route and exercise the credential check.
const rawRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", PTY_CONNECT_PATH, () => Effect.succeed(HttpServerResponse.text("connect")))
    yield* router.add("GET", "/pty/static/connect", () => Effect.succeed(HttpServerResponse.text("decoy")))
    yield* router.add("*", "/*", () => Effect.succeed(HttpServerResponse.text("fallback")))
  }),
)

const connectLayer = HttpRouter.serve(
  Layer.mergeAll(HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers)), rawRoutes).pipe(
    Layer.provide(authorizationRouterMiddleware.layer),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const itConnectSecret = testEffect(connectLayer.pipe(Layer.provide(secretLayer)))

describe("HttpApi authorization middleware", () => {
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("opencode", "wrong") }),
          getProbe({ authorization: basic("opencode", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"]).toBe('Basic realm="Secure Area"')
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"]).toBe('Basic realm="Secure Area"')
      expect(good.status).toBe(200)
      expect(badPassword.status).toBe(401)
      expect(good.status).toBe(200)
    }),
  )
  itColonSecret.live("accepts passwords containing colons in basic auth and auth token query credentials", () =>
    Effect.gen(function* () {
      const password = "secret:with:colon"
      const [header, query] = yield* Effect.all(
        [
          getProbe({ authorization: basic("opencode", password) }),
          HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("opencode", password))}`),
        ],
        { concurrency: "unbounded" },
      )

      expect(header.status).toBe(200)
      expect(query.status).toBe(200)
    }),
  )

  itUnicodeSecret.live("accepts UTF-8 basic auth credentials", () =>
    Effect.gen(function* () {
      const response = yield* getProbe({ authorization: basic("opencode", "päss🔐") })

      expect(response.status).toBe(200)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("opencode", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("prefers auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("opencode", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when auth token query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-base64")

      expect(response.status).toBe(401)
    }),
  )
})

describe("HttpApi authorization PTY connect skip", () => {
  const request = (path: string, headers?: Record<string, string>) =>
    HttpClientRequest.get(path).pipe(
      headers ? HttpClientRequest.setHeaders(headers) : (value) => value,
      HttpClient.execute,
    )

  itConnectSecret.live("skips credentials only for the dispatched connect route with a ticket", () =>
    Effect.gen(function* () {
      const [ticketed, unticketed] = yield* Effect.all(
        [
          request(`/pty/abc/connect?${PTY_CONNECT_TICKET_QUERY}=opaque`),
          request("/pty/abc/connect"),
        ],
        { concurrency: "unbounded" },
      )

      expect(ticketed.status).toBe(200)
      expect(yield* ticketed.text).toBe("connect")
      expect(unticketed.status).toBe(401)
    }),
  )

  itConnectSecret.live("does not skip a differently dispatched route that matches the connect pathname", () =>
    Effect.gen(function* () {
      const response = yield* request(`/pty/static/connect?${PTY_CONNECT_TICKET_QUERY}=opaque`)

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"]).toBe('Basic realm="Secure Area"')
    }),
  )

  itConnectSecret.live("enforces credentials for paths dispatched away from the connect route", () =>
    Effect.gen(function* () {
      const paths = [
        "/pty/abc/connect/extra?ticket=opaque",
        "/pty%2Fabc/connect?ticket=opaque",
        "/pty/abc/connect-token?ticket=opaque",
        "/probe?ticket=opaque",
      ]
      const responses = yield* Effect.all(paths.map((path) => request(path)), { concurrency: "unbounded" })

      expect(responses.map((response) => response.status)).toEqual(paths.map(() => 401))
    }),
  )

  itConnectSecret.live("follows the dispatched route for case and trailing-slash variants", () =>
    Effect.gen(function* () {
      const paths = [
        "/PTY/abc/connect?ticket=opaque",
        "/pty/ABC/connect?ticket=opaque",
        "/pty/abc/connect/?ticket=opaque",
      ]
      const responses = yield* Effect.all(paths.map((path) => request(path)), { concurrency: "unbounded" })

      // The Effect router matches these to the same connect route, so the
      // middleware skips credentials exactly where dispatch sends the request;
      // the connect handler still consumes and validates the ticket.
      expect(responses.map((response) => response.status)).toEqual(paths.map(() => 200))
    }),
  )

  itConnectSecret.live("still accepts a ticketed connect request carrying valid credentials", () =>
    Effect.gen(function* () {
      const response = yield* request(`/pty/abc/connect?${PTY_CONNECT_TICKET_QUERY}=opaque`, {
        authorization: basic("opencode", "secret"),
      })

      expect(response.status).toBe(200)
    }),
  )
})
