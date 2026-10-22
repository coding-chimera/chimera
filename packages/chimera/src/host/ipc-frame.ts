/**
 * Rust host ↔ Bun worker IPC frame codec (schema v0).
 *
 * Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §3 (frame layout),
 * §3.3 (`frame_kind`), §3.4 (`flags`), §3.5 (limits), §10.2 (transport codes)
 * and §16 (test vectors).
 *
 * This module is deliberately pure: `Uint8Array` + `DataView` only, no Node
 * `Buffer`, no runtime imports. It is not wired into any existing module yet.
 */

export const MAGIC = 0x50494843
export const HEADER_BYTES = 64
export const PROTOCOL_VERSION = 0x0100
export const CORRELATION_ID_BYTES = 16

/** §3.5 candidate defaults. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const MAX_FRAME_BYTES_HARD = 16 * 1024 * 1024
export const MAX_REASSEMBLED_BYTES = 32 * 1024 * 1024
export const MAX_FRAGMENTS = 256

/** §3.3 */
export const FrameKind = {
  hello: 1,
  request: 2,
  response: 3,
  event: 4,
  ack: 5,
  cancel: 6,
  drain: 7,
  error: 8,
  replay: 9,
} as const

/** §3.4 */
export const Flag = {
  MORE: 0x0001,
  DURABLE: 0x0002,
  REPLAYABLE: 0x0004,
  COMPRESSED: 0x0008,
  FINAL: 0x0010,
  CHECKSUM: 0x0020,
} as const

export const FLAG_KNOWN_MASK =
  Flag.MORE | Flag.DURABLE | Flag.REPLAYABLE | Flag.COMPRESSED | Flag.FINAL | Flag.CHECKSUM

/** Transport-level codes from §10.2. A magic mismatch surfaces as the more
 * specific `bad_magic`; §16.2 scenario 1's `bad_header` wording is read as
 * "header-class rejection". Truncated input is `decode_error`. */
export type FrameErrorCode =
  | "bad_magic"
  | "bad_header"
  | "frame_too_large"
  | "payload_too_large"
  | "decode_error"
  | "unknown_frame_kind"
  | "unsupported_protocol_version"

export class FrameError extends Error {
  readonly code: FrameErrorCode
  readonly category = "transport" as const
  readonly retryable = false

  constructor(code: FrameErrorCode, message: string) {
    super(message)
    this.name = "FrameError"
    this.code = code
  }
}

/** Decoded 64-byte header. `magic`, `header_len` and both reserved fields are
 * validated and therefore not represented. `sequence` is the canonical wire
 * name of `transport_sequence` (§3.2). */
export interface Header {
  protocol_version: number
  frame_kind: number
  flags: number
  payload_length: number
  connection_id: bigint
  worker_generation: bigint
  sequence: bigint
  correlation_id: Uint8Array
  payload_crc32c: number
}

export interface Frame {
  header: Header
  payload: Uint8Array
}

export interface DecodeOptions {
  /** `COMPRESSED` bodies require an explicit v0 zstd negotiation (§3.4, §16.2
   * scenario 18). Decompression itself is out of this codec's scope. */
  compressedNegotiated?: boolean
}

const CRC32C_POLY = 0x82f63b78

const CRC32C_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  const crc = Array.from({ length: 8 }).reduce<number>(
    (value) => (value & 1 ? (value >>> 1) ^ CRC32C_POLY : value >>> 1),
    index,
  )
  return crc >>> 0
})

/** Table-driven CRC32C (Castagnoli). Known vector: "123456789" → 0xE3069283. */
export function crc32c(data: Uint8Array): number {
  return (data.reduce((crc, byte) => CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0
}

const FRAME_KIND_VALUES: readonly number[] = Object.values(FrameKind)

const isFrameKind = (value: number) => FRAME_KIND_VALUES.includes(value)

/** Encode one frame. When `CHECKSUM` is set the CRC is computed from `payload`;
 * otherwise `payload_crc32c` is written as 0 (§3.2). */
export function encodeFrame(header: Header, payload: Uint8Array): Uint8Array {
  validateOutgoing(header, payload.length)

  const bytes = new Uint8Array(HEADER_BYTES + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint16(4, header.protocol_version, true)
  view.setUint16(6, HEADER_BYTES, true)
  view.setUint8(8, header.frame_kind)
  view.setUint16(9, header.flags, true)
  view.setUint8(11, 0)
  view.setUint32(12, payload.length, true)
  view.setBigUint64(16, header.connection_id, true)
  view.setBigUint64(24, header.worker_generation, true)
  view.setBigUint64(32, header.sequence, true)
  bytes.set(header.correlation_id, 40)
  view.setUint32(56, header.flags & Flag.CHECKSUM ? crc32c(payload) : 0, true)
  view.setUint32(60, 0, true)
  bytes.set(payload, HEADER_BYTES)
  return bytes
}

/** Decode and validate a header without touching the body. Every rejection in
 * §3.2/§3.5 happens here, before any body-sized allocation. */
export function decodeHeader(bytes: Uint8Array): Header {
  // Early magic rejection as soon as 4 bytes are available, matching the Rust
  // arm; a shorter buffer is `decode_error` (truncation, not a bad value).
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) !== MAGIC)
    throw new FrameError("bad_magic", "bad magic")
  if (bytes.length < HEADER_BYTES)
    throw new FrameError("decode_error", `truncated header: ${bytes.length} < ${HEADER_BYTES}`)

  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES)
  if (view.getUint16(6, true) !== HEADER_BYTES)
    throw new FrameError("bad_header", `bad header_len: ${view.getUint16(6, true)}`)
  if (view.getUint8(11) !== 0) throw new FrameError("bad_header", "reserved0 must be 0")
  if (view.getUint32(60, true) !== 0) throw new FrameError("bad_header", "reserved1 must be 0")

  // Version negotiation belongs to the handshake layer (§6.1): a hello from a
  // different version must still parse so it can be rejected with a structured
  // error. `protocol_version` is therefore parsed but not rejected here.
  const protocol_version = view.getUint16(4, true)

  const flags = view.getUint16(9, true)
  if (flags & ~FLAG_KNOWN_MASK) throw new FrameError("bad_header", `unknown flags: 0x${(flags & ~FLAG_KNOWN_MASK).toString(16)}`)

  const frame_kind = view.getUint8(8)
  if (!isFrameKind(frame_kind)) throw new FrameError("unknown_frame_kind", `unknown frame_kind: ${frame_kind}`)

  const payload_length = view.getUint32(12, true)
  if (payload_length > MAX_FRAME_BYTES)
    throw new FrameError("frame_too_large", `payload_length ${payload_length} > ${MAX_FRAME_BYTES}`)

  return {
    protocol_version,
    frame_kind,
    flags,
    payload_length,
    connection_id: view.getBigUint64(16, true),
    worker_generation: view.getBigUint64(24, true),
    sequence: view.getBigUint64(32, true),
    correlation_id: bytes.slice(40, 56),
    payload_crc32c: view.getUint32(56, true),
  }
}

/** Decode one frame from the front of `bytes`. Trailing bytes are ignored so a
 * stream buffer can be consumed incrementally. */
export function decodeFrame(bytes: Uint8Array, options: DecodeOptions = {}): Frame {
  const header = decodeHeader(bytes)

  if (header.flags & Flag.COMPRESSED && !options.compressedNegotiated)
    throw new FrameError("decode_error", "COMPRESSED frame without negotiated compression")

  const end = HEADER_BYTES + header.payload_length
  if (bytes.length < end)
    throw new FrameError("decode_error", `truncated body: ${bytes.length - HEADER_BYTES} < ${header.payload_length}`)

  const payload = bytes.slice(HEADER_BYTES, end)
  if (header.flags & Flag.CHECKSUM && crc32c(payload) !== header.payload_crc32c)
    throw new FrameError("decode_error", "payload_crc32c mismatch")

  return { header, payload }
}

export interface ReassemblerOptions {
  maxFragments?: number
  maxReassembledBytes?: number
}

/** Reassembly guard for `MORE` fragments (§3.5, §16.2 scenario 17). `push`
 * returns `undefined` while a logical message is still open and the joined
 * payload on the final fragment. */
export class FrameReassembler {
  #maxFragments: number
  #maxReassembledBytes: number
  #fragments = 0
  #bytes = 0
  #chunks: Uint8Array[] = []

  constructor(options: ReassemblerOptions = {}) {
    this.#maxFragments = options.maxFragments ?? MAX_FRAGMENTS
    this.#maxReassembledBytes = options.maxReassembledBytes ?? MAX_REASSEMBLED_BYTES
  }

  push(header: Header, payload: Uint8Array): Uint8Array | undefined {
    // Per-fragment integrity, matching the Rust arm: a checksum failure or a
    // bounds violation discards the partial message.
    if (header.flags & Flag.CHECKSUM && crc32c(payload) !== header.payload_crc32c) {
      this.#reset()
      throw new FrameError("decode_error", "payload_crc32c mismatch")
    }

    const fragments = this.#fragments + 1
    if (fragments > this.#maxFragments) {
      this.#reset()
      throw new FrameError("payload_too_large", `fragment count ${fragments} > ${this.#maxFragments}`)
    }

    const bytes = this.#bytes + payload.length
    if (bytes > this.#maxReassembledBytes) {
      this.#reset()
      throw new FrameError("payload_too_large", `reassembled bytes ${bytes} > ${this.#maxReassembledBytes}`)
    }

    if (header.flags & Flag.MORE) {
      this.#fragments = fragments
      this.#bytes = bytes
      this.#chunks.push(payload.slice())
      return undefined
    }

    const chunks = this.#chunks
    const total = bytes
    this.#reset()
    if (chunks.length === 0) return payload.slice()

    const joined = new Uint8Array(total)
    chunks.reduce((offset, chunk) => {
      joined.set(chunk, offset)
      return offset + chunk.length
    }, 0)
    joined.set(payload, total - payload.length)
    return joined
  }

  #reset() {
    this.#fragments = 0
    this.#bytes = 0
    this.#chunks = []
  }
}

function validateOutgoing(header: Header, payloadLength: number) {
  if (header.protocol_version !== PROTOCOL_VERSION)
    throw new FrameError("unsupported_protocol_version", `unsupported protocol_version: ${header.protocol_version}`)
  if (!isFrameKind(header.frame_kind))
    throw new FrameError("unknown_frame_kind", `unknown frame_kind: ${header.frame_kind}`)
  if (header.flags & ~FLAG_KNOWN_MASK)
    throw new FrameError("bad_header", `unknown flags: 0x${(header.flags & ~FLAG_KNOWN_MASK).toString(16)}`)
  if (header.correlation_id.length !== CORRELATION_ID_BYTES)
    throw new FrameError("bad_header", `correlation_id must be ${CORRELATION_ID_BYTES} bytes`)
  if (payloadLength > MAX_FRAME_BYTES)
    throw new FrameError("frame_too_large", `payload_length ${payloadLength} > ${MAX_FRAME_BYTES}`)
  // `payload_length` on the wire is derived from the payload itself (same as
  // the Rust arm); the header field is decode-side information, not asserted.
}