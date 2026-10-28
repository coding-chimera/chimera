import * as path from 'path';
import { Language, ExtractionResult, Node } from '../types';
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
 * Identity used to collapse a framework extract() node onto the extractor node
 * it restates. React's hook pattern, for example, re-emits `function useX`
 * that the tsjs extractor already produced — same kind, name, file and start
 * line, but a different id (`hook:…`). Only an exact declaration match
 * collapses; framework enrichment with a different kind (e.g. a `component`
 * node for a plain function component) is preserved. A collapsed node that is
 * the source of a framework reference is re-pointed at the retained id by the
 * merge below, so the reference never dangles.
 */
function frameworkNodeKey(node: Node): string {
  return `${node.kind}\u0000${node.name}\u0000${node.filePath}\u0000${node.startLine}`;
}

/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language run after the base extraction (the
 * native kernel or the wasm tree-sitter arm) and their nodes/references/errors
 * are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  // Framework resolvers are computed once up front so the merge pass below
  // walks one stable filter/order on every file, whichever extraction arm the
  // kernel selector picks (kernel or wasm).
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
    //   — CODEGRAPH_KERNEL_LANGS overrides the routed set).
    // Framework files are NOT excluded (P1-1): framework extract() hooks are
    // source-text passes whose nodes/references merge AFTER extraction, so the
    // kernel serves the tree for every language it supports and the merge
    // below runs unchanged. Returns null when not routed / no verified kernel
    // loaded / kernel error / `defer:` signal (parse-tree ERROR, deep-nesting
    // stack guard) — the wasm TreeSitterExtractor below stays the fallback in
    // every case (wasm error recovery is canonical).
    // K-v2 P4: N's takeDeferredPreParse reuse wired — a kernel-deferred
    // file already paid the (offset-preserving) preParse at the route
    // point; the fallback reuses those bytes instead of blanking again.
    const kernelResult = tryKernelExtract(filePath, source, detectedLanguage);
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

  // Framework-specific extraction (routes, middleware, etc.) — the resolver
  // list is computed once up front so every file walks the same filter/order.
  // The hooks run on BOTH extraction arms; a node that merely restates an
  // extractor declaration (same kind, name, file, line — e.g. react's `hook:`
  // node for a `function useX`) is dropped so the merge never duplicates it,
  // and the append order stays stable: base-extraction nodes first, then
  // framework nodes in resolver order.
  //
  // Dropping a restatement must not orphan a reference: some framework nodes
  // (spring's `@Value` binding is the canonical case) are BOTH a restatement
  // and a reference source. Those references are re-pointed at the retained
  // declaration instead of keeping an id the merge just removed (P1-1).
  const retainedNodeIdByKey = new Map(
    result.nodes.map((node) => [frameworkNodeKey(node), node.id] as const)
  );
  const retainedIdByDroppedId = new Map<string, string>();
  for (const fw of frameworkResolvers) {
    if (!fw.extract) continue;
    try {
      const fwResult = fw.extract(filePath, source);
      for (const node of fwResult.nodes) {
        const key = frameworkNodeKey(node);
        const retainedId = retainedNodeIdByKey.get(key);
        if (retainedId === undefined) {
          retainedNodeIdByKey.set(key, node.id);
          result.nodes.push(node);
          continue;
        }
        if (retainedId !== node.id) retainedIdByDroppedId.set(node.id, retainedId);
      }
      for (const ref of fwResult.references) {
        const retainedId = retainedIdByDroppedId.get(ref.fromNodeId);
        result.unresolvedReferences.push(
          retainedId === undefined ? ref : { ...ref, fromNodeId: retainedId }
        );
      }
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
