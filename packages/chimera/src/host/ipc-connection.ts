/**
 * Rust host ↔ Bun worker IPC connection layer (schema v0).
 *
 * Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §3.1 (length prefix),
 * §7.3 (transport sequence / gap handling) and §9.1 (bounded queues and
 * backpressure).
 *
 * `FrameWriter` owns the send-direction `transport_sequence`; `FrameReader`
 * owns the receive-direction `expectedSequence` and reconstructs frames from an
 * arbitrary chunk stream. Like `ipc-frame.ts` this module is pure: it only
 * touches `Uint8Array` and the sibling codec, never the socket itself.
 *
 * The transport sink/source is injected so the same logic runs over a Unix
 * socket, a named pipe, or an in-memory pipe in tests. `FrameWriter.send`
 * awaits an async sink, so a sink that resolves when the transport drains gives
 * natural write-side backpressure. `FrameReader.pendingBytes` / `pendingFrames`
 * expose the read-side high-water marks the caller needs for §9.1 queue limits.
 */

import {
  decodeFrame,
  decodeHeader,
  encodeFrame,
  Flag,
  FrameError,
  FrameReassembler,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  type DecodeOptions,
  type Frame,
  type Header,
} from "./ipc-frame"

/** Transport write primitive. A promise return value applies backpressure. */
export type FrameSink = (bytes: Uint8Array) => void | Promise<void>

/** Non-throwing header probe for `pendingFrames`; a corrupt header just ends the scan. */
const tryDecodeHeader = (bytes: Uint8Array): Header | undefined => {
  try {
    return decodeHeader(bytes)
  } catch {
    return undefined
  }
}

/**
 * Header fields owned by the caller. `sequence` is assigned by `FrameWriter`
 * and `payload_length` is derived from the payload (§3.1, §7.3).
 */
export type OutgoingHeader = Omit<Header, "sequence" | "payload_length">

/** Send-direction `transport_sequence` owner (§7.3). */
export class FrameWriter {
  #sink: FrameSink
  #sequence = 1n
  #sent = 0

  constructor(sink: FrameSink) {
    this.#sink = sink
  }

  /** Next `transport_sequence` this writer will stamp onto a frame. */
  get sequence(): bigint {
    return this.#sequence
  }

  /** Number of frames successfully handed to the sink. */
  get sent(): number {
    return this.#sent
  }

  /**
   * Encode one frame with the writer-assigned sequence and hand it to the sink.
   * A sink rejection propagates unchanged and does not consume a sequence
   * number, so a retry reuses the same value (the frame never reached the wire).
   */
  async send(header: OutgoingHeader, payload: Uint8Array = new Uint8Array()): Promise<Header> {
    const sequence = this.#sequence
    const full: Header = { ...header, payload_length: payload.length, sequence }
    await this.#sink(encodeFrame(full, payload))
    this.#sequence = sequence + 1n
    this.#sent += 1
    return full
  }
}

/** A skipped receive-direction sequence range (§7.3). */
export interface SequenceGap {
  expected: bigint
  received: bigint
  skipped: bigint
  durable: boolean
}

export interface FrameReaderOptions extends DecodeOptions {
  /**
   * Upper bound for the unparsed buffer. Defaults to `MAX_FRAME_BYTES + 64`,
   * the largest possible single frame; anything beyond it means the peer sent
   * data that cannot be a valid frame (§3.1). Overridable for calibration and
   * focused tests.
   */
  maxBufferBytes?: number
  /** Notified for every transient gap; durable gaps throw instead (§7.3). */
  onGap?: (gap: SequenceGap) => void
}

/**
 * Receive-direction frame stream.
 *
 * Frames are parsed incrementally: any chunk granularity is accepted and a
 * partial frame simply stays buffered until the remaining bytes arrive. Like
 * the Rust arm the reader does not deduplicate; a sequence other than the
 * expected one is a discontinuity (§7.3), and `(connection_id, sequence)`
 * dedupe is the caller's job (§8.2).
 */
export class FrameReader {
  #iterator: AsyncIterator<Uint8Array>
  #reassembler = new FrameReassembler()
  #options: FrameReaderOptions
  #maxBufferBytes: number
  #buffer = new Uint8Array(0)
  #expected = 1n
  #gaps = 0
  #messageOpen = false
  #ended = false

  constructor(source: AsyncIterable<Uint8Array>, options: FrameReaderOptions = {}) {
    this.#iterator = source[Symbol.asyncIterator]()
    this.#options = options
    this.#maxBufferBytes = Math.max(options.maxBufferBytes ?? MAX_FRAME_BYTES + HEADER_BYTES, HEADER_BYTES)
  }

  /** Bytes buffered but not yet consumed. */
  get pendingBytes(): number {
    return this.#buffer.length
  }

  /** Complete frames currently buffered, i.e. parseable without another read. */
  get pendingFrames(): number {
    let offset = 0
    let frames = 0
    while (offset + HEADER_BYTES <= this.#buffer.length) {
      const header = tryDecodeHeader(this.#buffer.subarray(offset))
      if (header === undefined) break
      const total = HEADER_BYTES + header.payload_length
      if (offset + total > this.#buffer.length) break
      frames += 1
      offset += total
    }
    return frames
  }

  /** Next receive-direction `transport_sequence` expected on this connection. */
  get expectedSequence(): bigint {
    return this.#expected
  }

  /** Number of transient gaps observed (each gap counts once). */
  get gapCount(): number {
    return this.#gaps
  }

  /**
   * Next complete frame, or `undefined` at a clean end of stream. A stream that
   * ends mid-frame is `decode_error`; a durable gap is `sequence_gap` and is
   * not returned, leaving the reader stopped at the gap (§7.3).
   */
  async next(): Promise<Frame | undefined> {
    while (true) {
      const frame = this.#parse()
      if (frame !== undefined) {
        this.#accept(frame)
        return frame
      }
      if (this.#ended) {
        if (this.#buffer.length > 0)
          throw new FrameError("decode_error", `stream ended mid-frame: ${this.#buffer.length} buffered bytes`)
        return undefined
      }
      const chunk = await this.#iterator.next()
      if (chunk.done) {
        this.#ended = true
        continue
      }
      this.#append(chunk.value)
    }
  }

  /**
   * Next reassembled logical message (`MORE` fragments joined, §3.1). Returns
   * the final fragment's header with the joined payload; `undefined` at a clean
   * end of stream. EOF in the middle of a fragmented message is `decode_error`.
   */
  async nextMessage(): Promise<Frame | undefined> {
    while (true) {
      const frame = await this.next()
      if (frame === undefined) {
        if (this.#messageOpen) throw new FrameError("decode_error", "stream ended mid-message")
        return undefined
      }
      const payload = this.#reassembler.push(frame.header, frame.payload)
      this.#messageOpen = (frame.header.flags & Flag.MORE) !== 0
      if (payload !== undefined) return { header: frame.header, payload }
    }
  }

  #append(chunk: Uint8Array) {
    if (chunk.length === 0) return
    const merged = new Uint8Array(this.#buffer.length + chunk.length)
    merged.set(this.#buffer)
    merged.set(chunk, this.#buffer.length)
    this.#buffer = merged
  }

  #parse(): Frame | undefined {
    if (this.#buffer.length < HEADER_BYTES) return undefined
    const header = decodeHeader(this.#buffer)
    const total = HEADER_BYTES + header.payload_length
    // Reject an oversized frame before waiting for (or buffering) its body.
    if (total > this.#maxBufferBytes)
      throw new FrameError("frame_too_large", `frame ${total} bytes > buffer limit ${this.#maxBufferBytes}`)
    if (this.#buffer.length < total) return undefined
    const frame = decodeFrame(this.#buffer, { compressedNegotiated: this.#options.compressedNegotiated })
    this.#buffer = this.#buffer.slice(total)
    return frame
  }

  #accept(frame: Frame) {
    const sequence = frame.header.sequence
    if (sequence === this.#expected) {
      this.#expected = sequence + 1n
      return
    }

    const gap: SequenceGap = {
      expected: this.#expected,
      received: sequence,
      skipped: sequence > this.#expected ? sequence - this.#expected : 0n,
      durable: (frame.header.flags & Flag.DURABLE) !== 0,
    }
    // Durable content may not be silently skipped; transient gaps are recorded
    // and surfaced so the SSE layer can emit `server.event-gap`.
    if (gap.durable)
      throw new FrameError("sequence_gap", `durable sequence gap: expected ${this.#expected}, received ${sequence}`)
    this.#gaps += 1
    this.#options.onGap?.(gap)
    this.#expected = sequence + 1n
  }
}