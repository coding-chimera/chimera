/**
 * Native-kernel loader — finds, loads, and contract-verifies the
 * codegraph-kernel .node addon.
 *
 * The kernel is OPTIONAL everywhere. Every failure mode here (no binary for
 * this platform, dlopen error, ABI/kind-table mismatch) resolves to `null`
 * and the extraction path silently keeps using the wasm pipeline — a missing
 * or stale kernel must never break indexing, only skip the speedup. Set
 * CODEGRAPH_KERNEL_DEBUG=1 to see why a kernel didn't load.
 *
 * Kill switch: CODEGRAPH_KERNEL=0 disables the kernel entirely (checked per
 * call so tests and embedders can flip it at runtime).
 *
 * Search order (fork adaptation of upstream src/extraction/kernel/loader.ts —
 * candidate 2 follows the fork's execPath-adjacent asset convention, the same
 * shape grammars.ts uses for `tree-sitter-wasms/` next to the binary):
 *   1. CODEGRAPH_KERNEL_PATH — explicit .node path (dev/testing override)
 *   2. <dir of process.execPath>/kernel/codegraph-kernel.node — the release
 *      bundle layout (.node shipped beside the compiled chimera binary)
 *   3. <repo root>/codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node
 *      — from-source runs and tests (staged by packages/chimera/script/build-kernel.sh)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { NODE_KINDS } from '../../types';
import { EDGE_KINDS, KERNEL_ABI_VERSION } from './layout';

/** Raw buffer tables for one file — see layout.ts for the byte layout. */
export interface KernelBuffers {
  meta: Buffer;
  nodes: Buffer;
  edges: Buffer;
  refs: Buffer;
  arena: Buffer;
}

export interface KernelContractInfo {
  abiVersion: number;
  kernelVersion: string;
  nodeKinds: string[];
  edgeKinds: string[];
  languages: string[];
}

export interface KernelGrammarInfo {
  abiVersion: number;
  nodeKindCount: number;
  fieldCount: number;
  nodeKinds: string[];
  fieldNames: string[];
}

/** Input to the cFnPtr extraction sweep: one file's raw text + its struct
 *  node extents (`endLine ?? startLine` applied by the caller). */
export interface CfnptrFileIn {
  text: string;
  structs: { id: string; startLine: number; endLine: number }[];
}

/** Per-file facts from the native cFnPtr extraction sweep — mirror of the
 *  Rust `CfnptrFacts` (see codegraph-kernel/src/cfnptr.rs). OPTIONAL surface:
 *  the fork has no JS cFnPtr synthesizer consumer yet (plan §5 item F is a
 *  free rider on kernel adoption); the declarations are ported so the
 *  feature-detect contract survives the vendoring unchanged. */
export interface CfnptrFactsOut {
  fnPtrTypedefs: string[];
  fnTypeTypedefs: string[];
  structs: { id: string; parsed: boolean; fields: { name: string; index: number; ptr: boolean; type: string }[] }[];
  inlinePtr: boolean;
  inlineTypes: string[];
  inlineTags: string[];
  initTokens: string[];
  arrayElems: string[];
  aliasNames: string[];
  dPairs: string[];
  dispatchFields: string[];
  arrayDispatchNames: string[];
  includes: string[];
}

export interface KernelModule {
  extractFile(filePath: string, content: string, language: string): KernelBuffers;
  contractInfo(): KernelContractInfo;
  grammarInfo(language: string): KernelGrammarInfo | null;
  /** Batched cFnPtr extraction sweep. OPTIONAL: absent on older binaries —
   *  callers feature-detect and keep their JS path. */
  cfnptrScanFiles?(files: CfnptrFileIn[]): CfnptrFactsOut[];
  /** Native `stripCommentsForRegex(text, 'c')` — differential-oracle hook. */
  cfnptrStripC?(text: string): string;
}

const debugEnabled = () => process.env.CODEGRAPH_KERNEL_DEBUG === '1';
function debug(msg: string): void {
  // Fork diagnostics discipline: stderr with the [CodeGraph] prefix (never
  // @opencode-ai/core — src/graph must stay single-binary-compile safe).
  if (debugEnabled()) process.stderr.write(`[CodeGraph] kernel: ${msg}\n`);
}

/** Languages the loaded binary supports (contract-verified). Empty when no kernel. */
let kernelLanguages: ReadonlySet<string> = new Set();
/** undefined = not attempted yet; null = attempted and unavailable. */
let cached: KernelModule | null | undefined;

/** Repo root from src/graph/extraction/kernel/ (dev/test runs only — inside a
 *  compiled binary this path doesn't exist and the candidate is skipped). */
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');

function candidatePaths(): string[] {
  const candidates: string[] = [];
  if (process.env.CODEGRAPH_KERNEL_PATH) candidates.push(process.env.CODEGRAPH_KERNEL_PATH);
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

/** Human-readable table diff for the contract-mismatch debug line / report. */
function tableDiff(label: string, kernel: readonly string[], fork: readonly string[]): string {
  const parts: string[] = [];
  const max = Math.max(kernel.length, fork.length);
  for (let i = 0; i < max; i++) {
    if (kernel[i] !== fork[i]) parts.push(`[${i}] kernel='${kernel[i] ?? ''}' fork='${fork[i] ?? ''}'`);
  }
  return `${label}: ${parts.join(', ') || '(length differs only)'}`;
}

/**
 * Verify the binary speaks our wire contract: same ABI version and byte-equal
 * NodeKind/EdgeKind tables (kinds cross the boundary as indexes into these).
 *
 * Fork status (P0-2a): the vendored upstream kernel's NODE_KINDS table does
 * NOT match the fork's (fork has 'statement' at index 18 and no 'union'; the
 * kernel has import/export/route/component at 18-21 and 'union' at 22), so
 * this check currently REJECTS the vendored binary and everything degrades to
 * wasm — the plan's "对账失败整体降级" posture. Aligning the tables (G4 union
 * NodeKind chain) is a follow-up decision, not part of this batch.
 */
export function verifyKernelContract(info: KernelContractInfo): boolean {
  if (info.abiVersion !== KERNEL_ABI_VERSION) {
    debug(`ABI ${info.abiVersion} != expected ${KERNEL_ABI_VERSION} — ignoring kernel`);
    return false;
  }
  const sameTable = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const diffs: string[] = [];
  if (!sameTable(info.nodeKinds, NODE_KINDS)) diffs.push(tableDiff('nodeKinds', info.nodeKinds, NODE_KINDS));
  if (!sameTable(info.edgeKinds, EDGE_KINDS)) diffs.push(tableDiff('edgeKinds', info.edgeKinds, EDGE_KINDS));
  if (diffs.length > 0) {
    debug(`NodeKind/EdgeKind tables differ from src/graph/types.ts — ignoring kernel (${diffs.join('; ')})`);
    return false;
  }
  return true;
}

/**
 * Load (once per process) and return the kernel module, or null when
 * unavailable. The kill switch is NOT checked here — callers route through
 * `kernelSupports()` / `tryKernelExtract()` which check it per call.
 */
export function getKernel(): KernelModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const candidate of candidatePaths()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // createRequire: works identically from CJS output and future ESM.
      const req = createRequire(import.meta.url);
      const mod = req(candidate) as KernelModule;
      if (typeof mod.extractFile !== 'function' || typeof mod.contractInfo !== 'function') {
        debug(`${candidate}: missing expected exports — ignoring`);
        continue;
      }
      const info = mod.contractInfo();
      if (!verifyKernelContract(info)) {
        debug(`${info.kernelVersion ? `kernel ${info.kernelVersion} @ ` : ''}${candidate}: contract mismatch`);
        continue;
      }
      kernelLanguages = new Set(info.languages);
      debug(`loaded ${candidate} (languages: ${[...kernelLanguages].join(', ')})`);
      cached = mod;
      break;
    } catch (err) {
      debug(`${candidate}: failed to load — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cached;
}

/** True when the kill switch is off, a verified binary is loaded, and it supports `language`. */
export function kernelSupports(language: string): boolean {
  if (process.env.CODEGRAPH_KERNEL === '0') return false;
  return getKernel() !== null && kernelLanguages.has(language);
}

/** Test hook: forget the loaded module so a changed env is re-evaluated. */
export function resetKernelForTests(): void {
  cached = undefined;
  kernelLanguages = new Set();
}

/**
 * Test hook (fork addition): install a fake KernelModule directly, bypassing
 * the search/contract path — lets selector tests exercise the kernel arm even
 * while the vendored binary's kind tables are rejected by verifyKernelContract.
 * Pass null to clear.
 */
export function setKernelForTests(mod: KernelModule | null): void {
  cached = mod;
  kernelLanguages = mod ? new Set(mod.contractInfo().languages) : new Set();
}
