/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import { matchReference, matchFunctionRef, isVisibleAcrossFiles, isUnresolvedJsMemberCall, clearNameMatcherMemos } from './name-matcher';
import {
  JS_BUILT_INS,
  REACT_HOOKS,
  PYTHON_BUILT_INS,
  PYTHON_BUILT_IN_TYPES,
  PYTHON_BUILT_IN_METHODS,
  GO_STDLIB_PACKAGES,
  GO_BUILT_INS,
  PASCAL_UNIT_PREFIXES,
  PASCAL_BUILT_INS,
  C_BUILT_INS,
  CPP_BUILT_INS,
} from './js-builtins';
import { resolveViaImport, resolveJvmImport, extractImportMappings, extractReExports, loadCppIncludeDirs, resolveImportPath } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { synthesizeCallbackEdges } from './callback-synthesizer';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { loadGoModule, type GoModule } from './go-module';
import { logDebug } from '../errors';
import type { ReExport } from './types';
import { LRUCache } from './lru-cache';
import { createYielder, type MaybeYield } from './cooperative-yield';
import { CtxBridge, isCtxWireError } from './ctx-bridge';

/**
 * Cache size limits. Each per-resolver cache is bounded so memory
 * stays flat on large codebases (20k+ files). Sizes were chosen to
 * cover the working set for typical resolution batches without
 * exceeding a few hundred MB worst-case. Override via the env var
 * `CODEGRAPH_RESOLVER_CACHE_SIZE` (single integer applied to all
 * caches) when tuning for very large or very small projects.
 */
const DEFAULT_CACHE_LIMIT = 5_000;
function resolveCacheLimit(): number {
  const raw = process.env.CODEGRAPH_RESOLVER_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CACHE_LIMIT;
}

// Re-export types
export * from './types';

// Built-in name tables live in ./js-builtins (K-v2 P5-1 / D7: upstream N
// module skeleton — JS_BUILT_INS + TS_PRIMITIVE_TYPES consumed by BOTH
// name-matcher and this file — unioned with the fork's multi-language
// five-family sets).

// Evidence-class ordering for cross-strategy arbitration: a higher rank wins
// when several strategies produced a candidate for the same reference. This
// is an ordering over how the candidate was resolved (the evidence category),
// not a calibrated probability.
const RESOLVER_RANK: Record<ResolvedRef['resolvedBy'], number> = {
  import: 6,
  'qualified-name': 5,
  'exact-match': 4,
  // function_ref refs (#756) take a dedicated path in resolveOne and never
  // reach cross-strategy arbitration in practice; ranked at exact-match tier
  // (unique-or-drop exact-name evidence) so the Record stays exhaustive and
  // any future arbitration involvement keeps exact-name strength.
  'function-ref': 4,
  'instance-method': 3,
  'file-path': 2,
  framework: 1,
  fuzzy: 0,
};

// Call-receiver chain shape `<inner>().<method>` (upstream #1683/#645/#608
// re-encoding). TS/JS/Python chains bypass the import strategy (the chain
// names the ROOT's import, not the method's) and belong to the name-matcher's
// store-accessor fallback.
const CHAIN_SHAPE = /^(.+)\(\)\.(\w+)$/;

// Kinds whose qualifiedName IS the class scope (a hook attributed to the
// class body itself), used by resolveThisMemberFnRef (mirrors upstream
// SUPERTYPE_BEARING_KINDS + 'module').
const CLASS_SCOPE_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'module',
]);

/**
 * K-v2 P5-1 import-binding/re-export double-emission hygiene (P2 probe: a
 * file that BOTH `import { X } from './y'` and `export { X } from './y'`
 * emitted a binding ref AND a re-export ref — one dependency fact persisted
 * as two file→symbol `imports` edges that only the line/col component of the
 * edge identity index kept apart).
 *
 * A symbol-level `imports` edge is a file→symbol dependency FACT:
 * multiplicity carries no graph information (dependents/impact walks traverse
 * it once), so duplicates only inflate edge counts and double-count in
 * edge-based metrics. Division of responsibility stays as EMITTED (binding
 * refs cover local use, re-export refs cover barrel-only dependencies — a
 * barrel that only re-exports still gets its edge); the collapse happens
 * here, in the shared resolution layer, so BOTH extraction arms (wasm and
 * kernel) converge without touching emission parity. file→file imports edges
 * are already deduped by materializeFileLevelImportEdges (delete-then-insert
 * + one edge per resolved source), and file→import-statement syntax edges
 * target distinct per-statement nodes, so neither is affected.
 *
 * Deterministic keep-rule: lowest (line, column) wins — stable across
 * reindexes. Documented consequence: the dropped occurrence's refName/line
 * does not participate in edge resurrection (#1240); a full re-index re-emits
 * every occurrence anyway, and resurrecting one occurrence suffices to
 * re-resolve the dependency.
 */
function dedupeSymbolImportEdges(edges: Edge[]): Edge[] {
  const keptIndex = new Map<string, number>();
  const out: Edge[] = [];
  for (const edge of edges) {
    if (edge.kind !== 'imports') {
      out.push(edge);
      continue;
    }
    const key = `${edge.source}\u0000${edge.target}`;
    const at = keptIndex.get(key);
    if (at === undefined) {
      keptIndex.set(key, out.length);
      out.push(edge);
      continue;
    }
    const rank = (e: Edge) => (e.line ?? 0) * 0x1000000 + (e.column ?? 0);
    if (rank(edge) < rank(out[at]!)) out[at] = edge;
  }
  return out;
}

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  // All per-resolver caches are LRU-bounded. Previously these were
  // unbounded Maps that grew with every distinct lookup and OOM'd on
  // codebases with 20k+ files (see issue: unbounded cache growth).
  private nodeCache: LRUCache<string, Node[]>; // per-file node cache
  private fileCache: LRUCache<string, string | null>; // per-file content cache
  private linesCache: LRUCache<string, string[]>; // per-file split-lines cache (getFileLines)
  private importMappingCache: LRUCache<string, ImportMapping[]>;
  private reExportCache: LRUCache<string, ReExport[]>;
  private nameCache: LRUCache<string, Node[]>; // name → nodes cache
  private lowerNameCache: LRUCache<string, Node[]>; // lower(name) → nodes cache
  private qualifiedNameCache: LRUCache<string, Node[]>; // qualified_name → nodes cache
  private knownNames: Set<string> | null = null; // all known symbol names for fast pre-filtering
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;
  /**
   * (R3b) Native resolution read context, or null when the TS arm is the
   * only arm (no live store bridge on the QueryBuilder — which covers
   * readOnly/crossProject opens and CODEGRAPH_STORE=0 —, CODEGRAPH_CTX=0,
   * missing/pre-R3b binary, contract mismatch, or ctx_open failure). Every
   * routed getter falls back to its TS implementation per call on any
   * native failure; the four declared-absent getters (getProjectAliases,
   * getGoModule, getCppIncludeDirs, resolveImport) ALWAYS keep the TS arm.
   */
  private ctx: CtxBridge | null = null;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  private projectAliases: AliasMap | null | undefined = undefined;
  // go.mod module path. Same lazy/immutable convention as projectAliases.
  private goModule: GoModule | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;

    const limit = resolveCacheLimit();
    // The content cache is heavier (full file text), so we give it a
    // smaller budget than the metadata caches.
    const contentLimit = Math.max(64, Math.floor(limit / 5));
    this.nodeCache = new LRUCache(limit);
    this.fileCache = new LRUCache(contentLimit);
    this.linesCache = new LRUCache(contentLimit);
    this.importMappingCache = new LRUCache(limit);
    this.reExportCache = new LRUCache(limit);
    this.nameCache = new LRUCache(limit);
    this.lowerNameCache = new LRUCache(limit);
    this.qualifiedNameCache = new LRUCache(limit);

    // (R3b) Open the native read context BEFORE createContext so the getter
    // closures see it. Symbiotic with the QueryBuilder's store bridge: null
    // store bridge (readOnly/crossProject/kill-switched) ⇒ null ctx.
    this.ctx = CtxBridge.open(queries.getStoreBridge(), projectRoot);

    this.context = this.createContext();
  }

  /**
   * (R3b) Deterministically release the native read-context handle.
   * CodeGraph.close() calls this BEFORE QueryBuilder.dispose() closes the
   * store handle whose commit-generation counter the ctx borrows (R1
   * pairing). Idempotent; the resolver stays usable on the TS arm after.
   */
  dispose(): void {
    this.ctx?.close();
    this.ctx = null;
  }

  /** The native read-context bridge (null = TS arm) — tests/status introspection. */
  getCtxBridge(): CtxBridge | null {
    return this.ctx;
  }

  /**
   * Run a native ctx read. Null when the ctx arm is unavailable (not
   * attached, kill-switched, disabled) or the call threw — the caller falls
   * back to its TS implementation for that call. Wire/handle-shaped failures
   * sticky-disable the bridge (a systematic decoder bug degrades once).
   */
  private ctxRead<T>(fn: (ctx: CtxBridge) => T): T | null {
    const ctx = this.ctx;
    if (!ctx?.live()) return null;
    try {
      return fn(ctx);
    } catch (err) {
      this.handleCtxFailure(err);
      return null;
    }
  }

  private handleCtxFailure(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (isCtxWireError(err)) this.ctx?.disable(msg);
    logDebug('native ctx read failed — falling back to the TS arm', { error: msg });
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Run each framework resolver's cross-file finalization pass and persist
   * the returned node updates. Idempotent — safe to call after every indexAll
   * and every incremental sync. Returns the number of nodes updated.
   *
   * Caches are cleared before/after so the post-extract pass sees fresh DB
   * state and downstream queries see the updated names.
   */
  runPostExtract(): number {
    let updated = 0;
    this.clearCaches();
    for (const fw of this.frameworks) {
      if (!fw.postExtract) continue;
      try {
        const nodes = fw.postExtract(this.context);
        for (const node of nodes) {
          this.queries.updateNode(node);
          updated++;
        }
      } catch (err) {
        logDebug(`Framework '${fw.name}' postExtract failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (updated > 0) this.clearCaches();
    return updated;
  }

  /**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;

    // (R3b) Native arm: warm the Rust-side knownFiles/knownNames indexes
    // (ctx_warm) and build the membership Sets from the Rust batch getters —
    // one reader of truth. NOTE: the JS Set projections REMAIN until R3c
    // internalizes hasAnyPossibleMatch/isBuiltInOrExternal (recorded
    // limitation — the ~85MB heap win lands with R3c, not here).
    if (this.ctx?.live()) {
      try {
        this.ctx.warm();
      } catch (err) {
        this.handleCtxFailure(err);
      }
    }
    const files = this.ctxRead((ctx) => ctx.getAllFiles());
    const names = this.ctxRead((ctx) => ctx.getAllNodeNames());

    // Cache the set of known file paths (lightweight string set)
    this.knownFiles = new Set(files ?? this.queries.getAllFilePaths());

    // Cache all distinct symbol names for fast pre-filtering (just strings, not full nodes)
    this.knownNames = new Set(names ?? this.queries.getAllNodeNames());

    this.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    // (R3b) Invalidation seam: drop the native read-context caches with the
    // TS ones. Covers TS-arm direct writes (runPostExtract's updateNode,
    // fallback replays) the store commit-generation counter cannot see; the
    // QueryBuilder TS-write listener covers the remaining seams.
    if (this.ctx?.live()) {
      try {
        this.ctx.invalidate();
      } catch (err) {
        this.handleCtxFailure(err);
      }
    }
    this.nodeCache.clear();
    this.fileCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.knownNames = null;
    this.knownFiles = null;
    this.cachesWarmed = false;
    this.linesCache.clear();
    // Source-derived name-matcher memos (sealed-module state, static-function
    // reads, local-binding scans, store-binding eligibility, receiver
    // declarations, import supplements) die with the file caches they were
    // derived from (upstream clearNameMatcherMemos discipline).
    clearNameMatcherMemos(this.context);
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        const native = this.ctxRead((ctx) => ctx.getNodesInFile(filePath));
        if (native) return native;
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      getNodesByName: (name: string) => {
        const native = this.ctxRead((ctx) => ctx.getNodesByName(name));
        if (native) return native;
        const cached = this.nameCache.get(name);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByName(name);
        this.nameCache.set(name, result);
        return result;
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        const native = this.ctxRead((ctx) => ctx.getNodesByQualifiedName(qualifiedName));
        if (native) return native;
        const cached = this.qualifiedNameCache.get(qualifiedName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
        this.qualifiedNameCache.set(qualifiedName, result);
        return result;
      },

      getNodesByKind: (kind: Node['kind']) => {
        const native = this.ctxRead((ctx) => ctx.getNodesByKind(kind));
        if (native) return native;
        return this.queries.getNodesByKind(kind);
      },

      fileExists: (filePath: string) => {
        const native = this.ctxRead((ctx) => ctx.fileExists(filePath));
        if (native !== null) return native;
        // Check pre-built known files set first (O(1))
        if (this.knownFiles) {
          const normalized = filePath.replace(/\\/g, '/');
          if (this.knownFiles.has(filePath) || this.knownFiles.has(normalized)) {
            return true;
          }
        }
        // Fall back to filesystem for files not yet indexed
        const fullPath = path.join(this.projectRoot, filePath);
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        // Boxed: a native `null` (read miss) is a RESULT, distinct from the
        // ctxRead `null` that means "native arm unavailable".
        const native = this.ctxRead((ctx) => ({ content: ctx.readFile(filePath) }));
        if (native) return native.content;
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath)!;
        }

        const fullPath = path.join(this.projectRoot, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(filePath, content);
          return content;
        } catch (error) {
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(filePath, null);
          return null;
        }
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        const native = this.ctxRead((ctx) => ctx.getAllFiles());
        if (native) return native;
        return this.queries.getAllFilePaths();
      },

      listDirectories: (relativePath: string) => {
        const native = this.ctxRead((ctx) => ctx.listDirectories(relativePath));
        if (native) return native;
        const target = relativePath === '.' || relativePath === ''
          ? this.projectRoot
          : path.join(this.projectRoot, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (error) {
          logDebug('Failed to list directory for resolution', {
            relativePath,
            error: String(error),
          });
          return [];
        }
      },

      getNodesByLowerName: (lowerName: string) => {
        const native = this.ctxRead((ctx) => ctx.getNodesByLowerName(lowerName));
        if (native) return native;
        const cached = this.lowerNameCache.get(lowerName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByLowerName(lowerName);
        this.lowerNameCache.set(lowerName, result);
        return result;
      },

      getImportMappings: (filePath: string, language) => {
        const native = this.ctxRead((ctx) => ctx.getImportMappings(filePath, language));
        if (native) return native;
        const cacheKey = filePath;
        const cached = this.importMappingCache.get(cacheKey);
        if (cached) return cached;

        const content = this.context.readFile(filePath);
        if (!content) {
          this.importMappingCache.set(cacheKey, []);
          return [];
        }

        const mappings = extractImportMappings(filePath, content, language);
        this.importMappingCache.set(cacheKey, mappings);
        return mappings;
      },

      getProjectAliases: () => {
        if (this.projectAliases === undefined) {
          this.projectAliases = loadProjectAliases(this.projectRoot);
        }
        return this.projectAliases;
      },

      getGoModule: () => {
        if (this.goModule === undefined) {
          this.goModule = loadGoModule(this.projectRoot);
        }
        return this.goModule;
      },

      getReExports: (filePath: string, language) => {
        const native = this.ctxRead((ctx) => ctx.getReExports(filePath, language));
        if (native) return native;
        const cached = this.reExportCache.get(filePath);
        if (cached) return cached;
        const content = this.context.readFile(filePath);
        if (!content) {
          this.reExportCache.set(filePath, []);
          return [];
        }
        const reExports = extractReExports(content, language);
        this.reExportCache.set(filePath, reExports);
        return reExports;
      },

      getCppIncludeDirs: () => {
        return loadCppIncludeDirs(this.projectRoot);
      },

      getFileLines: (filePath: string) => {
        const native = this.ctxRead((ctx) => ctx.getFileLines(filePath));
        if (native) return native;
        const cached = this.linesCache.get(filePath);
        if (cached !== undefined) return cached;
        // Shares the LRU file-content cache via readFile; the split result is
        // memoized separately so line-oriented scans (sealed-module reads,
        // bare-call shape checks, static-C detection) never re-split per ref.
        const content = this.fileCache.has(filePath)
          ? this.fileCache.get(filePath)
          : this.context.readFile(filePath);
        if (content === null || content === undefined) return [];
        const lines = content.split('\n');
        this.linesCache.set(filePath, lines);
        return lines;
      },

      getNodeById: (id: string) => {
        // Boxed: a native `undefined` (id miss) is a RESULT, distinct from
        // the ctxRead `null` that means "native arm unavailable".
        const native = this.ctxRead((ctx) => ({ node: ctx.getNodeById(id) }));
        if (native) return native.node;
        return this.queries.getNodeById(id) ?? undefined;
      },

      resolveImport: (r: UnresolvedRef) => {
        return resolveViaImport(r, this.context);
      },
    };
  }

  /**
   * Resolve all unresolved references
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    // Pre-load all nodes into memory for fast lookups
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format, using denormalized fields when available
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      id: ref.id,
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      // Report progress every 1% to avoid too many updates
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    // Final progress report
    if (onProgress && total > 0) {
      onProgress(total, total);
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Resolve a batch with cooperative per-ref yielding so a dense batch never
   * starves the event loop (agent runtime responsiveness, CLI progress, MCP
   * daemon responses). Mirrors resolveAll's semantics exactly — same order,
   * same stats — but yields between every reference (upstream #1122: a single
   * reference can take seconds worst-case, so a fixed N-refs cadence would
   * let the worst case land inside one unyielded span).
   */
  private async resolveBatchYielding(
    unresolvedRefs: UnresolvedReference[],
    maybeYield: MaybeYield
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      id: ref.id,
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      await maybeYield();
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Check if a reference name has any possible match in the codebase.
   * Uses the pre-built knownNames set to skip expensive resolution
   * for names that definitely don't exist as symbols.
   */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames) return true; // no pre-filter available

    // Direct name match
    if (this.knownNames.has(name)) return true;

    // For qualified names like "obj.method" or "Class::method", check the parts
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
      // Also check capitalized receiver (instance-method resolution)
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (this.knownNames.has(capitalized)) return true;
      // JVM FQN: `com.example.foo.Bar` — the only useful segment is the
      // last one (`Bar`); the earlier check finds `example.foo.Bar` which
      // never matches a node name.
      const lastDot = name.lastIndexOf('.');
      if (lastDot > dotIdx) {
        const tail = name.substring(lastDot + 1);
        if (tail && this.knownNames.has(tail)) return true;
      }
    }
    const colonIdx = name.indexOf('::');
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
    }

    // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1);
      if (this.knownNames.has(fileName)) return true;
    }

    return false;
  }

  /**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a single reference. Strategies produce candidates tagged with an
   * evidence category (`resolvedBy`); the strongest evidence class wins (see
   * {@link RESOLVER_RANK}), with ties broken by file/language proximity to the
   * reference rather than any numeric scoring.
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    // AND the name doesn't match a local import. The import escape is
    // necessary because re-export rename chains (`import { login }
    // from './barrel'` where the barrel has `export { signIn as login }
    // from './auth'`) intentionally call a name that has no
    // declaration anywhere — only the renamed upstream symbol does.
    if (
      !this.hasAnyPossibleMatch(ref.referenceName) &&
      !this.matchesAnyImport(ref) &&
      !this.frameworks.some((f) => f.claimsReference?.(ref.referenceName))
    ) {
      return null;
    }

    // Function-as-value refs (#756) get a dedicated, strictly-gated path:
    // `this.<member>` values resolve ONLY against the enclosing class's own
    // members; everything else tries import-based resolution first (an
    // imported callback resolves through its import, the most precise
    // cross-file signal), then matchFunctionRef (same-file first, unique-only
    // cross-file, function/method targets only). They never reach the
    // framework or fuzzy strategies below.
    if (ref.referenceKind === 'function_ref') {
      if (ref.referenceName.startsWith('this.')) {
        return this.resolveThisMemberFnRef(ref);
      }
      const fnRefViaImport = resolveViaImport(ref, this.context);
      if (fnRefViaImport) {
        const target = this.queries.getNodeById(fnRefViaImport.targetNodeId);
        if (
          target &&
          (target.kind === 'function' ||
            target.kind === 'method' ||
            // Python (#1478): an imported class used as a value (`return
            // OrgSerializerFull`) resolves through its import like any
            // callback — mirrors matchFunctionRef's bareClassOk.
            (ref.language === 'python' && target.kind === 'class'))
        ) {
          return fnRefViaImport;
        }
      }
      return matchFunctionRef(ref, this.context);
    }

    // JVM FQN imports skip framework/name-matcher: `import com.example.Bar`
    // resolves directly through the qualifiedName index, which is unambiguous
    // even when several `Bar` classes exist in different packages.
    const jvmImport = resolveJvmImport(ref, this.context);
    if (jvmImport) return jvmImport;

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution
    for (const framework of this.frameworks) {
      const result = framework.resolve(ref, this.context);
      if (!result) continue;
      // Authoritative evidence resolves immediately: `import`/`qualified-name`
      // classes, or a framework result explicitly flagged `authoritative`
      // (the successor of the legacy confidence >= 0.9 short-circuit).
      if (result.authoritative || result.resolvedBy === 'import' || result.resolvedBy === 'qualified-name') return result;
      candidates.push(result);
    }

    // A retained untyped qualified chain (`a.b.c`, 3+ segments) supplies
    // effect/call-site evidence only. In particular, importing its root does
    // not make the root its call target — nothing below may bind it.
    if (isUnresolvedJsMemberCall(ref)) return null;

    // A TS/JS/Python call-receiver chain (`useStore.getState().reset`, #1683)
    // names the ROOT's import, not the method's: letting resolveViaImport see
    // it binds the call to the imported store constant and the method is
    // never looked up. The name-matcher owns the chain shape for these
    // languages (store-accessor fallback or nothing) — the Java/Kotlin/C++
    // chains keep their existing path below.
    if (
      ref.referenceKind === 'calls' &&
      CHAIN_SHAPE.test(ref.referenceName) &&
      (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'python')
    ) {
      return matchReference(ref, this.context);
    }

    // Strategy 2: Try import-based resolution
    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      // Import evidence is always the strongest available — resolve
      // immediately. (Today every import result carries `resolvedBy: 'import'`,
      // so this is a straight short-circuit.)
      if (importResult.resolvedBy === 'import' || importResult.resolvedBy === 'qualified-name') return importResult;
      candidates.push(importResult);
    }

    // Strategy 3: Try name matching
    let nameResult = matchReference(ref, this.context);
    if (nameResult) {
      const target = this.queries.getNodeById(nameResult.targetNodeId);
      // Post-pipeline visibility guard (K-v2 P5-1 / D8): a definition its
      // language makes file-local — a C `static`, a Kotlin `private fun`, a
      // Go unexported name in another package, a Rust non-`pub` item outside
      // its module subtree, a binding in a sealed JS/TS module — cannot be
      // what a name in another file means, whichever strategy chose it
      // (upstream #1730/#1719). The rejection is FINAL: the reference stays
      // unresolved rather than promoting another candidate.
      if (target && !isVisibleAcrossFiles(target, ref, this.context)) {
        nameResult = null;
      }
    }
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) return null;

    // Pick the candidate with the strongest evidence class; equal classes
    // fall to same-file, then same-language, then a deterministic id order.
    return this.pickBestCandidate(ref, candidates);
  }

  /**
   * Cross-strategy arbitration (see RESOLVER_RANK). Ties within one
   * evidence class prefer a target in the reference's own file, then a
   * same-language target, then the lexicographically smaller target id
   * (deterministic across reindexes).
   */
  private pickBestCandidate(ref: UnresolvedRef, candidates: ResolvedRef[]): ResolvedRef {
    return candidates.reduce((best, curr) => {
      const rankDiff = RESOLVER_RANK[curr.resolvedBy] - RESOLVER_RANK[best.resolvedBy];
      if (rankDiff !== 0) return rankDiff > 0 ? curr : best;
      const bestNode = this.queries.getNodeById(best.targetNodeId);
      const currNode = this.queries.getNodeById(curr.targetNodeId);
      const bestSameFile = bestNode?.filePath === ref.filePath;
      const currSameFile = currNode?.filePath === ref.filePath;
      if (currSameFile !== bestSameFile) return currSameFile ? curr : best;
      if (currNode && bestNode && currNode.language !== bestNode.language) {
        return currNode.language === ref.language ? curr : best;
      }
      return curr.targetNodeId < best.targetNodeId ? curr : best;
    });
  }

  /**
   * Resolve a `this.<member>` function-as-value reference (#756/#808) to the
   * ENCLOSING CLASS's own member — never a same-named symbol elsewhere. The
   * registration idiom (`btn.on('click', this.handleClick)`) names a member of
   * the class being defined, so the only valid target shares the from-symbol's
   * qualified-name scope. Function/method targets only, same file required, no
   * fallback of any kind.
   *
   * Scope-narrowed against upstream N: a member not found on the class itself
   * stays unresolved here — N defers those to a second supertype pass
   * (resolveDeferredThisMemberRefs, inherited-member walk over
   * implements/extends edges) which the fork skeleton does not carry yet
   * (pending-parent item in the K-v2 P5-1 report).
   */
  private resolveThisMemberFnRef(ref: UnresolvedRef): ResolvedRef | null {
    const member = ref.referenceName.slice('this.'.length);
    if (!member) return null;
    const fromNode = this.queries.getNodeById(ref.fromNodeId);
    if (!fromNode) return null;
    // A hook declared at class-body level attributes to the CLASS node itself
    // — its qualified name IS the scope. For members, strip the member segment.
    let classPrefix: string;
    if (CLASS_SCOPE_KINDS.has(fromNode.kind)) {
      classPrefix = fromNode.qualifiedName;
    } else {
      const sep = fromNode.qualifiedName.lastIndexOf('::');
      if (sep <= 0) return null; // not inside a class scope
      classPrefix = fromNode.qualifiedName.slice(0, sep);
    }
    const candidates = this.context
      .getNodesByQualifiedName(`${classPrefix}::${member}`)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          n.filePath === ref.filePath &&
          n.id !== ref.fromNodeId
      );
    if (candidates.length === 0) return null;
    const target = candidates.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      resolvedBy: 'function-ref',
    };
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    const edges = resolved.flatMap((ref) => {
      // `function_ref` (#756) is internal-only: it persists as a `references`
      // edge (the registration site depends on the callback), distinguishable
      // by metadata.fnRef. callers/impact already traverse `references`, so
      // registration sites surface with no graph-layer changes.
      let kind: Edge['kind'] =
        ref.edgeKind ??
        (ref.original.referenceKind === 'function_ref' ? 'references' : ref.original.referenceKind);

      // Promote "extends" to "implements" when a class/struct targets an interface
      if (kind === 'extends') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
          const sourceNode = this.queries.getNodeById(ref.original.fromNodeId);
          if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
            kind = 'implements';
          }
        }
      }

      // Promote "calls" to "instantiates" when the resolved target is a
      // class/struct/union. Languages without a `new` keyword (Python, Ruby)
      // express instantiation as `Foo()` — extraction can't tell that
      // apart from a function call without symbol info, but resolution
      // can: if `Foo` resolves to a class, the call IS an instantiation.
      if (kind === 'calls') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (
          targetNode &&
          (targetNode.kind === 'class' || targetNode.kind === 'struct' || targetNode.kind === 'union')
        ) {
          kind = 'instantiates';
        }
      }

      // One reference can name several targets — a navigation whose
      // destination is a conditional reaches every arm. Each becomes its own
      // edge, sharing this resolution's kind.
      const targets = [
        { targetNodeId: ref.targetNodeId, metadata: ref.metadata },
        ...(ref.alsoTargets ?? []),
      ];
      return targets.map((t) => ({
        source: ref.original.fromNodeId,
        target: t.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata: {
          ...(t.metadata ?? {}),
          resolvedBy: ref.resolvedBy,
          // The ORIGINAL reference text (and kind, when kind promotion above
          // rewrote it — calls→instantiates, extends→implements,
          // function_ref→references). If this edge's target is later removed
          // by a re-index, the edge is resurrected as exactly this ref and
          // re-resolved (upstream #1240 removal case). Edges without refName
          // (pre-existing, synthesized) are deliberately NOT resurrected:
          // reconstructing from the target's plain name would strip receiver
          // context and risk a rebind a full re-index would never make.
          refName: ref.original.referenceName,
          ...(ref.original.referenceKind !== kind ? { refKind: ref.original.referenceKind } : {}),
          // Uniform marker for function-as-value edges (#756), regardless of
          // which strategy resolved them (import vs matchFunctionRef) — lets
          // tooling label "callback registration" and lets validation diff
          // exactly the edges this feature added.
          ...(ref.original.referenceKind === 'function_ref' ? { fnRef: true } : {}),
        },
      }));
    });
    // Import-binding/re-export double-emission hygiene (K-v2 P5-1) — see
    // dedupeSymbolImportEdges for the adjudication and keep-rule.
    return dedupeSymbolImportEdges(edges);
  }

  /**
   * Materialize file-level `imports` edges (source file node → target file
   * node) for the given files. The tree-sitter pipeline already emits
   * file→import-statement edges, but those never cross files; the real
   * dependency facts only lived in the in-memory import-mapping cache and
   * were invisible to FILE_PROJECTION walks (getFileDependents and friends).
   *
   * Semantic notes:
   * - Edges carry no refName (synthesized edges deliberately don't — see
   *   createEdges) so target removal never resurrects them for re-resolution.
   * - Each file's existing file→file import edges are deleted first (targets
   *   restricted to kind='file', so syntax edges to kind='import' statement
   *   nodes survive) then re-inserted from current content — idempotent under
   *   the edges identity unique index.
   * - Same-source mappings are deduped before resolution; the unique index
   *   additionally collapses distinct specifiers resolving to one file.
   * - External specifiers and unresolvable paths resolve to null and are skipped.
   */
  private materializeFileLevelImportEdges(filePaths: string[]): void {
    if (filePaths.length === 0) return;

    const edges: Edge[] = [];
    const fileNodeCache = new Map<string, Node | undefined>();
    const getFileNode = (filePath: string): Node | undefined => {
      if (!fileNodeCache.has(filePath)) {
        fileNodeCache.set(
          filePath,
          this.queries.getNodesByFile(filePath).find((n) => n.kind === 'file')
        );
      }
      return fileNodeCache.get(filePath);
    };

    for (const filePath of filePaths) {
      const fileRecord = this.queries.getFileByPath(filePath);
      if (!fileRecord) continue;
      const sourceNode = getFileNode(filePath);
      if (!sourceNode) continue;

      // Stale edges first: an import removed since the last pass must not
      // linger (re-extraction cascade covers re-indexed files; this delete
      // covers every other pass).
      this.queries.deleteFileLevelImportEdgesBySource(sourceNode.id);

      const mappings = this.context.getImportMappings(filePath, fileRecord.language);
      const reExports = this.context.getReExports?.(filePath, fileRecord.language) ?? [];
      if (mappings.length === 0 && reExports.length === 0) continue;

      // Import and re-export sources share one dedupe set: `export { x } from
      // './a'` and `import { y } from './a'` are one file-level dependency.
      const seenSources = new Set<string>();
      const addSource = (source: string): void => {
        if (seenSources.has(source)) return;
        seenSources.add(source);
        const resolvedPath = resolveImportPath(source, filePath, fileRecord.language, this.context);
        if (!resolvedPath || resolvedPath === filePath) return;
        const targetNode = getFileNode(resolvedPath);
        if (!targetNode) return;
        edges.push({
          source: sourceNode.id,
          target: targetNode.id,
          kind: 'imports',
          line: 0,
          column: 0,
          metadata: { resolvedBy: 'import' },
        });
      };
      for (const imp of mappings) addSource(imp.source);
      for (const reExport of reExports) addSource(reExport.source);
    }

    if (edges.length > 0) this.queries.insertEdges(edges);
  }

  /**
   * Delete unresolved rows by stable SQLite IDs when available, preserving
   * tuple-based deletion for extraction callers that do not have row IDs.
   */
  private deleteUnresolvedReferences(refs: UnresolvedRef[]): number {
    if (refs.length === 0) return 0;

    const ids = refs.flatMap((ref) => ref.id === undefined ? [] : [ref.id]);
    const withoutIds = refs.filter((ref) => ref.id === undefined);
    let deleted = 0;
    if (ids.length > 0) {
      deleted += this.queries.deleteUnresolvedReferencesByIds(ids);
    }
    if (withoutIds.length > 0) {
      deleted += this.queries.deleteSpecificResolvedReferences(
        withoutIds.map((ref) => ({
          fromNodeId: ref.fromNodeId,
          referenceName: ref.referenceName,
          referenceKind: ref.referenceKind,
        }))
      );
    }
    return deleted;
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }
    // Persist file-level import edges — full sweep over every indexed file so
    // import-only dependencies land even when no symbol ref crossed the boundary.
    this.materializeFileLevelImportEdges(this.queries.getAllFilePaths());

    // Scoped sync resolves only the changed files' refs, but dynamic-dispatch
    // edges can depend on unchanged neighbors (e.g. base method -> new override).
    // Re-run additive synthesis so syncFiles() reaches the same graph shape as
    // full indexAll(). insertEdges() is idempotent.
    try {
      result.stats.byMethod['callback-synthesis'] = synthesizeCallbackEdges(this.queries, this.context);
    } catch {
      // synthesis is additive and optional; ignore failures
    }

    // Clean up resolved refs from unresolved_refs so metrics stay accurate.
    if (result.resolved.length > 0) {
      this.deleteUnresolvedReferences(result.resolved.map((ref) => ref.original));
    }

    // Park still-unresolvable refs as status='failed' — parity with the
    // batched path (upstream #1240). A ref whose own file never changes would
    // otherwise stay pending forever; failed rows are excluded from the
    // pending readers but stay retryable by a later sync that adds the
    // satisfying symbol.
    if (result.unresolved.length > 0) {
      this.queries.markReferencesFailed(
        result.unresolved.map((r) => ({
          fromNodeId: r.fromNodeId,
          referenceName: r.referenceName,
          referenceKind: r.referenceKind,
        }))
      );
    }

    return result;
  }

  /**
   * Yielding counterpart of {@link resolveAndPersist} for a caller-supplied
   * ref list — used by sync's failed-ref retry pass (upstream #1240). Same
   * persistence semantics: resolved refs become edges and their rows are
   * deleted; still-unresolvable refs are (re-)marked failed (a no-op for rows
   * already in that status). Yields per chunk because sync can run under a
   * daemon watchdog and a retry set is unbounded when a large edit lands many
   * popular symbol names at once.
   */
  async resolveAndPersistListYielding(refs: UnresolvedReference[]): Promise<ResolutionResult> {
    const maybeYield = createYielder();
    const result = await this.resolveBatchYielding(refs, maybeYield);

    const PERSIST_CHUNK = 1000;
    const edges = this.createEdges(result.resolved);
    for (let i = 0; i < edges.length; i += PERSIST_CHUNK) {
      this.queries.insertEdges(edges.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }
    // Materialize file-level import edges for the involved files only.
    const listFilePaths = [...new Set(refs.map((ref) => ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId)))];
    this.materializeFileLevelImportEdges(listFilePaths);

    const resolvedKeys = result.resolved.map((r) => ({
      fromNodeId: r.original.fromNodeId,
      referenceName: r.original.referenceName,
      referenceKind: r.original.referenceKind,
    }));
    for (let i = 0; i < resolvedKeys.length; i += PERSIST_CHUNK) {
      this.queries.deleteSpecificResolvedReferences(resolvedKeys.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }

    const unresolvedKeys = result.unresolved.map((r) => ({
      fromNodeId: r.fromNodeId,
      referenceName: r.referenceName,
      referenceKind: r.referenceKind,
    }));
    for (let i = 0; i < unresolvedKeys.length; i += PERSIST_CHUNK) {
      this.queries.markReferencesFailed(unresolvedKeys.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }

    return result;
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000,
    walBackpressure?: () => Promise<void> | null,
    persistenceChunkSize: number = 1000
  ): Promise<ResolutionResult> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer');
    }
    if (!Number.isInteger(persistenceChunkSize) || persistenceChunkSize <= 0) {
      throw new RangeError('persistenceChunkSize must be a positive integer');
    }

    // Resolution runs on the host runtime's main thread; a dense batch's
    // synchronous resolveAll freezes the event loop (CLI progress, MCP daemon
    // responses) for seconds on large repos. A shared yielder gives the loop a
    // regular window between references and between persistence chunks.
    const maybeYield = createYielder();

    this.warmCaches();

    const total = this.queries.getUnresolvedReferencesCount();
    let remaining = total;
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    // Files whose file-level import edges were already swept inside the batch
    // loop; the post-loop sweep below covers the rest.
    const importEdgeSweptFiles = new Set<string>();

    // Process in batches. We always read from offset 0 because rows are
    // deleted after each batch, shifting the remaining rows forward.
    let previousRemaining = total + 1;
    while (true) {
      const batch = this.queries.getUnresolvedReferencesBatch(0, batchSize);
      if (batch.length === 0) break;

      const result = await this.resolveBatchYielding(batch, maybeYield);

      // Persist edges immediately in bounded sub-transactions with yields
      // between chunks so a large batch never monopolizes the event loop.
      const edges = this.createEdges(result.resolved);
      for (let i = 0; i < edges.length; i += persistenceChunkSize) {
        this.queries.insertEdges(edges.slice(i, i + persistenceChunkSize));
        await maybeYield();
      }
      // Materialize file-level import edges scoped to this batch's files;
      // delete-then-insert keeps it idempotent across repeated batches.
      const batchFilePaths = [...new Set(batch.map((ref) => ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId)))];
      this.materializeFileLevelImportEdges(batchFilePaths);
      for (const batchPath of batchFilePaths) importEdgeSweptFiles.add(batchPath);

      // Resolved rows are deleted; unresolvable ones are parked as
      // status='failed' (upstream #1240) — both leave the pending set the batch
      // reader sees, so the drain still terminates, and failed rows stay
      // retryable by a later sync that adds the satisfying symbol. Resolved rows
      // loaded from the database carry stable IDs; tuple delete remains the
      // compatibility path.
      let consumed = 0;
      const resolvedRefs = result.resolved.map((ref) => ref.original);
      for (let i = 0; i < resolvedRefs.length; i += persistenceChunkSize) {
        consumed += this.deleteUnresolvedReferences(resolvedRefs.slice(i, i + persistenceChunkSize));
        await maybeYield();
      }
      const unresolvedKeys = result.unresolved.map((ref) => ({
        fromNodeId: ref.fromNodeId,
        referenceName: ref.referenceName,
        referenceKind: ref.referenceKind,
      }));
      for (let i = 0; i < unresolvedKeys.length; i += persistenceChunkSize) {
        const chunk = unresolvedKeys.slice(i, i + persistenceChunkSize);
        this.queries.markReferencesFailed(chunk);
        consumed += chunk.length;
        await maybeYield();
      }

      // Aggregate stats
      aggregateStats.total += result.stats.total;
      aggregateStats.resolved += result.stats.resolved;
      aggregateStats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
      }

      processed += consumed;
      onProgress?.(processed, total);

      // Writer-side backstop: pause between batches when the WAL valve's hard
      // cap is breached until a full backfill lands (upstream #1231 wiring).
      const bp = walBackpressure?.();
      if (bp) await bp;

      // Yield so progress UI can render between batches
      await new Promise(resolve => setImmediate(resolve));

      // NOTE: there used to be an extra early break here when a batch resolved
      // nothing (`resolved.length === 0 && unresolved.length === batch.length`).
      // That was wrong: an all-unresolvable batch still DELETES its rows
      // (progress), yet the break abandoned every batch after it in the same
      // run — on a repo whose first 5000 refs are all external/stdlib calls,
      // resolution stopped at batch one and left the rest of the table as
      // permanent orphans (upstream #1187).

      // Non-progress guard: the pending population must shrink after every
      // batch — resolved rows are deleted and unresolvable rows are parked as
      // failed above, and both leave the pending set the batch reader sees.
      // A batch that consumed nothing, or a pending count that failed to
      // shrink, means a resolver returned a match whose tuple does not match
      // the stored row and we would spin forever (the pre-#1187 runaway).
      if (consumed === 0) break;
      remaining = this.queries.getUnresolvedReferencesCount();
      if (remaining >= previousRemaining) break;
      previousRemaining = remaining;
    }

    // Ref-less files never enter a batch: a barrel whose only cross-file
    // dependency is `export { x } from './a'` emits no unresolved references,
    // so sweep the files the batch loop skipped. Delete-then-insert keeps the
    // whole pass idempotent; the non-batched path covers this in-file with a
    // full sweep in resolveAndPersist.
    this.materializeFileLevelImportEdges(
      this.queries.getAllFilePaths().filter((filePath) => !importEdgeSweptFiles.has(filePath))
    );

    // Dynamic-edge synthesis: now that all base `calls` edges are persisted,
    // synthesize observer/callback dispatch edges (dispatcher → registered
    // callbacks) that static parsing leaves out. Best-effort — never fail the
    // index on it. See docs/design/callback-edge-synthesis.md.
    try {
      aggregateStats.byMethod['callback-synthesis'] = synthesizeCallbackEdges(this.queries, this.context);
    } catch {
      // synthesis is additive and optional; ignore failures
    }

    return {
      resolved: [],
      unresolved: [],
      stats: aggregateStats,
    };
  }


  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;
    const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
      || ref.language === 'tsx' || ref.language === 'jsx';

    // JavaScript/TypeScript built-ins
    if (isJsTs && JS_BUILT_INS.has(name)) {
      return true;
    }

    // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
      return true;
    }

    // React hooks from React itself
    if (isJsTs && REACT_HOOKS.has(name)) {
      return true;
    }

    // Python built-ins (bare calls only — dotted calls like console.print are method calls)
    if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
      return true;
    }

    // Python built-in method calls (e.g., list.extend, dict.update)
    if (ref.language === 'python') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        const method = name.substring(dotIdx + 1);
        // Filter calls on built-in types (list.append, dict.update, etc.)
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
          return true;
        }
        // Filter built-in methods on non-class receivers
        // (e.g., items.append where items is a local list variable)
        // But allow if the capitalized receiver matches a known codebase class
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
          if (!this.knownNames?.has(capitalized)) {
            return true;
          }
        }
      }
      // A bare name colliding with a builtin method (index, get, update, count…)
      // is only a builtin when NOTHING in the codebase declares it. A declared
      // symbol with that exact name — e.g. a Flask/FastAPI view `def index()` or
      // `def get()` — is a real reference target. Mirrors the knownNames guard on
      // the dotted branch above; without it, every handler named after a builtin
      // method silently loses its route→handler edge.
      if (PYTHON_BUILT_IN_METHODS.has(name) && !this.knownNames?.has(name)) {
        return true;
      }
    }

    // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
    if (ref.language === 'go') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const pkg = name.substring(0, dotIdx);
        if (GO_STDLIB_PACKAGES.has(pkg)) {
          return true;
        }
      }
      if (GO_BUILT_INS.has(name)) {
        return true;
      }
    }

    // Pascal/Delphi built-ins and standard library units
    if (ref.language === 'pascal') {
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
        return true;
      }
      if (PASCAL_BUILT_INS.has(name)) {
        return true;
      }
    }

    // C/C++ standard library symbols (printf, malloc, std::vector, etc.).
    // Names that collide with user-defined symbols are NOT filtered —
    // C and C++ projects routinely shadow stdlib names (custom allocators
    // define `malloc`/`free`, stream wrappers define `read`/`write`/`open`,
    // containers define `move`/`swap`, logging libs wrap `printf`). Killing
    // those resolutions makes the graph wrong, not cleaner. We only filter
    // when there's no user node with this name — then name-matching would
    // produce zero edges anyway and the filter just short-circuits work.
    if (ref.language === 'c' || ref.language === 'cpp') {
      // C++ std:: namespace prefix — safe to filter unconditionally,
      // since `std::foo` is never a user-defined qualified name in
      // tree-sitter output.
      if (name.startsWith('std::')) return true;
      if (C_BUILT_INS.has(name) || CPP_BUILT_INS.has(name)) {
        return !this.hasAnyPossibleMatch(name);
      }
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
