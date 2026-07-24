import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
  return Server.Legacy().app
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("legacy Hono instance context", () => {
  test("uses the routed directory for path and text search", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (directory) => Bun.write(`${directory}/ambient-instance-route.txt`, "ambient-instance-route-marker"),
    })
    const headers = { "x-chimera-directory": tmp.path }

    const paths = await app().request("/path", { headers })
    const found = await app().request("/find?pattern=ambient-instance-route-marker", { headers })

    expect(paths.status).toBe(200)
    expect(await paths.json()).toMatchObject({ directory: tmp.path, worktree: tmp.path })
    expect(found.status).toBe(200)
    expect(JSON.stringify(await found.json())).toContain("ambient-instance-route.txt")
  })

  test("uses the routed project for experimental worktree listing", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const response = await app().request("/experimental/worktree", {
      headers: { "x-chimera-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test("disposes the routed instance and emits its directory", async () => {
    await using tmp = await tmpdir()
    const disposed = waitGlobalBusEventPromise({
      message: "timed out waiting for legacy instance disposal",
      predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === tmp.path,
    })

    const response = await app().request("/instance/dispose", {
      method: "POST",
      headers: { "x-chimera-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
    expect((await disposed).directory).toBe(tmp.path)
  })

  test("uses the routed project for project and workspace control reads", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-chimera-directory": tmp.path }

    const current = await app().request("/project/current", { headers })
    expect(current.status).toBe(200)
    const project = (await current.json()) as { id: string; worktree: string }
    expect(project.worktree).toBe(tmp.path)

    const adapter: WorkspaceAdapter = {
      name: "Routed Project Adapter",
      description: "Scoped to the routed project",
      configure: (info) => info,
      create: async () => {},
      remove: async () => {},
      target: () => ({ type: "local", directory: tmp.path }),
    }
    registerAdapter(project.id as Parameters<typeof registerAdapter>[0], "routed-project", adapter)

    const adapters = await app().request("/experimental/workspace/adapter", { headers })
    const workspaces = await app().request("/experimental/workspace", { headers })
    const status = await app().request("/experimental/workspace/status", { headers })

    expect(adapters.status).toBe(200)
    expect(await adapters.json()).toContainEqual({
      type: "routed-project",
      name: "Routed Project Adapter",
      description: "Scoped to the routed project",
    })
    expect(workspaces.status).toBe(200)
    expect(await workspaces.json()).toEqual([])
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("starts legacy sync for the routed project", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const response = await app().request("/sync/start", {
      method: "POST",
      headers: { "x-chimera-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
  })
})
