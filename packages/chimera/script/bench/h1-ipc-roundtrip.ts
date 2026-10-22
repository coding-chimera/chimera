// H1 protocol-layer benchmark: TS arm IPC loopback round-trip latency.
//
// Run from packages/chimera:
//   bun run script/bench/h1-ipc-roundtrip.ts
//   BENCH_H1_IPC_N=1000 BENCH_OUT=/Volumes/workspace/cbench/h1-codec bun run script/bench/h1-ipc-roundtrip.ts
//
// Topology: two in-memory duplex pipes (client→server, server→client), each an
// async-iterable byte queue. A real `FrameWriter`/`FrameReader` pair sits on
// each end: the client sends a request frame, the server reads it and echoes a
// response frame with the same correlation_id, the client decodes the response.
// Latency is measured per request/response pair on the client side, so it
// covers both codec passes plus four microtask queue hops.
//
// The queues are unbounded on purpose: this measures protocol-layer latency,
// not socket backpressure (see `src/host/ipc-connection.ts` §9.1 notes).
//
// Only `src/host/ipc-frame.ts` + `src/host/ipc-connection.ts` are imported:
// no server/session runtime.
import fs from "fs"
import os from "os"
import path from "path"

import { Flag, FrameKind, PROTOCOL_VERSION } from "../../src/host/ipc-frame"
import { FrameReader, FrameWriter, type OutgoingHeader } from "../../src/host/ipc-connection"

const DEFAULT_OUT = "/Volumes/workspace/cbench/h1-codec"

const envInt = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const N = envInt("BENCH_H1_IPC_N", 1_000)
const WARMUP = envInt("BENCH_H1_IPC_WARMUP", 100)
const PAYLOAD_BYTES = envInt("BENCH_H1_IPC_PAYLOAD", 256)

type Latency = { min: number; p50: number; p95: number; p99: number; max: number; mean: number }

/** Single-consumer async byte queue; `close()` wakes a pending reader. */
class BytePipe implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = []
  #waiters: ((result: IteratorResult<Uint8Array>) => void)[] = []
  #closed = false

  push(bytes: Uint8Array) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ value: bytes, done: false })
      return
    }
    this.#chunks.push(bytes)
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.#chunks.shift()
    if (chunk) return Promise.resolve({ value: chunk, done: false })
    if (this.#closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  [Symbol.asyncIterator]() {
    return { next: () => this.next() }
  }
}

const makePayload = (size: number) => {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index++) bytes[index] = (index * 17 + 3) & 0xff
  return bytes
}

const correlation = (id: number) => {
  const bytes = new Uint8Array(16)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(id), true)
  return bytes
}

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

const pick = (sorted: number[], q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]

const latency = (values: number[]): Latency => {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    min: sorted[0],
    p50: pick(sorted, 0.5),
    p95: pick(sorted, 0.95),
    p99: pick(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  }
}

/** Server side: read frames off `inbound`, echo a response on `outbound`. */
const serve = async (inbound: BytePipe, outbound: BytePipe) => {
  const reader = new FrameReader(inbound)
  const writer = new FrameWriter((bytes) => outbound.push(bytes))
  while (true) {
    const frame = await reader.next()
    if (frame === undefined) return { frames: writer.sent, gaps: reader.gapCount }
    const header: OutgoingHeader = {
      protocol_version: frame.header.protocol_version,
      frame_kind: FrameKind.response,
      flags: Flag.CHECKSUM | Flag.FINAL,
      connection_id: frame.header.connection_id,
      worker_generation: frame.header.worker_generation,
      correlation_id: frame.header.correlation_id,
      payload_crc32c: 0,
    }
    await writer.send(header, frame.payload)
  }
}

const run = async () => {
  const toServer = new BytePipe()
  const toClient = new BytePipe()
  const requestPayload = makePayload(PAYLOAD_BYTES)
  const clientWriter = new FrameWriter((bytes) => toServer.push(bytes))
  const clientReader = new FrameReader(toClient)

  const server = serve(toServer, toClient)

  const baseHeader = (correlation_id: Uint8Array): OutgoingHeader => ({
    protocol_version: PROTOCOL_VERSION,
    frame_kind: FrameKind.request,
    flags: Flag.CHECKSUM | Flag.FINAL,
    connection_id: 7n,
    worker_generation: 1n,
    correlation_id,
    payload_crc32c: 0,
  })

  const total = WARMUP + N
  const samples = new Array<number>(N)
  let measuredWallNs = 0
  for (let index = 0; index < total; index++) {
    const correlation_id = correlation(index + 1)
    const started = Bun.nanoseconds()
    await clientWriter.send(baseHeader(correlation_id), requestPayload)
    const frame = await clientReader.next()
    const elapsed = Bun.nanoseconds() - started
    if (frame === undefined) throw new Error(`stream closed at roundtrip ${index + 1}`)
    if (frame.header.frame_kind !== FrameKind.response) throw new Error(`unexpected frame_kind ${frame.header.frame_kind}`)
    if (!sameBytes(frame.header.correlation_id, correlation_id)) throw new Error(`correlation mismatch at ${index + 1}`)
    if (frame.payload.length !== PAYLOAD_BYTES) throw new Error(`payload length ${frame.payload.length} != ${PAYLOAD_BYTES}`)
    if (index < WARMUP) continue
    samples[index - WARMUP] = elapsed
    measuredWallNs += elapsed
  }

  toServer.close()
  const serverStats = await server
  toClient.close()

  return {
    request: requestPayload.length,
    response: PAYLOAD_BYTES,
    latency: latency(samples),
    throughput: N / (measuredWallNs / 1e9),
    wallMs: measuredWallNs / 1e6,
    bytesPerSec: (N * (PAYLOAD_BYTES * 2)) / (measuredWallNs / 1e9),
    clientGaps: clientReader.gapCount,
    serverGaps: serverStats.gaps,
    serverFrames: serverStats.frames,
    clientSent: clientWriter.sent,
    clientExpectedSequence: clientReader.expectedSequence.toString(),
  }
}

const revision = () => {
  const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: path.join(import.meta.dir, "../..") })
  return git.exitCode === 0 ? git.stdout.toString().trim() : "unknown"
}

const table = (headers: string[], rows: string[][]) => {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)))
  const line = (cells: string[]) => cells.map((cell, index) => (cell ?? "").padEnd(widths[index])).join(" | ")
  return [`| ${line(headers)} |`, `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map((row) => `| ${line(row)} |`)].join("\n")
}

const renderMarkdown = (input: { result: Awaited<ReturnType<typeof run>>; generatedAt: string; revision: string; outDir: string }) => {
  const { result } = input
  const us = (ns: number) => (ns / 1_000).toFixed(2)
  const lines: string[] = []
  lines.push("# H1 IPC loopback round-trip (TS arm)")
  lines.push("")
  lines.push(`- generated: ${input.generatedAt}`)
  lines.push(`- git: ${input.revision}`)
  lines.push(`- bun: ${Bun.version}`)
  lines.push(`- platform: ${process.platform}/${process.arch}`)
  lines.push(`- host load average (1/5/15m): ${os.loadavg().map((value) => value.toFixed(2)).join(" / ")}`)
  lines.push(`- archive dir: ${input.outDir}`)
  lines.push("- transport: two in-memory async byte queues (client→server, server→client)")
  lines.push(`- payload: request ${result.request} B, response ${result.response} B (echo)`)
  lines.push(`- roundtrips: ${N} measured + ${WARMUP} warmup, sequential (no pipelining)`)
  lines.push("")
  lines.push(
    table(
      ["metric", "min", "p50", "p95", "p99", "max", "mean"],
      [
        [
          "latency (µs)",
          us(result.latency.min),
          us(result.latency.p50),
          us(result.latency.p95),
          us(result.latency.p99),
          us(result.latency.max),
          us(result.latency.mean),
        ],
      ],
    ),
  )
  lines.push("")
  lines.push(
    table(
      ["roundtrips", "wall ms", "roundtrips/s", "payload MB/s", "client gaps", "server gaps", "client sent", "server sent"],
      [
        [
          String(N),
          result.wallMs.toFixed(1),
          result.throughput.toFixed(0),
          (result.bytesPerSec / 1e6).toFixed(2),
          String(result.clientGaps),
          String(result.serverGaps),
          String(result.clientSent),
          String(result.serverFrames),
        ],
      ],
    ),
  )
  lines.push("")
  lines.push("## Notes")
  lines.push("")
  lines.push("- Each round-trip covers: request encode (CRC32C) → queue hop → server `FrameReader` parse → response encode (CRC32C) → queue hop → client parse.")
  lines.push("- The loop is strictly sequential, so this is unloaded single-connection latency, not pipelined throughput.")
  lines.push("- Both directions carry `Flag.CHECKSUM | Flag.FINAL`; `FrameWriter` owns the per-direction `transport_sequence` and `FrameReader` validates it.")
  lines.push("- In-memory queues are unbounded; socket/pipe backpressure is out of scope for this measurement.")
  lines.push("")
  return lines.join("\n")
}

const result = await run()
const outDir = process.env["BENCH_OUT"] ?? DEFAULT_OUT
const generatedAt = new Date().toISOString()
const meta = {
  generatedAt,
  revision: revision(),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  loadAverage: os.loadavg(),
  roundtrips: N,
  warmup: WARMUP,
  payloadBytes: PAYLOAD_BYTES,
  source: ["packages/chimera/src/host/ipc-frame.ts", "packages/chimera/src/host/ipc-connection.ts"],
}
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, "ts-ipc-roundtrip.json"), JSON.stringify({ meta, result }, null, 2) + "\n")
fs.writeFileSync(
  path.join(outDir, "ts-ipc-roundtrip.md"),
  renderMarkdown({ result, generatedAt, revision: meta.revision, outDir }) + "\n",
)
console.log(
  `ipc roundtrip: n=${N} p50=${(result.latency.p50 / 1_000).toFixed(2)}us ` +
    `p95=${(result.latency.p95 / 1_000).toFixed(2)}us p99=${(result.latency.p99 / 1_000).toFixed(2)}us ` +
    `rt/s=${result.throughput.toFixed(0)} gaps=${result.clientGaps}/${result.serverGaps}`,
)
console.log(`archived: ${path.join(outDir, "ts-ipc-roundtrip.md")}`)