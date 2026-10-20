/**
 * Packed read wire decoder — the TS half of the sqlite bridge "packed-read"
 * capability (sqliteBridgeAllPacked / sqliteBridgeValuesPacked). Rust encodes
 * a whole result set into ONE flat Uint8Array per query (O(1) napi boundary
 * crossings instead of one value creation per cell); this module turns that
 * buffer back into the exact bun:sqlite shapes the object path produces
 * (all = column-name-keyed objects, values = positional arrays).
 *
 * THIS FILE AND codegraph-kernel/src/sqlite_bridge.rs (packed read wire
 * section) MUST MATCH BYTE FOR BYTE. Any layout change bumps
 * PACKED_LAYOUT_VERSION — decodePackedHeader hard-fails (throws) on a
 * version it doesn't know, the kernel/decode.ts posture: a wire mismatch is
 * a programming error, never a silent fallback.
 *
 * Layout v1 (single buffer, header ‖ name table ‖ grid ‖ arena; every
 * multi-byte field little-endian — the buffers.rs ExtractBuffers
 * conventions):
 *
 * header (32 bytes):
 *   0   u8   layout_version (= PACKED_LAYOUT_VERSION)
 *   1   u8   flags — bit0: has_column_names (packed-all; packed-values is 0)
 *   2   u16  column_count
 *   4   u32  row_count
 *   8   u32  grid_offset   (= 32 + names_len)
 *   12  u32  grid_len      (= row_count * column_count * 12)
 *   16  u32  names_offset  (NONE = 0xFFFF_FFFF when !has_column_names)
 *   20  u32  names_len     (= column_count * 8 when present, else 0)
 *   24  u32  arena_offset  (= grid_offset + grid_len)
 *   28  u32  arena_len     (buffer ends exactly at arena_offset + arena_len)
 *
 * name table (has_column_names only; 8 bytes per column, column order):
 *   0   u32  arena offset of the column-name bytes
 *   4   u32  byte length
 *
 * cell (12 bytes, row-major, row_count × column_count):
 *   0   u8   tag: 0=NULL, 1=F64, 2=TEXT, 3=BLOB — per-cell because SQLite
 *        column types are DYNAMIC (a column may mix types across rows)
 *   1   [3]  pad (zero)
 *   4   8B   payload: F64 → f64 LE bits (INTEGER arrives pre-converted
 *        through f64 — bun's non-strict lossy double read happens Rust-side
 *        so both wire shapes hand JS the identical Number); TEXT/BLOB →
 *        u32 arena offset + u32 byte length; NULL → zero
 *
 * arena: raw bytes, no dedup, no alignment. Column names lead (packed-all),
 * then cell payload bytes in grid order. TEXT is SQLite's ORIGINAL UTF-8
 * bytes INCLUDING invalid sequences — the Rust side performs NO lossy
 * re-encode, so the TextDecoder here (WHATWG maximal-subpart replacements)
 * is what must be byte-exactly aligned with the object path's
 * String::from_utf8_lossy (same Unicode recommended practice).
 *
 * Text decoding: the whole arena is decoded ONCE; when every byte mapped to
 * exactly one character (`decoded.length === arenaLen` — every character
 * consumed exactly one byte, so string index == byte offset provably) cell
 * strings are O(1) slices of that one decode. Otherwise (any multi-byte
 * character) each TEXT cell decodes its own zero-copy subarray view — the
 * kernel decode.ts byte-range convention.
 */

/** Must equal sqlite_bridge.rs PACKED_LAYOUT_VERSION. */
export const PACKED_LAYOUT_VERSION = 1
export const PACKED_HEADER_SIZE = 32
export const PACKED_CELL_SIZE = 12
const PACKED_NAME_ENTRY_SIZE = 8
/** flags bit0: the buffer carries the column-name table (packed-all shape). */
const PACKED_FLAG_COLUMN_NAMES = 1
const PACKED_TAG_NULL = 0
const PACKED_TAG_F64 = 1
const PACKED_TAG_TEXT = 2
const PACKED_TAG_BLOB = 3
/** "Segment absent" sentinel (buffers.rs NONE convention). */
const PACKED_NONE = 0xffffffff

function fail(message: string): never {
  throw new Error(`sqlite bridge packed decode: ${message}`)
}

// One shared decoder instance: TextDecoder is stateless for non-streaming
// decode() calls, so reuse across cells and queries is safe.
const textDecoder = new TextDecoder()

interface PackedHeader {
  flags: number
  columnCount: number
  rowCount: number
  gridOffset: number
  namesOffset: number
  namesLen: number
  arenaOffset: number
  arenaLen: number
}

/**
 * Parse + fully cross-validate the 32-byte header. Every segment boundary is
 * re-derived and checked against the buffer length: a malformed or truncated
 * buffer throws instead of decoding garbage (or worse, reading out of
 * bounds into undefined JS values).
 */
function decodePackedHeader(buf: Uint8Array): PackedHeader {
  if (buf.length < PACKED_HEADER_SIZE) fail(`buffer too short: ${buf.length} < ${PACKED_HEADER_SIZE}`)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const version = view.getUint8(0)
  if (version !== PACKED_LAYOUT_VERSION) {
    fail(`wire layout version ${version} != expected ${PACKED_LAYOUT_VERSION}`)
  }
  const flags = view.getUint8(1)
  const columnCount = view.getUint16(2, true)
  const rowCount = view.getUint32(4, true)
  const gridOffset = view.getUint32(8, true)
  const gridLen = view.getUint32(12, true)
  const namesOffset = view.getUint32(16, true)
  const namesLen = view.getUint32(20, true)
  const arenaOffset = view.getUint32(24, true)
  const arenaLen = view.getUint32(28, true)

  const hasColumnNames = (flags & PACKED_FLAG_COLUMN_NAMES) !== 0
  if (hasColumnNames) {
    // A 0-column all() shape (e.g. INSERT ... .all() parity with bun) keeps
    // bit0 set with an empty name table at the fixed offset.
    if (namesLen !== columnCount * PACKED_NAME_ENTRY_SIZE) {
      fail(`names_len ${namesLen} != column_count ${columnCount} * ${PACKED_NAME_ENTRY_SIZE}`)
    }
    if (namesOffset !== PACKED_HEADER_SIZE) fail(`names_offset ${namesOffset} != ${PACKED_HEADER_SIZE}`)
  } else {
    if (namesLen !== 0) fail(`names_len ${namesLen} != 0 for a values-shape buffer`)
    if (namesOffset !== PACKED_NONE) fail(`names_offset ${namesOffset} != NONE for a values-shape buffer`)
  }
  if (gridLen !== rowCount * columnCount * PACKED_CELL_SIZE) {
    fail(`grid_len ${gridLen} != row_count ${rowCount} * column_count ${columnCount} * ${PACKED_CELL_SIZE}`)
  }
  if (gridOffset !== PACKED_HEADER_SIZE + namesLen) fail(`grid_offset ${gridOffset} != ${PACKED_HEADER_SIZE + namesLen}`)
  if (arenaOffset !== gridOffset + gridLen) fail(`arena_offset ${arenaOffset} != ${gridOffset + gridLen}`)
  if (buf.length !== arenaOffset + arenaLen) fail(`buffer length ${buf.length} != arena end ${arenaOffset + arenaLen}`)
  return { flags, columnCount, rowCount, gridOffset, namesOffset, namesLen, arenaOffset, arenaLen }
}

/**
 * Arena text access. Fast path: ONE whole-arena TextDecoder decode; when the
 * decoded length equals the byte length, every character consumed exactly
 * one byte, so string indices ARE byte offsets and cells slice in O(1).
 * Slow path (any multi-byte character in the arena): per-cell decode over a
 * zero-copy subarray view.
 */
function arenaText(buf: Uint8Array, header: PackedHeader) {
  const arena = buf.subarray(header.arenaOffset, header.arenaOffset + header.arenaLen)
  const whole = header.arenaLen > 0 ? textDecoder.decode(arena) : ""
  if (whole.length === header.arenaLen) {
    return (off: number, len: number) => whole.slice(off, off + len)
  }
  return (off: number, len: number) => textDecoder.decode(buf.subarray(header.arenaOffset + off, header.arenaOffset + off + len))
}

/** Decode one 12-byte cell at `at` (grid-relative) into its JS value. */
function decodeCell(view: DataView, buf: Uint8Array, header: PackedHeader, at: number, text: (off: number, len: number) => string): unknown {
  const tag = view.getUint8(header.gridOffset + at)
  const payload = header.gridOffset + at + 4
  if (tag === PACKED_TAG_NULL) return null
  if (tag === PACKED_TAG_F64) return view.getFloat64(payload, true)
  const off = view.getUint32(payload, true)
  const len = view.getUint32(payload + 4, true)
  if (tag === PACKED_TAG_TEXT) return text(off, len)
  if (tag === PACKED_TAG_BLOB) {
    // Owned copy (slice, not a view): the object path hands JS an independent
    // Uint8Array per blob cell — aliasing the wire buffer would outlive the
    // query and let callers mutate it.
    return buf.slice(header.arenaOffset + off, header.arenaOffset + off + len)
  }
  return fail(`unknown cell tag ${tag} at grid offset ${at}`)
}

/**
 * packed-all shape → bun:sqlite Statement.all result: column-name-keyed
 * plain objects, one per row.
 */
export function decodePackedAll(buf: Uint8Array): Record<string, unknown>[] {
  const header = decodePackedHeader(buf)
  if ((header.flags & PACKED_FLAG_COLUMN_NAMES) === 0) fail("buffer carries no column names but all() shape was requested")
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const text = arenaText(buf, header)
  const columns: string[] = new Array(header.columnCount)
  for (let i = 0; i < header.columnCount; i++) {
    const entry = header.namesOffset + i * PACKED_NAME_ENTRY_SIZE
    columns[i] = text(view.getUint32(entry, true), view.getUint32(entry + 4, true))
  }
  const rows: Record<string, unknown>[] = new Array(header.rowCount)
  for (let r = 0; r < header.rowCount; r++) {
    const row: Record<string, unknown> = {}
    const base = r * header.columnCount * PACKED_CELL_SIZE
    for (let col = 0; col < header.columnCount; col++) {
      row[columns[col]!] = decodeCell(view, buf, header, base + col * PACKED_CELL_SIZE, text)
    }
    rows[r] = row
  }
  return rows
}

/**
 * packed-values shape → bun:sqlite Statement.values result: positional row
 * arrays (drizzle's field-mapped read path; no column names decoded).
 */
export function decodePackedValues(buf: Uint8Array): unknown[][] {
  const header = decodePackedHeader(buf)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const text = arenaText(buf, header)
  const rows: unknown[][] = new Array(header.rowCount)
  for (let r = 0; r < header.rowCount; r++) {
    const row: unknown[] = new Array(header.columnCount)
    const base = r * header.columnCount * PACKED_CELL_SIZE
    for (let col = 0; col < header.columnCount; col++) {
      row[col] = decodeCell(view, buf, header, base + col * PACKED_CELL_SIZE, text)
    }
    rows[r] = row
  }
  return rows
}
