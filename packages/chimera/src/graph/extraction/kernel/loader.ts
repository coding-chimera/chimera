/**
 * Native-kernel loader — finds, loads, and contract-verifies the
 * codegraph-kernel .node addon.
 *
 * The kernel is OPTIONAL everywhere. Every failure mode here (no binary for
 * this platform, dlopen error, ABI mismatch, a kind table that is not a
 * subset of the fork's) resolves to `null`
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
/**
 * Wire kind tables of the loaded, contract-verified kernel (P1): the
 * index order the kernel writes its rows with. Decode ALWAYS resolves
 * wire indexes through these; the fork's NODE_KINDS/EDGE_KINDS serve only
 * as the subset reference for verifyKernelContract. null = no verified
 * kernel loaded (kernelWireTables() then falls back to the fork tables).
 */
let kernelTables: { nodeKinds: readonly string[]; edgeKinds: readonly string[] } | null = null;
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

/**
 * Verify the binary speaks our wire contract: same ABI version, and each
 * kernel kind table a SUBSET of the fork's BY NAME (kernel ⊆ fork — the
 * direction is fixed: a kernel kind the fork doesn't know is refused so a
 * future kernel cannot smuggle an unmapped kind past the gate; a fork-only
 * kind like 'statement' is fine because the kernel simply never emits it).
 *
 * Index alignment is deliberately NOT required (P1 subset batch): wire rows
 * carry indexes into the KERNEL's own tables, which decode resolves through
 * `kernelWireTables()` — so the fork's 'statement'@18 shifting the kernel's
 * import/export/route/component/union down one index is legal divergence.
 * The statement-survival research fixed the two-phase route: relaxing this
 * gate unblocks non-tsjs language routing, which today produces no
 * statement rows through the wasm arm either — zero audit downgrade.
 */
export function verifyKernelContract(info: KernelContractInfo): boolean {
  if (info.abiVersion !== KERNEL_ABI_VERSION) {
    debug(`ABI ${info.abiVersion} != expected ${KERNEL_ABI_VERSION} — ignoring kernel`);
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
    debug(`kernel kind tables not a subset of the fork contract (src/graph/types.ts) — ignoring kernel (${parts.join('; ')})`);
    return false;
  }
  return true;
}

/**
 * The verified kernel's own kind tables — the wire index order every
 * production decode must use. Fork tables are returned only when no kernel
 * is loaded (nothing kernel-side wrote those bytes; tests building
 * fork-indexed synthetic buffers rely on this fallback).
 */
export function kernelWireTables(): { nodeKinds: readonly string[]; edgeKinds: readonly string[] } {
  return kernelTables ?? { nodeKinds: NODE_KINDS, edgeKinds: EDGE_KINDS };
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
      kernelTables = { nodeKinds: info.nodeKinds, edgeKinds: info.edgeKinds };
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
  kernelTables = null;
}

/**
 * Test hook (fork addition): install a fake KernelModule directly, bypassing
 * the search/contract path — lets selector tests exercise the kernel arm
 * independently of the vendored binary's contract state. The fake's own
 * contractInfo kind tables become the wire tables (kernelWireTables), so
 * decode paths see exactly what a real load would have installed.
 * Pass null to clear.
 */
export function setKernelForTests(mod: KernelModule | null): void {
  cached = mod;
  const info = mod ? mod.contractInfo() : null;
  kernelLanguages = info ? new Set(info.languages) : new Set();
  kernelTables = info ? { nodeKinds: info.nodeKinds, edgeKinds: info.edgeKinds } : null;
}
