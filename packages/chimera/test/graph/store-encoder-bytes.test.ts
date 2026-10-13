/**
 * R3 encoder byte-equivalence — proves the allocation-free StoreBuffersBuilder
 * produces byte-identical wire output to the previous chunk-concat encoder.
 *
 * The expected bytes are built by `LegacyBuilder`, an in-test verbatim replica
 * of the pre-rewrite implementation (per-row Buffer.alloc, per-string
 * Buffer.from, finish-time Buffer.concat), so the oracle is independent of the
 * new code path. Both builders are driven through the same seeded random op
 * sequence (nodes/edges/refs/files + every op code) covering ASCII, Chinese,
 * emoji (4-byte UTF-8), empty strings, absent-vs-empty fields, and long strings
 * big enough to force multiple geometric arena/table regrowths.
 */

import { describe, it, expect } from './vitest';
import type { Edge, FileRecord, Node, UnresolvedReference } from '../../src/graph/types';
import { StoreBuffersBuilder, type RefTriple } from '../../src/graph/store/encoder';
import { buildSearchText } from '../../src/graph/search/query-utils';
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
} from '../../src/graph/store/layout';

// ---------------------------------------------------------------------------
// Legacy encoder replica — the pre-rewrite chunk-concat implementation.
// ---------------------------------------------------------------------------

type RowRange = [start: number, end: number];

function serializeParamsJson(params: Node['params']): string | null {
  return params?.length ? JSON.stringify(params.map((p) => ({ n: p.name, t: p.type }))) : null;
}

class LegacyBuilder {
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

  get nodes(): number {
    return this.nodeCount;
  }
  get edges(): number {
    return this.edgeCount;
  }
  get refs(): number {
    return this.refCount;
  }

  node(n: Node): number {
    const row = Buffer.alloc(STORE_NODE_ROW_SIZE);
    LegacyBuilder.writeStr(row, 0, this.put(n.id ?? ''));
    LegacyBuilder.writeStr(row, 8, this.put(n.kind ?? ''));
    LegacyBuilder.writeStr(row, 16, this.put(n.name ?? ''));
    LegacyBuilder.writeStr(row, 24, this.putOpt(n.qualifiedName));
    LegacyBuilder.writeStr(row, 32, this.put(n.filePath ?? ''));
    LegacyBuilder.writeStr(row, 40, this.put(n.language ?? ''));
    row.writeUInt32LE(n.startLine ?? 0, 48);
    row.writeUInt32LE(n.endLine ?? 0, 52);
    row.writeUInt32LE(n.startColumn ?? 0, 56);
    row.writeUInt32LE(n.endColumn ?? 0, 60);
    LegacyBuilder.writeStr(row, 64, this.putOpt(n.docstring));
    LegacyBuilder.writeStr(row, 72, this.putOpt(n.signature));
    LegacyBuilder.writeStr(row, 80, this.putOpt(n.visibility));
    row.writeUInt8(
      (n.isExported ? 1 : 0) | (n.isAsync ? 2 : 0) | (n.isStatic ? 4 : 0) | (n.isAbstract ? 8 : 0),
      88
    );
    LegacyBuilder.writeStr(row, 92, this.putOpt(n.decorators ? JSON.stringify(n.decorators) : null));
    LegacyBuilder.writeStr(row, 100, this.putOpt(n.typeParameters ? JSON.stringify(n.typeParameters) : null));
    LegacyBuilder.writeStr(row, 108, this.putOpt(n.returnType));
    LegacyBuilder.writeStr(row, 116, this.putOpt(serializeParamsJson(n.params)));
    LegacyBuilder.writeStr(row, 124, this.put(buildSearchText(n.name ?? '', n.qualifiedName ?? n.name)));
    row.writeBigInt64LE(BigInt(n.updatedAt ?? Date.now()), 132);
    this.nodeChunks.push(row);
    this.nodeCount++;
    return this.nodeCount - 1;
  }

  edge(e: Edge): number {
    const row = Buffer.alloc(STORE_EDGE_ROW_SIZE);
    LegacyBuilder.writeStr(row, 0, this.put(e.source));
    LegacyBuilder.writeStr(row, 8, this.put(e.target));
    LegacyBuilder.writeStr(row, 16, this.put(e.kind));
    LegacyBuilder.writeStr(row, 24, this.putOpt(e.metadata ? JSON.stringify(e.metadata) : null));
    row.writeUInt32LE(e.line ?? NONE, 32);
    row.writeUInt32LE(e.column ?? NONE, 36);
    LegacyBuilder.writeStr(row, 40, this.putOpt(e.provenance));
    this.edgeChunks.push(row);
    this.edgeCount++;
    return this.edgeCount - 1;
  }

  ref(r: UnresolvedReference): number {
    const row = Buffer.alloc(STORE_REF_ROW_SIZE);
    LegacyBuilder.writeStr(row, 0, this.put(r.fromNodeId));
    LegacyBuilder.writeStr(row, 8, this.put(r.referenceName));
    LegacyBuilder.writeStr(row, 16, this.put(r.referenceKind));
    row.writeUInt32LE(r.line ?? NONE, 24);
    row.writeUInt32LE(r.column ?? NONE, 28);
    LegacyBuilder.writeStr(row, 32, this.putOpt(r.candidates ? JSON.stringify(r.candidates) : null));
    LegacyBuilder.writeStr(row, 40, this.putOpt(r.filePath));
    LegacyBuilder.writeStr(row, 48, this.putOpt(r.language));
    this.refChunks.push(row);
    this.refCount++;
    return this.refCount - 1;
  }

  file(f: FileRecord): number {
    const row = Buffer.alloc(STORE_FILE_ROW_SIZE);
    LegacyBuilder.writeStr(row, 0, this.put(f.path));
    LegacyBuilder.writeStr(row, 8, this.put(f.contentHash));
    LegacyBuilder.writeStr(row, 16, this.put(f.language));
    LegacyBuilder.writeStr(row, 24, this.putOpt(f.errors ? JSON.stringify(f.errors) : null));
    row.writeBigInt64LE(BigInt(f.size), 32);
    row.writeDoubleLE(f.modifiedAt, 40);
    row.writeBigInt64LE(BigInt(f.indexedAt), 48);
    row.writeUInt32LE(f.nodeCount, 56);
    this.fileChunks.push(row);
    this.fileCount++;
    return this.fileCount - 1;
  }

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
    LegacyBuilder.writeStr(row, 32, this.putOpt(arg));
    row.writeUInt32LE(flags, 40);
    this.opChunks.push(row);
    this.opCount++;
    return this.opCount - 1;
  }

  opStoreFileResult(fileIndex: number, nodes: RowRange | null, edges: RowRange | null, refs: RowRange | null): number {
    return this.op(OP_STORE_FILE_RESULT, fileIndex, nodes, edges, refs, null, 0);
  }
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
  opDeleteUnresolvedByIds(ids: readonly number[]): number {
    return this.op(OP_DELETE_UNRESOLVED_BY_IDS, null, null, null, null, ids.map((id) => String(id)).join('\0'), 0);
  }
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

// ---------------------------------------------------------------------------
// Shared builder surface + seeded random generation
// ---------------------------------------------------------------------------

interface BuilderLike {
  readonly nodes: number;
  readonly edges: number;
  readonly refs: number;
  node(n: Node): number;
  edge(e: Edge): number;
  ref(r: UnresolvedReference): number;
  file(f: FileRecord): number;
  opStoreFileResult(fi: number, n: RowRange | null, e: RowRange | null, r: RowRange | null): number;
  opDeleteFile(path: string, resurrect: boolean): number;
  opInsertNodes(n: RowRange): number;
  opInsertEdges(e: RowRange): number;
  opInsertRefs(r: RowRange): number;
  opUpsertFile(fi: number): number;
  opDeleteUnresolvedByIds(ids: readonly number[]): number;
  opDeleteSpecificResolvedRefs(refs: readonly RefTriple[]): number;
  opMarkRefsFailed(refs: readonly RefTriple[]): number;
  finish(): StoreBuffers;
}

type Action = (b: BuilderLike) => void;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Unicode pool as code points (emoji kept whole so strings stay valid UTF-16).
const CHARS = Array.from('abcXYZ_0123./- \t中文测试字符日本語한국어😀🎉🚀éüñßΩ');

function randString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(rng() * CHARS.length)];
  return s;
}

function maybe<T>(rng: () => number, p: number, value: T): T | undefined {
  return rng() < p ? value : undefined;
}

function randNode(rng: () => number): Node {
  return {
    id: randString(rng, 24),
    kind: randString(rng, 10),
    name: randString(rng, 30),
    qualifiedName: maybe(rng, 0.8, randString(rng, 40)),
    filePath: randString(rng, 20),
    language: randString(rng, 8),
    startLine: Math.floor(rng() * 1e6),
    endLine: Math.floor(rng() * 1e6),
    startColumn: Math.floor(rng() * 1e4),
    endColumn: Math.floor(rng() * 1e4),
    docstring: maybe(rng, 0.5, randString(rng, 120)),
    signature: maybe(rng, 0.5, randString(rng, 60)),
    visibility: maybe(rng, 0.3, 'public'),
    isExported: rng() < 0.5,
    isAsync: rng() < 0.5,
    isStatic: rng() < 0.3,
    isAbstract: rng() < 0.3,
    decorators: maybe(rng, 0.4, [randString(rng, 8), randString(rng, 8)]),
    typeParameters: maybe(rng, 0.4, [randString(rng, 6)]),
    returnType: maybe(rng, 0.5, randString(rng, 20)),
    params: maybe(rng, 0.5, [
      { name: randString(rng, 8), type: randString(rng, 12) },
      { name: randString(rng, 8), type: randString(rng, 12) },
    ]),
    updatedAt: Math.floor(rng() * 1e13),
  } as unknown as Node;
}

function randEdge(rng: () => number): Edge {
  return {
    source: randString(rng, 20),
    target: randString(rng, 20),
    kind: randString(rng, 10),
    metadata: maybe(rng, 0.5, { a: randString(rng, 10), b: Math.floor(rng() * 100) }),
    line: maybe(rng, 0.5, Math.floor(rng() * 1e5)),
    column: maybe(rng, 0.5, Math.floor(rng() * 1e3)),
    provenance: maybe(rng, 0.5, 'tree-sitter'),
  } as unknown as Edge;
}

function randRef(rng: () => number): UnresolvedReference {
  return {
    fromNodeId: randString(rng, 20),
    referenceName: randString(rng, 24),
    referenceKind: randString(rng, 10),
    line: maybe(rng, 0.5, Math.floor(rng() * 1e5)),
    column: maybe(rng, 0.5, Math.floor(rng() * 1e3)),
    candidates: maybe(rng, 0.4, [randString(rng, 10), randString(rng, 10)]),
    filePath: maybe(rng, 0.6, randString(rng, 20)),
    language: maybe(rng, 0.6, randString(rng, 8)),
  } as unknown as UnresolvedReference;
}

function randFile(rng: () => number): FileRecord {
  return {
    path: randString(rng, 24),
    contentHash: randString(rng, 40),
    language: randString(rng, 8),
    errors: maybe(rng, 0.3, [{ message: randString(rng, 20), severity: 'error' }]),
    size: Math.floor(rng() * 1e9),
    modifiedAt: rng() * 1e12,
    indexedAt: Math.floor(rng() * 1e13),
    nodeCount: Math.floor(rng() * 1e4),
  } as unknown as FileRecord;
}

function makeActions(rng: () => number, opCount: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < opCount; i++) {
    const pick = Math.floor(rng() * 9);
    if (pick === 0) {
      const items = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randNode(rng));
      actions.push((b) => {
        const start = b.nodes;
        for (const n of items) b.node(n);
        b.opInsertNodes([start, b.nodes]);
      });
    } else if (pick === 1) {
      const items = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randEdge(rng));
      actions.push((b) => {
        const start = b.edges;
        for (const e of items) b.edge(e);
        b.opInsertEdges([start, b.edges]);
      });
    } else if (pick === 2) {
      const items = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randRef(rng));
      actions.push((b) => {
        const start = b.refs;
        for (const r of items) b.ref(r);
        b.opInsertRefs([start, b.refs]);
      });
    } else if (pick === 3) {
      const f = randFile(rng);
      actions.push((b) => b.opUpsertFile(b.file(f)));
    } else if (pick === 4) {
      const f = randFile(rng);
      const nodes = Array.from({ length: Math.floor(rng() * 5) }, () => randNode(rng));
      const edges = Array.from({ length: Math.floor(rng() * 5) }, () => randEdge(rng));
      const refs = Array.from({ length: Math.floor(rng() * 5) }, () => randRef(rng));
      actions.push((b) => {
        const fi = b.file(f);
        const ns = b.nodes;
        for (const n of nodes) b.node(n);
        const es = b.edges;
        for (const e of edges) b.edge(e);
        const rs = b.refs;
        for (const r of refs) b.ref(r);
        b.opStoreFileResult(fi, b.nodes > ns ? [ns, b.nodes] : null, b.edges > es ? [es, b.edges] : null, b.refs > rs ? [rs, b.refs] : null);
      });
    } else if (pick === 5) {
      const path = randString(rng, 20);
      const resurrect = rng() < 0.5;
      actions.push((b) => b.opDeleteFile(path, resurrect));
    } else if (pick === 6) {
      const ids = Array.from({ length: Math.floor(rng() * 5) }, () => Math.floor(rng() * 1e6));
      actions.push((b) => b.opDeleteUnresolvedByIds(ids));
    } else if (pick === 7) {
      const triples = Array.from({ length: Math.floor(rng() * 4) }, () => ({
        fromNodeId: randString(rng, 12),
        referenceName: randString(rng, 12),
        referenceKind: randString(rng, 8),
      }));
      const fail = rng() < 0.5;
      actions.push((b) => (fail ? b.opMarkRefsFailed(triples) : b.opDeleteSpecificResolvedRefs(triples)));
    } else {
      const f = randFile(rng);
      actions.push((b) => b.file(f));
    }
  }
  return actions;
}

function expectBuffersEqual(actual: StoreBuffers, expected: StoreBuffers): void {
  for (const key of ['meta', 'nodes', 'edges', 'refs', 'arena'] as const) {
    expect(actual[key].length, `${key} length`).toBe(expected[key].length);
    expect(actual[key].equals(expected[key]), `${key} bytes`).toBe(true);
  }
}

// ---------------------------------------------------------------------------

describe('StoreBuffersBuilder byte-equivalence (old chunk-concat vs new single-buffer)', () => {
  it('empty builder produces identical (header-only) buffers', () => {
    expectBuffersEqual(new StoreBuffersBuilder().finish(), new LegacyBuilder().finish());
  });

  it('random op sequence produces byte-identical output', () => {
    const rng = mulberry32(0xc0ffee);
    const actions = makeActions(rng, 400);
    const next = new StoreBuffersBuilder();
    const legacy = new LegacyBuilder();
    for (const action of actions) {
      action(next as unknown as BuilderLike);
      action(legacy as unknown as BuilderLike);
    }
    expectBuffersEqual(next.finish(), legacy.finish());
  });

  it('large input forcing repeated arena/table regrowth stays byte-identical', () => {
    const rng = mulberry32(0x5eed);
    const next = new StoreBuffersBuilder();
    const legacy = new LegacyBuilder();
    // ~6000 long-string nodes/edges/refs: arena and each table grow several times.
    const nodes = Array.from({ length: 3000 }, () => randNode(rng));
    const edges = Array.from({ length: 2000 }, () => randEdge(rng));
    const refs = Array.from({ length: 1000 }, () => randRef(rng));
    const longNode = { ...randNode(rng), name: 'x'.repeat(20000), id: 'long:😀:' + '中'.repeat(5000) } as unknown as Node;
    for (const n of [...nodes, longNode]) {
      next.node(n);
      legacy.node(n);
    }
    for (const e of edges) {
      next.edge(e);
      legacy.edge(e);
    }
    for (const r of refs) {
      next.ref(r);
      legacy.ref(r);
    }
    expectBuffersEqual(next.finish(), legacy.finish());
  });

  it('hand-derived node row + arena layout (independent of legacy replica)', () => {
    const b = new StoreBuffersBuilder();
    b.node({
      id: 'function:x',
      kind: 'function',
      name: 'x',
      filePath: 'a.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 2,
      startColumn: 3,
      endColumn: 4,
      isExported: true,
      updatedAt: 1700000000000,
    } as unknown as Node);
    const bufs = b.finish();

    expect(bufs.nodes.length).toBe(STORE_NODE_ROW_SIZE);
    expect(bufs.meta.length).toBe(STORE_META_HEADER_SIZE);
    expect(bufs.meta.readUInt8(0)).toBe(STORE_ABI_VERSION);
    expect(bufs.meta.readUInt32LE(12)).toBe(1); // node_count
    expect(bufs.meta.readUInt32LE(24)).toBe(bufs.arena.length); // arena_len

    // arena = id, kind, name, filePath, language, searchText (insertion order).
    const expectedArena = Buffer.concat([
      Buffer.from('function:x', 'utf8'),
      Buffer.from('function', 'utf8'),
      Buffer.from('x', 'utf8'),
      Buffer.from('a.ts', 'utf8'),
      Buffer.from('typescript', 'utf8'),
      Buffer.from(buildSearchText('x', 'x'), 'utf8'),
    ]);
    expect(bufs.arena.equals(expectedArena)).toBe(true);

    // id ref at row offset 0 = (0, 10); kind ref = (10, 8).
    expect(bufs.nodes.readUInt32LE(0)).toBe(0);
    expect(bufs.nodes.readUInt32LE(4)).toBe(10);
    expect(bufs.nodes.readUInt32LE(8)).toBe(10);
    expect(bufs.nodes.readUInt32LE(12)).toBe(8);
    // Inter-field padding bytes 89..91 stay zero (allocUnsafe would have leaked garbage).
    expect(bufs.nodes[89]).toBe(0);
    expect(bufs.nodes[90]).toBe(0);
    expect(bufs.nodes[91]).toBe(0);
    // updated_at i64 at 132.
    expect(bufs.nodes.readBigInt64LE(132)).toBe(1700000000000n);
  });

  it('emoji and Chinese strings round-trip with correct UTF-8 byte lengths', () => {
    const b = new StoreBuffersBuilder();
    const legacy = new LegacyBuilder();
    const name = '中😀文';
    const n = {
      id: 'n1',
      kind: 'function',
      name,
      filePath: '文件.ts',
      language: 'typescript',
      startLine: 0,
      endLine: 0,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 1,
    } as unknown as Node;
    b.node(n);
    legacy.node(n);
    expectBuffersEqual(b.finish(), legacy.finish());
  });
});