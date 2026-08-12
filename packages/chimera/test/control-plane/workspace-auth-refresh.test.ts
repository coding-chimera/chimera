import { afterEach, beforeEach, describe, expect, mock, spyOn } from "bun:test"
import { mkdir } from "node:fs/promises"
import Http from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "../../src/auth"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter, WorkspaceInfo } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { Database } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provideMerge(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const layer = Layer.mergeAll(
  NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }),
  workspaceLayer,
  Session.defaultLayer,
  Auth.defaultLayer,
)
const it = testEffect(layer)
const originalWorkspacesFlag = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT

beforeEach(async () => {
  Database.close()
  await mkdir(Global.Path.data, { recursive: true })
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
  process.env.OPENCODE_AUTH_CONTENT = "{}"
})

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspacesFlag
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  if (originalAuthContent !== undefined) process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  await resetDatabase()
})

function unique(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

async function waitFor<T>(fn: () => T | Promise<T>, timeout = 3000): Promise<T> {
  const started = Date.now()
  let last: unknown
  while (Date.now() - started < timeout) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await delay(10)
    }
  }
  throw last ?? new Error("Timed out waiting for condition")
}

function eventually<T>(fn: () => T | Promise<T>, timeout?: number) {
  return Effect.promise(() => waitFor(fn, timeout))
}

function authKey(env: Record<string, string | undefined>, provider = "phase5") {
  const value = JSON.parse(env.OPENCODE_AUTH_CONTENT ?? "{}") as Record<string, { key?: string }>
  return value[provider]?.key
}

function eventStreamResponse() {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(":\n\n"))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function serveRemote(requests: string[]) {
  return Effect.gen(function* () {
    yield* HttpServer.serveEffect()(
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const pathname = new URL(req.url, "http://localhost").pathname
        requests.push(`${req.method} ${pathname}`)
        if (pathname.endsWith("/global/event")) return HttpServerResponse.fromWeb(eventStreamResponse())
        if (pathname.endsWith("/sync/history")) return yield* HttpServerResponse.json([])
        return HttpServerResponse.text("unexpected", { status: 500 })
      }),
    )
    return HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
  })
}

type Calls = {
  create: Array<{ info: WorkspaceInfo; env: Record<string, string | undefined> }>
  restart: Array<{ info: WorkspaceInfo; env: Record<string, string | undefined> }>
  remove: WorkspaceInfo[]
  target: WorkspaceInfo[]
}

function remoteAdapter(input: {
  target: () => string
  restart?: (info: WorkspaceInfo, env: Record<string, string | undefined>) => Promise<void>
}) {
  const calls: Calls = { create: [], restart: [], remove: [], target: [] }
  const adapter: WorkspaceAdapter = {
    name: "phase5 remote",
    description: "phase5 remote",
    configure(info) {
      return info
    },
    async create(info, env) {
      calls.create.push({ info: structuredClone(info), env: { ...env } })
    },
    restart: input.restart
      ? async (info, env) => {
          calls.restart.push({ info: structuredClone(info), env: { ...env } })
          await input.restart!(info, env)
        }
      : undefined,
    async remove(info) {
      calls.remove.push(structuredClone(info))
    },
    target(info) {
      calls.target.push(structuredClone(info))
      return { type: "remote", url: input.target() }
    },
  }
  return { adapter, calls }
}

function localAdapter(directory: string) {
  const calls: Calls = { create: [], restart: [], remove: [], target: [] }
  const adapter: WorkspaceAdapter = {
    name: "phase5 local",
    description: "phase5 local",
    configure(info) {
      return { ...info, directory }
    },
    async create(info, env) {
      calls.create.push({ info: structuredClone(info), env: { ...env } })
    },
    async restart(info, env) {
      calls.restart.push({ info: structuredClone(info), env: { ...env } })
    },
    async remove(info) {
      calls.remove.push(structuredClone(info))
    },
    target(info) {
      calls.target.push(structuredClone(info))
      return { type: "local", directory }
    },
  }
  return { adapter, calls }
}

function create(workspace: Workspace.Interface, type: string) {
  return workspace.create({ type, branch: null, projectID: Instance.project.id, extra: null })
}

describe("workspace auth refresh", () => {
  it.live("restarts an active remote workspace with fresh snapshots without removing it", () => {
    const requests: string[] = []
    return Effect.gen(function* () {
      const url = yield* serveRemote(requests)
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const workspace = yield* Workspace.Service
            process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ phase5: { type: "api", key: "snapshot-a" } })
            let target = `${url}/target-a`
            const recorded = remoteAdapter({
              target: () => target,
              async restart() {
                target = `${url}/target-b`
              },
            })
            const type = unique("snapshot")
            registerAdapter(Instance.project.id, type, recorded.adapter)

            const info = yield* create(workspace, type)
            expect(authKey(recorded.calls.create[0].env)).toBe("snapshot-a")
            expect(recorded.calls.create[0].env.OPENCODE_WORKSPACE_ID).toBe(info.id)
            expect(recorded.calls.create[0].env.OPENCODE_EXPERIMENTAL_WORKSPACES).toBe("true")

            yield* auth.set("phase5", { type: "api", key: "snapshot-b" })
            yield* eventually(() => {
              expect(recorded.calls.restart).toHaveLength(1)
              expect(requests).toContain("GET /target-b/global/event")
              return recorded.calls.restart[0]
            })
            expect(authKey(recorded.calls.restart[0].env)).toBe("snapshot-b")
            expect(recorded.calls.restart[0].env.OPENCODE_WORKSPACE_ID).toBe(info.id)

            yield* auth.set("phase5", { type: "api", key: "snapshot-b" })
            yield* Effect.sleep("100 millis")
            expect(recorded.calls.restart).toHaveLength(1)

            yield* auth.remove("phase5")
            yield* eventually(() => {
              expect(recorded.calls.restart).toHaveLength(2)
              return recorded.calls.restart[1]
            })
            expect(JSON.parse(recorded.calls.restart[1].env.OPENCODE_AUTH_CONTENT ?? "{}")).toEqual({})
            expect(recorded.calls.remove).toHaveLength(0)
            yield* eventually(async () => {
              const syncing = await Effect.runPromise(workspace.isSyncing(info.id))
              expect(syncing).toBe(true)
              return syncing
            })
            yield* workspace.remove(info.id)
          }),
        { git: true },
      )
    })
  })

  it.live("skips local workspaces and surfaces unsupported active remote adapters without secrets", () => {
    const requests: string[] = []
    const warn = spyOn(Log.create({ service: "workspace-sync" }), "warn")
    return Effect.gen(function* () {
      const url = yield* serveRemote(requests)
      yield* provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const workspace = yield* Workspace.Service
            const local = localAdapter(directory)
            const localType = unique("local")
            registerAdapter(Instance.project.id, localType, local.adapter)
            const localInfo = yield* create(workspace, localType)

            const unsupported = remoteAdapter({ target: () => `${url}/unsupported` })
            const unsupportedType = unique("unsupported")
            registerAdapter(Instance.project.id, unsupportedType, unsupported.adapter)
            const unsupportedInfo = yield* create(workspace, unsupportedType)

            yield* auth.set("phase5", { type: "api", key: "unsupported-secret" })
            yield* eventually(async () => {
              const status = (await Effect.runPromise(workspace.status())).find(
                (item) => item.workspaceID === unsupportedInfo.id,
              )
              expect(status?.status).toBe("error")
              return status
            })

            expect(local.calls.restart).toHaveLength(0)
            expect((yield* workspace.status()).find((item) => item.workspaceID === localInfo.id)?.status).toBe("connected")
            expect(unsupported.calls.remove).toHaveLength(0)
            expect(yield* workspace.isSyncing(unsupportedInfo.id)).toBe(false)
            const call = warn.mock.calls.find(([message]) => message === "workspace auth refresh unsupported")
            expect(call?.[1]).toMatchObject({ workspaceID: unsupportedInfo.id, type: unsupportedType, revision: 1 })
            expect(JSON.stringify(call)).not.toContain("unsupported-secret")
          }),
        { git: true },
      )
    })
  })

  it.live("serializes two workspace restarts and coalesces queued auth changes", () => {
    const requests: string[] = []
    let releaseFirst!: () => void
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let reportStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    let shouldBlock = true
    let active = 0
    let maximumActive = 0

    return Effect.gen(function* () {
      const url = yield* serveRemote(requests)
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const workspace = yield* Workspace.Service
            const restart = async () => {
              active += 1
              maximumActive = Math.max(maximumActive, active)
              try {
                if (!shouldBlock) return
                shouldBlock = false
                reportStarted()
                await release
              } finally {
                active -= 1
              }
            }
            const one = remoteAdapter({ target: () => `${url}/one`, restart })
            const two = remoteAdapter({ target: () => `${url}/two`, restart })
            const oneType = unique("one")
            const twoType = unique("two")
            registerAdapter(Instance.project.id, oneType, one.adapter)
            registerAdapter(Instance.project.id, twoType, two.adapter)
            const oneInfo = yield* create(workspace, oneType)
            const twoInfo = yield* create(workspace, twoType)

            yield* auth.set("phase5", { type: "api", key: "snapshot-b" })
            yield* Effect.promise(() => started)
            yield* auth.set("phase5", { type: "api", key: "snapshot-c" })
            yield* auth.set("phase5", { type: "api", key: "snapshot-d" })
            releaseFirst()

            yield* eventually(() => {
              expect(one.calls.restart.length + two.calls.restart.length).toBe(4)
              expect(active).toBe(0)
              return true
            })
            expect(one.calls.restart.map((call) => authKey(call.env))).toEqual(["snapshot-b", "snapshot-d"])
            expect(two.calls.restart.map((call) => authKey(call.env))).toEqual(["snapshot-b", "snapshot-d"])
            expect(maximumActive).toBe(1)
            expect(one.calls.remove).toHaveLength(0)
            expect(two.calls.remove).toHaveLength(0)
            yield* workspace.remove(oneInfo.id)
            yield* workspace.remove(twoInfo.id)
          }),
        { git: true },
      )
    })
  })

  it.live("replaces a real child process and its auth environment", () => {
    const requests: string[] = []
    return Effect.gen(function* () {
      const url = yield* serveRemote(requests)
      yield* provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const workspace = yield* Workspace.Service
            const stateFile = path.join(directory, "workspace-child.json")
            let child: ReturnType<typeof Bun.spawn> | undefined
            const stop = async () => {
              const current = child
              child = undefined
              if (!current) return
              current.kill()
              await current.exited
            }
            const start = async (env: Record<string, string | undefined>) => {
              const childEnv = Object.fromEntries(
                Object.entries({ ...process.env, ...env }).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              )
              const script = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ pid: process.pid, auth: process.env.OPENCODE_AUTH_CONTENT })); setInterval(() => {}, 1000)`
              const next = Bun.spawn([process.execPath, "-e", script], {
                env: childEnv,
                stdout: "ignore",
                stderr: "ignore",
              })
              child = next
              await waitFor(async () => {
                const state = (await Bun.file(stateFile).json()) as { pid: number; auth: string }
                expect(state.pid).toBe(next.pid)
                return state
              })
            }
            yield* Effect.addFinalizer(() => Effect.promise(stop))
            const calls = { remove: 0 }
            const adapter: WorkspaceAdapter = {
              name: "real child",
              description: "real child",
              configure(info) {
                return info
              },
              async create(_info, env) {
                await start(env)
              },
              async restart(_info, env) {
                await stop()
                await start(env)
              },
              async remove() {
                calls.remove += 1
                await stop()
              },
              target() {
                return { type: "remote", url: `${url}/child` }
              },
            }
            const type = unique("child")
            registerAdapter(Instance.project.id, type, adapter)
            process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ phase5: { type: "api", key: "child-a" } })

            const info = yield* create(workspace, type)
            const before = (yield* eventually(async () => {
              const state = (await Bun.file(stateFile).json()) as { pid: number; auth: string }
              expect(JSON.parse(state.auth).phase5.key).toBe("child-a")
              return state
            })) as { pid: number; auth: string }

            yield* auth.set("phase5", { type: "api", key: "child-b" })
            const after = (yield* eventually(async () => {
              const state = (await Bun.file(stateFile).json()) as { pid: number; auth: string }
              expect(state.pid).not.toBe(before.pid)
              expect(JSON.parse(state.auth).phase5.key).toBe("child-b")
              return state
            })) as { pid: number; auth: string }

            expect(after.pid).not.toBe(before.pid)
            expect(calls.remove).toBe(0)
            yield* workspace.remove(info.id)
          }),
        { git: true },
      )
    })
  }, 15000)

  it.live("retries a failed auth restart on the next auth change", () => {
    const requests: string[] = []
    return Effect.gen(function* () {
      const url = yield* serveRemote(requests)
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const workspace = yield* Workspace.Service
            let failNextRestart = true
            const recorded = remoteAdapter({
              target: () => `${url}/retry`,
              async restart() {
                if (failNextRestart) {
                  failNextRestart = false
                  throw new Error("transient restart failure")
                }
              },
            })
            const type = unique("retry")
            registerAdapter(Instance.project.id, type, recorded.adapter)

            const info = yield* create(workspace, type)
            expect(recorded.calls.create).toHaveLength(1)

            yield* auth.set("phase5", { type: "api", key: "retry-b" })
            yield* eventually(() => {
              expect(recorded.calls.restart).toHaveLength(1)
              return recorded.calls.restart[0]
            })
            yield* eventually(async () => {
              const status = (await Effect.runPromise(workspace.status())).find(
                (item) => item.workspaceID === info.id,
              )
              expect(status?.status).toBe("error")
              return status
            })
            expect(recorded.calls.remove).toHaveLength(0)

            yield* auth.set("phase5", { type: "api", key: "retry-c" })
            yield* eventually(() => {
              expect(recorded.calls.restart).toHaveLength(2)
              return recorded.calls.restart[1]
            })
            expect(authKey(recorded.calls.restart[1].env)).toBe("retry-c")
            expect(recorded.calls.remove).toHaveLength(0)
            yield* eventually(async () => {
              const syncing = await Effect.runPromise(workspace.isSyncing(info.id))
              expect(syncing).toBe(true)
              return syncing
            })
            yield* workspace.remove(info.id)
          }),
        { git: true },
      )
    })
  })
})
