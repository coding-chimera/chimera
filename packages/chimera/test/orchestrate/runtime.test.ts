import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { parseChildFrame, type ChildFrame } from "@/orchestrate/protocol"
import { OrchestrateRuntime } from "@/orchestrate/runtime"
import { testEffect } from "../lib/effect"

/**
 * Real-process coverage for the orchestrate seam. Two layers:
 * - a direct host harness speaks the stdio protocol to child-main.ts itself
 *   (handshake, bindings, console shim, missing marker);
 * - OrchestrateRuntime tests exercise the production spawn path
 *   (entry.ts --orch-child -> child-main) for budgets and failure kinds.
 */

const projectRoot = path.join(import.meta.dir, "../..")
const childMain = path.join(projectRoot, "src/orchestrate/child-main.ts")
const TIMEOUT = 60_000

const budgets = {
  timeoutMs: 10_000,
  maxPending: 16,
  maxLogBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
}

function childEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

function spawnWorker(env: Record<string, string>) {
  return Bun.spawn({
    cmd: [process.execPath, childMain, "--orch-child"],
    cwd: projectRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(env),
  })
}

/** Interactive host: reads protocol frames line by line and writes replies. */
function directHost() {
  const child = spawnWorker({ CHIMERA_ORCH_CHILD: "test-nonce" })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const send = async (frame: unknown) => {
    child.stdin.write(JSON.stringify(frame) + "\n")
    await child.stdin.flush()
  }

  const nextFrame = async (): Promise<ChildFrame> => {
    while (true) {
      const index = buffer.indexOf("\n")
      if (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length === 0) continue
        const parsed = parseChildFrame(line)
        if (!parsed.ok) throw new Error(`invalid child frame: ${parsed.message} (${line})`)
        return parsed.frame
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error("child closed stdout before a frame arrived")
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  const close = async () => {
    child.kill()
    await child.exited
  }

  return { child, send, nextFrame, close }
}

const it = testEffect(OrchestrateRuntime.defaultLayer)

describe("orchestrate child worker (direct protocol)", () => {
  test(
    "handshakes and returns the program value",
    async () => {
      const host = directHost()
      try {
        expect(await host.nextFrame()).toEqual({ type: "ready" })
        await host.send({ type: "boot", program: "return { ok: true, n: 1 }", namespaces: {}, budgets })
        expect(await host.nextFrame()).toEqual({ type: "done", value: { ok: true, n: 1 } })
      } finally {
        await host.close()
      }
    },
    TIMEOUT,
  )

  test(
    "round-trips a binding call",
    async () => {
      const host = directHost()
      try {
        expect(await host.nextFrame()).toEqual({ type: "ready" })
        await host.send({
          type: "boot",
          program: "const orchestratingNs = orche.echo; return await orchestratingNs.echo({ msg: 'hi' })",
          namespaces: { echo: ["echo"] },
          budgets,
        })
        const call = await host.nextFrame()
        if (call.type !== "call") throw new Error(`expected call, got ${call.type}`)
        expect(call.name).toBe("echo")
        expect(call.args).toEqual({ msg: "hi" })
        await host.send({ type: "reply", id: call.id, ok: true, value: { echoed: call.args } })
        expect(await host.nextFrame()).toEqual({ type: "done", value: { echoed: { msg: "hi" } } })
      } finally {
        await host.close()
      }
    },
    TIMEOUT,
  )

  test(
    "surfaces a binding failure as a catchable named error",
    async () => {
      const host = directHost()
      try {
        expect(await host.nextFrame()).toEqual({ type: "ready" })
        await host.send({
          type: "boot",
          program:
            "const ns = orche.echo; try { await ns.fail({}); return 'unreachable' } catch (error) { return { name: error.name, message: error.message } }",
          namespaces: { echo: ["fail"] },
          budgets,
        })
        const call = await host.nextFrame()
        if (call.type !== "call") throw new Error(`expected call, got ${call.type}`)
        await host.send({ type: "reply", id: call.id, ok: false, message: "binding exploded" })
        expect(await host.nextFrame()).toEqual({
          type: "done",
          value: { name: "fail", message: "binding exploded" },
        })
      } finally {
        await host.close()
      }
    },
    TIMEOUT,
  )

  test(
    "streams console.log into log frames",
    async () => {
      const host = directHost()
      try {
        expect(await host.nextFrame()).toEqual({ type: "ready" })
        await host.send({
          type: "boot",
          program: "console.log('hello', { a: 1 }); return 'ok'",
          namespaces: {},
          budgets,
        })
        const log = await host.nextFrame()
        if (log.type !== "log") throw new Error(`expected log, got ${log.type}`)
        expect(log.text).toContain("hello")
        expect(await host.nextFrame()).toEqual({ type: "done", value: "ok" })
      } finally {
        await host.close()
      }
    },
    TIMEOUT,
  )

  test(
    "refuses to run without the CHIMERA_ORCH_CHILD marker",
    async () => {
      const child = spawnWorker({})
      const code = await child.exited
      await new Response(child.stderr).text()
      expect(code).toBe(2)
    },
    TIMEOUT,
  )
})

describe("OrchestrateRuntime", () => {
  it.live(
    "runs a program through the production entry route",
    () =>
      Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({ code: "return 41 + 1" })
        const result = yield* runtime.run(spec)
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(42)
      }),
    TIMEOUT,
  )

  it.live(
    "routes a host binding through the worker",
    () =>
      Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({
          code: "const ns = orche.echo; return await ns.echo({ value: 7 })",
          bindings: { echo: { echo: async (args) => args } },
        })
        const result = yield* runtime.run(spec)
        expect(result.error).toBeUndefined()
        expect(result.value).toEqual({ value: 7 })
      }),
    TIMEOUT,
  )

  it.live(
    "reports a program exception as a result error",
    () =>
      Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({ code: "throw new Error('boom')" })
        const result = yield* runtime.run(spec)
        expect(result.error?.kind).toBe("exception")
        expect(result.error?.message).toContain("boom")
      }),
    TIMEOUT,
  )

  it.live(
    "times out a non-terminating program",
    () =>
      Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({ code: "while (true) {}", timeoutMs: 300 })
        const result = yield* runtime.run(spec)
        expect(result.error?.kind).toBe("timeout")
      }),
    30_000,
  )

  it.live(
    "enforces the log byte budget",
    () =>
      Effect.gen(function* () {
        const runtime = yield* OrchestrateRuntime.Service
        const spec = yield* runtime.resolve({
          code: "console.log('x'.repeat(5000)); return 1",
          maxLogBytes: 1000,
        })
        const result = yield* runtime.run(spec)
        expect(result.error?.kind).toBe("output-limit")
      }),
    TIMEOUT,
  )
})
