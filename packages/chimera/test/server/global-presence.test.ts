import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { Server } from "../../src/server/server"
import { disposeAllInstances } from "../fixture/fixture"

void Log.init({ print: false })

const original = {
  experimental: Flag.OPENCODE_EXPERIMENTAL_HTTPAPI,
  hono: Flag.OPENCODE_SERVER_HONO,
  password: Flag.OPENCODE_SERVER_PASSWORD,
  username: Flag.OPENCODE_SERVER_USERNAME,
}

function app(effect: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = effect
  Flag.OPENCODE_SERVER_HONO = !effect
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  return Server.Default().app
}

function post(app_: ReturnType<typeof app>, body: unknown, contentType = "application/json") {
  return app_.request("/global/presence", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original.experimental
  Flag.OPENCODE_SERVER_HONO = original.hono
  Flag.OPENCODE_SERVER_PASSWORD = original.password
  Flag.OPENCODE_SERVER_USERNAME = original.username
  await disposeAllInstances()
})

describe("global presence route", () => {
  test("records presence and keeps bodies aligned across Hono and HttpApi", async () => {
    const body = { directories: ["/tmp/does-not-need-to-exist"] }
    const hono = await post(app(false), body)
    const httpApi = await post(app(true), body)

    expect(hono.status).toBe(200)
    expect(httpApi.status).toBe(200)
    expect(await hono.json()).toEqual({ ok: true })
    expect(await httpApi.json()).toEqual({ ok: true })
  })

  test("accepts an empty directory list on both backends", async () => {
    for (const backend of [app(false), app(true)]) {
      const response = await post(backend, { directories: [] })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
    }
  })

  test("rejects malformed payloads with 400 on both backends", async () => {
    for (const body of ["{", JSON.stringify({ directories: "not-an-array" }), JSON.stringify({})]) {
      const hono = await post(app(false), body)
      const httpApi = await post(app(true), body)
      expect(hono.status).toBe(400)
      expect(httpApi.status).toBe(400)
    }
  })

  test("publishes the global.presence operation in both OpenAPI contracts", async () => {
    const hono = await Server.openapiHono()
    const effect = OpenApi.fromApi(PublicApi)

    expect(hono.paths["/global/presence"]?.post?.operationId).toBe("global.presence")
    expect(hono.paths["/global/presence"]?.post?.responses?.[400]).toBeDefined()
    expect(effect.paths["/global/presence"]?.post?.operationId).toBe("global.presence")
    expect(effect.paths["/global/presence"]?.post?.responses?.[400]).toBeDefined()
  })
})
