/**
 * Native store-bridge loader — finds, loads, and contract-verifies the
 * graph-store module of the codegraph-kernel .node addon (R3a).
 *
 * The store module is OPTIONAL everywhere. Every failure mode here (no
 * binary for this platform, dlopen error, ABI mismatch, a kind table that
 * is not a subset of the fork's, store_open refusing an uninitialized
 * schema) resolves to `null` and the write path silently keeps using the
 * TS QueryBuilder — a missing or stale kernel must never break indexing,
 * only skip the speedup (loader discipline copied from
 * extraction/kernel/loader.ts). Set CODEGRAPH_STORE_DEBUG=1 to see why the
 * store bridge didn't load.
 *
 * Kill switch: CODEGRAPH_STORE=0 disables the bridge entirely (checked per
 * call via storeEnabled() so tests and embedders can flip it at runtime).
 *
 * Search order (same convention as the extraction kernel — the store module
 * ships inside the SAME codegraph-kernel.node):
 *   1. CODEGRAPH_STORE_PATH — explicit .node path (dev/testing override;
 *      falls back to CODEGRAPH_KERNEL_PATH when unset)
 *   2. <dir of process.execPath>/kernel/codegraph-kernel.node — release bundle
 *   3. <repo root>/codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node
 *      — from-source runs and tests (staged by packages/chimera/script/build-kernel.sh)
 *
 * Thread discipline (R3a v1): napi store calls are synchronous and the
 * R3_PROPOSAL §2 hard constraint wants them on a worker thread. v1 allows
 * MAIN-THREAD calls — the same synchronous posture as today's bun:sqlite /
 * node:sqlite write path (not a regression); migrating the store bridge into
 * a worker is the recorded follow-up (parent's formal amendment to
 * R3_PROPOSAL §2 acceptance #4 for R3a).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { NODE_KINDS } from '../types';
import { EDGE_KINDS } from '../extraction/kernel/layout';
import { STORE_ABI_VERSION, type StoreBuffers } from './layout';

/** Opaque napi StoreHandle (one handle = one graph root = one SQLite connection). */
export type StoreHandle = object;

export interface StoreContractInfo {
  abiVersion: number;
  storeVersion: string;
  nodeKinds: string[];
  edgeKinds: string[];
}

/** store.rs StoreWriteStats (napi camelCase projection). */
export interface StoreWriteStats {
  nodesInserted: number;
  nodesSkippedInvalid: number;
  edgesInserted: number;
  edgesDroppedDangling: number;
  edgesDroppedNotInBatch: number;
  edgesReattached: number;
  refsInserted: number;
  refsDroppedNotInBatch: number;
  refsResurrected: number;
  refsDeleted: number;
  refsMarkedFailed: number;
  filesDeleted: number;
  filesUpserted: number;
  filesSkippedUnchanged: number;
  walPages: number;
  durationMs: number;
}

/** The store export surface of codegraph-kernel.node (napi camelCase). */
export interface StoreModule {
  storeContractInfo(): StoreContractInfo;
  storeOpen(dbPath: string): StoreHandle;
  storeInsertNodes(handle: StoreHandle, batch: StoreBuffers): number;
  storeInsertEdges(handle: StoreHandle, batch: StoreBuffers): number;
  storeInsertRefs(handle: StoreHandle, batch: StoreBuffers): number;
  storeDeleteFile(handle: StoreHandle, path: string): void;
  storeCommitBatch(handle: StoreHandle, ops: StoreBuffers): StoreWriteStats;
  /** OPTIONAL (R3a-3): deterministic handle/connection release. Absent on
   *  older binaries — StoreBridge.close() then degrades to the GC finalizer. */
  storeClose?(handle: StoreHandle): void;
  /** OPTIONAL (R3a-3): mirror the WAL-deferral valve's per-connection
   *  wal_autocheckpoint pragma onto the Rust connection (performance knob). */
  storeSetWalAutocheckpoint?(handle: StoreHandle, pages: number): void;
}

const debugEnabled = () => process.env.CODEGRAPH_STORE_DEBUG === '1';
export function storeDebug(msg: string): void {
  // Fork diagnostics discipline: stderr with the [CodeGraph] prefix (never
  // @opencode-ai/core — src/graph must stay single-binary-compile safe).
  if (debugEnabled()) process.stderr.write(`[CodeGraph] store: ${msg}\n`);
}

/** undefined = not attempted yet; null = attempted and unavailable. */
let cached: StoreModule | null | undefined;

/** Repo root from src/graph/store/ (dev/test runs only — inside a compiled
 *  binary this path doesn't exist and the candidate is skipped). */
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

function candidatePaths(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.CODEGRAPH_STORE_PATH ?? process.env.CODEGRAPH_KERNEL_PATH;
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(path.dirname(process.execPath), 'kernel', 'codegraph-kernel.node'));
  candidates.push(
    path.join(
      repoRoot,
      'codegraph-kernel',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'codegraph-kernel.node'
    )
  );
  return candidates;
}

/**
 * Verify the binary speaks our store wire contract: same STORE_ABI_VERSION
 * (equality, not ordering — the store ABI is numbered independently from the
 * extraction KERNEL_ABI_VERSION), and each kernel kind table a SUBSET of the
 * fork's BY NAME (kernel ⊆ fork — the loader.ts:150-167 direction: a kernel
 * kind the fork doesn't know is refused; a fork-only kind is fine because the
 * store wire carries kind strings verbatim, never indexes).
 */
export function verifyStoreContract(info: StoreContractInfo): boolean {
  if (info.abiVersion !== STORE_ABI_VERSION) {
    storeDebug(`store ABI ${info.abiVersion} != expected ${STORE_ABI_VERSION} — ignoring store module`);
    return false;
  }
  const kernelOnly = (kernel: readonly string[], fork: readonly string[]) =>
    kernel.filter((kind) => !fork.includes(kind));
  const missingNodeKinds = kernelOnly(info.nodeKinds, NODE_KINDS as readonly string[]);
  const missingEdgeKinds = kernelOnly(info.edgeKinds, EDGE_KINDS as readonly string[]);
  if (missingNodeKinds.length > 0 || missingEdgeKinds.length > 0) {
    const parts: string[] = [];
    if (missingNodeKinds.length > 0) parts.push(`nodeKinds kernel-only: '${missingNodeKinds.join("', '")}'`);
    if (missingEdgeKinds.length > 0) parts.push(`edgeKinds kernel-only: '${missingEdgeKinds.join("', '")}'`);
    storeDebug(`store kind tables not a subset of the fork contract — ignoring store module (${parts.join('; ')})`);
    return false;
  }
  return true;
}

/**
 * Load (once per process) and return the store module, or null when
 * unavailable. The kill switch is NOT checked here — callers route through
 * `storeEnabled()` which checks it per call.
 */
export function getStoreModule(): StoreModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const candidate of candidatePaths()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // createRequire: works identically from CJS output and future ESM.
      const req = createRequire(import.meta.url);
      const mod = req(candidate) as Partial<StoreModule>;
      if (
        typeof mod.storeContractInfo !== 'function' ||
        typeof mod.storeOpen !== 'function' ||
        typeof mod.storeCommitBatch !== 'function'
      ) {
        storeDebug(`${candidate}: missing store exports (pre-R3a kernel binary?) — ignoring`);
        continue;
      }
      const info = mod.storeContractInfo();
      if (!verifyStoreContract(info)) {
        storeDebug(`${info.storeVersion ? `store ${info.storeVersion} @ ` : ''}${candidate}: contract mismatch`);
        continue;
      }
      storeDebug(`loaded store module from ${candidate} (store ${info.storeVersion}, abi ${info.abiVersion})`);
      cached = mod as StoreModule;
      break;
    } catch (err) {
      storeDebug(`${candidate}: failed to load — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cached;
}

/**
 * Per-call routing gate: kill switch off AND a verified module loaded.
 * CODEGRAPH_STORE=0 flips this false at any point (checked per call, the
 * extraction kernelSupports() posture).
 */
export function storeEnabled(): boolean {
  if (process.env.CODEGRAPH_STORE === '0') return false;
  return getStoreModule() !== null;
}

/** Test hook: forget the loaded module so a changed env is re-evaluated. */
export function resetStoreForTests(): void {
  cached = undefined;
}

/**
 * Test hook: install a fake StoreModule directly, bypassing the search /
 * contract path (the kernel loader's setKernelForTests posture). Pass null
 * to clear.
 */
export function setStoreModuleForTests(mod: StoreModule | null): void {
  cached = mod;
}
