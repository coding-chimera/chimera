/**
 * RESOLVE wire encoder/decoder (R3c-2) — the TS mirror of codegraph-kernel
 * resolver.rs's ResolveBuffers/ResolveBuffersOut layout (RESOLVE_ABI_VERSION
 * 1; the byte-level contract lives in the resolver.rs module docs).
 *
 * Direction of trust: the Rust contract_info reports its row sizes and the
 * loader gate compares them against the constants here, so a stale binary
 * with a different layout is refused before any batch crosses.
 *
 * Metadata assembly discipline: edge rows carry STAMP FIELDS (resolvedBy,
 * refName, refKind?, fnRef?) plus the strategy/framework t.metadata as raw
 * JSON text; this decoder rebuilds the metadata OBJECT in the exact JS
 * spread order createEdges uses ({...t.metadata, resolvedBy, refName,
 * refKind?, fnRef?}) so stored JSON bytes are identical to the TS arm.
 * Sweep-range edges are the synthesized file-level `imports` edges — their
 * metadata is exactly {resolvedBy} and they deliberately carry NO refName
 * (never resurrected, index.ts:1026-1028).
 */

import type { Edge, EdgeKind, ReferenceKind } from '../types';
import type { UnresolvedRef } from './types';

/** Must equal resolver.rs RESOLVE_ABI_VERSION. */
export const RESOLVE_ABI_VERSION = 1;

// Row/table sizes — verified against resolve_contract_info at load time.
export const RESOLVE_REF_ROW_SIZE = 64;
export const RESOLVE_EXT_HEADER_SIZE = 32;
export const RESOLVE_EDGE_ROW_SIZE = 80;
export const RESOLVE_OUT_REF_ROW_SIZE = 40;
export const RESOLVE_SWEEP_ROW_SIZE = 24;
export const RESOLVE_STAT_ROW_SIZE = 16;
export const RESOLVE_OUT_HEADER_SIZE = 40;

/** meta flags bit0: sweep the batch's own files for file-level import edges. */
export const RESOLVE_FLAG_SWEEP_BATCH_FILES = 1;

const NONE = 0xffffffff;

/** resolvedBy → wire code (resolver.rs ResolvedBy::code). */
const RESOLVED_BY_CODE: Record<string, number> = {
  import: 1,
  'qualified-name': 2,
  'exact-match': 3,
  'function-ref': 4,
  'instance-method': 5,
  'file-path': 6,
  framework: 7,
  fuzzy: 8,
};

// ---------------------------------------------------------------------------
// Input wire types
// ---------------------------------------------------------------------------

export interface ImportResultWire {
  filePath: string;
  referenceName: string;
  referenceKind: string;
  targetNodeId: string;
}

export interface AlsoTargetWire {
  targetNodeId: string;
  metadata?: Record<string, unknown> | null;
}

export interface FrameworkCandidateWire {
  targetNodeId: string;
  resolvedBy: string;
  authoritative: boolean;
  edgeKind?: string | null;
  metadata?: Record<string, unknown> | null;
  alsoTargets?: AlsoTargetWire[];
}

export interface FrameworkGroupWire {
  filePath: string;
  referenceName: string;
  referenceKind: string;
  /** Framework resolve() is POSITION-dependent (it parses the call site) —
   *  the table is keyed by the full ref position, never by name alone. */
  line: number;
  col: number;
  /** Detection order; MUST already stop at the first authoritative/import/
   *  qualified-name candidate (resolveOne's short-circuit parity). */
  candidates: FrameworkCandidateWire[];
}

export interface ImportPathWire {
  filePath: string;
  source: string;
  /** resolveImportPath result; null = external/unresolvable. */
  resolvedPath: string | null;
}

export interface ExternalWireInput {
  importResults: ImportResultWire[];
  jvmImportResults: ImportResultWire[];
  frameworkResults: FrameworkGroupWire[];
  claimedNames: string[];
  importPaths: ImportPathWire[];
}

export interface ResolveBuffersIn {
  meta: Buffer;
  refs: Buffer;
  external: Buffer;
  arena: Buffer;
}

export interface ResolveBuffersOut {
  header: Buffer;
  edges: Buffer;
  refs: Buffer;
  files: Buffer;
  stats: Buffer;
  arena: Buffer;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Sequentially-grown byte buffer for wire rows. */
class WireBuf {
  private buf: Buffer;
  private len = 0;

  constructor(initial = 1024) {
    this.buf = Buffer.alloc(Math.max(16, initial));
  }

  get length(): number {
    return this.len;
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = Buffer.alloc(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf.writeUInt8(v & 0xff, this.len);
    this.len += 1;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.len);
    this.len += 4;
    return this;
  }

  i64(v: number): this {
    this.ensure(8);
    this.buf.writeBigInt64LE(BigInt(Math.trunc(v)), this.len);
    this.len += 8;
    return this;
  }

  pad(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  raw(b: Buffer): this {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
    return this;
  }

  strRef(ref: [number, number]): this {
    return this.u32(ref[0]).u32(ref[1]);
  }

  bytes(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

/** The single shared UTF-8 string arena (offset/len pairs point into it). */
class WireArena {
  private buf = new WireBuf(4096);

  get length(): number {
    return this.buf.length;
  }

  put(s: string): [number, number] {
    const bytes = Buffer.from(s, 'utf8');
    const off = this.buf.length;
    this.buf.raw(bytes);
    return [off, bytes.length];
  }

  putOpt(s: string | null | undefined): [number, number] {
    if (s === null || s === undefined) return [NONE, 0];
    return this.put(s);
  }

  bytes(): Buffer {
    return this.buf.bytes();
  }
}

/**
 * Encode one batch: refs (already denormalized — filePath/language filled) +
 * the precomputed external strategy tables. Throws on an unencodable
 * resolvedBy (a wire-shaped error → the caller sticky-disables the bridge).
 */
export function encodeResolveBatch(
  refs: UnresolvedRef[],
  ext: ExternalWireInput,
  flags: number
): ResolveBuffersIn {
  const arena = new WireArena();
  const rows = new WireBuf(refs.length * RESOLVE_REF_ROW_SIZE + 64);
  for (const ref of refs) {
    rows.i64(ref.id ?? -1);
    rows.strRef(arena.put(ref.fromNodeId));
    rows.strRef(arena.put(ref.referenceName));
    rows.strRef(arena.put(ref.referenceKind));
    rows.strRef(arena.put(ref.filePath));
    rows.strRef(arena.put(ref.language));
    rows.i64(ref.line);
    rows.i64(ref.column);
  }

  let fwCandCount = 0;
  let alsoCount = 0;
  for (const g of ext.frameworkResults) {
    fwCandCount += g.candidates.length;
    for (const c of g.candidates) alsoCount += c.alsoTargets?.length ?? 0;
  }
  const external = new WireBuf(
    RESOLVE_EXT_HEADER_SIZE +
      (ext.importResults.length + ext.jvmImportResults.length) * 32 +
      ext.frameworkResults.length * 48 +
      fwCandCount * 40 +
      alsoCount * 16 +
      ext.claimedNames.length * 8 +
      ext.importPaths.length * 24
  );
  external.u8(RESOLVE_ABI_VERSION).pad(3);
  external.u32(ext.importResults.length);
  external.u32(ext.jvmImportResults.length);
  external.u32(ext.frameworkResults.length);
  external.u32(fwCandCount);
  external.u32(alsoCount);
  external.u32(ext.claimedNames.length);
  external.u32(ext.importPaths.length);

  const keyRow = (e: { filePath: string; referenceName: string; referenceKind: string }): void => {
    external.strRef(arena.put(e.filePath));
    external.strRef(arena.put(e.referenceName));
    external.strRef(arena.put(e.referenceKind));
  };
  for (const e of ext.importResults) {
    keyRow(e);
    external.strRef(arena.put(e.targetNodeId));
  }
  for (const e of ext.jvmImportResults) {
    keyRow(e);
    external.strRef(arena.put(e.targetNodeId));
  }
  // fw group rows: position-keyed row + the candidate range in the FLATTENED
  // candidate table (48B: key 24B + line i64 + col i64 + range 8B).
  let candStart = 0;
  for (const g of ext.frameworkResults) {
    keyRow(g);
    external.i64(g.line);
    external.i64(g.col);
    external.u32(candStart);
    external.u32(candStart + g.candidates.length);
    candStart += g.candidates.length;
  }
  // fw candidate rows (flattened, group order) with also-target ranges.
  let alsoStart = 0;
  for (const g of ext.frameworkResults) {
    for (const c of g.candidates) {
      const code = RESOLVED_BY_CODE[c.resolvedBy];
      if (code === undefined) {
        throw new Error(`resolve wire: unknown resolvedBy '${c.resolvedBy}'`);
      }
      external.strRef(arena.put(c.targetNodeId));
      external.u8(code);
      external.u8(c.authoritative ? 1 : 0);
      external.pad(2);
      external.strRef(arena.putOpt(c.edgeKind ?? null));
      external.strRef(arena.putOpt(c.metadata ? JSON.stringify(c.metadata) : null));
      const also = c.alsoTargets ?? [];
      external.u32(alsoStart);
      external.u32(alsoStart + also.length);
      external.pad(4);
      alsoStart += also.length;
    }
  }
  for (const g of ext.frameworkResults) {
    for (const c of g.candidates) {
      for (const a of c.alsoTargets ?? []) {
        external.strRef(arena.put(a.targetNodeId));
        external.strRef(arena.putOpt(a.metadata ? JSON.stringify(a.metadata) : null));
      }
    }
  }
  for (const name of ext.claimedNames) {
    external.strRef(arena.put(name));
  }
  for (const p of ext.importPaths) {
    external.strRef(arena.put(p.filePath));
    external.strRef(arena.put(p.source));
    external.strRef(arena.putOpt(p.resolvedPath));
  }

  const meta = new WireBuf(16);
  meta.u8(RESOLVE_ABI_VERSION).pad(3);
  meta.u32(refs.length);
  meta.u32(flags);
  meta.u32(arena.length);

  return {
    meta: meta.bytes(),
    refs: rows.bytes(),
    external: external.bytes(),
    arena: arena.bytes(),
  };
}

// ---------------------------------------------------------------------------
// Output decode
// ---------------------------------------------------------------------------

export interface ResolvedRefRow {
  /** unresolved_refs row id when the ref was loaded with one. */
  id?: number;
  fromNodeId: string;
  referenceName: string;
  referenceKind: ReferenceKind;
}

export interface FailedRefRow {
  fromNodeId: string;
  referenceName: string;
  referenceKind: ReferenceKind;
}

export interface SweepWire {
  sourceNodeId: string;
  /** File-level `imports` edges to insert after the per-source delete. */
  edges: Edge[];
}

export interface DecodedBatch {
  /** createEdges output (dedupeSymbolImportEdges already applied) — insert as-is. */
  batchEdges: Edge[];
  /** Delete these rows (id path when present, tuple path otherwise). */
  resolved: ResolvedRefRow[];
  /** markReferencesFailed input. */
  failed: FailedRefRow[];
  /** materializeFileLevelImportEdges output: delete-then-insert per source. */
  sweeps: SweepWire[];
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

export function decodeResolveBatch(out: ResolveBuffersOut): DecodedBatch {
  const header = out.header;
  if (header.length < RESOLVE_OUT_HEADER_SIZE) {
    throw new Error('resolve wire: output header truncated');
  }
  if (header.readUInt8(0) !== RESOLVE_ABI_VERSION) {
    throw new Error(`resolve wire: output abi ${header.readUInt8(0)} != ${RESOLVE_ABI_VERSION}`);
  }
  const batchEdgeCount = header.readUInt32LE(4);
  const resolvedCount = header.readUInt32LE(8);
  const failedCount = header.readUInt32LE(12);
  const sweepCount = header.readUInt32LE(16);
  const statCount = header.readUInt32LE(20);
  const arenaLen = header.readUInt32LE(24);
  const total = header.readUInt32LE(28);
  const resolvedTotal = header.readUInt32LE(32);
  const unresolvedTotal = header.readUInt32LE(36);
  const arena = out.arena;
  if (arena.length < arenaLen) {
    throw new Error('resolve wire: output arena truncated');
  }

  const str = (buf: Buffer, at: number): string => {
    const off = buf.readUInt32LE(at);
    if (off === NONE) return '';
    const len = buf.readUInt32LE(at + 4);
    if (off + len > arena.length) throw new Error('resolve wire: str outside arena');
    return arena.toString('utf8', off, off + len);
  };
  const optStr = (buf: Buffer, at: number): string | null => {
    const off = buf.readUInt32LE(at);
    return off === NONE ? null : str(buf, at);
  };

  const edgeAt = (i: number, stamped: boolean): Edge => {
    const b = out.edges;
    const at = i * RESOLVE_EDGE_ROW_SIZE;
    const targetMetadata = optStr(b, at + 40);
    const resolvedBy = str(b, at + 48);
    const refName = str(b, at + 56);
    const refKind = optStr(b, at + 64);
    const fnRef = b.readUInt8(at + 72) === 1;
    const metadata: Record<string, unknown> = stamped
      ? {
          ...(targetMetadata ? (JSON.parse(targetMetadata) as Record<string, unknown>) : {}),
          resolvedBy,
          refName,
          ...(refKind ? { refKind } : {}),
          ...(fnRef ? { fnRef: true } : {}),
        }
      : { resolvedBy };
    return {
      source: str(b, at),
      target: str(b, at + 8),
      kind: str(b, at + 16) as EdgeKind,
      line: Number(b.readBigInt64LE(at + 24)),
      column: Number(b.readBigInt64LE(at + 32)),
      metadata,
    };
  };

  const batchEdges: Edge[] = [];
  for (let i = 0; i < batchEdgeCount; i++) batchEdges.push(edgeAt(i, true));

  const sweeps: SweepWire[] = [];
  for (let s = 0; s < sweepCount; s++) {
    const at = s * RESOLVE_SWEEP_ROW_SIZE;
    const sourceNodeId = str(out.files, at);
    const start = out.files.readUInt32LE(at + 8);
    const end = out.files.readUInt32LE(at + 12);
    const edges: Edge[] = [];
    for (let i = start; i < end; i++) edges.push(edgeAt(i, false));
    sweeps.push({ sourceNodeId, edges });
  }

  const resolved: ResolvedRefRow[] = [];
  const failed: FailedRefRow[] = [];
  for (let i = 0; i < resolvedCount + failedCount; i++) {
    const at = i * RESOLVE_OUT_REF_ROW_SIZE;
    const flag = out.refs.readUInt8(at);
    const idRaw = Number(out.refs.readBigInt64LE(at + 8));
    const fromNodeId = str(out.refs, at + 16);
    const referenceName = str(out.refs, at + 24);
    const referenceKind = str(out.refs, at + 32) as ReferenceKind;
    if (flag === 1) {
      resolved.push({
        ...(idRaw >= 0 ? { id: idRaw } : {}),
        fromNodeId,
        referenceName,
        referenceKind,
      });
    } else if (flag === 2) {
      failed.push({ fromNodeId, referenceName, referenceKind });
    } else {
      throw new Error(`resolve wire: bad ref-row flag ${flag}`);
    }
  }

  const byMethod: Record<string, number> = {};
  for (let i = 0; i < statCount; i++) {
    const at = i * RESOLVE_STAT_ROW_SIZE;
    byMethod[str(out.stats, at)] = out.stats.readUInt32LE(at + 8);
  }

  return {
    batchEdges,
    resolved,
    failed,
    sweeps,
    stats: {
      total,
      resolved: resolvedTotal,
      unresolved: unresolvedTotal,
      byMethod,
    },
  };
}
