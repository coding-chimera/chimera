import { describe, expect, test } from "bun:test"
import {
  encodeFrame,
  Flag,
  FrameError,
  FrameKind,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from "../../src/host/ipc-frame"
import { FrameReader, FrameWriter, type OutgoingHeader, type SequenceGap } from "../../src/host/ipc-connection"

function header(overrides: Partial<OutgoingHeader> = {}): OutgoingHeader {
  return {
    protocol_version: PROTOCOL_VERSION,
    frame_kind: FrameKind.event,
    flags: Flag.DURABLE,
    connection_id: 1n,
    worker_generation: 7n,
    correlation_id: new Uint8Array(16).fill(0x11),
    payload_crc32c: 0,
    ...overrides,
  }
}

function encode(sequence: bigint, flags: number, payload: Uint8Array): Uint8Array {
  return encodeFrame({ ...header({ flags }), payload_length: payload.length, sequence }, payload)
}

function bytes(value: number, length: number): Uint8Array {
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

async function* chunks(parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part
}

async function collect(reader: FrameReader) {
  const frames = []
  while (true) {
    const next = await reader.next()
    if (next === undefined) return frames
    frames.push(next)
  }
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof FrameError ? error.code : `${error}`
  }
  return "no-error"
}

describe("FrameWriter", () => {
  test("stamps transport_sequence from 1 and forwards whole frames", async () => {
    const written: Uint8Array[] = []
    const writer = new FrameWriter((value) => {
      written.push(value.slice())
    })

    const first = await writer.send(header(), bytes(0xa1, 4))
    const second = await writer.send(header(), bytes(0xb2, 2))

    expect(first.sequence).toBe(1n)
    expect(second.sequence).toBe(2n)
    expect(writer.sequence).toBe(3n)
    expect(writer.sent).toBe(2)
    expect(written.map((value) => value.length)).toEqual([HEADER_BYTES + 4, HEADER_BYTES + 2])

    const reader = new FrameReader(chunks(written))
    const frames = await collect(reader)
    expect(frames.map((value) => value.header.sequence)).toEqual([1n, 2n])
    expect(Array.from(frames[0].payload)).toEqual(Array.from(bytes(0xa1, 4)))
  })

  test("propagates sink errors without consuming a sequence number", async () => {
    const writer = new FrameWriter(() => {
      throw new Error("socket closed")
    })

    expect(await codeOf(writer.send(header(), bytes(0, 1)))).toBe("Error: socket closed")
    expect(writer.sequence).toBe(1n)
    expect(writer.sent).toBe(0)
  })
})

describe("FrameReader framing", () => {
  test("passes a whole frame through", async () => {
    const encoded = encode(1n, Flag.DURABLE, bytes(0x42, 8))
    const reader = new FrameReader(chunks([encoded]))

    const next = await reader.next()
    expect(next?.header.sequence).toBe(1n)
    expect(Array.from(next?.payload ?? [])).toEqual(Array.from(bytes(0x42, 8)))
    expect(await reader.next()).toBeUndefined()
  })

  test("restores a frame fed one byte at a time", async () => {
    const encoded = encode(1n, Flag.DURABLE, bytes(0x5a, 32))
    const reader = new FrameReader(chunks(Array.from(encoded, (value) => new Uint8Array([value]))))

    const next = await reader.next()
    expect(next?.header.payload_length).toBe(32)
    expect(Array.from(next?.payload ?? [])).toEqual(Array.from(bytes(0x5a, 32)))
    expect(reader.pendingBytes).toBe(0)
  })

  test("restores multiple frames split at deterministic random points", async () => {
    const encoded = [0, 1, 2, 3].map((index) => encode(BigInt(index + 1), Flag.DURABLE, bytes(index + 1, 10 + index * 7)))
    const joined = new Uint8Array(encoded.reduce((total, value) => total + value.length, 0))
    encoded.reduce((offset, value) => {
      joined.set(value, offset)
      return offset + value.length
    }, 0)

    const random = mulberry32(0x51ce)
    const parts: Uint8Array[] = []
    joined.reduce((offset) => {
      const size = 1 + Math.floor(random() * 9)
      parts.push(joined.slice(offset, offset + size))
      return offset + size
    }, 0)
    // `reduce` stops before the final tail; append any remainder explicitly.
    const consumed = parts.reduce((total, value) => total + value.length, 0)
    if (consumed < joined.length) parts.push(joined.slice(consumed))

    const reader = new FrameReader(chunks(parts))
    const frames = await collect(reader)
    expect(frames.map((value) => value.header.sequence)).toEqual([1n, 2n, 3n, 4n])
    expect(frames.map((value) => value.payload.length)).toEqual([10, 17, 24, 31])
  })

  test("queues consecutive frames from one chunk and reports pending counts", async () => {
    const encoded = [0, 1, 2].map((index) => encode(BigInt(index + 1), Flag.DURABLE, bytes(index, 3)))
    const reader = new FrameReader(chunks([new Uint8Array(encoded.flatMap((value) => Array.from(value)))]))

    const first = await reader.next()
    expect(first?.header.sequence).toBe(1n)
    expect(reader.pendingFrames).toBe(2)
    expect(reader.pendingBytes).toBe(2 * (HEADER_BYTES + 3))
    expect((await collect(reader)).map((value) => value.header.sequence)).toEqual([2n, 3n])
  })

  test("a half frame waits without error and only fails at end of stream", async () => {
    const encoded = encode(1n, Flag.DURABLE, bytes(0x77, 16))
    const reader = new FrameReader(chunks([encoded.slice(0, HEADER_BYTES + 4)]))

    expect(await codeOf(reader.next())).toBe("decode_error")
    expect(reader.pendingBytes).toBe(HEADER_BYTES + 4)
  })
})

describe("FrameReader sequence tracking (§7.3)", () => {
  test("rejects a durable gap with sequence_gap", async () => {
    const reader = new FrameReader(chunks([encode(1n, Flag.DURABLE, bytes(1, 2)), encode(3n, Flag.DURABLE, bytes(3, 2))]))

    expect((await reader.next())?.header.sequence).toBe(1n)
    expect(await codeOf(reader.next())).toBe("sequence_gap")
    expect(reader.expectedSequence).toBe(2n)
  })

  test("counts a transient gap and keeps going", async () => {
    const gaps: SequenceGap[] = []
    const reader = new FrameReader(
      chunks([encode(1n, 0, bytes(1, 2)), encode(3n, 0, bytes(3, 2)), encode(4n, 0, bytes(4, 2))]),
      { onGap: (gap) => gaps.push(gap) },
    )

    const frames = await collect(reader)
    expect(frames.map((value) => value.header.sequence)).toEqual([1n, 3n, 4n])
    expect(reader.gapCount).toBe(1)
    expect(gaps).toEqual([{ expected: 2n, received: 3n, skipped: 1n, durable: false }])
    expect(reader.expectedSequence).toBe(5n)
  })

  test("treats a behind sequence as a transient gap without deduplicating", async () => {
    const reader = new FrameReader(chunks([encode(1n, 0, bytes(1, 2)), encode(1n, 0, bytes(1, 2)), encode(2n, 0, bytes(2, 2))]))

    const frames = await collect(reader)
    expect(frames.map((value) => value.header.sequence)).toEqual([1n, 1n, 2n])
    expect(reader.gapCount).toBe(1)
  })
})

describe("FrameReader bounds", () => {
  test("rejects a payload_length over MAX_FRAME_BYTES before buffering the body", async () => {
    const encoded = encode(1n, Flag.DURABLE, bytes(0, 0)).slice()
    new DataView(encoded.buffer).setUint32(12, MAX_FRAME_BYTES + 1, true)
    const reader = new FrameReader(chunks([encoded]))

    expect(await codeOf(reader.next())).toBe("frame_too_large")
  })

  test("rejects a buffered partial frame beyond maxBufferBytes", async () => {
    const encoded = encode(1n, Flag.DURABLE, bytes(0x33, 100))
    const reader = new FrameReader(chunks([encoded.slice(0, HEADER_BYTES + 20)]), { maxBufferBytes: HEADER_BYTES + 10 })

    expect(await codeOf(reader.next())).toBe("frame_too_large")
  })
})

describe("FrameReader message reassembly", () => {
  test("joins MORE fragments into one logical message", async () => {
    const reader = new FrameReader(
      chunks([
        encode(1n, Flag.MORE | Flag.DURABLE, bytes(0x01, 3)),
        encode(2n, Flag.MORE | Flag.DURABLE, bytes(0x02, 4)),
        encode(3n, Flag.DURABLE, bytes(0x03, 5)),
      ]),
    )

    const message = await reader.nextMessage()
    expect(message?.header.sequence).toBe(3n)
    expect(Array.from(message?.payload ?? [])).toEqual([1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3])
    expect(await reader.nextMessage()).toBeUndefined()
  })

  test("returns an unfragmented frame as-is from nextMessage", async () => {
    const reader = new FrameReader(chunks([encode(1n, Flag.DURABLE, bytes(0x09, 6))]))

    const message = await reader.nextMessage()
    expect(message?.header.sequence).toBe(1n)
    expect(Array.from(message?.payload ?? [])).toEqual(Array.from(bytes(0x09, 6)))
  })

  test("rejects end of stream in the middle of a fragmented message", async () => {
    const reader = new FrameReader(chunks([encode(1n, Flag.MORE | Flag.DURABLE, bytes(0x01, 3))]))

    expect(await codeOf(reader.nextMessage())).toBe("decode_error")
  })
})