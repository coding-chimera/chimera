import { describe, expect, test } from "bun:test"
import { FrameReader, FrameWriter, type OutgoingHeader } from "../../src/host/ipc-connection"
import {
  Flag,
  FrameKind,
  MAX_FRAGMENTS,
  MAX_FRAME_BYTES,
  MAX_REASSEMBLED_BYTES,
  PROTOCOL_VERSION,
} from "../../src/host/ipc-frame"
import type { HelloResume } from "../../src/host/ipc-handshake"
import {
  EXIT_OK,
  EXIT_TEMP_FAILURE,
  WorkerBootstrap,
  type RequestBody,
  type WorkerIdentity,
} from "../../src/host/worker-bootstrap"

const CONNECTION_ID = 17n
const WORKER_GENERATION = 8n
const HANDSHAKE_TIMEOUT_MS = 20
const NONCE = "nonce-1"

const IDENTITY: WorkerIdentity = {
  pid: 12345,
  build: "chimera-bun-worker@0.0.0",
  runtime: "bun@1.2.0",
  boot_id: "boot_1729550000000_12345",
  workspace: { directory: "/abs/workspace", project_id: "prj_test" },
  capabilities: ["frame.v1", "control.json", "event.batch", "cancel", "drain", "replay.command"],
  encodings: ["json", "msgpack"],
}

interface Channel {
  source: AsyncIterable<Uint8Array>
  push(bytes: Uint8Array): void
  end(): void
}

/** One-direction in-memory byte pipe; `push` before `end` is the only writer. */
function channel(): Channel {
  const queue: Uint8Array[] = []
  const waiters: ((result: IteratorResult<Uint8Array>) => void)[] = []
  let closed = false

  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = queue.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<Uint8Array>>((resolve) => waiters.push(resolve))
      },
    }),
  }

  return {
    source,
    push(bytes) {
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        waiter({ value: bytes, done: false })
        return
      }
      queue.push(bytes)
    },
    end() {
      closed = true
      waiters.splice(0).forEach((resolve) => resolve({ value: undefined, done: true }))
    },
  }
}

function setup(options: { resume?: HelloResume; handshakeTimeoutMs?: number } = {}) {
  const inbound = channel()
  const outbound = channel()
  const writer = new FrameWriter((bytes) => outbound.push(bytes))
  const reader = new FrameReader(inbound.source)
  const hostWriter = new FrameWriter((bytes) => inbound.push(bytes))
  const hostReader = new FrameReader(outbound.source)
  const bootstrap = new WorkerBootstrap({
    writer,
    reader,
    identity: IDENTITY,
    resume: options.resume,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  })
  return { bootstrap, hostWriter, hostReader, inbound, outbound }
}

type Setup = ReturnType<typeof setup>

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const encodeBody = (body: unknown) => encoder.encode(JSON.stringify(body))
const decodeBody = (payload: Uint8Array) => JSON.parse(decoder.decode(payload))

function hostHeader(kind: number, generation: bigint = WORKER_GENERATION): OutgoingHeader {
  return {
    protocol_version: PROTOCOL_VERSION,
    frame_kind: kind,
    flags: Flag.FINAL,
    connection_id: CONNECTION_ID,
    worker_generation: generation,
    correlation_id: new Uint8Array(16).fill(kind),
    payload_crc32c: 0,
  }
}

function readyBody(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: "hello",
    phase: "ready",
    connection_id: Number(CONNECTION_ID),
    worker_generation: Number(WORKER_GENERATION),
    protocol: PROTOCOL_VERSION,
    encodings: ["json", "msgpack"],
    compressions: [],
    capabilities: [...IDENTITY.capabilities],
    limits: {
      max_frame_bytes: MAX_FRAME_BYTES,
      max_reassembled_bytes: MAX_REASSEMBLED_BYTES,
      max_fragments: MAX_FRAGMENTS,
      heartbeat_ms: 10_000,
      request_timeout_ms: 30_000,
      cancel_soft_timeout_ms: 5_000,
      cancel_hard_timeout_ms: 30_000,
    },
    resume: { from_command_sequence: 43, replay_available: true },
    ...overrides,
  }
}

function requestBody(overrides: Partial<RequestBody> = {}) {
  return {
    v: 1,
    kind: "request",
    id: "req-1",
    method: "session.prompt",
    session_id: "ses_1",
    job_id: null,
    turn_id: "turn_1",
    deadline_ms: 30_000,
    params: {},
    ...overrides,
  }
}

function drainBody(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: "drain",
    id: "drain-1",
    drain_id: "drain_1",
    reason: "restart",
    deadline_ms: 500,
    allow_new_requests: false,
    ...overrides,
  }
}

/** Run `runHandshake` while a fake host reads `hello` and optionally replies. */
async function handshake(env: Setup, reply?: (hello: unknown) => Promise<void>) {
  const script = (async () => {
    const helloFrame = await env.hostReader.nextMessage()
    if (helloFrame === undefined) throw new Error("worker did not send hello")
    const hello = decodeBody(helloFrame.payload)
    if (reply !== undefined) await reply(hello)
    return hello
  })()

  const result = await env.bootstrap.runHandshake(NONCE)
  const hello = await script
  return { result, hello }
}

async function sendReady(env: Setup) {
  await env.hostWriter.send(hostHeader(FrameKind.hello), encodeBody(readyBody()))
}

async function established(options: { resume?: HelloResume } = {}) {
  const env = setup(options)
  const { result } = await handshake(env, async () => {
    await sendReady(env)
  })
  if (!result.ok) throw new Error(`handshake failed: ${result.code}`)
  const ack = await env.hostReader.nextMessage()
  if (ack === undefined) throw new Error("worker did not acknowledge hello")
  return env
}

describe("handshake", () => {
  test("sends hello, accepts ready and acknowledges hello_complete", async () => {
    const env = setup({ resume: { last_acked_command_sequence: 42, stream_epoch: "epoch_1" } })
    const { result, hello } = await handshake(env, async () => {
      await sendReady(env)
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ready).toEqual({
      v: 1,
      kind: "hello",
      phase: "ready",
      connection_id: CONNECTION_ID,
      worker_generation: WORKER_GENERATION,
      protocol: PROTOCOL_VERSION,
      encodings: ["json", "msgpack"],
      compressions: [],
      capabilities: IDENTITY.capabilities,
      limits: {
        max_frame_bytes: MAX_FRAME_BYTES,
        max_reassembled_bytes: MAX_REASSEMBLED_BYTES,
        max_fragments: MAX_FRAGMENTS,
        heartbeat_ms: 10_000,
        request_timeout_ms: 30_000,
        cancel_soft_timeout_ms: 5_000,
        cancel_hard_timeout_ms: 30_000,
      },
      resume: { from_command_sequence: 43, replay_available: true },
    })
    expect(env.bootstrap.ready).toBe(result.ready)

    expect(hello).toMatchObject({
      v: 1,
      kind: "hello",
      phase: "hello",
      nonce: NONCE,
      worker: {
        pid: 12345,
        build: "chimera-bun-worker@0.0.0",
        runtime: "bun@1.2.0",
        boot_id: "boot_1729550000000_12345",
      },
      protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      encodings: ["json", "msgpack"],
      compressions: [],
      capabilities: IDENTITY.capabilities,
      limits: { max_frame_bytes: MAX_FRAME_BYTES },
      workspace: { directory: "/abs/workspace", project_id: "prj_test" },
      resume: { last_acked_command_sequence: 42, stream_epoch: "epoch_1" },
    })

    const ackFrame = await env.hostReader.nextMessage()
    expect(ackFrame?.header.frame_kind).toBe(FrameKind.ack)
    const ack = decodeBody(ackFrame!.payload)
    expect(ack).toMatchObject({
      v: 1,
      kind: "ack",
      phase: "hello_complete",
      durable_through_command_sequence: 0,
      event_seq: null,
      replay_complete: false,
    })
    expect(ack.ack_of).toHaveLength(32)
    expect(ack.id).toHaveLength(32)
  })

  test("a fresh worker omits resume from hello", async () => {
    const env = setup()
    const { hello } = await handshake(env, async () => {
      await sendReady(env)
    })
    expect(hello).not.toHaveProperty("resume")
  })

  test("an error frame is a structured rejection, not a ready", async () => {
    const env = setup()
    const { result } = await handshake(env, async () => {
      await env.hostWriter.send(
        hostHeader(FrameKind.error),
        encodeBody({
          v: 1,
          kind: "error",
          id: "err-1",
          error: {
            code: "unsupported_protocol_version",
            category: "protocol",
            retryable: false,
            retry_after_ms: null,
            message: "no common protocol version",
            details: { worker_protocol: { min: 512, max: 512 } },
            cause_chain: [],
          },
        }),
      )
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("rejected")
    expect(result.message).toBe("no common protocol version")
    expect(result.error).toMatchObject({
      code: "unsupported_protocol_version",
      category: "protocol",
      retryable: false,
      details: { worker_protocol: { min: 512, max: 512 } },
    })
    expect(env.bootstrap.ready).toBeUndefined()
  })

  test("no ready within the handshake timeout is handshake_timeout", async () => {
    const env = setup()
    const { result } = await handshake(env)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("handshake_timeout")
    expect(env.bootstrap.ready).toBeUndefined()
  })

  test("a malformed ready body is invalid_ready", async () => {
    const env = setup()
    const { result } = await handshake(env, async () => {
      await env.hostWriter.send(hostHeader(FrameKind.hello), encodeBody({ v: 1, kind: "hello", phase: "ready" }))
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("invalid_ready")
  })
})

describe("serve", () => {
  test("routes a request to the handler and writes the response", async () => {
    const env = await established()
    const calls: string[] = []

    const serving = env.bootstrap.serve((request) => {
      calls.push(request.method)
      return { result: { echo: request.params } }
    })

    await env.hostWriter.send(hostHeader(FrameKind.request), encodeBody(requestBody({ params: { prompt: "hi" } })))
    await env.hostWriter.send(hostHeader(FrameKind.drain), encodeBody(drainBody()))

    const response = decodeBody((await env.hostReader.nextMessage())!.payload)
    expect(response).toMatchObject({
      v: 1,
      kind: "response",
      id: "req-1",
      status: "ok",
      result: { echo: { prompt: "hi" } },
      error: null,
    })

    const ack = decodeBody((await env.hostReader.nextMessage())!.payload)
    expect(ack).toMatchObject({ kind: "ack", phase: "drained", active_sessions: 0, interrupted_turns: 0 })

    const result = await serving
    expect(result).toMatchObject({ exitCode: EXIT_OK, reason: "drain", drained: true })
    expect(calls).toEqual(["session.prompt"])
  })

  test("a handler error becomes response.error and keeps the loop alive", async () => {
    const env = await established()

    const serving = env.bootstrap.serve(() => {
      throw new Error("boom")
    })

    await env.hostWriter.send(hostHeader(FrameKind.request), encodeBody(requestBody()))
    await env.hostWriter.send(hostHeader(FrameKind.drain), encodeBody(drainBody()))

    const response = decodeBody((await env.hostReader.nextMessage())!.payload)
    expect(response.status).toBe("error")
    expect(response.result).toBeNull()
    expect(response.error).toMatchObject({ code: "internal_error", category: "worker", message: "boom" })

    await serving
  })

  test("drain waits for in-flight work, then acknowledges drained and exits 0", async () => {
    const env = await established()
    let completed = false

    const serving = env.bootstrap.serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      completed = true
      return { result: { done: true } }
    })

    await env.hostWriter.send(hostHeader(FrameKind.request), encodeBody(requestBody()))
    await env.hostWriter.send(hostHeader(FrameKind.drain), encodeBody(drainBody()))

    const response = decodeBody((await env.hostReader.nextMessage())!.payload)
    expect(response.status).toBe("ok")
    expect(completed).toBe(true)

    const ack = decodeBody((await env.hostReader.nextMessage())!.payload)
    expect(ack).toMatchObject({
      kind: "ack",
      phase: "drained",
      active_sessions: 0,
      interrupted_turns: 0,
    })
    expect(ack.ack_of).toBe("drain-1")

    const result = await serving
    expect(result).toEqual({
      exitCode: EXIT_OK,
      reason: "drain",
      drained: true,
      active_sessions: 0,
      interrupted_turns: 0,
    })
  })

  test("drain timeout reports a structured temp failure instead of exiting", async () => {
    const env = await established()

    const serving = env.bootstrap.serve(() => new Promise<never>(() => {}))

    await env.hostWriter.send(hostHeader(FrameKind.request), encodeBody(requestBody()))
    await env.hostWriter.send(hostHeader(FrameKind.drain), encodeBody(drainBody({ deadline_ms: 20 })))

    const result = await serving
    expect(result).toEqual({
      exitCode: EXIT_TEMP_FAILURE,
      reason: "drain_timeout",
      drained: false,
      active_sessions: 1,
      interrupted_turns: 1,
    })
  })

  test("frames with a stale worker_generation are counted and never executed", async () => {
    const env = await established()
    const calls: string[] = []

    const serving = env.bootstrap.serve((request) => {
      calls.push(request.id)
      return { result: request.id }
    })

    await env.hostWriter.send(
      hostHeader(FrameKind.request, WORKER_GENERATION - 1n),
      encodeBody(requestBody({ id: "stale" })),
    )
    await env.hostWriter.send(hostHeader(FrameKind.request), encodeBody(requestBody({ id: "fresh" })))
    await env.hostWriter.send(hostHeader(FrameKind.drain), encodeBody(drainBody()))

    const response = decodeBody((await env.hostReader.nextMessage())!.payload)
    expect(response.id).toBe("fresh")
    expect(calls).toEqual(["fresh"])
    expect(env.bootstrap.staleFrames).toBe(1)

    await serving
  })

  test("an ipc.heartbeat event updates lastHeartbeat", async () => {
    const env = await established()
    expect(env.bootstrap.lastHeartbeat).toBeUndefined()

    const serving = env.bootstrap.serve(() => ({}))

    await env.hostWriter.send(
      hostHeader(FrameKind.event),
      encodeBody({
        v: 1,
        kind: "event",
        id: null,
        event: "ipc.heartbeat",
        session_id: null,
        job_id: null,
        turn_id: null,
        transport_sequence: 0,
        event_seq: null,
        payload_encoding: "json",
        payload: {},
      }),
    )
    await env.hostWriter.send(hostHeader(FrameKind.drain), encodeBody(drainBody()))

    await serving
    expect(typeof env.bootstrap.lastHeartbeat).toBe("number")
    expect(env.bootstrap.lastHeartbeat).toBeGreaterThan(0)
  })

  test("serve before handshake refuses with the incompatible exit code", async () => {
    const env = setup()
    const result = await env.bootstrap.serve(() => ({}))
    expect(result).toMatchObject({ exitCode: 78, reason: "not_ready", drained: false })
  })
})
