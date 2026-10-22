/**
 * Bun Unix-socket transport for the Rust host ↔ Bun worker IPC (schema v0).
 *
 * Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §2.1 (local byte
 * stream), §2.3 (connection lifecycle) and §9.1 (bounded queues/backpressure).
 *
 * This is the only host module that knows about `Bun.connect`. It adapts one
 * connected Unix socket into the injected `FrameWriter` sink and `FrameReader`
 * source, so `worker-bootstrap.ts` stays transport agnostic. The narrow
 * `BunSocketLike` surface keeps the adapter unit-testable with an in-memory
 * fake socket (no real socket is opened by the tests).
 *
 * Backpressure: `FrameWriter.send` awaits the sink. The sink admits at most
 * `TRANSPORT_WRITE_QUEUE_FRAMES` frames; further writers wait for a completed
 * write before enqueueing, so a slow peer applies pressure instead of growing
 * the queue. Partial `Socket.write` results are retried in order and a `0`
 * result parks the queue until Bun's `drain` handler fires.
 */

import { FrameReader, FrameWriter, type FrameSink } from "./ipc-connection"
import { MAX_FRAME_BYTES } from "./ipc-frame"

/**
 * §9.1 candidate default: frames the write queue admits before writers block.
 * Each frame is itself bounded by `MAX_FRAME_BYTES`, so the queue memory bound
 * is `TRANSPORT_WRITE_QUEUE_FRAMES * MAX_FRAME_BYTES` in the worst case.
 */
export const TRANSPORT_WRITE_QUEUE_FRAMES = 64

/** Transport failure raised when the socket closes under a pending write. */
export class TransportClosedError extends Error {
  readonly code = "transport_closed"

  constructor(message = "transport is closed", options?: { cause?: unknown }) {
    super(message, options)
    this.name = "TransportClosedError"
  }
}

/** Minimal connected-socket surface; Bun's `Socket` satisfies it. */
export interface BunSocketLike {
  write(data: Uint8Array): number
  end(): unknown
}

/**
 * Handlers passed to `Bun.connect({ unix, socket })`. Kept structural so the
 * adapter can be driven directly by tests.
 */
export interface BunTransportHandlers {
  open(socket: BunSocketLike): void
  data(socket: BunSocketLike, data: Uint8Array | ArrayBuffer | string): void
  drain(socket: BunSocketLike): void
  close(socket: BunSocketLike, error?: Error): void
  error(socket: BunSocketLike, error: Error): void
  end(socket: BunSocketLike): void
}

export interface BunTransportOptions {
  /** Overrides `TRANSPORT_WRITE_QUEUE_FRAMES`; must be a positive integer. */
  maxQueuedFrames?: number
}

interface PendingWrite {
  bytes: Uint8Array
  offset: number
  resolve(): void
  reject(error: Error): void
}

const encoder = new TextEncoder()

const toBytes = (data: Uint8Array | ArrayBuffer | string): Uint8Array => {
  if (typeof data === "string") return encoder.encode(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}

/**
 * One connected socket adapted to the IPC frame layer. Construct it, then
 * either hand `handlers` to `Bun.connect` (see `connectBunTransport`) or attach
 * a fake socket in tests via `handlers.open`.
 */
export class BunTransport {
  readonly writer: FrameWriter
  readonly reader: FrameReader
  readonly handlers: BunTransportHandlers

  #socket?: BunSocketLike
  #queue: PendingWrite[] = []
  #slots: number
  #slotWaiters: (() => void)[] = []
  #blocked = false
  #closed = false
  #failure?: Error
  #inbound: Uint8Array[] = []
  #inboundWaiters: ((result: IteratorResult<Uint8Array>) => void)[] = []
  #inboundEnded = false

  constructor(options: BunTransportOptions = {}) {
    const maxQueuedFrames = options.maxQueuedFrames ?? TRANSPORT_WRITE_QUEUE_FRAMES
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames <= 0)
      throw new RangeError(`maxQueuedFrames must be a positive integer, received ${maxQueuedFrames}`)

    this.#slots = maxQueuedFrames
    this.writer = new FrameWriter(this.#write)
    this.reader = new FrameReader(this.#source)
    this.handlers = {
      open: (socket) => this.#open(socket),
      data: (_socket, data) => this.#pushInbound(data),
      drain: () => this.#drain(),
      close: (_socket, error) => this.#close(error),
      error: (_socket, error) => this.#close(error),
      end: () => this.#close(),
    }
  }

  /** True once the socket closed, ended, or failed. */
  get closed(): boolean {
    return this.#closed
  }

  /** The error that ended the transport, when it was not a clean close. */
  get failure(): Error | undefined {
    return this.#failure
  }

  /** Frames currently admitted to the write queue (not counting waiters). */
  get queuedFrames(): number {
    return this.#queue.length
  }

  /** Close the transport and its socket; pending writes are rejected. */
  close(error?: Error) {
    const socket = this.#socket
    this.#close(error)
    socket?.end()
  }

  #write: FrameSink = async (bytes) => {
    if (this.#closed) throw this.#failure ?? new TransportClosedError()

    const wait = this.#acquire()
    if (wait !== undefined) {
      await wait
      // The slot was handed over directly; a closed transport has nothing to write.
      if (this.#closed) throw this.#failure ?? new TransportClosedError()
    }

    await new Promise<void>((resolve, reject) => {
      this.#queue.push({ bytes, offset: 0, resolve, reject })
      this.#pump()
    })
  }

  #source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => this.#readChunk(),
    }),
  }

  #acquire(): Promise<void> | undefined {
    if (this.#slots > 0) {
      this.#slots -= 1
      return undefined
    }
    return new Promise<void>((resolve) => this.#slotWaiters.push(resolve))
  }

  #release() {
    const waiter = this.#slotWaiters.shift()
    if (waiter !== undefined) {
      waiter()
      return
    }
    this.#slots += 1
  }

  #open(socket: BunSocketLike) {
    if (this.#closed) {
      socket.end()
      return
    }
    if (this.#socket !== undefined) return
    this.#socket = socket
    this.#pump()
  }

  #drain() {
    this.#blocked = false
    this.#pump()
  }

  #pump() {
    const socket = this.#socket
    if (socket === undefined || this.#blocked || this.#closed) return

    while (this.#queue.length > 0) {
      const entry = this.#queue[0]
      const written = socket.write(entry.bytes.subarray(entry.offset))

      if (written < 0) {
        this.#close(new TransportClosedError("socket rejected a write"))
        return
      }

      // The socket buffer is full: wait for Bun's `drain` callback before
      // retrying, which is what turns a slow peer into writer backpressure.
      if (written === 0) {
        this.#blocked = true
        return
      }

      entry.offset += written
      if (entry.offset < entry.bytes.length) continue

      this.#queue.shift()
      entry.resolve()
      this.#release()
    }
  }

  #close(error?: Error) {
    if (this.#closed) return
    this.#closed = true
    this.#failure = error
    this.#blocked = false
    this.#socket = undefined
    this.#endInbound()

    const failure = error ?? new TransportClosedError()
    const pending = this.#queue.splice(0)
    pending.forEach((entry) => entry.reject(failure))
    this.#slotWaiters.splice(0).forEach((resolve) => resolve())
  }

  #pushInbound(data: Uint8Array | ArrayBuffer | string) {
    if (this.#inboundEnded) return
    const chunk = toBytes(data)
    if (chunk.length === 0) return

    const waiter = this.#inboundWaiters.shift()
    if (waiter !== undefined) {
      waiter({ value: chunk, done: false })
      return
    }
    this.#inbound.push(chunk)
  }

  #endInbound() {
    if (this.#inboundEnded) return
    this.#inboundEnded = true
    this.#inboundWaiters.splice(0).forEach((resolve) => resolve({ value: undefined, done: true }))
  }

  #readChunk(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.#inbound.shift()
    if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false })
    if (this.#inboundEnded) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.#inboundWaiters.push(resolve))
  }
}

/**
 * Connect one Unix socket and adapt it. The returned transport is already
 * attached to the live socket; `open` runs before `Bun.connect` resolves.
 */
export async function connectBunTransport(unix: string, options: BunTransportOptions = {}): Promise<BunTransport> {
  const transport = new BunTransport(options)
  try {
    const socket = await Bun.connect({ unix, socket: transport.handlers })
    transport.handlers.open(socket)
    return transport
  } catch (error) {
    transport.close(error instanceof Error ? error : new TransportClosedError(String(error)))
    throw error
  }
}