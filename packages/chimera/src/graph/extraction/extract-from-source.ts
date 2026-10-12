import * as path from 'path';
import { Language, ExtractionResult } from '../types';
import { detectLanguage, isFileLevelOnlyLanguage } from './grammars';
import { LiquidExtractor } from './liquid-extractor';
import { RazorExtractor } from './razor-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { AstroExtractor } from './astro-extractor';
import { DfmExtractor } from './dfm-extractor';
import { VueExtractor } from './vue-extractor';
import { MyBatisExtractor } from './mybatis-extractor';
import { CfmlExtractor } from './cfml-extractor';
import { tryKernelExtract, takeDeferredPreParse } from './kernel';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';
import { TreeSitterExtractor } from './tree-sitter';

/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  // Framework resolvers are computed once up front: the kernel selector below
  // skips the native arm when a framework extract() hook hits this file, and
  // the merge pass reuses the same list (identical behavior to computing it
  // there — same filter, same order).
  const frameworkResolvers =
    frameworkNames && frameworkNames.length > 0
      ? getApplicableFrameworks(
          getAllFrameworkResolvers().filter((r) => frameworkNames.includes(r.name)),
          detectedLanguage
        )
      : [];

  let result: ExtractionResult;

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // Use custom extractor for Vue
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'astro') {
    // Use custom extractor for Astro (frontmatter + template delegation)
    const extractor = new AstroExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // Use custom extractor for Liquid
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'razor') {
    // Use custom extractor for ASP.NET Razor (.cshtml) / Blazor (.razor) markup
    const extractor = new RazorExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'xml') {
    // Custom extractor for MyBatis mapper XML. Non-mapper XML returns just a
    // file node so the watcher tracks it without emitting symbols.
    const extractor = new MyBatisExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'cfml' || detectedLanguage === 'cfscript') {
    // Custom extractor for CFML (.cfc/.cfm) — dialect-switches between the
    // tag-based cfml grammar and the bare-script cfscript grammar. Standalone
    // `.cfs` files (language 'cfscript') are always pure script (never `<`-led),
    // so routing them through here too gets them the same anonymous-component
    // filename fallback as a bare-script `.cfc` — without it a `.cfs` whose
    // `component { ... }` declares no name (the grammar has no `name` field;
    // CFML never spells one in source) stays `<anonymous>`.
    const extractor = new CfmlExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  } else if (isFileLevelOnlyLanguage(detectedLanguage)) {
    // No symbol extraction at this stage — files are tracked at the file-record
    // level only. Framework extractors (Drupal routing yml, Spring `@Value`
    // resolution against application.yml/application.properties) run later and
    // add per-file nodes/references when they apply.
    result = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // Use custom extractor for DFM/FMX form files
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    // Native-kernel route (UPSTREAM_RUST_KERNEL_PLAN.md P0): gated per
    // language (DEFAULT_ROUTED is lua/luau since wave 1 plus the tsjs family
    //   typescript/tsx/javascript/jsx since the wave-2 byte-identical opening,
    //   plus kotlin/scala/dart since wave 3
    //   — CODEGRAPH_KERNEL_LANGS overrides the routed set)
    // and gated on no framework extract() hook hitting this file. Returns
    // null when not routed / no verified kernel loaded / kernel error /
    // `defer:` signal (parse-tree ERROR, deep-nesting stack guard) — the
    // wasm TreeSitterExtractor below stays the fallback in every case (wasm
    // error recovery is canonical).
    // K-v2 P4: N's takeDeferredPreParse reuse wired — a kernel-deferred
    // file already paid the (offset-preserving) preParse at the route
    // point; the fallback reuses those bytes instead of blanking again.
    const kernelResult = frameworkResolvers.some((fw) => fw.extract)
      ? null
      : tryKernelExtract(filePath, source, detectedLanguage);
    if (kernelResult) {
      result = kernelResult;
    } else {
      const deferredPre = takeDeferredPreParse(filePath, source, detectedLanguage);
      const extractor = new TreeSitterExtractor(
        filePath,
        deferredPre ?? source,
        detectedLanguage,
        { sourceIsPreParsed: deferredPre != null }
      );
      result = extractor.extract();
    }
  }

  // Framework-specific extraction (routes, middleware, etc.) — reuses the
  // list computed up front for the kernel gate (same filter, same order).
  for (const fw of frameworkResolvers) {
    if (!fw.extract) continue;
    try {
      const fwResult = fw.extract(filePath, source);
      result.nodes.push(...fwResult.nodes);
      result.unresolvedReferences.push(...fwResult.references);
    } catch (err) {
      result.errors.push({
        message: `Framework extractor '${fw.name}' failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        filePath,
        severity: 'warning',
      });
    }
  }

  return result;
}
