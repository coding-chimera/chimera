import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { Server } from "../../src/server/server"
import { disposeAllInstances } from "../fixture/fixture"

void Log.init({ print: false })

const projectKey = Hash.fast(`/artifact-route-project\u0000/artifact-route-project`).slice(0, 24)
const sessionHashValue = Hash.fast("ses_artifact_route").slice(0, 24)
const artifactRoot = path.join(Global.Path.data, "browser-artifacts", projectKey, sessionHashValue)
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const secretPath = path.join(Global.Path.data, "browser-artifacts", "secret.png")

const original = {
  experimental: Flag.OPENCODE_EXPERIMENTAL_HTTPAPI,
  hono: Flag.OPENCODE_SERVER_HONO,
  password: Flag.OPENCODE_SERVER_PASSWORD,
}

function app(effect: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = effect
  Flag.OPENCODE_SERVER_HONO = !effect
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  return Server.Default().app
}

const url = (filename: string) => `/global/browser-artifact/${projectKey}/${sessionHashValue}/${filename}`

async function setup() {
  await fs.mkdir(artifactRoot, { recursive: true })
  await Bun.write(path.join(artifactRoot, "shot-1.png"), pngBytes)
  await Bun.write(path.join(artifactRoot, "note.txt"), "not an image")
  await Bun.write(secretPath, new Uint8Array([1, 2, 3]))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original.experimental
  Flag.OPENCODE_SERVER_HONO = original.hono
  Flag.OPENCODE_SERVER_PASSWORD = original.password
  await disposeAllInstances()
})

afterAll(async () => {
  await fs.rm(path.join(Global.Path.data, "browser-artifacts"), { recursive: true, force: true })
})

describe("global browser-artifact route", () => {
  test("serves an existing png with its content type on both backends", async () => {
    await setup()
    // Build each backend right before its request: the Flag switches are read at
    // app construction, so eagerly building both would leave a stale-flag app.
    for (const effect of [false, true]) {
      const response = await app(effect).request(url("shot-1.png"))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("image/png")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes)
    }
  })

  test("answers 404 for missing files, unknown extensions, and traversal attempts", async () => {
    await setup()
    const targets = [
      url("missing.png"),
      url("note.txt"),
      `/global/browser-artifact/${projectKey}/${sessionHashValue}/..%2F..%2F..%2Fsecret.png`,
      `/global/browser-artifact/${projectKey}/..%2F${sessionHashValue}/shot-1.png`,
    ]
    for (const target of targets) {
      for (const effect of [false, true]) {
        const response = await app(effect).request(target)
        expect(response.status).toBe(404)
      }
    }
    // A traversal segment in the project-hash position escapes the route shape and
    // is rejected by shared server middleware before the handler; it must never
    // serve content either.
    for (const effect of [false, true]) {
      const response = await app(effect).request(
        `/global/browser-artifact/..%2F..%2F..%2F..%2Fetc/passwd/x/y.png`,
      )
      expect(response.status).not.toBe(200)
    }
    const leaked = await fs.readFile(secretPath)
    expect(leaked.length).toBe(3)
  })

  test("publishes the global.browserArtifact operation in both OpenAPI contracts", async () => {
    const hono = await Server.openapiHono()
    const effect = OpenApi.fromApi(PublicApi)

    expect(hono.paths["/global/browser-artifact/{projectHash}/{sessionHash}/{filename}"]?.get?.operationId).toBe(
      "global.browserArtifact",
    )
    expect(effect.paths["/global/browser-artifact/{projectHash}/{sessionHash}/{filename}"]?.get?.operationId).toBe(
      "global.browserArtifact",
    )
  })
})
