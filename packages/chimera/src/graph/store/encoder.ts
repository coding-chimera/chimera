/**
 * Store wire encoder — the TS counterpart of codegraph-kernel/src/store.rs
 * `mod wire_build::Builder` (its executable reference) against the byte
 * layout in ./layout.ts (R3a-2).
 *
 * TS-side responsibilities carried here (R3a-1 handover — Rust never
 * duplicates these derivations, single source of truth stays TS):
 *   - buildSearchText(name, qualifiedName ?? name)   (nodes.search_text)
 *   - serializeParamsJson(params)                    (nodes.params_json)
 *   - JSON.stringify of decorators / typeParameters / candidates / errors /
 *     edge metadata (byte-identical to what the TS QueryBuilder would bind)
 *   - updatedAt ?? Date.now()                        (nodes.updated_at)
 *   - FileRecord passthrough: indexedAt = Date.now() is stamped by the
 *     extraction orchestrator, node_count = the PRE-validity-filter
 *     result.nodes.length — the encoder passes FileRecord fields through
 *     verbatim because upsertFile's TS bindings are the contract.
 *
 * Absent-vs-empty discipline: `undefined`/`null` encode as NONE (Rust maps
 * to NULL / the documented fallback); the empty string encodes as a present
 * zero-length arena ref — exactly the `?? null` vs `?? ''` split in
 * queries.ts insertNode / insertUnresolvedRef bindings.
 */

import type { Edge, FileRecord, Node, UnresolvedReference } from '../types';
import { buildSearchText } from '../search/query-utils';
import {
  NONE,
  STORE_ABI_VERSION,
  STORE_EDGE_ROW_SIZE,
  STORE_FILE_ROW_SIZE,
  STORE_META_HEADER_SIZE,
  STORE_NODE_ROW_SIZE,
  STORE_OP_ROW_SIZE,
  STORE_REF_ROW_SIZE,
  DELETE_FILE_FLAG_RESURRECT,
  OP_DELETE_FILE,
  OP_DELETE_SPECIFIC_RESOLVED_REFS,
  OP_DELETE_UNRESOLVED_BY_IDS,
  OP_INSERT_EDGES,
  OP_INSERT_NODES,
  OP_INSERT_REFS,
  OP_MARK_REFS_FAILED,
  OP_STORE_FILE_RESULT,
  OP_UPSERT_FILE,
  type StoreBuffers,
} from './layout';

/** Mirror of queries.ts serializeParamsJson (private there; kept byte-equal). */
function serializeParamsJson(params: Node['params']): string | null {
  return params?.length ? JSON.stringify(params.map((p) => ({ n: p.name, t: p.type }))) : null;
}

/** (fromNodeId, referenceName, referenceKind) triple — the arg-only ops. */
export interface RefTriple {
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
}

type RowRange = [start: number, end: number];

/**
 * Five-buffer builder. Rows are fixed-width; strings go through the shared
 * UTF-8 arena (no dedup requirement — store.rs reads (offset,len) pairs).
 *
 * Allocation strategy: ONE geometrically-grown buffer per table plus one for
 * the arena — no per-row `Buffer.alloc`, no per-string `Buffer.from`, and no
 * finish-time `Buffer.concat`. Strings are written straight into the arena
 * with a single `Buffer.write` (capacity reserved up front from the UTF-8
 * upper bound), and each row is written in place at its append offset.
 * `finish()` hands back zero-copy `subarray` views of the exact used byte
 * ranges, so the wire layout is byte-identical to the previous chunk-concat
 * implementation while the allocation storm is gone.
 */
export class StoreBuffersBuilder {
  private arena: Buffer = Buffer.alloc(0);
  private arenaLen = 0;
  private nodeBuf: Buffer = Buffer.alloc(0);
  private nodeLen = 0;
  private edgeBuf: Buffer = Buffer.alloc(0);
  private edgeLen = 0;
  private refBuf: Buffer = Buffer.alloc(0);
  private refLen = 0;
  private opBuf: Buffer = Buffer.alloc(0);
  private opLen = 0;
  private fileBuf: Buffer = Buffer.alloc(0);
  private fileLen = 0;
  private nodeCount = 0;
  private edgeCount = 0;
  private refCount = 0;
  private opCount = 0;
  private fileCount = 0;

  /**
   * Grow `buf` to hold at least `len + need` bytes while preserving `[0, len)`.
   * Geometric doubling keeps reallocations O(log n) instead of O(rows).
   * `zeroed` tables use `Buffer.alloc` so inter-field padding bytes stay 0
   * (byte-identical to the old per-row `Buffer.alloc`); the arena is fully
   * overwritten up to `arenaLen`, so it can use the cheaper `allocUnsafe`.
   */
  private static ensure(buf: Buffer, len: number, need: number, zeroed: boolean): Buffer {
    if (len + need <= buf.length) return buf;
    const cap = Math.max(buf.length * 2, len + need, 64);
    const next = zeroed ? Buffer.alloc(cap) : Buffer.allocUnsafe(cap);
    buf.copy(next, 0, 0, len);
    return next;
  }

  private put(s: string): RowRange {
    const off = this.arenaLen;
    // UTF-8 encodes at most 3 bytes per UTF-16 code unit, so this upper bound
    // lets `write` encode the string exactly once — no intermediate Buffer.from
    // and no second byteLength scan; arenaLen advances by the actual bytes.
    this.arena = StoreBuffersBuilder.ensure(this.arena, this.arenaLen, s.length * 3, false);
    const n = this.arena.write(s, off, 'utf8');
    this.arenaLen = off + n;
    return [off, n];
  }

  private putOpt(s: string | null | undefined): RowRange {
    return s === null || s === undefined ? [NONE, 0] : this.put(s);
  }

  private static writeStr(row: Buffer, at: number, ref: RowRange): void {
    row.writeUInt32LE(ref[0], at);
    row.writeUInt32LE(ref[1], at + 4);
  }

  // --- row tables -----------------------------------------------------------

  /** Current row index of the node table (range starts). */
  get nodes(): number {
    return this.nodeCount;
  }
  get edges(): number {
    return this.edgeCount;
  }
  get refs(): number {
    return this.refCount;
  }

  /**
   * Encode one node row with the queries.ts insertNode bindings: required
   * fields go verbatim (Rust skips rows missing any of them — the insertNode
   * validation guard), derived fields are computed HERE (see module docs).
   */
  node(n: Node): number {
    const at = this.nodeLen;
    this.nodeBuf = StoreBuffersBuilder.ensure(this.nodeBuf, at, STORE_NODE_ROW_SIZE, true);
    const row = this.nodeBuf;
    this.nodeLen = at + STORE_NODE_ROW_SIZE;
    this.nodeCount++;
    StoreBuffersBuilder.writeStr(row, at + 0, this.put(n.id ?? ''));
    StoreBuffersBuilder.writeStr(row, at + 8, this.put(n.kind ?? ''));
    StoreBuffersBuilder.writeStr(row, at + 16, this.put(n.name ?? ''));
    // TS binds qualifiedName ?? name; absent → Rust falls back to name.
    StoreBuffersBuilder.writeStr(row, at + 24, this.putOpt(n.qualifiedName));
    StoreBuffersBuilder.writeStr(row, at + 32, this.put(n.filePath ?? ''));
    StoreBuffersBuilder.writeStr(row, at + 40, this.put(n.language ?? ''));
    row.writeUInt32LE(n.startLine ?? 0, at + 48);
    row.writeUInt32LE(n.endLine ?? 0, at + 52);
    row.writeUInt32LE(n.startColumn ?? 0, at + 56);
    row.writeUInt32LE(n.endColumn ?? 0, at + 60);
    StoreBuffersBuilder.writeStr(row, at + 64, this.putOpt(n.docstring));
    StoreBuffersBuilder.writeStr(row, at + 72, this.putOpt(n.signature));
    StoreBuffersBuilder.writeStr(row, at + 80, this.putOpt(n.visibility));
    row.writeUInt8(
      (n.isExported ? 1 : 0) | (n.isAsync ? 2 : 0) | (n.isStatic ? 4 : 0) | (n.isAbstract ? 8 : 0),
      at + 88
    );
    StoreBuffersBuilder.writeStr(row, at + 92, this.putOpt(n.decorators ? JSON.stringify(n.decorators) : null));
    StoreBuffersBuilder.writeStr(row, at + 100, this.putOpt(n.typeParameters ? JSON.stringify(n.typeParameters) : null));
    StoreBuffersBuilder.writeStr(row, at + 108, this.putOpt(n.returnType));
    StoreBuffersBuilder.writeStr(row, at + 116, this.putOpt(serializeParamsJson(n.params)));
    // searchText: TS ALWAYS binds a string (absent → '' on the Rust side, but
    // computing it here keeps the row byte-equal to the TS binding).
    StoreBuffersBuilder.writeStr(row, at + 124, this.put(buildSearchText(n.name ?? '', n.qualifiedName ?? n.name)));
    row.writeBigInt64LE(BigInt(n.updatedAt ?? Date.now()), at + 132);
    return this.nodeCount - 1;
  }

  /** Encode one edge row with the queries.ts insertEdge bindings. */
  edge(e: Edge): number {
    const at = this.edgeLen;
    this.edgeBuf = StoreBuffersBuilder.ensure(this.edgeBuf, at, STORE_EDGE_ROW_SIZE, true);
    const row = this.edgeBuf;
    this.edgeLen = at + STORE_EDGE_ROW_SIZE;
    this.edgeCount++;
    StoreBuffersBuilder.writeStr(row, at + 0, this.put(e.source));
    StoreBuffersBuilder.writeStr(row, at + 8, this.put(e.target));
    StoreBuffersBuilder.writeStr(row, at + 16, this.put(e.kind));
    // Byte-identical passthrough: the same JSON.stringify text the TS
    // insertEdge would bind (store.rs metadata_sql contract).
    StoreBuffersBuilder.writeStr(row, at + 24, this.putOpt(e.metadata ? JSON.stringify(e.metadata) : null));
    row.writeUInt32LE(e.line ?? NONE, at + 32);
    row.writeUInt32LE(e.column ?? NONE, at + 36);
    StoreBuffersBuilder.writeStr(row, at + 40, this.putOpt(e.provenance));
    return this.edgeCount - 1;
  }

  /** Encode one unresolved-ref row with the insertUnresolvedRef bindings. */
  ref(r: UnresolvedReference): number {
    const at = this.refLen;
    this.refBuf = StoreBuffersBuilder.ensure(this.refBuf, at, STORE_REF_ROW_SIZE, true);
    const row = this.refBuf;
    this.refLen = at + STORE_REF_ROW_SIZE;
    this.refCount++;
    StoreBuffersBuilder.writeStr(row, at + 0, this.put(r.fromNodeId));
    StoreBuffersBuilder.writeStr(row, at + 8, this.put(r.referenceName));
    StoreBuffersBuilder.writeStr(row, at + 16, this.put(r.referenceKind));
    row.writeUInt32LE(r.line ?? NONE, at + 24);
    row.writeUInt32LE(r.column ?? NONE, at + 28);
    StoreBuffersBuilder.writeStr(row, at + 32, this.putOpt(r.candidates ? JSON.stringify(r.candidates) : null));
    // Absent → Rust fills '' standalone / the op's file context inside
    // OP_STORE_FILE_RESULT — matching `ref.filePath ?? filePath`.
    StoreBuffersBuilder.writeStr(row, at + 40, this.putOpt(r.filePath));
    StoreBuffersBuilder.writeStr(row, at + 48, this.putOpt(r.language));
    return this.refCount - 1;
  }

  /** Encode one file row with the queries.ts upsertFile bindings. */
  file(f: FileRecord): number {
    const at = this.fileLen;
    this.fileBuf = StoreBuffersBuilder.ensure(this.fileBuf, at, STORE_FILE_ROW_SIZE, true);
    const row = this.fileBuf;
    this.fileLen = at + STORE_FILE_ROW_SIZE;
    this.fileCount++;
    StoreBuffersBuilder.writeStr(row, at + 0, this.put(f.path));
    StoreBuffersBuilder.writeStr(row, at + 8, this.put(f.contentHash));
    StoreBuffersBuilder.writeStr(row, at + 16, this.put(f.language));
    StoreBuffersBuilder.writeStr(row, at + 24, this.putOpt(f.errors ? JSON.stringify(f.errors) : null));
    row.writeBigInt64LE(BigInt(f.size), at + 32);
    row.writeDoubleLE(f.modifiedAt, at + 40);
    row.writeBigInt64LE(BigInt(f.indexedAt), at + 48);
    // node_count passthrough — the caller (extraction orchestrator) supplies
    // the PRE-validity-filter result.nodes.length.
    row.writeUInt32LE(f.nodeCount, at + 56);
    return this.fileCount - 1;
  }

  // --- op table -------------------------------------------------------------

  private op(
    code: number,
    fileIndex: number | null,
    nodes: RowRange | null,
    edges: RowRange | null,
    refs: RowRange | null,
    arg: string | null,
    flags: number
  ): number {
    const at = this.opLen;
    this.opBuf = StoreBuffersBuilder.ensure(this.opBuf, at, STORE_OP_ROW_SIZE, true);
    const row = this.opBuf;
    this.opLen = at + STORE_OP_ROW_SIZE;
    this.opCount++;
    row.writeUInt8(code, at + 0);
    row.writeUInt32LE(fileIndex ?? NONE, at + 4);
    row.writeUInt32LE(nodes ? nodes[0] : 0, at + 8);
    row.writeUInt32LE(nodes ? nodes[1] : NONE, at + 12);
    row.writeUInt32LE(edges ? edges[0] : 0, at + 16);
    row.writeUInt32LE(edges ? edges[1] : NONE, at + 20);
    row.writeUInt32LE(refs ? refs[0] : 0, at + 24);
    row.writeUInt32LE(refs ? refs[1] : NONE, at + 28);
    StoreBuffersBuilder.writeStr(row, at + 32, this.putOpt(arg));
    row.writeUInt32LE(flags, at + 40);
    return this.opCount - 1;
  }

  /** OP_STORE_FILE_RESULT — the full storeExtractionResultTxn for one file. */
  opStoreFileResult(fileIndex: number, nodes: RowRange | null, edges: RowRange | null, refs: RowRange | null): number {
    return this.op(OP_STORE_FILE_RESULT, fileIndex, nodes, edges, refs, null, 0);
  }

  /** OP_DELETE_FILE — plain cascade, or resurrect-first with the flag (#1240). */
  opDeleteFile(path: string, resurrect: boolean): number {
    return this.op(OP_DELETE_FILE, null, null, null, null, path, resurrect ? DELETE_FILE_FLAG_RESURRECT : 0);
  }

  opInsertNodes(nodes: RowRange): number {
    return this.op(OP_INSERT_NODES, null, nodes, null, null, null, 0);
  }

  opInsertEdges(edges: RowRange): number {
    return this.op(OP_INSERT_EDGES, null, null, edges, null, null, 0);
  }

  opInsertRefs(refs: RowRange): number {
    return this.op(OP_INSERT_REFS, null, null, null, refs, null, 0);
  }

  opUpsertFile(fileIndex: number): number {
    return this.op(OP_UPSERT_FILE, fileIndex, null, null, null, null, 0);
  }

  /** OP_DELETE_UNRESOLVED_BY_IDS — arg = NUL-joined decimal row ids. */
  opDeleteUnresolvedByIds(ids: readonly number[]): number {
    return this.op(OP_DELETE_UNRESOLVED_BY_IDS, null, null, null, null, ids.map((id) => String(id)).join('\0'), 0);
  }

  /** OP_DELETE_SPECIFIC_RESOLVED_REFS / OP_MARK_REFS_FAILED — flat NUL-joined triples. */
  private opTriples(code: number, refs: readonly RefTriple[]): number {
    return this.op(
      code,
      null,
      null,
      null,
      null,
      refs.map((r) => `${r.fromNodeId}\0${r.referenceName}\0${r.referenceKind}`).join('\0'),
      0
    );
  }

  opDeleteSpecificResolvedRefs(refs: readonly RefTriple[]): number {
    return this.opTriples(OP_DELETE_SPECIFIC_RESOLVED_REFS, refs);
  }

  opMarkRefsFailed(refs: readonly RefTriple[]): number {
    return this.opTriples(OP_MARK_REFS_FAILED, refs);
  }

  // --- finish ----------------------------------------------------------------

  /** Assemble the five flat buffers (meta = header + op table + file table). */
  finish(): StoreBuffers {
    const meta = Buffer.alloc(STORE_META_HEADER_SIZE);
    meta.writeUInt8(STORE_ABI_VERSION, 0);
    meta.writeUInt32LE(this.opCount, 4);
    meta.writeUInt32LE(this.fileCount, 8);
    meta.writeUInt32LE(this.nodeCount, 12);
    meta.writeUInt32LE(this.edgeCount, 16);
    meta.writeUInt32LE(this.refCount, 20);
    meta.writeUInt32LE(this.arenaLen, 24);
    // One exact allocation for the meta buffer; header + op table + file table
    // are copied in (no concat of per-row chunks).
    const metaFull = Buffer.allocUnsafe(STORE_META_HEADER_SIZE + this.opLen + this.fileLen);
    meta.copy(metaFull, 0);
    this.opBuf.copy(metaFull, STORE_META_HEADER_SIZE, 0, this.opLen);
    this.fileBuf.copy(metaFull, STORE_META_HEADER_SIZE + this.opLen, 0, this.fileLen);
    return {
      meta: metaFull,
      nodes: this.nodeBuf.subarray(0, this.nodeLen),
      edges: this.edgeBuf.subarray(0, this.edgeLen),
      refs: this.refBuf.subarray(0, this.refLen),
      arena: this.arena.subarray(0, this.arenaLen),
    };
  }
}
