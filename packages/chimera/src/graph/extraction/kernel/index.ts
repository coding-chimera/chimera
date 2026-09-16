/**
 * Kernel routing — which languages go through the native kernel, and the
 * single entry point the extraction path calls.
 *
 * Routing policy is deliberately TS-side and per-language
 * (UPSTREAM_RUST_KERNEL_PLAN.md, B-plan strangler): a language routes to the
 * kernel only after its fork parity gate passes; everything else stays on the
 * wasm path forever if need be. Rollback per language = removing it from
 * DEFAULT_ROUTED (or CODEGRAPH_KERNEL=0 for all).
 *
 * Fork routing status (P1 subset batch): DEFAULT_ROUTED is EMPTY — no
 * language has passed the fork's parity harness yet (wave2). The loader's
 * contract gate is now a NAME-based subset check (kernel ⊆ fork, see
 * loader.verifyKernelContract): the vendored kernel loads once the fork
 * table covers the kernel's kinds (the G4 'union' chain; fork-only
 * 'statement' no longer blocks it), and env-enabled routing then really
 * engages the native arm. Wire rows always decode through the kernel's own
 * tables (kernelWireTables) — the fork tables are only the subset reference.
 * Override for experiments with
 *   CODEGRAPH_KERNEL_LANGS=<langs|all>  (replaces the default set), or
 *   CODEGRAPH_KERNEL=0                  (kill switch, everything → wasm).
 *
 * Fork adaptations vs upstream src/extraction/kernel/index.ts:
 * - No preParse hoist: the fork's LanguageExtractor has no `preParse` hook
 *   (c/cpp blanking is a P2 precondition per plan §2.2), so the kernel
 *   receives the raw source and the defer slot only short-circuits repeat
 *   attempts — there is no pre-blanked string to hand the wasm fallback.
 * - No ExtractionResult.kernelBuffers seam (fork types.ts is out of scope):
 *   tryKernelExtractRaw returns owned KernelBuffers and
 *   materializeKernelResult takes that raw result directly. The parse-worker
 *   deferred-decode fast path is therefore NOT wired yet (wave2).
 * - Diagnostics use defaultLogger ([CodeGraph] prefix), never @opencode-ai/core.
 */

import type { ExtractionResult, Language } from '../../types';
import { defaultLogger } from '../../errors';
import {
  getKernel,
  kernelSupports,
  kernelWireTables,
  type KernelBuffers,
  type KernelGrammarInfo,
} from './loader';
import { decodeExtractBuffers } from './decode';
import {
  KERNEL_ABI_VERSION as LAYOUT_ABI,
  META as LAYOUT_META,
  NONE as LAYOUT_NONE,
} from './layout';

export {
  getKernel,
  kernelSupports,
  kernelWireTables,
  resetKernelForTests,
  setKernelForTests,
  verifyKernelContract,
} from './loader';
export type {
  KernelBuffers,
  KernelContractInfo,
  KernelGrammarInfo,
  KernelModule,
} from './loader';
export { decodeExtractBuffers } from './decode';

/**
 * Languages routed to the kernel by default (gate-passed only — see
 * UPSTREAM_RUST_KERNEL_PLAN.md §3 P1 for the first-gate plan: ts/tsx/js/jsx
 * after the params extraJson patch + parity diff zero).
 *
 * P0 acceptance rule: this set is EMPTY, so with no CODEGRAPH_KERNEL_LANGS
 * env the selector in extractFromSource never consults the kernel and the
 * extraction behavior is byte-identical to the pre-kernel fork.
 *
 * Per-file safety valve regardless of routing: a file whose parse tree
 * contains ERRORS defers to the wasm extractor (error recovery differs
 * between UTF-8 and UTF-16 parsing — wasm's recovery is canonical), as does
 * the kernel's deep-nesting stack guard (upstream #1581). Both surface as a
 * thrown `defer:` error from the native side.
 */
const DEFAULT_ROUTED: ReadonlySet<Language> = new Set<Language>();

/**
 * Per-language TS post-pass over the decoded result — the escape hatch for
 * logic `.scm` queries can't express (macro salvage, dialect sniffing,
 * wrapper-based component recognition). Runs synchronously after decode,
 * before the framework extract() hooks the caller applies. Keep these SMALL:
 * anything heavy belongs in the Rust emitter.
 */
export type KernelPostPass = (result: ExtractionResult, source: string) => void;
const POST_PASSES: Partial<Record<Language, KernelPostPass>> = {
  // (none yet — fork wave2+)
};

function isRouted(language: Language): boolean {
  const env = process.env.CODEGRAPH_KERNEL_LANGS;
  if (env === undefined || env === '') return DEFAULT_ROUTED.has(language);
  if (env === 'all') return true;
  return env
    .split(',')
    .map((s) => s.trim())
    .includes(language);
}

/** True when `language` would be extracted by the kernel right now. */
export function kernelRoutes(language: Language): boolean {
  return isRouted(language) && kernelSupports(language);
}

/** Warned-once registry so a broken language logs a single line, not one per file. */
const warned = new Set<string>();

/**
 * One-slot defer memo (upstream mechanism, minus the preParse reuse the fork
 * can't have). A file the kernel defers (parse errors / stack guard → wasm)
 * would otherwise pay a full native parse again at every seam; the slot
 * remembers the LAST deferred (file, source, language) so a repeat kernel
 * attempt for the same file short-circuits to null. Source is matched by
 * string identity — the worker passes the same string through every seam.
 */
let deferSlot: { filePath: string; source: string; language: Language } | null = null;

function wasDeferred(filePath: string, source: string, language: Language): boolean {
  return (
    deferSlot !== null &&
    deferSlot.filePath === filePath &&
    deferSlot.source === source &&
    deferSlot.language === language
  );
}

/** The raw table buffers + the cheap facts the orchestrator needs pre-decode. */
export interface KernelRawResult {
  buffers: KernelBuffers;
  counts: { nodes: number; edges: number; refs: number };
  errors: ExtractionResult['errors'];
}

/** Read the meta-level facts (counts + errors JSON) without decoding rows. */
function readRawMeta(buffers: KernelBuffers): { counts: KernelRawResult['counts']; errors: ExtractionResult['errors'] } {
  const meta = buffers.meta;
  if (meta.readUInt8(LAYOUT_META.version) !== LAYOUT_ABI) {
    throw new Error(`kernel buffer ABI ${meta.readUInt8(LAYOUT_META.version)} != expected ${LAYOUT_ABI}`);
  }
  const counts = {
    nodes: meta.readUInt32LE(LAYOUT_META.nodeCount),
    edges: meta.readUInt32LE(LAYOUT_META.edgeCount),
    refs: meta.readUInt32LE(LAYOUT_META.refCount),
  };
  let errors: ExtractionResult['errors'] = [];
  const errorsOff = meta.readUInt32LE(LAYOUT_META.errorsOff);
  if (errorsOff !== LAYOUT_NONE) {
    const errorsLen = meta.readUInt32LE(LAYOUT_META.errorsLen);
    errors = JSON.parse(
      buffers.arena.toString('utf8', errorsOff, errorsOff + errorsLen)
    ) as ExtractionResult['errors'];
  }
  return { counts, errors };
}

/**
 * Extract via the kernel WITHOUT decoding — the bulk-index fast path seam
 * (upstream ships these buffers to the store boundary; the fork's worker
 * wiring lands with wave2 since ExtractionResult has no kernelBuffers field
 * yet). Returns null under exactly the conditions tryKernelExtract does,
 * PLUS when the language has a registered post() pass (post passes operate
 * on decoded results, so those languages keep the decoded path).
 */
export function tryKernelExtractRaw(
  filePath: string,
  source: string,
  language: Language
): KernelRawResult | null {
  if (!kernelRoutes(language) || POST_PASSES[language]) return null;
  const kernel = getKernel();
  if (!kernel) return null;
  if (wasDeferred(filePath, source, language)) return null; // already deferred
  try {
    const buffers = kernel.extractFile(filePath, source, language);
    const { counts, errors } = readRawMeta(buffers);
    return { buffers, counts, errors };
  } catch (err) {
    return handleKernelFailure(err, filePath, source, language, null);
  }
}

/**
 * Decode a raw kernel result into a plain, fully-materialized
 * ExtractionResult — the fallback for store paths that need objects
 * (main-thread store, tests). Fork signature: takes the KernelRawResult
 * directly (no kernelBuffers carrier on the fork's ExtractionResult).
 */
export function materializeKernelResult(
  raw: KernelRawResult,
  filePath: string,
  language: Language,
  durationMs = 0
): ExtractionResult {
  // Wire index order: the kernel's own verified tables — the fork tables
  // only gate the subset check and never index-decode a kernel row.
  const tables = kernelWireTables();
  const decoded = decodeExtractBuffers(
    raw.buffers,
    filePath,
    language,
    tables.nodeKinds,
    tables.edgeKinds
  );
  decoded.durationMs = durationMs;
  return decoded;
}

/** Shared defer/warn/null tail for the raw and decoded entry points. */
function handleKernelFailure(
  err: unknown,
  filePath: string,
  source: string,
  language: Language,
  _result: null
): null {
  const message = err instanceof Error ? err.message : String(err);
  // `defer:` is the kernel's expected-routing signal (files with parse
  // errors or a tripped stack guard take the wasm path — its error RECOVERY
  // is the canonical one; recovery differs between UTF-8 and UTF-16
  // parsing). Silent by design.
  if (message.includes('defer:')) {
    deferSlot = { filePath, source, language };
    return null;
  }
  if (!warned.has(language)) {
    warned.add(language);
    defaultLogger.warn(
      `kernel ${language} extraction failed (${message}) — falling back to the wasm path`
    );
  }
  return null;
}

/**
 * Extract via the native kernel. Returns null when the kernel doesn't apply
 * (not routed / not available / kill switch) — the caller falls back to the
 * wasm TreeSitterExtractor. A kernel ERROR on a routed file also returns
 * null: per-file fallback keeps indexing correct while a kernel bug costs
 * only that file's speedup.
 */
export function tryKernelExtract(
  filePath: string,
  source: string,
  language: Language
): ExtractionResult | null {
  if (!kernelRoutes(language)) return null;
  const kernel = getKernel();
  if (!kernel) return null;
  if (wasDeferred(filePath, source, language)) return null; // already deferred
  const t0 = Date.now();
  try {
    const buffers = kernel.extractFile(filePath, source, language);
    // Kernel-own wire tables for decode — see materializeKernelResult.
    const tables = kernelWireTables();
    const result = decodeExtractBuffers(buffers, filePath, language, tables.nodeKinds, tables.edgeKinds);
    POST_PASSES[language]?.(result, source);
    result.durationMs = Date.now() - t0;
    return result;
  } catch (err) {
    return handleKernelFailure(err, filePath, source, language, null);
  }
}

/**
 * grammar_info parity hook — the grammar-source-parity gate surface: the
 * native grammar and the wasm grammar for a language must expose identical
 * node-kind/field tables, or kernel-vs-wasm routing would be non-deterministic
 * (plan §4.4: Cargo.toml pins ↔ wasm revision-match). Null when no verified
 * kernel is loaded or the binary doesn't know the language.
 */
export function kernelGrammarInfo(language: string): KernelGrammarInfo | null {
  return getKernel()?.grammarInfo(language) ?? null;
}

/** Test hook: clear the defer memo and the warned-once registry. */
export function resetKernelRoutingForTests(): void {
  deferSlot = null;
  warned.clear();
}
