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
 * Fork routing status (2026-09-17): DEFAULT_ROUTED = lua+luau (wave 1) +
 * typescript/tsx/javascript/jsx (wave 2) + kotlin/scala/dart (wave 3) — the
 * gate-passed languages (see DEFAULT_ROUTED below for the per-language
 * evidence and deferrals). The loader's
 * contract gate is a NAME-based subset check (kernel ⊆ fork, see
 * loader.verifyKernelContract): the vendored kernel loads once the fork
 * table covers the kernel's kinds (the G4 'union' chain; fork-only
 * 'statement' no longer blocks it), and routed languages really engage the
 * native arm. Wire rows always decode through the kernel's own tables
 * (kernelWireTables) — the fork tables are only the subset reference.
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
 * UPSTREAM_RUST_KERNEL_PLAN.md §3 P1 for the first-gate plan; the P1 前置
 * 实测修正 re-scoped wave 1 to the grammar-aligned subset).
 *
 * First wave (2026-09-16): lua + luau. Parity evidence
 * (script/kernel-parity.ts; corpus = bottleneck node_modules lua ×22,
 * upstream kernel-parity torture fixtures, hand-written luau samples under
 * test/fixtures/kernel-corpus/):
 * - lua 22/23 byte-identical; the single torture.lua diff is kernel-side
 *   docstring comment-marker normalization ("-- x" -> "x") plus one 1:1
 *   calls-ref rename ("(handler)" -> "handler") — no node/edge/ref loss,
 *   field-semantics equivalent => acceptable non-byte diff.
 * - luau 0/6 byte-identical but ALL diffs are the same docstring-marker
 *   normalization family — no structural loss => acceptable.
 * - kotlin/scala/dart DEFERRED (grammar-aligned but kernel-walker semantics
 *   diverge structurally): kernel drops nodes/edges/refs the fork wasm arm
 *   emits (scala field/contains, dart method/contains/calls/extends, kotlin
 *   per-call chain decomposition) and adds whole families the wasm arm lacks
 *   (field/constant nodes, references/decorates/implements refs, returnType
 *   presence). Violates the no-loss gate; reconciliation is Rust-batch work.
 *
 * Semantic-version decision rule (operational discipline, per first-wave
 * batch; canonical wording in src/graph/db/extraction-version.ts): opening a
 * language whose parity is byte-identical does NOT bump
 * EXTRACTION_SEMANTICS_VERSION — routing swaps the implementation while the
 * stored output is unchanged; opening a language with acceptable non-byte
 * diffs (field-semantics equivalent, no node/edge/ref loss) DOES bump it.
 * Wave 1 (lua/luau) was the latter case (docstring normalization changes
 * stored field values), hence EXTRACTION_SEMANTICS_VERSION 2 -> 3.
 *
 * Second wave (2026-09-16): typescript + tsx + javascript + jsx. Parity
 * evidence (script/kernel-parity.ts dual-arm harness, report
 * /Volumes/workspace/cbench/kernel-parity/tsjs-p2-20260916.json): 379/380
 * corpus files BYTE-IDENTICAL between the kernel arm and the fork wasm arm;
 * the single non-identical file is a legitimate parse-error case that the
 * kernel defers to wasm by design (the `defer:` safety valve below) — i.e.
 * it never stores kernel output at all. Byte-identical routing means the
 * stored graph output is unchanged, so per the decision rule above this
 * is forced on upgrade and none is needed.
 *
 * Wave-2 production E2E footnote (main-repo full reindex, 2,858 files,
 * kernel arm vs CODEGRAPH_KERNEL=0 arm on the identical corpus): nodes
 * identical, edges -10 (-0.004%), references-kind -10 of 35,164 (-0.03%).
 * Fully attributed by the dual-arm harness on the 6 divergent files: ALL
 * missing refs are namespace-member type references (`ServerConnection.Any`
 * pattern, packages/app solidjs code — a corpus the tsjs parity gate did not
 * cover): the wasm arm tracks the qualified member name, the kernel's
 * value-ref retrack currently skips it (and the wasm arm also double-emits
 * one of them). Magnitude is two orders below the 0.5% stop-and-attribute
 * threshold and this batch is explicitly no-bump; the kernel-side
 * namespace-member type-ref tracking is recorded as a Rust follow-up.
 *
 * Third wave (2026-09-17): kotlin + scala + dart. The vendored R7b walkers
 * were written against upstream's NEWER wasm (post-#708 returnType/type-refs,
 * post-#750/#752/#761/#762 chained-call re-encode + dart ctor naming, post-
 * #897 property value nodes + value-ref edges); the fork's oracles are the
 * PRE-feature wasm configs (kotlin.ts @ upstream 34240eb, scala.ts @ 8506936,
 * dart.ts @ a2ed181), so the three walkers were re-aligned to fork semantics
 * (the three `fix(kernel): align the <lang> walker` commits): zero
 * returnType/references/instantiates(scala)/decorates(kotlin+scala) emission,
 * no property|constant value nodes (kotlin/dart), the stack-kind val/var
 * classification (scala object vals are fields), bare per-call callee names
 * (no chain re-encode, no literal-receiver skip, no paren conversion), the
 * dart ctor naming/skip quirks + superclass first-named-child extends rule
 * (`extends "with MixA"`), and the fork's simpler docstring cleaner (`///`
 * keeps its third slash). Parity evidence (script/kernel-parity.ts dual-arm
 * harness, report /Volumes/workspace/cbench/kernel-parity/
 * ksd-parity-20260917.json): 21/21 corpus files BYTE-IDENTICAL (dart 7/7 —
 * 182/175/157 n/e/r; kotlin 6/6 — 61/55/285; scala 8/8 — 169/161/71;
 * 0 deferred, 0 kernel errors, losses=[] enrichments=[]).
 *
 * Semantics-version note for wave 3: byte-identical routing normally rides
 * WITHOUT a bump (wave-2 rule), but the ksd corpus is short (<20 files per
 * language — the in-repo ceiling) and the batch ships a re-built kernel
 * binary, so per the canonical route-change clause in
 * src/graph/db/extraction-version.ts the version bumps 3 -> 4: any
 * out-of-corpus divergence must force a re-extraction instead of silently
 * mixing kernel and wasm shapes inside one database.
 *
 * All other languages stay on the wasm arm until their own parity gate
 * passes.
 *
 * Per-file safety valve regardless of routing: a file whose parse tree
 * contains ERRORS defers to the wasm extractor (error recovery differs
 * between UTF-8 and UTF-16 parsing — wasm's recovery is canonical), as does
 * the kernel's deep-nesting stack guard (upstream #1581). Both surface as a
 * thrown `defer:` error from the native side.
 */
const DEFAULT_ROUTED: ReadonlySet<Language> = new Set<Language>([
  // wave 1 (2026-09-16): grammar-aligned lua family, acceptable non-byte
  // diffs (docstring normalization) — semantics v3 bump rode along.
  'lua',
  'luau',
  // wave 2 (2026-09-16): tsjs family, 379/380 byte-identical (the single
  // defer is a parse-error file that routes to wasm by design) — NO
  // EXTRACTION_SEMANTICS_VERSION bump; see the decision rule above and
  // /Volumes/workspace/cbench/kernel-parity/tsjs-p2-20260916.json.
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  // wave 3 (2026-09-17): kotlin/scala/dart after the walkers were re-aligned
  // to the fork's pre-#708/#750/#897 wasm oracles — 21/21 corpus files
  // byte-identical; semantics v4 bump rides along (conservative: short
  // corpus + re-built binary); see the third-wave note above and
  // /Volumes/workspace/cbench/kernel-parity/ksd-parity-20260917.json.
  'kotlin',
  'scala',
  'dart',
]);

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
