import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import * as Log from "@opencode-ai/core/util/log"
import { HttpRouter } from "effect/unstable/http"
import { IntegrationPaths } from "../../src/server/routes/instance/httpapi/groups/v2/integration"
import { CredentialPaths } from "../../src/server/routes/instance/httpapi/groups/v2/credential"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

// L5.4b connector-auth endpoints over the fork httpapi tree, backed by the
// vendored core Integration/Credential trunk on the isolated chimera-v2.db
// (decision L5.0②: the upstream migration lineage and the fork chimera.db
// never meet; the test preload additionally redirects XDG_DATA_HOME into a
// per-process tmp dir, so the v2 db lands there, never in a real home).
// Dual parity: the /api/* forward in routes/instance/index.ts is unconditional,
// so the legacy Hono app and the default effect httpapi backend serve the
// identical handler — asserted below against both Server.Legacy and
// Server.Default.

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, {
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

function pathFor(route: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), route)
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

interface IntegrationJSON {
  id: string
  name: string
  methods: Array<Record<string, unknown>>
  connections: Array<{ type: string; id?: string; label?: string }>
}

async function listIntegrations(request: (input: string, init?: RequestInit) => Promise<Response>) {
  const response = await request(IntegrationPaths.list)
  expect(response.status).toBe(200)
  return (await response.json()) as IntegrationJSON[]
}

describe("v2 integration + credential HttpApi (L5.4b)", () => {
  test("lists the opencode integration with upstream brand methods", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app()
    const request = (input: string, init?: RequestInit) =>
      server.request(input, { ...init, headers: { "x-chimera-directory": tmp.path, ...init?.headers } })

    const integrations = await listIntegrations(request)
    const opencode = integrations.find((item) => item.id === "opencode")
    expect(opencode).toBeDefined()
    // Decision #7 brand pins: opencode integration ID, console method labels.
    expect(opencode?.name).toBe("OpenCode")
    expect(opencode?.methods).toEqual([
      { id: "device", type: "oauth", label: "OpenCode Console account" },
      { type: "key", label: "API key (service account)" },
    ])
    expect(opencode?.connections).toEqual([])

    const single = await request(pathFor(IntegrationPaths.get, { integrationID: "opencode" }))
    expect(single.status).toBe(200)
    expect(((await single.json()) as IntegrationJSON).id).toBe("opencode")
  })

  test("credential roundtrips through connect/key + credential endpoints on the isolated chimera-v2 db", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app()
    const request = (input: string, init?: RequestInit) =>
      server.request(input, { ...init, headers: { "x-chimera-directory": tmp.path, ...init?.headers } })

    const connect = await request(pathFor(IntegrationPaths.connectKey, { integrationID: "opencode" }), {
      method: "POST",
      body: JSON.stringify({ key: "test-secret", label: "Work" }),
    })
    expect(connect.status).toBe(204)

    const afterConnect = await listIntegrations(request)
    const connections = afterConnect.find((item) => item.id === "opencode")?.connections ?? []
    expect(connections).toHaveLength(1)
    expect(connections[0]).toMatchObject({ type: "credential", label: "Work" })
    const credentialID = connections[0]?.id
    expect(typeof credentialID).toBe("string")
    if (typeof credentialID !== "string") throw new Error("expected credential connection id")

    const relabel = await request(pathFor(CredentialPaths.update, { credentialID }), {
      method: "PATCH",
      body: JSON.stringify({ label: "Renamed" }),
    })
    expect(relabel.status).toBe(204)
    const afterRelabel = await listIntegrations(request)
    expect(afterRelabel.find((item) => item.id === "opencode")?.connections).toEqual([
      { type: "credential", id: credentialID, label: "Renamed" },
    ])

    const remove = await request(pathFor(CredentialPaths.remove, { credentialID }), { method: "DELETE" })
    expect(remove.status).toBe(204)
    const afterRemove = await listIntegrations(request)
    expect(afterRemove.find((item) => item.id === "opencode")?.connections).toEqual([])

    // Isolation: the trunk db is the dedicated chimera-v2.db inside the
    // per-process tmp data dir — never the production fork chimera.db.
    const v2Db = path.join(Global.Path.data, "chimera-v2.db")
    expect(Global.Path.data.startsWith(os.tmpdir())).toBe(true)
    expect(await Bun.file(v2Db).exists()).toBe(true)
    expect(await Bun.file(path.join(Global.Path.data, "chimera.db")).exists()).toBe(false)
  })

  test("connect/key with an unknown integration surfaces the upstream defect as 500", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app()
    const response = await server.request(pathFor(IntegrationPaths.connectKey, { integrationID: "acme" }), {
      method: "POST",
      headers: { "x-chimera-directory": tmp.path },
      body: JSON.stringify({ key: "nope" }),
    })
    // Byte-identical upstream core dies (`Effect.die("Key method not found")`)
    // when the integration has no key method; the fork endpoint keeps that
    // upstream parity (500 defect), not a mapped 400.
    expect(response.status).toBe(500)
  })

  test("legacy Hono and default backends both forward /api/integration to the same handler", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-chimera-directory": tmp.path }

    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
    const legacy = await Server.Legacy().app.request(IntegrationPaths.list, { headers })
    expect(legacy.status).toBe(200)
    const legacyBody = (await legacy.json()) as IntegrationJSON[]
    expect(legacyBody.some((item) => item.id === "opencode")).toBe(true)

    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    const modern = await Server.Default().app.request(IntegrationPaths.list, { headers })
    expect(modern.status).toBe(200)
    const modernBody = (await modern.json()) as IntegrationJSON[]
    expect(modernBody.some((item) => item.id === "opencode")).toBe(true)
  })
})
