// H1 protocol-layer benchmark: TS arm codec microbenchmarks.
//
// Run from packages/chimera:
//   bun run script/bench/h1-codec.ts
//   BENCH_OUT=/Volumes/workspace/cbench/h1-codec bun run script/bench/h1-codec.ts
//
// Groups: frame_encode, header_decode, frame_roundtrip, reassemble, crc32c.
//
// Methodology: each sample times a batch of identical operations with
// `Bun.nanoseconds()` and divides by the batch size. The batch size is
// calibrated per group so one sample lasts >= ~50µs, which keeps the platform
// timer quantization (~41.7ns on darwin/arm64, a 24MHz clock) far below the
// per-op cost. p50/p95 come from the sorted sample array (`aggregate` from
// ./metrics). `ops_per_sec_mean` is derived from the whole timed region;
// `ops_per_sec_p50` from the median sample.
//
// Encode/header/roundtrip rows use `flags = 0` (no CHECKSUM) so the CRC cost is
// isolated in the `crc32c` group, matching the Rust criterion arm; `reassemble`
// also runs without checksums so it isolates the fragment join.
//
// Only `src/host/ipc-frame.ts` is imported: no server/session runtime.
import fs from "fs"
import os from "os"
import path from "path"

import {
  crc32c,
  decodeFrame,
  decodeHeader,
  encodeFrame,
  Flag,
  FrameKind,
  FrameReassembler,
  PROTOCOL_VERSION,
  type Header,
} from "../../src/host/ipc-frame"
import { aggregate, type Agg } from "./metrics"

const MB = 1024 * 1024
const KIB = 1024
const DEFAULT_OUT = "/Volumes/workspace/cbench/h1-codec"

const SIZES = [0, 64, 4096, MB] as const

type Row = {
  group: string
  size: number
  iterations: number
  samples: number
  batch: number
  ns_per_op: Agg
  ops_per_sec_p50: number
  ops_per_sec_mean: number
  mb_per_sec_mean: number
  sink: number
}

const envInt = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const SAMPLES = envInt("BENCH_H1_SAMPLES", 200)
const LARGE_SAMPLES = envInt("BENCH_H1_LARGE_SAMPLES", 100)
const WARMUP_BATCHES = envInt("BENCH_H1_WARMUP_BATCHES", 10)
const TARGET_BATCH_NS = envInt("BENCH_H1_TARGET_BATCH_NS", 200_000)
const MAX_BATCH = envInt("BENCH_H1_MAX_BATCH", 1024)

const makePayload = (size: number) => {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) & 0xff
  return bytes
}

const makeHeader = (flags: number, sequence = 1n): Header => {
  const correlation_id = new Uint8Array(16)
  correlation_id.fill(0xa5)
  return {
    protocol_version: PROTOCOL_VERSION,
    frame_kind: FrameKind.request,
    flags,
    payload_length: 0,
    connection_id: 1n,
    worker_generation: 1n,
    sequence,
    correlation_id,
    payload_crc32c: 0,
  }
}

/** Warm up, estimate per-op cost from a median probe, then size the batch. */
const calibrate = (op: () => number) => {
  for (let index = 0; index < 64; index++) op()
  const timeBatch = (batch: number) => {
    const started = Bun.nanoseconds()
    for (let index = 0; index < batch; index++) op()
    return Bun.nanoseconds() - started
  }
  // Median of five single-op probes: a lone GC pause would otherwise pin the
  // batch at 1 and reintroduce timer quantization.
  const probes = Array.from({ length: 5 }, () => timeBatch(1)).sort((left, right) => left - right)
  const perOp = Math.max(probes[2], 1)
  let batch = Math.min(MAX_BATCH, Math.max(1, Math.ceil(TARGET_BATCH_NS / perOp)))
  // One correction pass: grow if the estimate was too optimistic.
  if (Math.min(timeBatch(batch), timeBatch(batch)) < TARGET_BATCH_NS / 4)
    batch = Math.min(MAX_BATCH, batch * 4)
  return batch
}

const bench = (input: { group: string; size: number; op: () => number; bytesPerOp?: number }): Row => {
  const samplesCount = input.size >= MB ? LARGE_SAMPLES : SAMPLES
  const batch = calibrate(input.op)
  let sink = 0
  for (let round = 0; round < WARMUP_BATCHES; round++)
    for (let index = 0; index < batch; index++) sink += input.op()

  const samples = new Array<number>(samplesCount)
  const startedAt = Bun.nanoseconds()
  for (let sample = 0; sample < samplesCount; sample++) {
    const started = Bun.nanoseconds()
    for (let index = 0; index < batch; index++) sink += input.op()
    samples[sample] = (Bun.nanoseconds() - started) / batch
  }
  const wallNs = Bun.nanoseconds() - startedAt
  const iterations = samplesCount * batch

  const ns_per_op = aggregate(samples)
  if (!ns_per_op) throw new Error(`${input.group} produced no samples`)
  const ops_per_sec_mean = iterations / (wallNs / 1e9)
  const bytesPerOp = input.bytesPerOp ?? input.size
  return {
    group: input.group,
    size: input.size,
    iterations,
    samples: samplesCount,
    batch,
    ns_per_op,
    ops_per_sec_p50: 1e9 / ns_per_op.p50,
    ops_per_sec_mean,
    mb_per_sec_mean: (bytesPerOp * ops_per_sec_mean) / 1e6,
    sink,
  }
}

const rowLog = (row: Row) =>
  `${row.group} size=${row.size}B batch=${row.batch} ops=${row.iterations} ` +
  `p50=${row.ns_per_op.p50.toFixed(0)}ns p95=${row.ns_per_op.p95.toFixed(0)}ns ` +
  `ops/s=${row.ops_per_sec_mean.toFixed(0)} sink=${row.sink}`

const run = () => {
  const rows: Row[] = []
  const payloads = new Map<number, Uint8Array>(SIZES.map((size) => [size, makePayload(size)]))
  const frames = new Map<number, Uint8Array>(
    SIZES.map((size) => [size, encodeFrame(makeHeader(0), payloads.get(size)!)]),
  )

  // frame_encode: header + payload, flags = 0 (CRC measured separately).
  for (const size of SIZES) {
    const payload = payloads.get(size)!
    const header = makeHeader(0)
    const row = bench({
      group: "frame_encode",
      size,
      op: () => encodeFrame(header, payload).length,
      bytesPerOp: size + 64,
    })
    rows.push(row)
    console.log(rowLog(row))
  }

  // header_decode: header-only validation over a full frame buffer.
  for (const size of SIZES) {
    const frame = frames.get(size)!
    const row = bench({
      group: "header_decode",
      size,
      op: () => decodeHeader(frame).correlation_id.length,
      bytesPerOp: 64,
    })
    rows.push(row)
    console.log(rowLog(row))
  }

  // frame_roundtrip: encode + decode (payload slice included).
  for (const size of SIZES) {
    const payload = payloads.get(size)!
    const header = makeHeader(0)
    const row = bench({
      group: "frame_roundtrip",
      size,
      op: () => decodeFrame(encodeFrame(header, payload)).payload.length,
      bytesPerOp: (size + 64) * 2,
    })
    rows.push(row)
    console.log(rowLog(row))
  }

  // reassemble: 16 MORE fragments + 1 final fragment, no checksums.
  const FRAGMENT_BYTES = 4096
  const FRAGMENT_COUNT = 64
  const fragmentPayload = makePayload(FRAGMENT_BYTES)
  const fragments = Array.from({ length: FRAGMENT_COUNT }, (_, index) => ({
    header: makeHeader(index === FRAGMENT_COUNT - 1 ? 0 : Flag.MORE, BigInt(index + 1)),
    payload: fragmentPayload,
  }))
  const reassembleBytes = FRAGMENT_COUNT * FRAGMENT_BYTES
  const reassembleRow = bench({
    group: "reassemble",
    size: reassembleBytes,
    op: () => {
      const reassembler = new FrameReassembler()
      let joined: Uint8Array | undefined
      for (const fragment of fragments) joined = reassembler.push(fragment.header, fragment.payload)
      return joined?.length ?? 0
    },
    bytesPerOp: reassembleBytes,
  })
  rows.push(reassembleRow)
  console.log(rowLog(reassembleRow))

  // crc32c: 1KiB and 1MiB.
  for (const size of [KIB, MB]) {
    const payload = payloads.get(size) ?? makePayload(size)
    const row = bench({ group: "crc32c", size, op: () => crc32c(payload), bytesPerOp: size })
    rows.push(row)
    console.log(rowLog(row))
  }

  return rows
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

const renderMarkdown = (input: { rows: Row[]; generatedAt: string; revision: string; outDir: string }) => {
  const lines: string[] = []
  lines.push("# H1 protocol-layer codec (TS arm)")
  lines.push("")
  lines.push(`- generated: ${input.generatedAt}`)
  lines.push(`- git: ${input.revision}`)
  lines.push(`- bun: ${Bun.version}`)
  lines.push(`- platform: ${process.platform}/${process.arch}`)
  lines.push(`- host load average (1/5/15m): ${os.loadavg().map((value) => value.toFixed(2)).join(" / ")}`)
  lines.push(`- archive dir: ${input.outDir}`)
  lines.push("- source: `packages/chimera/src/host/ipc-frame.ts` (pure codec, no runtime wiring)")
  lines.push(
    `- timing: ${SAMPLES} samples (${LARGE_SAMPLES} for 1MiB rows) × calibrated batch, ${WARMUP_BATCHES} warmup batches; ` +
      `batch grows until one sample lasts >= ${TARGET_BATCH_NS}ns`,
  )
  lines.push("")
  lines.push(
    table(
      ["group", "payload B", "ops", "samples", "batch", "p50 ns", "p95 ns", "min ns", "max ns", "ops/s p50", "ops/s mean", "MB/s mean"],
      input.rows.map((row) => [
        row.group,
        String(row.size),
        String(row.iterations),
        String(row.samples),
        String(row.batch),
        row.ns_per_op.p50.toFixed(1),
        row.ns_per_op.p95.toFixed(1),
        row.ns_per_op.min.toFixed(1),
        row.ns_per_op.max.toFixed(1),
        row.ops_per_sec_p50.toFixed(0),
        row.ops_per_sec_mean.toFixed(0),
        row.mb_per_sec_mean.toFixed(1),
      ]),
    ),
  )
  lines.push("")
  lines.push("## Notes")
  lines.push("")
  lines.push("- Every value is a per-operation mean over a calibrated batch; p50/p95/min/max are percentiles of those per-op means, so min/max are not single-op extremes.")
  lines.push("- Batched timing avoids the platform timer granularity: `Bun.nanoseconds()` on darwin/arm64 ticks at 24MHz (~41.7ns), which would dominate sub-microsecond ops.")
  lines.push("- These ops allocate; JSC GC pauses land in the p95/max tails (visible on the 1MiB rows), while p50 is the steady-state per-op cost. The host was shared with a concurrent cargo bench, so treat cross-arm deltas as order-of-magnitude evidence, not precise ratios.")
  lines.push("- `frame_encode` / `header_decode` / `frame_roundtrip` use `flags = 0` (no CHECKSUM), matching the Rust criterion arm; CRC cost is isolated in the `crc32c` group.")
  lines.push("- `frame_roundtrip` is `encodeFrame` + `decodeFrame` (payload slice included). The Rust arm's roundtrip row is encode + `decode_header` only, so compare TS encode + TS header_decode for an apples-to-apples delta.")
  lines.push("- `header_decode` is size-independent by design (it only reads the 64-byte header); rows differ only by the backing buffer size, and its MB/s column counts 64 header bytes per op.")
  lines.push("- `reassemble` pushes 63 `MORE` fragments of 4096 B plus one final fragment (256 KiB logical message) into a fresh `FrameReassembler`, matching the Rust arm's 64 × 4 KiB shape; checksums are off.")
  lines.push("- `ops/s p50` = `1e9 / p50`; `ops/s mean` = total ops / measured wall time.")
  lines.push("- `MB/s mean` uses encoded bytes for encode rows (`payload + 64`) and `2 × (payload + 64)` for roundtrip rows.")
  lines.push("")
  return lines.join("\n")
}

const rows = run()
const outDir = process.env["BENCH_OUT"] ?? DEFAULT_OUT
const generatedAt = new Date().toISOString()
const meta = {
  generatedAt,
  revision: revision(),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  loadAverage: os.loadavg(),
  source: "packages/chimera/src/host/ipc-frame.ts",
  timing: {
    samples: SAMPLES,
    largeSamples: LARGE_SAMPLES,
    warmupBatches: WARMUP_BATCHES,
    targetBatchNs: TARGET_BATCH_NS,
    maxBatch: MAX_BATCH,
  },
}
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, "ts-codec.json"), JSON.stringify({ meta, rows }, null, 2) + "\n")
fs.writeFileSync(path.join(outDir, "ts-codec.md"), renderMarkdown({ rows, generatedAt, revision: meta.revision, outDir }) + "\n")
console.log(`archived: ${path.join(outDir, "ts-codec.md")}`)