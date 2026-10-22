import { describe, expect, test } from "bun:test"
import {
  crc32c,
  decodeFrame,
  decodeHeader,
  encodeFrame,
  Flag,
  FrameError,
  FrameKind,
  FrameReassembler,
  HEADER_BYTES,
  MAX_FRAGMENTS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type Header,
} from "../../src/host/ipc-frame"

const VECTOR = new Uint8Array([
  0x43, 0x48, 0x49, 0x50, 0x00, 0x01, 0x40, 0x00, 0x02, 0x02, 0x00, 0x00, 0x7b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x01, 0x8f, 0x2a, 0x7c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const VECTOR_CORRELATION = new Uint8Array([
  0x01, 0x8f, 0x2a, 0x7c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8,
])

function header(overrides: Partial<Header> = {}): Header {
  return {
    protocol_version: PROTOCOL_VERSION,
    frame_kind: FrameKind.request,
    flags: Flag.DURABLE,
    payload_length: 0,
    connection_id: 1n,
    worker_generation: 7n,
    sequence: 1n,
    correlation_id: new Uint8Array(16).fill(0x11),
    payload_crc32c: 0,
    ...overrides,
  }
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof FrameError ? error.code : `${error}`
  }
  return "no-error"
}

function bytes(value: number, length: number) {
  return new Uint8Array(length).fill(value)
}

/** Deterministic PRNG so property-style checks stay reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("IPC v0 header", () => {
  test("§16.1 fixed vector encodes byte-for-byte", () => {
    const encoded = encodeFrame(header({ payload_length: 123, correlation_id: VECTOR_CORRELATION }), bytes(0, 123))
    expect(encoded.length).toBe(HEADER_BYTES + 123)
    expect(Array.from(encoded.slice(0, HEADER_BYTES))).toEqual(Array.from(VECTOR))
  })

  test("§16.1 fixed vector decodes to the documented fields", () => {
    const decoded = decodeHeader(VECTOR)
    expect(decoded.protocol_version).toBe(0x0100)
    expect(decoded.frame_kind).toBe(FrameKind.request)
    expect(decoded.flags).toBe(Flag.DURABLE)
    expect(decoded.payload_length).toBe(123)
    expect(decoded.connection_id).toBe(1n)
    expect(decoded.worker_generation).toBe(7n)
    expect(decoded.sequence).toBe(1n)
    expect(Array.from(decoded.correlation_id)).toEqual(Array.from(VECTOR_CORRELATION))
    expect(decoded.payload_crc32c).toBe(0)
  })

  test("header-only vector is rejected before the body is read", () => {
    expect(codeOf(() => decodeFrame(VECTOR))).toBe("decode_error")
  })
})

describe("§16.2 transport scenarios", () => {
  test("1: bad magic is bad_magic", () => {
    const corrupt = VECTOR.slice()
    corrupt[0] = 0x00
    expect(codeOf(() => decodeHeader(corrupt))).toBe("bad_magic")
    expect(codeOf(() => decodeFrame(corrupt))).toBe("bad_magic")
  })

  test("2: payload_length = MAX_FRAME_BYTES + 1 is frame_too_large", () => {
    const corrupt = VECTOR.slice()
    new DataView(corrupt.buffer).setUint32(12, MAX_FRAME_BYTES + 1, true)
    expect(codeOf(() => decodeHeader(corrupt))).toBe("frame_too_large")
  })

  test("16: unknown frame_kind is unknown_frame_kind", () => {
    const corrupt = VECTOR.slice()
    corrupt[8] = 99
    expect(codeOf(() => decodeHeader(corrupt))).toBe("unknown_frame_kind")
  })

  test("17: MORE fragments beyond MAX_FRAGMENTS is payload_too_large", () => {
    const reassembler = new FrameReassembler()
    Array.from({ length: MAX_FRAGMENTS }).forEach(() => {
      expect(reassembler.push(header({ flags: Flag.MORE }), bytes(1, 1))).toBeUndefined()
    })
    expect(codeOf(() => reassembler.push(header({ flags: Flag.MORE }), bytes(1, 1)))).toBe("payload_too_large")
  })

  test("18: COMPRESSED without negotiation is decode_error", () => {
    const frame = encodeFrame(header({ flags: Flag.COMPRESSED, payload_length: 4 }), bytes(0, 4))
    expect(codeOf(() => decodeFrame(frame))).toBe("decode_error")
    expect(decodeFrame(frame, { compressedNegotiated: true }).payload.length).toBe(4)
  })
})

describe("CRC32C", () => {
  test("known vector 123456789 -> 0xE3069283", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283)
  })

  test("empty input is 0", () => {
    expect(crc32c(new Uint8Array(0))).toBe(0)
  })

  test("CHECKSUM frames round-trip and reject corruption", () => {
    const payload = new TextEncoder().encode("durable body")
    const frame = encodeFrame(header({ flags: Flag.DURABLE | Flag.CHECKSUM, payload_length: payload.length }), payload)
    expect(decodeFrame(frame).payload).toEqual(payload)

    const corrupt = frame.slice()
    corrupt[HEADER_BYTES] ^= 0xff
    expect(codeOf(() => decodeFrame(corrupt))).toBe("decode_error")
  })
})

describe("reassembly", () => {
  test("joins MORE fragments and returns the payload on the final frame", () => {
    const reassembler = new FrameReassembler()
    expect(reassembler.push(header({ flags: Flag.MORE }), new Uint8Array([1, 2]))).toBeUndefined()
    expect(reassembler.push(header({ flags: Flag.MORE }), new Uint8Array([3]))).toBeUndefined()
    expect(Array.from(reassembler.push(header({ flags: Flag.FINAL }), new Uint8Array([4]))!)).toEqual([1, 2, 3, 4])
  })

  test("a single frame passes through unchanged", () => {
    const reassembler = new FrameReassembler()
    expect(Array.from(reassembler.push(header({ flags: Flag.FINAL }), new Uint8Array([9]))!)).toEqual([9])
  })

  test("reassembled byte guard rejects oversized messages", () => {
    const reassembler = new FrameReassembler({ maxReassembledBytes: 4 })
    expect(reassembler.push(header({ flags: Flag.MORE }), bytes(1, 3))).toBeUndefined()
    expect(codeOf(() => reassembler.push(header({ flags: Flag.MORE }), bytes(1, 2)))).toBe("payload_too_large")
  })

  test("a checksum failure discards the partial message", () => {
    const reassembler = new FrameReassembler()
    expect(reassembler.push(header({ flags: Flag.MORE }), new Uint8Array([1, 2]))).toBeUndefined()
    expect(codeOf(() => reassembler.push(header({ flags: Flag.CHECKSUM, payload_crc32c: 0xffff }), new Uint8Array([3])))).toBe(
      "decode_error",
    )
    // State was reset: a fresh single frame passes through cleanly.
    expect(Array.from(reassembler.push(header({ flags: Flag.FINAL }), new Uint8Array([9]))!)).toEqual([9])
  })

  test("a bounds violation discards the partial message", () => {
    const reassembler = new FrameReassembler({ maxReassembledBytes: 4 })
    expect(reassembler.push(header({ flags: Flag.MORE }), bytes(1, 3))).toBeUndefined()
    expect(codeOf(() => reassembler.push(header({ flags: Flag.MORE }), bytes(1, 2)))).toBe("payload_too_large")
    expect(Array.from(reassembler.push(header({ flags: Flag.FINAL }), new Uint8Array([7]))!)).toEqual([7])
  })
})

describe("round-trip", () => {
  test("random frames survive encode -> decode -> encode", () => {
    const random = mulberry32(0x5eed)
    const pick = (limit: number) => Math.floor(random() * limit)
    const uint64 = () => BigInt(pick(Number.MAX_SAFE_INTEGER))

    Array.from({ length: 200 }).forEach(() => {
      const payload = Uint8Array.from({ length: pick(256) }, () => pick(256))
      const input = header({
        frame_kind: Object.values(FrameKind)[pick(9)],
        flags: pick(0x40) & 0x3f,
        payload_length: payload.length,
        connection_id: uint64(),
        worker_generation: uint64(),
        sequence: uint64(),
        correlation_id: Uint8Array.from({ length: 16 }, () => pick(256)),
      })
      const encoded = encodeFrame(input, payload)
      const decoded = decodeFrame(encoded, { compressedNegotiated: true })

      expect(decoded.header.protocol_version).toBe(input.protocol_version)
      expect(decoded.header.frame_kind).toBe(input.frame_kind)
      expect(decoded.header.flags).toBe(input.flags)
      expect(decoded.header.payload_length).toBe(input.payload_length)
      expect(decoded.header.connection_id).toBe(input.connection_id)
      expect(decoded.header.worker_generation).toBe(input.worker_generation)
      expect(decoded.header.sequence).toBe(input.sequence)
      expect(Array.from(decoded.header.correlation_id)).toEqual(Array.from(input.correlation_id))
      expect(Array.from(decoded.payload)).toEqual(Array.from(payload))
      expect(Array.from(encodeFrame(decoded.header, decoded.payload))).toEqual(Array.from(encoded))
    })
  })

  test("truncated input never reads out of bounds", () => {
    const frame = encodeFrame(header({ payload_length: 32 }), bytes(7, 32))
    const codes = Array.from({ length: frame.length }, (_, length) =>
      length < HEADER_BYTES ? codeOf(() => decodeHeader(frame.slice(0, length))) : codeOf(() => decodeFrame(frame.slice(0, length))),
    )
    // Truncation is `decode_error` at every prefix of a well-formed frame.
    expect(new Set(codes)).toEqual(new Set(["decode_error"]))
  })
})

describe("golden vectors (shared with the Rust arm)", () => {
  // chimera-host/tests/vectors/ipc-frame-v0.hex is generated from this module
  // and asserted byte-identically by chimera-host/tests/ipc_frame_vectors.rs.
  const vectors = (() => {
    const text = require("fs").readFileSync(
      require("path").join(import.meta.dirname, "../../../../chimera-host/tests/vectors/ipc-frame-v0.hex"),
      "utf-8",
    ) as string
    return text.split("\n").filter((line: string) => line.length > 0)
  })()

  const unhex = (input: string) => Uint8Array.from(input.match(/../g)!.map((pair) => parseInt(pair, 16)))

  test("every shared vector decodes and re-encodes byte-identically", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20)
    for (const line of vectors) {
      const [name, frameHex] = line.split("|")
      const frame = unhex(frameHex)
      const decoded = decodeFrame(frame, { compressedNegotiated: true })
      expect(Array.from(encodeFrame(decoded.header, decoded.payload))).toEqual(Array.from(frame))
    }
  })
})