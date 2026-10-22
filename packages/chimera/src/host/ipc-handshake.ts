/**
 * Rust host ↔ Bun worker IPC handshake and capability negotiation (schema v0).
 *
 * Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §5.1 (`hello`/`ready`),
 * §6.1 (version), §6.2 (capabilities), §6.3 / §10 (explicit rejection),
 * §2.3 (connection lifecycle) and §3.5 (limits).
 *
 * This module operates on already-parsed structures only: JSON encode/decode is
 * the caller's responsibility. Like `ipc-frame.ts` it is pure — `Uint8Array`
 * free, no Node `Buffer`, no runtime imports. The only import is the sibling
 * protocol codec's limit constants, which are the same v0 numbers.
 *
 * Host-side flow (§2.3): the worker sends `hello`, `acceptHello` negotiates and
 * returns the `ready` body or a structured reject. A rejected connection must
 * emit that reject as an `error` frame and then close (§6.3); this module never
 * touches the socket.
 */

import { MAX_FRAGMENTS, MAX_FRAME_BYTES, MAX_FRAME_BYTES_HARD, MAX_REASSEMBLED_BYTES } from "./ipc-frame"

/** Body envelope version (§5). v0 bodies carry `v: 1`. */
export const BODY_VERSION = 1

/**
 * §6.1: a host maintains `supported = [1.x]`. Minor upgrades only add optional
 * fields/capabilities (§12.1), so a v0 implementation can speak any 1.x by
 * ignoring what it does not know. `0x01ff` is "all of major 1".
 */
export const HOST_PROTOCOL_MIN = 0x0100
export const HOST_PROTOCOL_MAX = 0x01ff

/** §2.3 candidate defaults; calibrate against H0 baseline + H1 benchmark. */
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const HEARTBEAT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 30_000
export const CANCEL_SOFT_TIMEOUT_MS = 5_000
export const CANCEL_HARD_TIMEOUT_MS = 30_000

/** §6.2: every one of these must be present or the handshake is rejected. */
export const REQUIRED_CAPABILITIES = [
  "frame.v1",
  "control.json",
  "event.batch",
  "cancel",
  "drain",
  "replay.command",
] as const

/** §6.2: the v0 capability vocabulary. Anything else (except `x-*`) is unknown. */
export const KNOWN_CAPABILITIES = [
  ...REQUIRED_CAPABILITIES,
  "encoding.msgpack",
  "encoding.zstd",
  "session.runtime",
  "provider.stream",
  "tool.exec",
  "plugin.loader",
  "graph.read",
  "pty.bridge",
] as const

/** Capabilities this v0 host can actually route. `pty.bridge` is reserved/off. */
const HOST_CAPABILITIES: readonly string[] = KNOWN_CAPABILITIES.filter((capability) => capability !== "pty.bridge")

/** v0 control plane is canonical JSON; msgpack is a candidate data-plane default. */
const HOST_ENCODINGS: readonly string[] = ["json", "msgpack"]

/** v0 negotiates no compression (§3.4, §12.2). */
const HOST_COMPRESSIONS: readonly string[] = []

const KNOWN_CAPABILITY_SET = new Set<string>(KNOWN_CAPABILITIES)

/** `x-` capabilities are extensions the peer may ignore (§6.2). */
const isExtension = (capability: string) => capability.startsWith("x-")

/** §5.1 worker → host `hello` body. */
export interface HelloWorker {
  pid: number
  build: string
  runtime: string
  boot_id: string
}

/** `min`/`max` are `major << 8 | minor` (§6.1). */
export interface HelloProtocol {
  min: number
  max: number
}

export interface HelloLimits {
  /** Largest frame body the worker accepts. Required by v0 (§5.1). */
  max_frame_bytes: number
}

export interface HelloWorkspace {
  directory: string
  project_id: string
}

export interface HelloResume {
  last_acked_command_sequence: number
  stream_epoch: string
}

export interface Hello {
  v: number
  kind: "hello"
  phase: "hello"
  nonce: string
  worker: HelloWorker
  protocol: HelloProtocol
  encodings: string[]
  compressions: string[]
  capabilities: string[]
  limits: HelloLimits
  workspace: HelloWorkspace
  resume?: HelloResume
}

/** §5.1 host → worker `ready` limits (all candidate defaults except the negotiated frame size). */
export interface ReadyLimits {
  max_frame_bytes: number
  max_reassembled_bytes: number
  max_fragments: number
  heartbeat_ms: number
  request_timeout_ms: number
  cancel_soft_timeout_ms: number
  cancel_hard_timeout_ms: number
}

export interface ReadyResume {
  from_command_sequence: number
  replay_available: boolean
}

/**
 * §5.1 host → worker `ready` body. `connection_id` / `worker_generation` are
 * u64 on the wire and are carried as `bigint` here to stay lossless, matching
 * the frame header types. The caller's JSON layer chooses their wire spelling.
 */
export interface Ready {
  v: number
  kind: "hello"
  phase: "ready"
  connection_id: bigint
  worker_generation: bigint
  protocol: number
  encodings: string[]
  compressions: string[]
  capabilities: string[]
  limits: ReadyLimits
  resume: ReadyResume
}

/** §6.3 / §10.2 handshake rejection codes. */
export type HandshakeRejectCode =
  | "bad_header"
  | "unsupported_protocol_version"
  | "capability_missing"
  | "unknown_capability"
  | "unauthorized"
  | "handshake_timeout"
  | "validation_error"

/** §6.3: structured rejection, emitted as an `error` frame before closing. */
export interface HandshakeReject {
  code: HandshakeRejectCode
  message: string
  details: Record<string, unknown>
}

export type HandshakeState = "awaiting_hello" | "negotiating" | "ready" | "rejected"

export type AcceptHelloResult = { ok: true; ready: Ready } | { ok: false; reject: HandshakeReject }

export interface AcceptContext {
  connection_id: bigint
  worker_generation: bigint
  /** One-time nonce handed to the worker at spawn (§2.2). When omitted, not checked. */
  nonce?: string
}

const major = (version: number) => version >> 8
const minor = (version: number) => version & 0xff

/**
 * §6.1 version intersection. Returns the highest minor both sides speak, or
 * `undefined` when the ranges do not overlap. `major << 8 | minor` ordering
 * means the numeric maximum is the highest minor within one major.
 */
export function negotiateProtocol(worker: HelloProtocol): number | undefined {
  const low = Math.max(worker.min, HOST_PROTOCOL_MIN)
  const high = Math.min(worker.max, HOST_PROTOCOL_MAX)
  if (low > high) return undefined
  // Never cross a major boundary: a "1.x ∩ 2.x" request is not a minor upgrade.
  if (major(low) !== major(high)) return undefined
  return high
}

/**
 * §3.5 limits only tighten: the negotiated value is the smallest of the host
 * candidate default, the worker request, and the absolute hard ceiling. An
 * invalid (non-positive / non-integer) request is a `validation_error`.
 */
  export function negotiateMaxFrameBytes(limits: HelloLimits): number | undefined {
  const requested = limits.max_frame_bytes
  if (!Number.isSafeInteger(requested) || requested <= 0) return undefined
  return Math.min(MAX_FRAME_BYTES, requested, MAX_FRAME_BYTES_HARD)
}

const reject = (code: HandshakeRejectCode, message: string, details: Record<string, unknown> = {}): HandshakeReject => ({
  code,
  message,
  details,
})

/**
 * Host-side handshake state machine:
 * `awaiting_hello → negotiating → ready | rejected`.
 *
 * `acceptHello` is the only transition. Calling it outside `awaiting_hello` is a
 * protocol error and yields a `validation_error` reject without changing state.
 */
export class Handshake {
  #state: HandshakeState = "awaiting_hello"
  #ready?: Ready
  #reject?: HandshakeReject

  get state(): HandshakeState {
    return this.#state
  }

  get ready(): Ready | undefined {
    return this.#ready
  }

  get rejection(): HandshakeReject | undefined {
    return this.#reject
  }

  acceptHello(hello: Hello, context: AcceptContext): AcceptHelloResult {
    if (this.#state !== "awaiting_hello")
      return {
        ok: false,
        reject: reject("validation_error", `hello received in state ${this.#state}`, { state: this.#state }),
      }

    this.#state = "negotiating"

    if (context.nonce !== undefined && hello.nonce !== context.nonce)
      return this.#fail(reject("unauthorized", "hello nonce mismatch"))

    const protocol = negotiateProtocol(hello.protocol)
    if (protocol === undefined)
      return this.#fail(
        reject("unsupported_protocol_version", "no common protocol version", {
          worker_protocol: { min: hello.protocol.min, max: hello.protocol.max },
          host_protocol: { min: HOST_PROTOCOL_MIN, max: HOST_PROTOCOL_MAX },
        }),
      )

    // Missing capabilities are reported before unknown ones: the missing list
    // is the actionable error when both conditions hold (Rust-arm order).
    const offered = new Set(hello.capabilities)
    const missing = REQUIRED_CAPABILITIES.filter((capability) => !offered.has(capability))
    if (missing.length > 0)
      return this.#fail(reject("capability_missing", "required capability missing", { missing_capabilities: missing }))

    const unknown = hello.capabilities.filter((capability) => !isExtension(capability) && !KNOWN_CAPABILITY_SET.has(capability))
    if (unknown.length > 0)
      return this.#fail(reject("unknown_capability", "unknown capability", { unknown_capabilities: unknown }))

    const maxFrameBytes = negotiateMaxFrameBytes(hello.limits)
    if (maxFrameBytes === undefined)
      return this.#fail(
        reject("validation_error", "invalid limits.max_frame_bytes", { max_frame_bytes: hello.limits.max_frame_bytes }),
      )

    const encodings = HOST_ENCODINGS.filter((encoding) => hello.encodings.includes(encoding))
    if (!encodings.includes("json"))
      return this.#fail(reject("validation_error", "json encoding is required", { encodings: hello.encodings }))

    this.#state = "ready"
    this.#ready = {
      v: BODY_VERSION,
      kind: "hello",
      phase: "ready",
      connection_id: context.connection_id,
      worker_generation: context.worker_generation,
      protocol,
      encodings,
      compressions: HOST_COMPRESSIONS.filter((compression) => hello.compressions.includes(compression)),
      capabilities: HOST_CAPABILITIES.filter((capability) => offered.has(capability)),
      limits: {
        max_frame_bytes: maxFrameBytes,
        max_reassembled_bytes: MAX_REASSEMBLED_BYTES,
        max_fragments: MAX_FRAGMENTS,
        heartbeat_ms: HEARTBEAT_MS,
        request_timeout_ms: REQUEST_TIMEOUT_MS,
        cancel_soft_timeout_ms: CANCEL_SOFT_TIMEOUT_MS,
        cancel_hard_timeout_ms: CANCEL_HARD_TIMEOUT_MS,
      },
      // §11.3: replay resumes strictly after the last acknowledged command. A
      // fresh worker has no cursor, so replay is not available (Rust-arm rule).
      resume: hello.resume
        ? { from_command_sequence: hello.resume.last_acked_command_sequence + 1, replay_available: true }
        : { from_command_sequence: 1, replay_available: false },
    }
    return { ok: true, ready: this.#ready }
  }

  #fail(rejection: HandshakeReject): { ok: false; reject: HandshakeReject } {
    this.#state = "rejected"
    this.#reject = rejection
    return { ok: false, reject: rejection }
  }
}