/**
 * Bun worker-side IPC bootstrap (schema v0).
 *
 * Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §2.3 (connection
 * lifecycle), §5.1 (`hello`/`ready`), §5.5 (`ack`), §5.7 (`drain`), §7.2
 * (generation fencing) and §9.3 (drain exit codes).
 *
 * This is the protocol half of the worker skeleton: the transport pair is
 * injected by the caller (`FrameWriter` + `FrameReader`), so the same code runs
 * over a Unix socket, a named pipe, or the in-memory pipe used by tests. It
 * deliberately imports no runtime module (no `src/server`, `src/session`,
 * Node `Buffer`); only the sibling protocol codec.
 *
 * Lifecycle:
 * `runHandshake(nonce)` → `hello` / `ready` / `ack(hello_complete)` →
 * `serve(handler)` → request/response until `drain` / `ack(drained)`.
 */

import { FrameReader, FrameWriter, type OutgoingHeader } from "./ipc-connection"
import {
  CORRELATION_ID_BYTES,
  Flag,
  FrameError,
  FrameKind,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type Frame,
  type Header,
} from "./ipc-frame"
import {
  BODY_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  type Hello,
  type HelloProtocol,
  type HelloResume,
  type HelloWorkspace,
  type Ready,
  type ReadyLimits,
  type ReadyResume,
} from "./ipc-handshake"

/** §9.3 worker exit codes. `0` normal drain; the rest are failure classes. */
export const EXIT_OK = 0
export const EXIT_INTERNAL_ERROR = 70
export const EXIT_TEMP_FAILURE = 75
export const EXIT_INCOMPATIBLE = 78

/** §5.7 candidate default; the host's `deadline_ms` wins when present. */
export const DRAIN_TIMEOUT_MS = 30_000

/** §5.8 / §10.2 protocol error carried by an `error` frame or `response.error`. */
export interface WireError {
  code: string
  category?: string
  retryable?: boolean
  retry_after_ms?: number | null
  message: string
  details?: Record<string, unknown>
  cause_chain?: unknown[]
}

/** Worker identity advertised in `hello.worker` plus negotiation inputs (§5.1). */
export interface WorkerIdentity {
  pid: number
  build: string
  runtime: string
  boot_id: string
  workspace: HelloWorkspace
  capabilities: string[]
  encodings: string[]
  /** Largest frame body the worker accepts; defaults to `MAX_FRAME_BYTES`. */
  max_frame_bytes?: number
  compressions?: string[]
  protocol?: HelloProtocol
}

export interface WorkerBootstrapOptions {
  writer: FrameWriter
  reader: FrameReader
  identity: WorkerIdentity
  /** Cursor from a previous connection; omitted on a fresh boot (§11.3). */
  resume?: HelloResume
  /** Candidate default is `HANDSHAKE_TIMEOUT_MS`; overridable for calibration/tests. */
  handshakeTimeoutMs?: number
}

export type HandshakeFailureCode =
  | "handshake_timeout"
  | "rejected"
  | "unexpected_frame"
  | "transport_error"
  | "invalid_ready"

export interface HandshakeFailure {
  ok: false
  code: HandshakeFailureCode
  message: string
  /** Present when the host answered with an `error` frame (§5.8). */
  error?: WireError
}

export type HandshakeResult = { ok: true; ready: Ready } | HandshakeFailure

/** §5.2 request body handed to the injected handler. */
export interface RequestBody {
  v: number
  kind: "request"
  id: string
  method: string
  session_id?: string
  job_id?: string | null
  turn_id?: string
  deadline_ms?: number
  idempotency_key?: string
  params?: unknown
  ext?: Record<string, unknown>
}

export interface WorkerRequest extends RequestBody {
  header: Header
}

/** Handler return value: omit for `result: null`; set `error` for `status: "error"`. */
export interface HandlerResponse {
  result?: unknown
  error?: WireError
  meta?: Record<string, unknown>
}

export type RequestHandler = (
  request: WorkerRequest,
) => HandlerResponse | undefined | Promise<HandlerResponse | undefined>

export type ServeReason = "drain" | "drain_timeout" | "eof" | "fatal" | "not_ready"

/**
 * Result of the serving loop. The bootstrap never calls `process.exit`; the
 * caller maps `exitCode` onto its own exit path (or the host force-kills on
 * `drain_timeout`, §9.3).
 */
export interface ServeResult {
  exitCode: number
  reason: ServeReason
  drained: boolean
  active_sessions: number
  interrupted_turns: number
  error?: WireError
}

interface DrainBody {
  id: string
  drain_id: string
  reason: string
  deadline_ms: number
  allow_new_requests: boolean
}

interface Inflight {
  done: Promise<void>
  turn_id?: string
}

const TIMEOUT = Symbol("timeout")
type Timeout = typeof TIMEOUT

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const encodeBody = (body: unknown): Uint8Array => encoder.encode(JSON.stringify(body))

const decodeBody = (payload: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(payload))
  } catch {
    return undefined
  }
}

const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined
}

const toBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
  return undefined
}

const parseLimits = (value: unknown): ReadyLimits | undefined => {
  if (!isRecord(value)) return undefined
  const max_frame_bytes = numberField(value, "max_frame_bytes")
  const max_reassembled_bytes = numberField(value, "max_reassembled_bytes")
  const max_fragments = numberField(value, "max_fragments")
  const heartbeat_ms = numberField(value, "heartbeat_ms")
  const request_timeout_ms = numberField(value, "request_timeout_ms")
  const cancel_soft_timeout_ms = numberField(value, "cancel_soft_timeout_ms")
  const cancel_hard_timeout_ms = numberField(value, "cancel_hard_timeout_ms")
  if (
    max_frame_bytes === undefined ||
    max_reassembled_bytes === undefined ||
    max_fragments === undefined ||
    heartbeat_ms === undefined ||
    request_timeout_ms === undefined ||
    cancel_soft_timeout_ms === undefined ||
    cancel_hard_timeout_ms === undefined
  )
    return undefined
  return {
    max_frame_bytes,
    max_reassembled_bytes,
    max_fragments,
    heartbeat_ms,
    request_timeout_ms,
    cancel_soft_timeout_ms,
    cancel_hard_timeout_ms,
  }
}

const parseResume = (value: unknown): ReadyResume | undefined => {
  if (!isRecord(value)) return undefined
  const from_command_sequence = numberField(value, "from_command_sequence")
  if (from_command_sequence === undefined || typeof value.replay_available !== "boolean") return undefined
  return { from_command_sequence, replay_available: value.replay_available }
}

const parseReady = (body: unknown): Ready | undefined => {
  if (!isRecord(body)) return undefined
  if (body.v !== BODY_VERSION || body.kind !== "hello" || body.phase !== "ready") return undefined
  const connection_id = toBigInt(body.connection_id)
  const worker_generation = toBigInt(body.worker_generation)
  const protocol = numberField(body, "protocol")
  const encodings = stringArray(body.encodings)
  const compressions = stringArray(body.compressions)
  const capabilities = stringArray(body.capabilities)
  const limits = parseLimits(body.limits)
  const resume = parseResume(body.resume)
  if (
    connection_id === undefined ||
    worker_generation === undefined ||
    protocol === undefined ||
    encodings === undefined ||
    compressions === undefined ||
    capabilities === undefined ||
    limits === undefined ||
    resume === undefined
  )
    return undefined
  return {
    v: BODY_VERSION,
    kind: "hello",
    phase: "ready",
    connection_id,
    worker_generation,
    protocol,
    encodings,
    compressions,
    capabilities,
    limits,
    resume,
  }
}

const parseWireError = (value: unknown): WireError | undefined => {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined
  return {
    code: value.code,
    category: typeof value.category === "string" ? value.category : undefined,
    retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
    retry_after_ms: typeof value.retry_after_ms === "number" ? value.retry_after_ms : null,
    message: value.message,
    details: isRecord(value.details) ? value.details : undefined,
    cause_chain: Array.isArray(value.cause_chain) ? value.cause_chain : undefined,
  }
}

const parseRequest = (body: unknown): RequestBody | undefined => {
  if (!isRecord(body) || body.kind !== "request") return undefined
  if (typeof body.id !== "string" || typeof body.method !== "string") return undefined
  return {
    v: typeof body.v === "number" ? body.v : BODY_VERSION,
    kind: "request",
    id: body.id,
    method: body.method,
    session_id: typeof body.session_id === "string" ? body.session_id : undefined,
    job_id: typeof body.job_id === "string" ? body.job_id : null,
    turn_id: typeof body.turn_id === "string" ? body.turn_id : undefined,
    deadline_ms: numberField(body, "deadline_ms"),
    idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
    params: body.params,
    ext: isRecord(body.ext) ? body.ext : undefined,
  }
}

const parseDrain = (body: unknown): DrainBody | undefined => {
  if (!isRecord(body) || body.kind !== "drain" || typeof body.id !== "string") return undefined
  return {
    id: body.id,
    drain_id: typeof body.drain_id === "string" ? body.drain_id : body.id,
    reason: typeof body.reason === "string" ? body.reason : "shutdown",
    deadline_ms: numberField(body, "deadline_ms") ?? DRAIN_TIMEOUT_MS,
    allow_new_requests: body.allow_new_requests === true,
  }
}

async function withTimeout<T>(run: Promise<T>, ms: number): Promise<T | Timeout> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Timeout>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
  })
  try {
    return await Promise.race([run, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Worker-side handshake + serving loop.
 *
 * `runHandshake` is the only transition into `ready`; `serve` refuses to run
 * before it. Every inbound frame whose header generation differs from the
 * negotiated `worker_generation` is counted and dropped (§7.2), never executed.
 */
export class WorkerBootstrap {
  #writer: FrameWriter
  #reader: FrameReader
  #identity: WorkerIdentity
  #resume?: HelloResume
  #handshakeTimeoutMs: number
  #ready?: Ready
  #lastHeartbeat?: number
  #staleFrames = 0
  #correlationIDs = 0
  #inflightIDs = 0

  constructor(options: WorkerBootstrapOptions) {
    this.#writer = options.writer
    this.#reader = options.reader
    this.#identity = options.identity
    this.#resume = options.resume
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  }

  /** Negotiated `ready` body; `undefined` until `runHandshake` succeeds. */
  get ready(): Ready | undefined {
    return this.#ready
  }

  /** Timestamp of the last host `ipc.heartbeat` transient event (watchdog input). */
  get lastHeartbeat(): number | undefined {
    return this.#lastHeartbeat
  }

  /** Frames dropped because their header generation was stale (§7.2). */
  get staleFrames(): number {
    return this.#staleFrames
  }

  /**
   * §2.3 handshake: send `hello`, await `hello/ready`, then send
   * `ack(hello_complete)`. A timeout, an `error` frame or a malformed `ready`
   * is a structured failure — this method never reports success on a guess.
   */
  async runHandshake(nonce: string): Promise<HandshakeResult> {
    if (this.#ready !== undefined) return { ok: true, ready: this.#ready }

    const correlation = this.#correlation()
    try {
      await this.#writer.send(this.#outgoing(FrameKind.hello, Flag.FINAL, correlation), encodeBody(this.#hello(nonce)))
    } catch (error) {
      return this.#transportFailure(error)
    }

    let next: Frame | undefined | Timeout
    try {
      next = await withTimeout(this.#reader.nextMessage(), this.#handshakeTimeoutMs)
    } catch (error) {
      return this.#transportFailure(error)
    }

    if (next === TIMEOUT)
      return {
        ok: false,
        code: "handshake_timeout",
        message: `no ready frame within ${this.#handshakeTimeoutMs}ms`,
      }

    if (next === undefined) return { ok: false, code: "transport_error", message: "stream ended during handshake" }

    const body = decodeBody(next.payload)
    if (!isRecord(body))
      return { ok: false, code: "unexpected_frame", message: "ready frame body is not a JSON object" }

    if (body.kind === "error") {
      const error = parseWireError(body.error)
      return {
        ok: false,
        code: "rejected",
        message: error?.message ?? "host rejected the handshake",
        error,
      }
    }

    const ready = parseReady(body)
    if (ready === undefined)
      return {
        ok: false,
        code: "invalid_ready",
        message: `expected hello/ready, received ${typeof body.kind === "string" ? body.kind : "unknown"}`,
      }

    this.#ready = ready

    try {
      await this.#ackHello(hex(correlation))
    } catch (error) {
      return this.#transportFailure(error)
    }

    return { ok: true, ready }
  }

  /**
   * Main loop: request → handler → response; heartbeat events update
   * `lastHeartbeat`; `drain` stops intake, waits for in-flight work up to the
   * drain deadline, sends `ack(drained)` and reports the §9.3 exit code.
   *
   * A drain timeout does not send `ack(drained)` (the work was not drained);
   * it reports `drain_timeout` / `EXIT_TEMP_FAILURE` so the caller can exit and
   * let the host force-kill per §9.3.
   */
  async serve(handler: RequestHandler): Promise<ServeResult> {
    const ready = this.#ready
    if (ready === undefined)
      return {
        exitCode: EXIT_INCOMPATIBLE,
        reason: "not_ready",
        drained: false,
        active_sessions: 0,
        interrupted_turns: 0,
      }

    const inflight = new Map<number, Inflight>()
    const activeSessions = new Set<string>()

    try {
      while (true) {
        const frame = await this.#reader.nextMessage()
        if (frame === undefined)
          return {
            exitCode: EXIT_TEMP_FAILURE,
            reason: "eof",
            drained: false,
            active_sessions: activeSessions.size,
            interrupted_turns: 0,
          }

        if (!this.#currentGeneration(frame.header)) continue

        const body = decodeBody(frame.payload)

        if (frame.header.frame_kind === FrameKind.drain) {
          const drain = parseDrain(body)
          if (drain === undefined) continue
          return await this.#drain(drain, inflight, activeSessions)
        }

        if (frame.header.frame_kind === FrameKind.event) {
          this.#observeEvent(body)
          continue
        }

        if (frame.header.frame_kind === FrameKind.request) {
          const request = parseRequest(body)
          if (request === undefined) {
            await this.#writeProtocolError("bad_header", "invalid request body", {
              sequence: frame.header.sequence.toString(),
            })
            continue
          }
          this.#dispatch(frame, request, handler, inflight, activeSessions)
        }
      }
    } catch (error) {
      return this.#fatal(error, activeSessions.size)
    }
  }

  async #drain(drain: DrainBody, inflight: Map<number, Inflight>, activeSessions: Set<string>): Promise<ServeResult> {
    const deadline = drain.deadline_ms > 0 ? drain.deadline_ms : DRAIN_TIMEOUT_MS
    const pending = Array.from(inflight.values(), (entry) => entry.done)
    const settled = await withTimeout(Promise.allSettled(pending), deadline)

    if (settled === TIMEOUT) {
      const interrupted = Array.from(inflight.values()).filter((entry) => entry.turn_id !== undefined).length
      return {
        exitCode: EXIT_TEMP_FAILURE,
        reason: "drain_timeout",
        drained: false,
        active_sessions: activeSessions.size,
        interrupted_turns: interrupted,
      }
    }

    try {
      await this.#writeDrainAck(drain, activeSessions.size, 0)
    } catch (error) {
      return this.#fatal(error, activeSessions.size)
    }

    return {
      exitCode: EXIT_OK,
      reason: "drain",
      drained: true,
      active_sessions: activeSessions.size,
      interrupted_turns: 0,
    }
  }

  #dispatch(
    frame: Frame,
    request: RequestBody,
    handler: RequestHandler,
    inflight: Map<number, Inflight>,
    activeSessions: Set<string>,
  ) {
    const id = (this.#inflightIDs += 1)
    const session = request.session_id
    if (session !== undefined) activeSessions.add(session)

    const done = (async () => {
      let response: HandlerResponse | undefined
      try {
        response = await handler({ ...request, header: frame.header })
      } catch (error) {
        response = {
          error: { code: "internal_error", category: "worker", retryable: false, message: messageOf(error) },
        }
      }
      try {
        await this.#writeResponse(frame.header, request, response)
      } catch {
        // The connection is gone; there is nothing left to report on.
      }
    })().finally(() => {
      inflight.delete(id)
      if (session !== undefined) activeSessions.delete(session)
    })

    inflight.set(id, { done, turn_id: request.turn_id })
  }

  #observeEvent(body: unknown) {
    if (!isRecord(body) || body.kind !== "event") return
    if (body.event === "ipc.heartbeat") this.#lastHeartbeat = Date.now()
  }

  /**
   * §7.2 stale-generation discipline: a frame whose header generation is not
   * the negotiated one is recorded and ignored, never executed.
   */
  #currentGeneration(header: Header): boolean {
    const ready = this.#ready
    if (ready === undefined) return true
    if (header.worker_generation === ready.worker_generation) return true
    this.#staleFrames += 1
    return false
  }

  #hello(nonce: string): Hello {
    const hello: Hello = {
      v: BODY_VERSION,
      kind: "hello",
      phase: "hello",
      nonce,
      worker: {
        pid: this.#identity.pid,
        build: this.#identity.build,
        runtime: this.#identity.runtime,
        boot_id: this.#identity.boot_id,
      },
      protocol: this.#identity.protocol ?? { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      encodings: this.#identity.encodings,
      compressions: this.#identity.compressions ?? [],
      capabilities: this.#identity.capabilities,
      limits: { max_frame_bytes: this.#identity.max_frame_bytes ?? MAX_FRAME_BYTES },
      workspace: this.#identity.workspace,
    }
    if (this.#resume !== undefined) hello.resume = this.#resume
    return hello
  }

  async #ackHello(helloID: string) {
    const correlation = this.#correlation()
    await this.#writer.send(
      this.#outgoing(FrameKind.ack, Flag.FINAL, correlation),
      encodeBody({
        v: BODY_VERSION,
        kind: "ack",
        id: hex(correlation),
        ack_of: helloID,
        phase: "hello_complete",
        durable_through_command_sequence: 0,
        event_seq: null,
        replay_complete: false,
      }),
    )
  }

  async #writeDrainAck(drain: DrainBody, activeSessions: number, interruptedTurns: number) {
    const correlation = this.#correlation()
    await this.#writer.send(
      this.#outgoing(FrameKind.ack, Flag.FINAL, correlation),
      encodeBody({
        v: BODY_VERSION,
        kind: "ack",
        id: hex(correlation),
        ack_of: drain.id,
        phase: "drained",
        durable_through_command_sequence: 0,
        event_seq: null,
        replay_complete: false,
        active_sessions: activeSessions,
        interrupted_turns: interruptedTurns,
      }),
    )
  }

  async #writeResponse(header: Header, request: RequestBody, response: HandlerResponse | undefined) {
    const error = response?.error
    await this.#writer.send(
      this.#outgoing(FrameKind.response, Flag.DURABLE | Flag.FINAL, header.correlation_id),
      encodeBody({
        v: BODY_VERSION,
        kind: "response",
        id: request.id,
        status: error === undefined ? "ok" : "error",
        result: error === undefined ? (response?.result ?? null) : null,
        error: error ?? null,
        meta: response?.meta ?? {},
      }),
    )
  }

  async #writeProtocolError(code: string, message: string, details: Record<string, unknown> = {}) {
    const correlation = this.#correlation()
    await this.#writer.send(
      this.#outgoing(FrameKind.error, Flag.FINAL, correlation),
      encodeBody({
        v: BODY_VERSION,
        kind: "error",
        id: hex(correlation),
        error: {
          code,
          category: "protocol",
          retryable: false,
          retry_after_ms: null,
          message,
          details,
          cause_chain: [],
        },
      }),
    )
  }

  #outgoing(frame_kind: number, flags: number, correlation_id: Uint8Array): OutgoingHeader {
    return {
      protocol_version: PROTOCOL_VERSION,
      frame_kind,
      flags,
      connection_id: this.#ready?.connection_id ?? 0n,
      worker_generation: this.#ready?.worker_generation ?? 0n,
      correlation_id,
      payload_crc32c: 0,
    }
  }

  #correlation(): Uint8Array {
    this.#correlationIDs += 1
    const bytes = new Uint8Array(CORRELATION_ID_BYTES)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, this.#correlationIDs, true)
    view.setUint32(4, 0x4b524f57, true)
    return bytes
  }

  #transportFailure(error: unknown): HandshakeFailure {
    return {
      ok: false,
      code: "transport_error",
      message: messageOf(error),
      error:
        error instanceof FrameError
          ? { code: error.code, category: "transport", retryable: false, message: error.message }
          : undefined,
    }
  }

  #fatal(error: unknown, activeSessions: number): ServeResult {
    if (error instanceof FrameError) {
      const incompatible =
        error.code === "bad_magic" ||
        error.code === "bad_header" ||
        error.code === "unknown_frame_kind" ||
        error.code === "unsupported_protocol_version"
      return {
        exitCode: incompatible ? EXIT_INCOMPATIBLE : EXIT_INTERNAL_ERROR,
        reason: "fatal",
        drained: false,
        active_sessions: activeSessions,
        interrupted_turns: 0,
        error: { code: error.code, category: "transport", retryable: false, message: error.message },
      }
    }
    return {
      exitCode: EXIT_INTERNAL_ERROR,
      reason: "fatal",
      drained: false,
      active_sessions: activeSessions,
      interrupted_turns: 0,
      error: { code: "internal_error", category: "worker", retryable: false, message: messageOf(error) },
    }
  }
}
