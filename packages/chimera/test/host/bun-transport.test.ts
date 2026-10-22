import { describe, expect, test } from "bun:test"
import { BunTransport, TRANSPORT_WRITE_QUEUE_FRAMES, TransportClosedError } from "../../src/host/bun-transport"
import type { OutgoingHeader } from "../../src/host/ipc-connection"
import { CORRELATION_ID_BYTES, decodeFrame, encodeFrame, Flag, FrameKind, PROTOCOL_VERSION } from "../../src/host/ipc-frame"

const PAYLOAD = new TextEncoder().encode('{"method":"test.echo"}')

const header = (): OutgoingHeader => ({
  protocol_version: PROTOCOL_VERSION,
  frame_kind: FrameKind.request,
  flags: Flag.FINAL,
  connection_id: 1n,
  worker_generation: 1n,
  correlation_id: new Uint8Array(CORRELATION_ID_BYTES),
  payload_crc32c: 0,
})

const frameBytes = (sequence = 1n) =>
  encodeFrame({ ...header(), payload_length: PAYLOAD.length, sequence }, PAYLOAD)

interface FakeSocket {
  socket: {
    write(data: Uint8Array): number
    end(): void
  }
  writes: Uint8Array[]
  ended: boolean
}

/** In-memory socket: no real fd, `write` behavior is injectable. */
function fakeSocket(write?: (data: Uint8Array) => number): FakeSocket {
  const fake: FakeSocket = {
    writes: [],
    ended: false,
    socket: {
      write(data) {
        if (write !== undefined) return write(data)
        fake.writes.push(data.slice())
        return data.length
      },
      end() {
        fake.ended = true
      },
    },
  }
  return fake
}

const open = (transport: BunTransport, fake: FakeSocket) => transport.handlers.open(fake.socket)

describe("BunTransport", () => {
  test("sends writer frames to the socket sink", async () => {
    const transport = new BunTransport()
    const fake = fakeSocket()
    open(transport, fake)

    await transport.writer.send(header(), PAYLOAD)

    expect(fake.writes).toHaveLength(1)
    const decoded = decodeFrame(fake.writes[0])
    expect(decoded.header.sequence).toBe(1n)
    expect(decoded.payload).toEqual(PAYLOAD)
  })

  test("reassembles inbound chunks from the data handler", async () => {
    const transport = new BunTransport()
    const fake = fakeSocket()
    open(transport, fake)

    const bytes = frameBytes()
    transport.handlers.data(fake.socket, bytes.subarray(0, 10))
    transport.handlers.data(fake.socket, bytes.subarray(10))

    const frame = await transport.reader.next()
    expect(frame?.payload).toEqual(PAYLOAD)
  })

  test("retries partial writes in order", async () => {
    const transport = new BunTransport()
    const fake = fakeSocket((data) => {
      const written = Math.min(3, data.length)
      fake.writes.push(data.slice(0, written))
      return written
    })
    open(transport, fake)

    await transport.writer.send(header(), PAYLOAD)

    const joined = Uint8Array.from(fake.writes.flatMap((chunk) => Array.from(chunk)))
    const decoded = decodeFrame(joined)
    expect(decoded.header.sequence).toBe(1n)
    expect(decoded.payload).toEqual(PAYLOAD)
  })

  test("applies backpressure until the socket drains", async () => {
    const transport = new BunTransport()
    let blocked = true
    const fake = fakeSocket((data) => {
      if (blocked) return 0
      fake.writes.push(data.slice())
      return data.length
    })
    open(transport, fake)

    const sent = transport.writer.send(header(), PAYLOAD)
    expect(fake.writes).toHaveLength(0)
    expect(transport.queuedFrames).toBe(1)

    blocked = false
    transport.handlers.drain(fake.socket)
    await sent

    expect(fake.writes).toHaveLength(1)
    expect(transport.queuedFrames).toBe(0)
  })

  test("bounds the write queue by admitting at most maxQueuedFrames", async () => {
    const transport = new BunTransport({ maxQueuedFrames: 1 })
    let blocked = true
    const fake = fakeSocket((data) => {
      if (blocked) return 0
      fake.writes.push(data.slice())
      return data.length
    })
    open(transport, fake)

    const first = transport.writer.send(header(), PAYLOAD)
    const second = transport.writer.send(header(), PAYLOAD)
    expect(transport.queuedFrames).toBe(1)

    blocked = false
    transport.handlers.drain(fake.socket)
    await Promise.all([first, second])

    expect(transport.queuedFrames).toBe(0)
    expect(fake.writes).toHaveLength(2)
  })

  test("closes the reader and rejects pending writes on close", async () => {
    const transport = new BunTransport()
    const fake = fakeSocket(() => 0)
    open(transport, fake)

    const rejected = transport.writer.send(header(), PAYLOAD).catch((error) => error)
    transport.handlers.close(fake.socket)

    expect(await rejected).toBeInstanceOf(TransportClosedError)
    expect(transport.closed).toBe(true)
    expect(await transport.reader.next()).toBeUndefined()
  })

  test("maps socket errors to reader end and records the failure", async () => {
    const transport = new BunTransport()
    const fake = fakeSocket()
    open(transport, fake)

    const failure = new Error("connection reset")
    transport.handlers.error(fake.socket, failure)

    expect(transport.failure).toBe(failure)
    expect(transport.closed).toBe(true)
    expect(await transport.reader.next()).toBeUndefined()
  })

  test("uses the documented candidate queue default", () => {
    expect(TRANSPORT_WRITE_QUEUE_FRAMES).toBeGreaterThan(0)
    expect(() => new BunTransport({ maxQueuedFrames: 0 })).toThrow(RangeError)
  })
})