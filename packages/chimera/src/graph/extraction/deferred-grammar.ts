/**
 * T0-1 defer seam: lazy wasm-grammar loading for kernel-deferred files.
 *
 * Kernel-routed languages are filtered out of the grammar preload set
 * (filterKernelRoutedLanguages, kernel/index.ts) because the native arm
 * parses them without wasm. The kernel's per-file safety valve — parse-tree
 * errors and the deep-nesting stack guard surface as `defer:` and fall back
 * to the wasm extractor (handleKernelFailure in kernel/index.ts) — still
 * needs that language's grammar, but only for the deferred file. Loading it
 * eagerly in every worker would resurrect exactly the resident
 * WebAssembly.Memory heap the filter removes, so every async extraction
 * seam replays through here instead: first attempt without the grammar; if
 * (and only if) it fails with the "no parser loaded" shape for a
 * kernel-routed language, load that grammar on demand and extract once
 * more. The kernel's one-slot defer memo (takeDeferredPreParse)
 * short-circuits the repeat native parse, so the replay goes straight to
 * the wasm arm — and when a concurrent file overwrote the single memo slot,
 * the replay simply re-defers (same output, one extra native parse).
 *
 * A loaded grammar stays cached (languageCache) for the rest of the
 * process/worker lifetime, so the lazy cost is paid once per language.
 */
import type { ExtractionResult, Language } from '../types';
import { extractFromSource } from './tree-sitter';
import { loadGrammarsForLanguages } from './grammars';
import { kernelRoutes } from './kernel';

/**
 * The grammar a just-finished extraction is missing, when — and only when —
 * the failure is tree-sitter's `Failed to get parser for language` shape
 * (TreeSitterExtractor.extract) for a kernel-routed language: the T0-1
 * filtered-preload case a defer just exposed. Null for every other failure,
 * which keeps the behavior-preserved surfaces intact: non-routed languages
 * (objc, r, solidity, pascal, nix) keep their existing preload, and the
 * ruling-⑤ names (no shipped blob, never routed) keep their silent
 * unavailableGrammarErrors degradation instead of a pointless reload.
 */
export function missingKernelDeferredGrammar(
  result: ExtractionResult,
  language: Language
): Language | null {
  if (!kernelRoutes(language)) return null;
  const missing = result.errors.some(
    (e) =>
      e.code === 'parser_error' &&
      e.message.startsWith('Failed to get parser for language:')
  );
  return missing ? language : null;
}

/**
 * extractFromSource plus the one-shot lazy grammar load above. Shared by the
 * main-thread orchestrator seams (indexAll's no-pool in-process branch,
 * indexFileWithContent) and the parse worker's 'parse' handler, so the defer
 * semantics — a deferred file still produces wasm-arm output — hold on
 * every path regardless of what the preload set contained.
 */
export async function extractWithDeferredGrammarLoad(
  filePath: string,
  content: string,
  language: Language,
  frameworkNames?: string[]
): Promise<ExtractionResult> {
  const result = extractFromSource(filePath, content, language, frameworkNames);
  const missing = missingKernelDeferredGrammar(result, language);
  if (!missing) return result;
  await loadGrammarsForLanguages([missing]);
  return extractFromSource(filePath, content, language, frameworkNames);
}
