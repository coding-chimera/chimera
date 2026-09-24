/**
 * Store wire layout — TS mirror of codegraph-kernel/src/store.rs (R3a).
 *
 * `StoreBuffers` is five flat little-endian Buffers — meta, nodes, edges,
 * refs, arena — the store-side sibling of the extraction `KernelBuffers`
 * (extraction/kernel/layout.ts). Every fixed-width row lives in its table
 * buffer; every string is an `(offset u32, len u32)` pair into the UTF-8
 * arena; `offset === NONE` means "field absent".
 *
 * THIS FILE AND store.rs MUST MATCH BYTE FOR BYTE. Any layout change bumps
 * STORE_ABI_VERSION on both sides — the loader refuses a version it doesn't
 * know and the write path silently stays on the TS QueryBuilder.
 *
 * Unlike the extraction wire (which crosses kinds as table INDEXES), the
 * store wire carries kind/language/provenance strings verbatim — the store
 * tables persist TEXT, so no index-order contract exists here. The loader's
 * kind-table subset check is a version-skew guard only.
 */

/** Must equal store.rs STORE_ABI_VERSION (verified against storeContractInfo). */
export const STORE_ABI_VERSION = 1;

/** Sentinel for "absent" in u32 slots and string-ref offsets (buffers.rs NONE). */
export const NONE = 0xffffffff;

export const STORE_META_HEADER_SIZE = 28;
export const STORE_OP_ROW_SIZE = 48;
export const STORE_FILE_ROW_SIZE = 64;
export const STORE_NODE_ROW_SIZE = 140;
export const STORE_EDGE_ROW_SIZE = 48;
export const STORE_REF_ROW_SIZE = 56;

/** meta header byte offsets (after the u8 version + [3] pad). */
export const STORE_META = {
  version: 0, // u8
  opCount: 4, // u32
  fileCount: 8, // u32
  nodeCount: 12, // u32
  edgeCount: 16, // u32
  refCount: 20, // u32
  arenaLen: 24, // u32
} as const;

/** op row byte offsets. */
export const STORE_OP = {
  code: 0, // u8
  fileIndex: 4, // u32 (NONE = no file)
  nodeStart: 8, // u32
  nodeEnd: 12, // u32 exclusive (NONE = empty range)
  edgeStart: 16,
  edgeEnd: 20,
  refStart: 24,
  refEnd: 28,
  arg: 32, // str (op-specific NUL-joined payload)
  flags: 40, // u32
} as const;

/** file row byte offsets. */
export const STORE_FILE = {
  path: 0, // str
  contentHash: 8, // str
  language: 16, // str
  errorsJson: 24, // str (absent → NULL)
  size: 32, // i64
  modifiedAt: 40, // f64 (ms, may be fractional)
  indexedAt: 48, // i64 (ms epoch)
  nodeCount: 56, // u32 (PRE-validity-filter count — see store.rs)
} as const;

/** node row byte offsets. */
export const STORE_NODE = {
  id: 0, // str
  kind: 8, // str
  name: 16, // str
  qualifiedName: 24, // str (absent → Rust falls back to name)
  filePath: 32, // str
  language: 40, // str
  startLine: 48, // u32
  endLine: 52,
  startColumn: 56,
  endColumn: 60,
  docstring: 64, // str (absent → NULL)
  signature: 72,
  visibility: 80,
  flags: 88, // u8 — bit0 exported, bit1 async, bit2 static, bit3 abstract
  decoratorsJson: 92, // str (encoder-serialized JSON array)
  typeParametersJson: 100,
  returnType: 108,
  paramsJson: 116, // str (compact [{"n":..,"t":..}])
  searchText: 124, // str (encoder-computed buildSearchText; absent → '')
  updatedAt: 132, // i64
} as const;

/** edge row byte offsets. */
export const STORE_EDGE = {
  source: 0, // str
  target: 8, // str
  kind: 16, // str
  metadataJson: 24, // str (byte-identical passthrough contract)
  line: 32, // u32 (NONE → NULL)
  col: 36, // u32 (NONE → NULL)
  provenance: 40, // str
} as const;

/** unresolved-ref row byte offsets. */
export const STORE_REF = {
  fromNodeId: 0, // str
  referenceName: 8, // str
  referenceKind: 16, // str
  line: 24, // u32 (NONE → 0)
  col: 28, // u32 (NONE → 0)
  candidatesJson: 32, // str
  filePath: 40, // str (standalone absent → ''; in OP_STORE_FILE_RESULT → op file path)
  language: 48, // str (standalone absent → 'unknown'; in op → file language)
} as const;

/** Op codes (store.rs OP_*). */
export const OP_STORE_FILE_RESULT = 1;
export const OP_DELETE_FILE = 2;
export const OP_INSERT_NODES = 3;
export const OP_INSERT_EDGES = 4;
export const OP_INSERT_REFS = 5;
export const OP_UPSERT_FILE = 6;
export const OP_DELETE_UNRESOLVED_BY_IDS = 7;
export const OP_DELETE_SPECIFIC_RESOLVED_REFS = 8;
export const OP_MARK_REFS_FAILED = 9;

/** OP_DELETE_FILE flags bit0: resurrect incoming cross-file edges first (#1240). */
export const DELETE_FILE_FLAG_RESURRECT = 1;

/** The five flat store tables handed to the napi entry points. */
export interface StoreBuffers {
  meta: Buffer;
  nodes: Buffer;
  edges: Buffer;
  refs: Buffer;
  arena: Buffer;
}
