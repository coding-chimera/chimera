/**
 * Store bridge — routes QueryBuilder write units through the native
 * codegraph-kernel store module (R3a) with silent TS fallback.
 *
 * Shape of the seam (queries.ts owns the call sites):
 *   - Standalone covered writes (insertNodes / insertEdges /
 *     insertUnresolvedRefsBatch / upsertFile / deleteFile / the ref-lifecycle
 *     trio) encode a single-op batch and go through store_commit_batch.
 *   - A `QueryBuilder.transaction()` unit RECORDS its covered writes here
 *     instead of executing them; at the outermost commit the recorded log is
 *     fused (below), encoded once, and flushed as ONE store_commit_batch —
 *     one BEGIN/COMMIT for the whole unit, the TS adapter's nested-JOIN
 *     transaction semantics preserved by construction.
 *   - ANY failure (bridge dead, wire/encode bug, SQL error) returns control
 *     to the TS arm: the caller replays the recorded log through the real
 *     QueryBuilder TS implementations inside a TS transaction. Indexing must
 *     never fail because the bridge is missing or broken (loader discipline).
 *     Wire-shaped errors additionally DISABLE the bridge for the process
 *     (sticky) so a systematic encoder bug degrades once, not per call.
 *
 * # Op fusion (the resurrect semantics contract)
 *
 * The two canonical multi-write TS units fuse into their dedicated ops so the
 * Rust-side orchestration (not a TS replay of it) is the production path:
 *
 *   - `storeExtractionResultTxn` (extraction/index.ts) records
 *       [deleteFile(P)?, insertNodes?, (insertEdges?, insertRefs?)?  ×2, upsertFile(P)]
 *     → ONE OP_STORE_FILE_RESULT: Rust redoes the skip guard, the cross-file
 *     edge snapshot BEFORE the delete, the deleteFile cascade, the
 *     (kind,name)→id re-attach map, re-attach/resurrect (#899/#1240), the
 *     insertedIds endpoint filters, and writes the file record LAST. The
 *     recorded re-attach edges / resurrected refs are DROPPED from the fused
 *     ranges' effect — Rust's batch filters reject them (endpoints outside
 *     the batch) and its own snapshot recreates byte-equivalent rows.
 *   - `removeFileResurrectingRefs` records [insertRefs?, deleteFile(P)]
 *     → OP_DELETE_FILE with DELETE_FILE_FLAG_RESURRECT: Rust resurrects ALL
 *     stamped incoming cross-file edges as pending refs, then cascades — the
 *     same set the TS side recorded (same snapshot query, same stamp
 *     predicate), one transaction.
 *
 * Fusion fires ONLY on those exact shapes (validated structurally below);
 * anything else replays as raw per-method ops, which are individually
 * statement-for-statement mirrors of the TS methods and therefore always
 * safe — fusion is a semantic upgrade, never a correctness dependency.
 *
 * # Thread discipline (v1)
 *
 * store_commit_batch is a SYNCHRONOUS napi call and v1 allows it on the MAIN
 * thread — the same synchronous posture as the bun:sqlite/node:sqlite write
 * path it replaces (not a regression). This is the parent's formal amendment
 * to R3_PROPOSAL §2 acceptance #4 for R3a; migrating the bridge into a worker
 * thread is a recorded follow-up.
 *
 * # Dual-connection coexistence
 *
 * The Rust handle owns its own rusqlite connection to the SAME database file
 * the TS adapter connection has open (WAL, busy_timeout=5000 mirrored on both
 * sides — store.rs StoreConn::open). Writers serialize on the WAL write lock;
 * TS readers see committed bridge writes (WAL). Never hold an OPEN TS
 * transaction while flushing a batch — the recording design guarantees that
 * (native mode defers every write; the flush happens with no TS txn active).
 */

import type { Edge, FileRecord, Node, UnresolvedReference } from '../types';
import { getStoreModule, storeDebug, storeEnabled, type StoreHandle, type StoreModule, type StoreWriteStats } from './loader';
import { StoreBuffersBuilder, type RefTriple } from './encoder';

/**
 * One recorded logical write — the unit of both the native op log and the
 * TS replay fallback (replay calls the matching *Ts implementation with the
 * SAME arguments, so the fallback arm is the untouched original path).
 */
export type RecordedOp =
  | { kind: 'insertNodes'; nodes: Node[] }
  | { kind: 'insertEdges'; edges: Edge[] }
  | { kind: 'insertRefs'; refs: UnresolvedReference[] }
  | { kind: 'upsertFile'; file: FileRecord }
  | { kind: 'deleteFile'; path: string }
  | { kind: 'deleteUnresolvedByIds'; ids: number[] }
  | { kind: 'deleteResolvedTriples'; refs: RefTriple[] }
  | { kind: 'markRefsFailed'; refs: RefTriple[] };

export type FusedKind = 'storeFileResult' | 'deleteFileResurrect' | 'raw';

/** Which op shape the encoder will emit for a recorded log. */
export interface FusePlan {
  kind: FusedKind;
  /** Fused store-file-result: the file record + its path. */
  file?: FileRecord;
  /** Fused delete: the target path. */
  path?: string;
}

const INSERT_KINDS: ReadonlySet<RecordedOp['kind']> = new Set(['insertNodes', 'insertEdges', 'insertRefs']);

/**
 * Validate + classify a recorded log for fusion (pure — exported for tests).
 * Returns kind:'raw' when the log is not one of the two canonical shapes.
 */
export function planStoreFusion(ops: readonly RecordedOp[]): FusePlan {
  if (ops.length === 0) return { kind: 'raw' };

  // Shape B: [insertRefs+, deleteFile(P)] — the unambiguous signature of
  // removeFileResurrectingRefs (resurrectIncomingRefs inserts the resurrected
  // refs, then deleteFile cascades). Fusion DROPS the TS insertRefs and lets
  // OP_DELETE_FILE + RESURRECT recompute them natively from the same snapshot
  // query + stamp logic (byte-equal — the dual-arm test pins it). A LONE
  // [deleteFile] is NOT this shape: it is the plain cascade a direct
  // deleteFile-in-transaction caller expects, and RESURRECT would add refs
  // the TS arm never wrote — so it stays raw (require >=1 leading insertRefs).
  const last = ops[ops.length - 1];
  if (
    last.kind === 'deleteFile' &&
    ops.length >= 2 &&
    ops.slice(0, -1).every((o) => o.kind === 'insertRefs')
  ) {
    return { kind: 'deleteFileResurrect', path: last.path };
  }

  // Shape A: [deleteFile(P)?, insertNodes?, (insertEdges?, insertRefs?)×≤2, upsertFile(P)]
  // — storeExtractionResultTxn. Strict structural gate: upsertFile LAST,
  // deleteFile (when present) FIRST and same path, at most one insertNodes
  // and it precedes every edge/ref op, at most two insertEdges and two
  // insertRefs, and the middle sequence a subsequence of the canonical
  // [nodes, edges, refs, edges, refs] order.
  if (last.kind !== 'upsertFile' || ops.length < 2) return { kind: 'raw' };
  const file = last.file;
  let rest = ops.slice(0, -1);
  if (rest[0]?.kind === 'deleteFile') {
    if (rest[0].path !== file.path) return { kind: 'raw' };
    rest = rest.slice(1);
  }
  if (rest.some((o) => !INSERT_KINDS.has(o.kind))) return { kind: 'raw' };
  const canonical: RecordedOp['kind'][] = ['insertNodes', 'insertEdges', 'insertRefs', 'insertEdges', 'insertRefs'];
  let ci = 0;
  const seen = { insertNodes: 0, insertEdges: 0, insertRefs: 0 };
  for (const o of rest) {
    const idx = canonical.indexOf(o.kind, ci);
    if (idx < 0) return { kind: 'raw' };
    ci = idx + 1;
    seen[o.kind as keyof typeof seen]++;
  }
  if (seen.insertNodes > 1 || seen.insertEdges > 2 || seen.insertRefs > 2) return { kind: 'raw' };
  // Node rows must belong to the file being stored (storeExtractionResultTxn
  // only ever inserts this file's nodes; anything else keeps the raw replay).
  for (const o of rest) {
    if (o.kind === 'insertNodes' && o.nodes.some((n) => n.filePath !== file.path)) return { kind: 'raw' };
  }
  return { kind: 'storeFileResult', file };
}

/** Encode a recorded log into one StoreBuffers batch. Fusion applies unless
 *  `fuse` is false (standalone single-op commits, which are never a canonical
 *  multi-write shape and must keep their plain per-op encoding). */
export function encodeRecordedOps(ops: readonly RecordedOp[], fuse = true): { buffers: ReturnType<StoreBuffersBuilder['finish']>; plan: FusePlan } {
  const b = new StoreBuffersBuilder();
  const plan = fuse ? planStoreFusion(ops) : ({ kind: 'raw' } as FusePlan);

  if (plan.kind === 'deleteFileResurrect') {
    b.opDeleteFile(plan.path!, true);
    return { buffers: b.finish(), plan };
  }

  if (plan.kind === 'storeFileResult') {
    const fileIndex = b.file(plan.file!);
    const nodeStart = b.nodes;
    for (const o of ops) if (o.kind === 'insertNodes') for (const n of o.nodes) b.node(n);
    const nodeEnd = b.nodes;
    const edgeStart = b.edges;
    for (const o of ops) if (o.kind === 'insertEdges') for (const e of o.edges) b.edge(e);
    const edgeEnd = b.edges;
    const refStart = b.refs;
    for (const o of ops) if (o.kind === 'insertRefs') for (const r of o.refs) b.ref(r);
    const refEnd = b.refs;
    b.opStoreFileResult(
      fileIndex,
      nodeEnd > nodeStart ? [nodeStart, nodeEnd] : null,
      edgeEnd > edgeStart ? [edgeStart, edgeEnd] : null,
      refEnd > refStart ? [refStart, refEnd] : null
    );
    return { buffers: b.finish(), plan };
  }

  for (const o of ops) {
    switch (o.kind) {
      case 'insertNodes': {
        if (o.nodes.length === 0) break;
        const start = b.nodes;
        for (const n of o.nodes) b.node(n);
        b.opInsertNodes([start, b.nodes]);
        break;
      }
      case 'insertEdges': {
        if (o.edges.length === 0) break;
        const start = b.edges;
        for (const e of o.edges) b.edge(e);
        b.opInsertEdges([start, b.edges]);
        break;
      }
      case 'insertRefs': {
        if (o.refs.length === 0) break;
        const start = b.refs;
        for (const r of o.refs) b.ref(r);
        b.opInsertRefs([start, b.refs]);
        break;
      }
      case 'upsertFile':
        b.opUpsertFile(b.file(o.file));
        break;
      case 'deleteFile':
        b.opDeleteFile(o.path, false);
        break;
      case 'deleteUnresolvedByIds':
        b.opDeleteUnresolvedByIds(o.ids);
        break;
      case 'deleteResolvedTriples':
        b.opDeleteSpecificResolvedRefs(o.refs);
        break;
      case 'markRefsFailed':
        b.opMarkRefsFailed(o.refs);
        break;
    }
  }
  return { buffers: b.finish(), plan };
}

/** True for errors that indicate a systematic bridge/wire bug (disable sticky). */
export function isStoreWireError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('store wire') || msg.includes('store_open') || msg.includes('store handle');
}

/**
 * Thrown by an uncovered write (or a value-returning covered write whose
 * result cannot be deferred) inside a NATIVE recorded transaction. Native
 * recording defers every write to the flush, so an uncovered write cannot
 * execute in place without breaking the unit's atomicity — the signal
 * unwinds to QueryBuilder.transaction(), which DISCARDS the deferred log
 * (nothing was written) and re-runs the whole unit on the TS arm. Contract:
 * the recorded fn must be free of non-QueryBuilder side effects (both
 * canonical producers — storeExtractionResultTxn and
 * removeFileResurrectingRefs — are pure queries calls + computation), and
 * it must not swallow errors around its write calls.
 */
export class StoreDowngradeSignal extends Error {
  constructor(detail: string) {
    super(`store-bridge downgrade to the TS arm: ${detail}`);
  }
}

/**
 * One open native store connection for one graph root (store_open handle).
 * Created via StoreBridge.open; `live()` re-checks the CODEGRAPH_STORE=0 kill
 * switch on EVERY routing decision (per-call discipline).
 */
export class StoreBridge {
  private disabled = false;
  private disabledReason = '';
  /** Deterministically closed (paired with QueryBuilder.dispose — R3a-3). */
  private closed = false;
  /** Stats of the most recent successful commit (test/telemetry surface). */
  lastStats: StoreWriteStats | null = null;
  /** Count of native commits (fusion visibility for tests/harnesses). */
  commitCount = 0;
  lastFusion: FusedKind = 'raw';
  /** Per-kind native commit tally (fusion visibility for tests/harnesses). */
  fusionCounts: Record<FusedKind, number> = { storeFileResult: 0, deleteFileResurrect: 0, raw: 0 };

  private constructor(
    readonly dbPath: string,
    private readonly mod: StoreModule,
    private readonly handle: StoreHandle
  ) {}

  /**
   * Open the bridge for an initialized graph DB (schema.sql + migrations
   * already applied TS-side — store_open refuses a bare file). Returns null
   * on ANY failure: no module, kill switch on, contract mismatch, unopened
   * schema — the caller stays on the TS arm silently.
   */
  static open(dbPath: string): StoreBridge | null {
    if (!storeEnabled()) return null;
    const mod = getStoreModule();
    if (!mod) return null;
    try {
      return new StoreBridge(dbPath, mod, mod.storeOpen(dbPath));
    } catch (err) {
      storeDebug(`store_open(${dbPath}) failed — staying on the TS write path: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Per-call routing gate: attached, not disabled, not closed, kill switch off. */
  live(): boolean {
    return !this.disabled && !this.closed && storeEnabled();
  }

  /**
   * Deterministic handle/connection release (R3a-3), paired with
   * QueryBuilder.dispose() / CodeGraph.close() — the R1 no-unpaired-
   * resources discipline; the napi GC finalizer is only the crash fallback.
   * Idempotent. Pre-R3a-3 binaries without storeClose degrade to the GC
   * finalizer (the handle simply becomes unreachable after close()).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.mod.storeClose?.(this.handle);
    } catch (err) {
      storeDebug(`storeClose failed for ${this.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Mirror the TS WAL-deferral valve (upstream #1231) onto the Rust
   * connection: wal_autocheckpoint is PER-CONNECTION, so the bulk-index
   * deferral on the TS connection must be applied here too or the native
   * writes keep folding the WAL underneath the valve. Best-effort performance
   * knob — a failure neither throws nor disables the bridge.
   */
  setWalAutocheckpoint(pages: number): void {
    if (!this.live()) return;
    try {
      this.mod.storeSetWalAutocheckpoint?.(this.handle, pages);
    } catch (err) {
      storeDebug(`storeSetWalAutocheckpoint failed for ${this.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Sticky-disable after a wire-shaped failure (degrade once, not per call). */
  disable(reason: string): void {
    if (!this.disabled) {
      this.disabled = true;
      this.disabledReason = reason;
      storeDebug(`bridge disabled for ${this.dbPath}: ${reason}`);
    }
  }

  get isDisabled(): boolean {
    return this.disabled;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  get disableReason(): string {
    return this.disabledReason;
  }

  /**
   * Commit a recorded op log as ONE native transaction (fusion applied).
   * Throws on failure — the CALLER owns the TS replay fallback (it has the
   * replay implementations); wire-shaped errors disable the bridge first.
   */
  commit(ops: readonly RecordedOp[], fuse = true): StoreWriteStats {
    let buffers;
    let plan: FusePlan;
    try {
      ({ buffers, plan } = encodeRecordedOps(ops, fuse));
    } catch (err) {
      this.disable(`encode failure: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    try {
      const stats = this.mod.storeCommitBatch(this.handle, buffers);
      this.lastStats = stats;
      this.commitCount++;
      this.lastFusion = plan.kind;
      this.fusionCounts[plan.kind]++;
      return stats;
    } catch (err) {
      if (isStoreWireError(err)) this.disable(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Single-op commit returning one unambiguous counter (value-returning
   *  writes). Never fused — a lone op must keep its plain per-op encoding. */
  commitCount1(op: RecordedOp, field: keyof StoreWriteStats): number {
    const stats = this.commit([op], false);
    return stats[field];
  }
}
