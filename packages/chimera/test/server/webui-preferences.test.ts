import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { WebUIPreferences } from "@/server/webui-preferences"
import { Storage } from "@/storage/storage"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

function memoryStorage(seed?: unknown) {
  return Layer.effect(
    Storage.Service,
    Effect.sync(() => {
      const values = new Map<string, unknown>()
      if (seed !== undefined) values.set("global/webui_preferences", structuredClone(seed))
      const path = (key: string[]) => key.join("/")
      return Storage.Service.of({
        remove: (key) => Effect.sync(() => void values.delete(path(key))),
        read: <T>(key: string[]) =>
          Effect.suspend(() => {
            const value = values.get(path(key))
            if (value === undefined) {
              return Effect.fail(new Storage.NotFoundError({ message: `Resource not found: ${path(key)}` }))
            }
            return Effect.succeed(structuredClone(value) as T)
          }),
        update: <T>(key: string[], fn: (draft: T) => void) =>
          Effect.suspend(() => {
            const value = values.get(path(key))
            if (value === undefined) {
              return Effect.fail(new Storage.NotFoundError({ message: `Resource not found: ${path(key)}` }))
            }
            const draft = structuredClone(value) as T
            fn(draft)
            values.set(path(key), structuredClone(draft))
            return Effect.succeed(draft)
          }),
        write: (key, content) => Effect.sync(() => void values.set(path(key), structuredClone(content))),
        list: (prefix) =>
          Effect.sync(() =>
            [...values.keys()]
              .filter((key) => key.startsWith(path(prefix)))
              .map((key) => key.split("/")),
          ),
      })
    }),
  )
}

const serviceLayer = WebUIPreferences.layer.pipe(Layer.provide(memoryStorage()))
const invalidLayer = WebUIPreferences.layer.pipe(
  Layer.provide(memoryStorage({ schemaVersion: 1, revision: -1, initialized: false, preferences: {} })),
)
const it = testEffect(serviceLayer)
const itInvalid = testEffect(invalidLayer)

function update(revision: number, presetId: string) {
  return new WebUIPreferences.Update({
    revision,
    preferences: new WebUIPreferences.Preferences({ appearance: { presetId, colorMode: "dark" } }),
  })
}

function preferenceEvent() {
  return new Promise<GlobalEvent>((resolve) => {
    const listener = (event: GlobalEvent) => {
      if (event.payload.type !== "global.preferences.updated") return
      GlobalBus.off("event", listener)
      resolve(event)
    }
    GlobalBus.on("event", listener)
  })
}

describe("WebUI preferences service", () => {
  it.live("returns the uninitialized revision zero snapshot", () =>
    Effect.gen(function* () {
      const preferences = yield* WebUIPreferences.Service
      expect(yield* preferences.get()).toEqual({
        schemaVersion: 1,
        revision: 0,
        initialized: false,
        preferences: {},
      })
    }),
  )

  it.live("persists successful updates and publishes the full snapshot", () =>
    Effect.gen(function* () {
      const preferences = yield* WebUIPreferences.Service
      const event = preferenceEvent()
      const snapshot = yield* preferences.update(update(0, "chimera"))

      expect(snapshot).toEqual({
        schemaVersion: 1,
        revision: 1,
        initialized: true,
        preferences: { appearance: { presetId: "chimera", colorMode: "dark" } },
      })
      expect(yield* preferences.get()).toEqual(snapshot)
      expect(yield* Effect.promise(() => event)).toMatchObject({
        directory: "global",
        payload: { type: "global.preferences.updated", properties: snapshot },
      })
    }),
  )

  it.live("rejects stale revisions without changing the persisted snapshot", () =>
    Effect.gen(function* () {
      const preferences = yield* WebUIPreferences.Service
      const first = yield* preferences.update(update(0, "first"))
      const conflict = yield* preferences.update(update(0, "stale")).pipe(Effect.flip)

      expect(conflict).toMatchObject({
        name: "WebUIPreferencesRevisionConflictError",
        data: { expectedRevision: 0, actualRevision: 1 },
      })
      expect(yield* preferences.get()).toEqual(first)
    }),
  )

  it.live("allows exactly one concurrent update for the same revision", () =>
    Effect.gen(function* () {
      const preferences = yield* WebUIPreferences.Service
      const exits = yield* Effect.all(
        [preferences.update(update(0, "first")).pipe(Effect.exit), preferences.update(update(0, "second")).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      )

      expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(exits.filter(Exit.isFailure)).toHaveLength(1)
      expect((yield* preferences.get()).revision).toBe(1)
    }),
  )

  itInvalid.live("does not silently reset invalid persisted data", () =>
    Effect.gen(function* () {
      const preferences = yield* WebUIPreferences.Service
      expect(Exit.isFailure(yield* preferences.get().pipe(Effect.exit))).toBe(true)
    }),
  )
})

const original = {
  experimental: Flag.OPENCODE_EXPERIMENTAL_HTTPAPI,
  password: Flag.OPENCODE_SERVER_PASSWORD,
  username: Flag.OPENCODE_SERVER_USERNAME,
}

function app(effect: boolean, password?: string) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = effect
  Flag.OPENCODE_SERVER_PASSWORD = password
  Flag.OPENCODE_SERVER_USERNAME = "chimera"
  return Server.Default().app
}

function effectApp(password: string) {
  const handler = HttpRouter.toWebHandler(
    ExperimentalHttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: password,
            OPENCODE_SERVER_USERNAME: "chimera",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(path: string, init?: RequestInit) {
      return handler(new Request(new URL(path, "http://localhost"), init), ExperimentalHttpApiServer.context)
    },
  }
}

function authorization() {
  return `Basic ${Buffer.from("chimera:secret").toString("base64")}`
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original.experimental
  Flag.OPENCODE_SERVER_PASSWORD = original.password
  Flag.OPENCODE_SERVER_USERNAME = original.username
  await disposeAllInstances()
})

describe("WebUI preferences routes", () => {
  test("keeps GET and stale PUT status and bodies aligned across Hono and HttpApi", async () => {
    const honoGet = await app(false).request("/global/preferences")
    const httpApiGet = await app(true).request("/global/preferences")
    expect(honoGet.status).toBe(200)
    expect(httpApiGet.status).toBe(200)
    const snapshot = await honoGet.json()
    expect(await httpApiGet.json()).toEqual(snapshot)

    const body = JSON.stringify({ revision: snapshot.revision + 1, preferences: snapshot.preferences })
    const init = { method: "PUT", headers: { "content-type": "application/json" }, body }
    const honoConflict = await app(false).request("/global/preferences", init)
    const httpApiConflict = await app(true).request("/global/preferences", init)

    expect(honoConflict.status).toBe(409)
    expect(httpApiConflict.status).toBe(409)
    expect(await honoConflict.json()).toEqual({
      name: "WebUIPreferencesRevisionConflictError",
      data: { expectedRevision: snapshot.revision + 1, actualRevision: snapshot.revision },
    })
    expect(await httpApiConflict.json()).toEqual({
      name: "WebUIPreferencesRevisionConflictError",
      data: { expectedRevision: snapshot.revision + 1, actualRevision: snapshot.revision },
    })
  })

  test("keeps malformed and invalid PUT validation responses aligned across Hono and HttpApi", async () => {
    const headers = { "content-type": "application/json" }
    for (const body of ["{", JSON.stringify({ revision: -1, preferences: {} })]) {
      const init = { method: "PUT", headers, body }
      const hono = await app(false).request("/global/preferences", init)
      const httpApi = await app(true).request("/global/preferences", init)

      expect(hono.status).toBe(400)
      expect(httpApi.status).toBe(400)
      expect(await httpApi.text()).toBe(await hono.text())
    }
  })

  test("keeps PUT content-type validation aligned across Hono and HttpApi", async () => {
    const body = JSON.stringify({ revision: -1, preferences: {} })
    const headers = [undefined, { "content-type": "text/plain" }, { "content-type": "application/json" }]

    for (const nextHeaders of headers) {
      const init = { method: "PUT", headers: nextHeaders, body }
      const hono = await app(false).request("/global/preferences", init)
      const httpApi = await app(true).request("/global/preferences", init)

      expect({ status: httpApi.status, body: await httpApi.text() }).toEqual({
        status: hono.status,
        body: await hono.text(),
      })
    }
  })

  test("requires the same Basic Auth credentials on both backends", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "chimera"
    const apps = [app(false, "secret"), effectApp("secret")]
    const invalidPut = {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: -1, preferences: {} }),
    }

    for (const backend of apps) {
      expect((await backend.request("/global/preferences")).status).toBe(401)
      expect(
        (
          await backend.request("/global/preferences", {
            headers: { authorization: authorization() },
          })
        ).status,
      ).toBe(200)
      expect((await backend.request("/global/preferences", invalidPut)).status).toBe(401)
      expect(
        (
          await backend.request("/global/preferences", {
            ...invalidPut,
            headers: { ...invalidPut.headers, authorization: authorization() },
          })
        ).status,
      ).toBe(400)
    }
  })

  test("publishes the frozen operation IDs and 400/409 responses in both OpenAPI contracts", async () => {
    const hono = await Server.openapiHono()
    const effect = OpenApi.fromApi(PublicApi)

    expect(hono.paths["/global/preferences"]?.get?.operationId).toBe("global.preferences.get")
    expect(hono.paths["/global/preferences"]?.put?.operationId).toBe("global.preferences.update")
    expect(hono.paths["/global/preferences"]?.put?.responses?.[409]).toBeDefined()
    expect(hono.paths["/global/preferences"]?.put?.responses?.[400]).toBeDefined()
    expect(effect.paths["/global/preferences"]?.get?.operationId).toBe("global.preferences.get")
    expect(effect.paths["/global/preferences"]?.put?.operationId).toBe("global.preferences.update")
    expect(effect.paths["/global/preferences"]?.put?.responses?.[409]).toBeDefined()
    expect(effect.paths["/global/preferences"]?.put?.responses?.[400]).toBeDefined()
  })
})
