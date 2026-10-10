import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { ProcessPaths } from "../../src/server/routes/instance/httpapi/groups/process"
import { ProcessRegistry } from "../../src/chimera/process-registry"
import { SessionID } from "../../src/contracts/session-ids"
import { DatabaseConnection, getDatabasePath } from "../../src/graph"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

function app(experimental = true) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

// The registry store only opens an existing project DB, so seed the chimera
// database file the same way test/chimera/process-registry.test.ts does.
function ensureRegistryDb(root: string) {
  DatabaseConnection.initialize(getDatabasePath(root)).close()
}

const headers = (dir: string) => ({ "x-chimera-directory": dir })

describe("process registry routes", () => {
  test("documents process.list and the process.changed event in the HttpApi spec", async () => {
    const spec = await Server.openapi()
    const operation = spec.paths["/process"]?.get
    expect(operation?.operationId).toBe("process.list")
    // The registry event is registered on module import and must ride the
    // shared Event union that feeds the /event SSE stream and the SDK.
    expect(JSON.stringify(spec)).toContain("process.changed")
  })

  test("returns an empty list when no processes are registered", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const response = await app().request(ProcessPaths.list, { headers: headers(tmp.path) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test("lists active processes joined with the session title and agent", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    ensureRegistryDb(tmp.path)

    const created = await app().request("/session", {
      method: "POST",
      headers: { ...headers(tmp.path), "content-type": "application/json" },
      body: JSON.stringify({ title: "process demo" }),
    })
    expect(created.status).toBe(200)
    const session = await created.json()

    const entry = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: session.id,
      pid: process.pid,
      command: "sleep 25",
      cwd: tmp.path,
    })
    expect(entry).toBeDefined()
    if (!entry) return

    const response = await app().request(ProcessPaths.list, { headers: headers(tmp.path) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      id: entry.id,
      sessionID: session.id,
      pid: process.pid,
      pgid: null,
      command: "sleep 25",
      cwd: tmp.path,
      status: "running",
      exitCode: null,
      exitedAt: null,
      sessionTitle: "process demo",
      agent: null,
    })
    expect(body[0].startedAt).toStartWith("20")
  })

  test("degrades the session join to null when the session is gone", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    ensureRegistryDb(tmp.path)
    const entry = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: SessionID.descending(),
      pid: process.pid,
      command: "sleep 25",
    })
    expect(entry).toBeDefined()

    const response = await app().request(ProcessPaths.list, { headers: headers(tmp.path) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveLength(1)
    expect(body[0].sessionTitle).toBeNull()
    expect(body[0].agent).toBeNull()
  })

  test("matches the legacy Hono response body", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    ensureRegistryDb(tmp.path)
    await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: SessionID.descending(),
      pid: process.pid,
      command: "parity probe",
    })

    const hono = await app(false).request(ProcessPaths.list, { headers: headers(tmp.path) })
    const httpapi = await app().request(ProcessPaths.list, { headers: headers(tmp.path) })
    expect(hono.status).toBe(200)
    expect(httpapi.status).toBe(200)
    expect(await httpapi.json()).toEqual(await hono.json())
  })
})
