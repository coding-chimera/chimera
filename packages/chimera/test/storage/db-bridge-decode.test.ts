import { describe, expect, test } from "bun:test"
import {
  decodePackedAll,
  decodePackedValues,
  PACKED_CELL_SIZE,
  PACKED_HEADER_SIZE,
  PACKED_LAYOUT_VERSION,
} from "@/storage/db-bridge-decode"

// Pure-TS coverage of the packed read wire decoder (src/storage/
// db-bridge-decode.ts): a fixture encoder mirrors the sqlite_bridge.rs layout
// byte-for-byte, round-trips the value shapes, and malformed/version-skewed
// buffers must throw HARD (a wire mismatch is a programming error, never a
// silent fallback). No native binary needed — these always run.

const textEncoder = new TextEncoder()

/**
 * Fixture encoder for the packed wire v1 (MUST mirror the packed read wire
 * section of codegraph-kernel/src/sqlite_bridge.rs). `columns === null`
 * produces the values shape (flags bit0 clear, names_offset = NONE); raw
 * byte cells can be injected as { rawText: bytes } to exercise invalid
 * UTF-8 without going through TextEncoder.
 */
export function encodePacked(
  columns: string[] | null,
  rows: (unknown | { rawText: Uint8Array })[][],
): Uint8Array {
  const arenaChunks: Uint8Array[] = []
  let arenaLen = 0
  const put = (bytes: Uint8Array): [number, number] => {
    const off = arenaLen
    arenaChunks.push(bytes)
    arenaLen += bytes.length
    return [off, bytes.length]
  }
  const nameRefs = (columns ?? []).map((name) => put(textEncoder.encode(name)))
  const columnCount = columns ? columns.length : (rows[0]?.length ?? 0)
  const cells = rows.flatMap((row) =>
    row.map((value) => {
      const payload = new Uint8Array(8)
      const dv = new DataView(payload.buffer)
      if (value === null || value === undefined) return { tag: 0, payload }
      if (typeof value === "number") {
        dv.setFloat64(0, value, true)
        return { tag: 1, payload }
      }
      if (typeof value === "string") {
        const [off, len] = put(textEncoder.encode(value))
        dv.setUint32(0, off, true)
        dv.setUint32(4, len, true)
        return { tag: 2, payload }
      }
      if (value instanceof Uint8Array) {
        const [off, len] = put(value)
        dv.setUint32(0, off, true)
        dv.setUint32(4, len, true)
        return { tag: 3, payload }
      }
      if (typeof value === "object" && value !== null && "rawText" in value) {
        const [off, len] = put((value as { rawText: Uint8Array }).rawText)
        dv.setUint32(0, off, true)
        dv.setUint32(4, len, true)
        return { tag: 2, payload }
      }
      throw new Error(`fixture encoder: unsupported cell value ${String(value)}`)
    }),
  )

  const namesLen = nameRefs.length * 8
  const gridOffset = PACKED_HEADER_SIZE + namesLen
  const gridLen = cells.length * PACKED_CELL_SIZE
  const arenaOffset = gridOffset + gridLen
  const out = new Uint8Array(arenaOffset + arenaLen)
  const dv = new DataView(out.buffer)
  out[0] = PACKED_LAYOUT_VERSION
  out[1] = columns ? 1 : 0
  dv.setUint16(2, columnCount, true)
  dv.setUint32(4, rows.length, true)
  dv.setUint32(8, gridOffset, true)
  dv.setUint32(12, gridLen, true)
  dv.setUint32(16, columns ? PACKED_HEADER_SIZE : 0xffffffff, true)
  dv.setUint32(20, namesLen, true)
  dv.setUint32(24, arenaOffset, true)
  dv.setUint32(28, arenaLen, true)
  nameRefs.forEach(([off, len], i) => {
    dv.setUint32(PACKED_HEADER_SIZE + i * 8, off, true)
    dv.setUint32(PACKED_HEADER_SIZE + i * 8 + 4, len, true)
  })
  cells.forEach((cell, i) => {
    const at = gridOffset + i * PACKED_CELL_SIZE
    out[at] = cell.tag
    out.set(cell.payload, at + 4)
  })
  let cursor = arenaOffset
  for (const chunk of arenaChunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

/** Patch one header field of a valid fixture (malformed-buffer probes). */
function withHeader(buf: Uint8Array, at: number, value: number, width: 1 | 2 | 4 = 4): Uint8Array {
  const out = new Uint8Array(buf)
  const dv = new DataView(out.buffer)
  if (width === 1) dv.setUint8(at, value)
  else if (width === 2) dv.setUint16(at, value, true)
  else dv.setUint32(at, value, true)
  return out
}

describe("packed wire decoder", () => {
  test("all shape round-trips every cell type", () => {
    const buf = encodePacked(["n", "i", "r", "t", "b"], [
      [null, 42, 3.25, "漢字🚀", new Uint8Array([0, 255, 7])],
      [undefined, -1, 0, "", new Uint8Array(0)],
    ])
    expect(decodePackedAll(buf)).toEqual([
      { n: null, i: 42, r: 3.25, t: "漢字🚀", b: new Uint8Array([0, 255, 7]) },
      { n: null, i: -1, r: 0, t: "", b: new Uint8Array(0) },
    ])
  })

  test("values shape round-trips positional rows without column names", () => {
    const buf = encodePacked(null, [
      [1, "a"],
      [2, "b"],
    ])
    expect(decodePackedValues(buf)).toEqual([
      [1, "a"],
      [2, "b"],
    ])
    // The values decoder never reads the name table — flags bit0 is clear.
    expect(buf[1]).toBe(0)
  })

  test("empty result set decodes to []", () => {
    expect(decodePackedAll(encodePacked(["a", "b"], []))).toEqual([])
    expect(decodePackedValues(encodePacked(null, []))).toEqual([])
  })

  test("invalid UTF-8 TEXT decodes lossy with WHATWG maximal-subpart replacements", () => {
    // a, 0xFF (invalid byte), 0x80 (lone continuation), truncated E4 BD
    // sequence, 'a', F4 90 80 (out-of-range continuation after F4 → three
    // single-byte errors), 'z'.
    const raw = new Uint8Array([0x61, 0xff, 0x80, 0xe4, 0xbd, 0x61, 0xf4, 0x90, 0x80, 0x7a])
    const buf = encodePacked(["s"], [[{ rawText: raw }]])
    const decoded = decodePackedAll(buf)[0]!.s as string
    // Byte-parity with the platform TextDecoder — which is exactly what the
    // Rust object path's String::from_utf8_lossy is aligned with (same
    // Unicode recommended practice); the real-binary test pins the two arms
    // against each other.
    expect(decoded).toBe(new TextDecoder().decode(raw))
    expect(Array.from(decoded).filter((ch) => ch === "\uFFFD").length).toBe(6)
    expect(decoded.startsWith("a")).toBe(true)
    expect(decoded.endsWith("z")).toBe(true)
  })

  test("multibyte arena text falls back to per-cell decode and stays exact", () => {
    // The whole-arena single-decode fast path only applies when every byte
    // maps to one character; multibyte payloads must take the per-cell path
    // with identical results (cell 2 proves byte offsets != string indices).
    const buf = encodePacked(null, [
      ["漢字", "a", "🚀漢"],
      ["x", "漢", "y"],
    ])
    expect(decodePackedValues(buf)).toEqual([
      ["漢字", "a", "🚀漢"],
      ["x", "漢", "y"],
    ])
  })

  test("large text and blob payloads decode intact", () => {
    const bigText = "x漢🚀".repeat(100_000)
    const bigBlob = new Uint8Array(500_000).map((_, i) => i % 256)
    const buf = encodePacked(null, [[bigText, bigBlob]])
    const [t, b] = decodePackedValues(buf)[0]!
    expect(t).toBe(bigText)
    expect(b).toEqual(bigBlob)
  })

  test("blob cells are owned copies, not views into the wire buffer", () => {
    const buf = encodePacked(null, [[new Uint8Array([1, 2, 3])]])
    const first = decodePackedValues(buf)[0]![0] as Uint8Array
    first[0] = 99
    const second = decodePackedValues(buf)[0]![0] as Uint8Array
    expect(second[0]).toBe(1) // mutation of the decoded blob must not alias the buffer
  })

  test("2^53+1 arrives as the lossy double the Rust side encoded", () => {
    // INTEGER → f64 conversion happens Rust-side (bun non-strict parity);
    // the decoder just reads the f64 bits.
    const buf = encodePacked(null, [[Number(9007199254740993n)]])
    expect(decodePackedValues(buf)[0]![0]).toBe(9007199254740992)
  })
})

describe("packed wire decoder malformed buffers", () => {
  const valid = () => encodePacked(["a"], [[1]])

  test("short buffer throws", () => {
    expect(() => decodePackedAll(new Uint8Array(PACKED_HEADER_SIZE - 1))).toThrow(/packed decode/)
    expect(() => decodePackedValues(new Uint8Array(0))).toThrow(/packed decode/)
  })

  test("unknown layout version throws", () => {
    expect(() => decodePackedAll(withHeader(valid(), 0, PACKED_LAYOUT_VERSION + 1, 1))).toThrow(/version/)
    expect(() => decodePackedValues(withHeader(valid(), 0, 99, 1))).toThrow(/version/)
  })

  test("trailing garbage (wrong arena_len) throws", () => {
    const buf = valid()
    const grown = new Uint8Array(buf.length + 1)
    grown.set(buf)
    expect(() => decodePackedAll(grown)).toThrow(/packed decode/)
  })

  test("truncated buffer (missing tail) throws", () => {
    expect(() => decodePackedAll(valid().subarray(0, valid().length - 1))).toThrow(/packed decode/)
  })

  test("inconsistent grid_len throws", () => {
    expect(() => decodePackedAll(withHeader(valid(), 12, 999))).toThrow(/grid_len/)
  })

  test("inconsistent row_count throws", () => {
    expect(() => decodePackedAll(withHeader(valid(), 4, 7))).toThrow(/grid_len/)
  })

  test("unknown cell tag throws", () => {
    const buf = valid()
    buf[PACKED_HEADER_SIZE + 8] = 9 // first cell's tag byte (names table = 8B)
    expect(() => decodePackedAll(buf)).toThrow(/cell tag/)
  })

  test("all() refuses a values-shape buffer (no column names)", () => {
    expect(() => decodePackedAll(encodePacked(null, [[1]]))).toThrow(/column names/)
  })

  test("values-shape header with a non-NONE names_offset throws", () => {
    expect(() => decodePackedValues(withHeader(encodePacked(null, [[1]]), 16, PACKED_HEADER_SIZE))).toThrow(/NONE/)
  })
})
