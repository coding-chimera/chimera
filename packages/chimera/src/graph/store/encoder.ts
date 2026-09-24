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
 */
export class StoreBuffersBuilder {
  private arenaChunks: Buffer[] = [];
  private arenaLen = 0;
  private nodeChunks: Buffer[] = [];
  private edgeChunks: Buffer[] = [];
  private refChunks: Buffer[] = [];
  private opChunks: Buffer[] = [];
  private fileChunks: Buffer[] = [];
  private nodeCount = 0;
  private edgeCount = 0;
  private refCount = 0;
  private opCount = 0;
  private fileCount = 0;

  private put(s: string): RowRange {
    const b = Buffer.from(s, 'utf8');
    const off = this.arenaLen;
    this.arenaChunks.push(b);
    this.arenaLen += b.length;
    return [off, b.length];
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
    const row = Buffer.alloc(STORE_NODE_ROW_SIZE);
    StoreBuffersBuilder.writeStr(row, 0, this.put(n.id ?? ''));
    StoreBuffersBuilder.writeStr(row, 8, this.put(n.kind ?? ''));
    StoreBuffersBuilder.writeStr(row, 16, this.put(n.name ?? ''));
    // TS binds qualifiedName ?? name; absent → Rust falls back to name.
    StoreBuffersBuilder.writeStr(row, 24, this.putOpt(n.qualifiedName));
    StoreBuffersBuilder.writeStr(row, 32, this.put(n.filePath ?? ''));
    StoreBuffersBuilder.writeStr(row, 40, this.put(n.language ?? ''));
    row.writeUInt32LE(n.startLine ?? 0, 48);
    row.writeUInt32LE(n.endLine ?? 0, 52);
    row.writeUInt32LE(n.startColumn ?? 0, 56);
    row.writeUInt32LE(n.endColumn ?? 0, 60);
    StoreBuffersBuilder.writeStr(row, 64, this.putOpt(n.docstring));
    StoreBuffersBuilder.writeStr(row, 72, this.putOpt(n.signature));
    StoreBuffersBuilder.writeStr(row, 80, this.putOpt(n.visibility));
    row.writeUInt8(
      (n.isExported ? 1 : 0) | (n.isAsync ? 2 : 0) | (n.isStatic ? 4 : 0) | (n.isAbstract ? 8 : 0),
      88
    );
    StoreBuffersBuilder.writeStr(row, 92, this.putOpt(n.decorators ? JSON.stringify(n.decorators) : null));
    StoreBuffersBuilder.writeStr(row, 100, this.putOpt(n.typeParameters ? JSON.stringify(n.typeParameters) : null));
    StoreBuffersBuilder.writeStr(row, 108, this.putOpt(n.returnType));
    StoreBuffersBuilder.writeStr(row, 116, this.putOpt(serializeParamsJson(n.params)));
    // searchText: TS ALWAYS binds a string (absent → '' on the Rust side, but
    // computing it here keeps the row byte-equal to the TS binding).
    StoreBuffersBuilder.writeStr(row, 124, this.put(buildSearchText(n.name ?? '', n.qualifiedName ?? n.name)));
    row.writeBigInt64LE(BigInt(n.updatedAt ?? Date.now()), 132);
    this.nodeChunks.push(row);
    this.nodeCount++;
    return this.nodeCount - 1;
  }

  /** Encode one edge row with the queries.ts insertEdge bindings. */
  edge(e: Edge): number {
    const row = Buffer.alloc(STORE_EDGE_ROW_SIZE);
    StoreBuffersBuilder.writeStr(row, 0, this.put(e.source));
    StoreBuffersBuilder.writeStr(row, 8, this.put(e.target));
    StoreBuffersBuilder.writeStr(row, 16, this.put(e.kind));
    // Byte-identical passthrough: the same JSON.stringify text the TS
    // insertEdge would bind (store.rs metadata_sql contract).
    StoreBuffersBuilder.writeStr(row, 24, this.putOpt(e.metadata ? JSON.stringify(e.metadata) : null));
    row.writeUInt32LE(e.line ?? NONE, 32);
    row.writeUInt32LE(e.column ?? NONE, 36);
    StoreBuffersBuilder.writeStr(row, 40, this.putOpt(e.provenance));
    this.edgeChunks.push(row);
    this.edgeCount++;
    return this.edgeCount - 1;
  }

  /** Encode one unresolved-ref row with the insertUnresolvedRef bindings. */
  ref(r: UnresolvedReference): number {
    const row = Buffer.alloc(STORE_REF_ROW_SIZE);
    StoreBuffersBuilder.writeStr(row, 0, this.put(r.fromNodeId));
    StoreBuffersBuilder.writeStr(row, 8, this.put(r.referenceName));
    StoreBuffersBuilder.writeStr(row, 16, this.put(r.referenceKind));
    row.writeUInt32LE(r.line ?? NONE, 24);
    row.writeUInt32LE(r.column ?? NONE, 28);
    StoreBuffersBuilder.writeStr(row, 32, this.putOpt(r.candidates ? JSON.stringify(r.candidates) : null));
    // Absent → Rust fills '' standalone / the op's file context inside
    // OP_STORE_FILE_RESULT — matching `ref.filePath ?? filePath`.
    StoreBuffersBuilder.writeStr(row, 40, this.putOpt(r.filePath));
    StoreBuffersBuilder.writeStr(row, 48, this.putOpt(r.language));
    this.refChunks.push(row);
    this.refCount++;
    return this.refCount - 1;
  }

  /** Encode one file row with the queries.ts upsertFile bindings. */
  file(f: FileRecord): number {
    const row = Buffer.alloc(STORE_FILE_ROW_SIZE);
    StoreBuffersBuilder.writeStr(row, 0, this.put(f.path));
    StoreBuffersBuilder.writeStr(row, 8, this.put(f.contentHash));
    StoreBuffersBuilder.writeStr(row, 16, this.put(f.language));
    StoreBuffersBuilder.writeStr(row, 24, this.putOpt(f.errors ? JSON.stringify(f.errors) : null));
    row.writeBigInt64LE(BigInt(f.size), 32);
    row.writeDoubleLE(f.modifiedAt, 40);
    row.writeBigInt64LE(BigInt(f.indexedAt), 48);
    // node_count passthrough — the caller (extraction orchestrator) supplies
    // the PRE-validity-filter result.nodes.length.
    row.writeUInt32LE(f.nodeCount, 56);
    this.fileChunks.push(row);
    this.fileCount++;
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
    const row = Buffer.alloc(STORE_OP_ROW_SIZE);
    row.writeUInt8(code, 0);
    row.writeUInt32LE(fileIndex ?? NONE, 4);
    row.writeUInt32LE(nodes ? nodes[0] : 0, 8);
    row.writeUInt32LE(nodes ? nodes[1] : NONE, 12);
    row.writeUInt32LE(edges ? edges[0] : 0, 16);
    row.writeUInt32LE(edges ? edges[1] : NONE, 20);
    row.writeUInt32LE(refs ? refs[0] : 0, 24);
    row.writeUInt32LE(refs ? refs[1] : NONE, 28);
    StoreBuffersBuilder.writeStr(row, 32, this.putOpt(arg));
    row.writeUInt32LE(flags, 40);
    this.opChunks.push(row);
    this.opCount++;
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
    return {
      meta: Buffer.concat([meta, ...this.opChunks, ...this.fileChunks]),
      nodes: Buffer.concat(this.nodeChunks),
      edges: Buffer.concat(this.edgeChunks),
      refs: Buffer.concat(this.refChunks),
      arena: Buffer.concat(this.arenaChunks),
    };
  }
}
