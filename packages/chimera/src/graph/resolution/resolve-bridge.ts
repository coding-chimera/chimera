/**
 * ResolveBridge — the native resolution batch arm (R3c-2).
 *
 * One ResolveHandle per graph root, symbiotic with that root's CtxBridge:
 * resolve_open snapshots the ctx invalidation key (the Rust strategy memos
 * auto-drop when it moves) and resolve_batch borrows the ctx's read
 * connection per call. Lifecycle: ReferenceResolver.dispose() closes this
 * bridge BEFORE the CtxBridge (which itself closes before the StoreBridge).
 *
 * # Plan A precompute (R3 proposal §4.2 — the FFI boundary contract)
 *
 * The strategies the boundary keeps TS-side cross as PRECOMPUTED per-batch
 * tables, never as callbacks:
 *   - importResults / jvmImportResults: resolveViaImport / resolveJvmImport
 *     results for every gated-in distinct ref key PLUS the synthetic
 *     store-holder keys `(file, holderName, 'references')` that
 *     resolveStoreAction's `X.getState` lookups need (the R3c-1 report's
 *     named pit). Holder names come from a per-file source scan for
 *     `X.getState(` — a SUPERSET of every name the Rust strategies can ask
 *     for (destructured/selector bindings and the chain-shape inner both
 *     appear textually in the file).
 *   - frameworkResults: each detected framework's resolve() per gated-in
 *     distinct ref POSITION (file, name, kind, line, col — fw resolve()
 *     parses the call site, so same-name refs at different lines resolve
 *     differently), in detection order, STOPPING at the first
 *     authoritative/import/qualified-name candidate — the exact call set
 *     resolveOne's short-circuit would have made.
 *   - claimedNames: the union of claimsReference answers over the batch's
 *     distinct names (the prefilter escape).
 *   - importPaths: resolveImportPath per (file, specifier) over the batch
 *     files' import mappings + re-exports (plus C/C++ include-ref names) —
 *     the materializeFileLevelImportEdges seam; aliases/go-module/cpp-dirs
 *     stay TS by design.
 *
 * Gate parity: precompute runs the resolver's OWN resolveOne-keep gate
 * (isBuiltInOrExternal / hasAnyPossibleMatch / matchesAnyImport / claims)
 * per ref first, so refs the Rust side would drop never trigger strategy
 * work here — the TS-side call set matches the TS arm's exactly.
 *
 * Failure discipline: resolveBatch THROWS on native failure; the caller
 * (resolveAndPersistBatched) falls back to the TS arm for that batch and
 * wire-shaped errors sticky-disable the bridge (degrade once).
 *
 * Thread discipline (v1): synchronous napi calls on the caller's thread —
 * the recorded R3 §2 amendment (same posture as the store/ctx bridges);
 * worker-thread migration is the shared follow-up.
 */

import type { ResolvedRef, ResolutionContext, UnresolvedRef, FrameworkResolver } from './types';
import type { CtxBridge } from './ctx-bridge';
import {
  resolveDebug,
  resolveEnabled,
  getResolveModule,
  type ResolveHandle,
  type ResolveModule,
} from '../store/loader';
import {
  encodeResolveBatch,
  decodeResolveBatch,
  RESOLVE_FLAG_SWEEP_BATCH_FILES,
  type DecodedBatch,
  type ExternalWireInput,
  type FrameworkCandidateWire,
  type ImportPathWire,
} from './resolve-encode';
import { resolveViaImport, resolveJvmImport, resolveImportPath } from './import-resolver';
import { objectLiteralMemberBinding } from './name-matcher';
import { isVisibleCppMacro } from './cpp-macro-visibility';
import { isCppConstructorRef, matchCppConstructor } from './cpp-constructor';

/**
 * Sentinel target for a #1838 macro-veto entry in the FRAMEWORK table (whose
 * key carries the ref POSITION — macro visibility is per call site, so a
 * name-keyed table would let one veto poison every same-name ref of the file).
 * The native arm treats presence of the sentinel under the ref's own FwKey as
 * the veto and never resolves the group as framework candidates (it returns
 * before Strategy 1).
 */
const CPP_MACRO_VETO_SENTINEL = 'cpp-macro-veto';

/** True for errors indicating a systematic bridge/wire/handle fault (sticky disable). */
export function isResolveWireError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('resolve wire') || msg.includes('resolve handle');
}

/**
 * Store-holder scan for the synthetic resolveImport keys: any `X.getState(`
 * in the file text is a candidate holder (the destructured/selector store
 * variable). Superset by construction — unused entries cost one
 * resolveViaImport each, missing entries would silently degrade the Rust
 * store strategies.
 */
const GET_STATE_HOLDER = /([A-Za-z0-9_$]+)\s*\.\s*getState\s*\(/g;

export interface NativeBatchDeps {
  context: ResolutionContext;
  frameworks: FrameworkResolver[];
  /**
   * resolveOne's keep-gate (builtin/external + knownNames/import/claims
   * prefilter). Refs it drops never reach any strategy on EITHER arm, so the
   * precompute skips them — matching the TS arm's strategy call set exactly.
   * `claims` is filled with the names claimsReference accepted (they must
   * cross as claimedNames or the Rust gate would re-drop them).
   */
  gateKeep(ref: UnresolvedRef, claims: Set<string>): boolean;
}

function serializeFrameworkResult(res: ResolvedRef): FrameworkCandidateWire {
  return {
    targetNodeId: res.targetNodeId,
    resolvedBy: res.resolvedBy,
    authoritative: res.authoritative === true,
    edgeKind: res.edgeKind ?? null,
    metadata: (res.metadata as Record<string, unknown> | undefined) ?? null,
    alsoTargets: (res.alsoTargets ?? []).map((t) => ({
      targetNodeId: t.targetNodeId,
      metadata: (t.metadata as Record<string, unknown> | undefined) ?? null,
    })),
  };
}

/**
 * Build the Plan A external tables for one batch (pure TS reads through the
 * ResolutionContext — exported for tests). Deterministic: keyed by first
 * appearance, deduped, framework order preserved.
 */
export function precomputeExternal(refs: UnresolvedRef[], deps: NativeBatchDeps): ExternalWireInput {
  const { context, frameworks, gateKeep } = deps;
  const out: ExternalWireInput = {
    importResults: [],
    jvmImportResults: [],
    frameworkResults: [],
    claimedNames: [],
    importPaths: [],
  };
  const claims = new Set<string>();
  const seenKeys = new Set<string>();
  const seenFwKeys = new Set<string>();
  const seenNames = new Set<string>();
  const batchFiles: string[] = [];
  const seenFiles = new Set<string>();
  const fileLanguage = new Map<string, UnresolvedRef['language']>();
  const seenPathKeys = new Set<string>();
  const getStateFiles = new Set<string>();
  const memberValueNames = new Map<string, Set<string>>();

  for (const ref of refs) {
    if (!seenFiles.has(ref.filePath)) {
      seenFiles.add(ref.filePath);
      batchFiles.push(ref.filePath);
      fileLanguage.set(ref.filePath, ref.language);
    }
    // The synthetic store-holder scan is NOT gate-limited: a gated-in ref's
    // resolution can reach any holder in its file.
    if ((ref.language === 'typescript' || ref.language === 'javascript' ||
         ref.language === 'tsx' || ref.language === 'jsx') &&
        !getStateFiles.has(ref.filePath)) {
      getStateFiles.add(ref.filePath);
      const source = context.readFile(ref.filePath);
      if (source?.includes('.getState')) {
        for (const m of source.matchAll(GET_STATE_HOLDER)) {
          const key = `${ref.filePath}\u0000${m[1]}\u0000references`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const synthetic: UnresolvedRef = {
            ...ref,
            referenceName: m[1]!,
            referenceKind: 'references',
          };
          const imp = resolveViaImport(synthetic, context);
          if (imp) {
            out.importResults.push({
              filePath: ref.filePath,
              referenceName: m[1]!,
              referenceKind: 'references',
              targetNodeId: imp.targetNodeId,
            });
          }
        }
      }
    }
    // #1932 object-literal member bindings: the native arm's
    // resolve_object_literal_binding consults the precomputed import table for
    // `const api = { m: importedFn }` members whose binding is an IMPORT of
    // the holder's file. The synthetic query the native arm issues is
    // (container.file_path, binding, ref.referenceKind) — and the same-file
    // holder strategy guarantees container.file_path === ref.filePath.
    if (ref.language === 'typescript' || ref.language === 'javascript' ||
        ref.language === 'tsx' || ref.language === 'jsx') {
      const ol = /^([\w$]+)\.(\w+)$/.exec(ref.referenceName);
      if (ol) {
        for (const holder of context.getNodesByName(ol[1]!)) {
          if ((holder.kind !== 'constant' && holder.kind !== 'variable') ||
              holder.filePath !== ref.filePath) continue;
          const binding = objectLiteralMemberBinding(holder, ol[2]!, context);
          if (!binding) continue;
          const key = `${ref.filePath}\u0000${binding}\u0000${ref.referenceKind}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const synthetic: UnresolvedRef = { ...ref, referenceName: binding };
          const imp = resolveViaImport(synthetic, context);
          if (imp) {
            out.importResults.push({
              filePath: ref.filePath,
              referenceName: binding,
              referenceKind: ref.referenceKind,
              targetNodeId: imp.targetNodeId,
            });
          }
        }
      }
    }
    // #1820/#2034 Python/Go member-value fn-refs: the native arm's
    // match_member_function_ref resolves receiver CLASS names through the
    // precomputed import table with synthetic (filePath, name, 'references')
    // keys (python_ref_class). The reachable query set is bounded: the
    // receiver path itself, the file's import local names, and any dotted
    // source token whose root segment is imported — inferred annotation /
    // constructor type names always occur lexically in the ref's file, so
    // the token scan covers every name pythonRefClass can hand resolveImport.
    if ((ref.language === 'python' || ref.language === 'go') &&
        ref.referenceKind === 'function_ref' && ref.referenceName.includes('.')) {
      if (!memberValueNames.has(ref.filePath)) {
        const localNames = new Set(context.getImportMappings(ref.filePath, ref.language).map((i) => i.localName));
        const names = new Set<string>(localNames);
        const source = context.readFile(ref.filePath);
        if (source) {
          for (const m of source.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g)) {
            if (localNames.has(m[0].split('.')[0]!)) names.add(m[0]);
          }
        }
        memberValueNames.set(ref.filePath, names);
      }
      const receiver = ref.referenceName.slice(0, ref.referenceName.lastIndexOf('.'));
      for (const name of [...memberValueNames.get(ref.filePath)!, receiver]) {
        const key = `${ref.filePath}\u0000${name}\u0000references`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const synthetic: UnresolvedRef = { ...ref, referenceName: name, referenceKind: 'references' };
        const imp = resolveViaImport(synthetic, context);
        if (imp) {
          out.importResults.push({
            filePath: ref.filePath,
            referenceName: name,
            referenceKind: 'references',
            targetNodeId: imp.targetNodeId,
          });
        }
      }
    }
    // #1838/#1839 C/C++ special answers for the native arm: the macro-
    // visibility veto and the constructor-ref match are computed HERE in TS
    // (they walk include timelines / lexical namespaces) and carried on
    // existing tables — a veto occupies the ref's POSITION-keyed framework
    // group with a sentinel candidate, a constructor match occupies the
    // ref's own import-table key. resolver.rs consults both at the top of
    // resolve_one_ungated, before any prefilter or strategy (mirrors
    // resolveOneCore's ordering).
    if ((ref.language === 'c' || ref.language === 'cpp') && ref.referenceKind === 'calls') {
      if (isVisibleCppMacro(ref, context)) {
        const fwKey = `${ref.filePath}\u0000${ref.referenceName}\u0000calls\u0000${ref.line}\u0000${ref.column}`;
        if (!seenFwKeys.has(fwKey)) {
          seenFwKeys.add(fwKey);
          out.frameworkResults.push({
            filePath: ref.filePath,
            referenceName: ref.referenceName,
            referenceKind: 'calls',
            line: ref.line,
            col: ref.column,
            candidates: [{ targetNodeId: CPP_MACRO_VETO_SENTINEL, resolvedBy: 'framework', authoritative: false }],
          });
        }
      }
    }
    if (isCppConstructorRef(ref)) {
      const ctor = matchCppConstructor(ref, context);
      if (ctor) {
        const key = `${ref.filePath}\u0000${ref.referenceName}\u0000${ref.referenceKind}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          out.importResults.push({
            filePath: ref.filePath,
            referenceName: ref.referenceName,
            referenceKind: ref.referenceKind,
            targetNodeId: ctor.targetNodeId,
          });
        }
      }
    }
    if (!gateKeep(ref, claims)) continue;
    // claimedNames must NOT depend on which prefilter branch kept the ref:
    // the native warm path runs without JS knownNames (hasAnyPossibleMatch
    // keeps everything early), so the gate's own claims loop may never run —
    // yet the Rust gate, with its REAL name index, needs every framework-
    // claimed name as its prefilter escape (the sveltekit `goto` adjudication:
    // no node named goto exists, so only claimedNames can keep the ref).
    // claimsReference is a pure name test — the superset costs nothing.
    if (!seenNames.has(ref.referenceName)) {
      seenNames.add(ref.referenceName);
      for (const f of frameworks) {
        if (f.claimsReference?.(ref.referenceName)) {
          claims.add(ref.referenceName);
          break;
        }
      }
    }
    // Import/jvm arms are name-keyed: resolveViaImport/resolveJvmImport read
    // the import mappings by (file, name) — position plays no role.
    const key = `${ref.filePath}\u0000${ref.referenceName}\u0000${ref.referenceKind}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      // Import arms (resolveOne function_ref path + Strategy 2).
      const imp = resolveViaImport(ref, context);
      if (imp) {
        out.importResults.push({
          filePath: ref.filePath,
          referenceName: ref.referenceName,
          referenceKind: ref.referenceKind,
          targetNodeId: imp.targetNodeId,
        });
      }
      const jvm = resolveJvmImport(ref, context);
      if (jvm) {
        out.jvmImportResults.push({
          filePath: ref.filePath,
          referenceName: ref.referenceName,
          referenceKind: ref.referenceKind,
          targetNodeId: jvm.targetNodeId,
        });
      }
    }
    // Framework arm — detection order, short-circuit parity with resolveOne.
    // POSITION-keyed: fw.resolve() parses the call site at ref.line/col, so
    // every distinct position gets its own call set and table entry (the
    // vue-router/sveltekit adjudication — a name-keyed table cross-fed one
    // call site's candidate to another's ref).
    const fwKey = `${key}\u0000${ref.line}\u0000${ref.column}`;
    if (seenFwKeys.has(fwKey)) continue;
    seenFwKeys.add(fwKey);
    const candidates: FrameworkCandidateWire[] = [];
    for (const fw of frameworks) {
      const res = fw.resolve(ref, context);
      if (!res) continue;
      candidates.push(serializeFrameworkResult(res));
      if (res.authoritative || res.resolvedBy === 'import' || res.resolvedBy === 'qualified-name') break;
    }
    if (candidates.length > 0) {
      out.frameworkResults.push({
        filePath: ref.filePath,
        referenceName: ref.referenceName,
        referenceKind: ref.referenceKind,
        line: ref.line,
        col: ref.column,
        candidates,
      });
    }
  }
  out.claimedNames = [...claims];

  // resolveImportPath table for the file-level sweep (per batch file: every
  // specifier its import mappings + re-exports mention, plus C/C++
  // include-ref names). Absent key === null result on the Rust side, so the
  // enumeration must match the Rust sweep's iteration set exactly.
  for (const file of batchFiles) {
    const language = fileLanguage.get(file)!;
    const specifiers = new Set<string>();
    for (const m of context.getImportMappings(file, language)) specifiers.add(m.source);
    for (const re of context.getReExports?.(file, language) ?? []) specifiers.add(re.source);
    if (language === 'c' || language === 'cpp') {
      for (const ref of refs) {
        if (ref.filePath === file && ref.referenceKind === 'imports') {
          specifiers.add(ref.referenceName);
        }
      }
    }
    for (const source of specifiers) {
      const key = `${file}\u0000${source}`;
      if (seenPathKeys.has(key)) continue;
      seenPathKeys.add(key);
      out.importPaths.push({
        filePath: file,
        source,
        resolvedPath: resolveImportPath(source, file, language, context),
      } satisfies ImportPathWire);
    }
  }
  return out;
}

/**
 * The native batch arm. resolveBatch = precompute (TS reads) → ONE encode →
 * ONE crossing → decode; persistence runs through the caller's existing
 * QueryBuilder/StoreBridge arms (R3a vocabulary unchanged).
 */
export class ResolveBridge {
  private disabled = false;
  private disabledReason = '';
  private closed = false;
  /** Count of native batch crossings (test/telemetry surface). */
  batchCount = 0;

  private constructor(
    private readonly mod: ResolveModule,
    private readonly ctxBridge: CtxBridge,
    private readonly handle: ResolveHandle
  ) {}

  /**
   * Open against a LIVE ctx bridge. Null on any failure (no ctx bridge —
   * which covers readOnly/crossProject, CODEGRAPH_STORE=0, CODEGRAPH_CTX=0 —,
   * CODEGRAPH_RESOLVE=0, missing/pre-R3c binary, contract mismatch,
   * resolve_open error): the caller keeps the TS batch arm silently.
   */
  static open(ctxBridge: CtxBridge | null): ResolveBridge | null {
    if (!ctxBridge?.live()) return null;
    if (!resolveEnabled()) return null;
    const mod = getResolveModule();
    if (!mod) return null;
    const rawCtx = ctxBridge.rawCtxHandle();
    if (!rawCtx) return null;
    try {
      const bridge = new ResolveBridge(mod, ctxBridge, mod.resolveOpen(rawCtx));
      resolveDebug('resolve handle opened');
      return bridge;
    } catch (err) {
      resolveDebug(`resolve_open failed — staying on the TS batch arm: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Per-call routing gate: open, not disabled, kill switch off, ctx live. */
  live(): boolean {
    return !this.disabled && !this.closed && resolveEnabled() && this.ctxBridge.live();
  }

  disable(reason: string): void {
    if (!this.disabled) {
      this.disabled = true;
      this.disabledReason = reason;
      resolveDebug(`resolve bridge disabled: ${reason}`);
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
   * Deterministic release, paired with ReferenceResolver.dispose() — runs
   * BEFORE CtxBridge.close(). Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.mod.resolveClose?.(this.handle);
    } catch (err) {
      resolveDebug(`resolveClose failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Resolve one batch natively. THROWS on any native/wire failure — the
   * caller owns the per-batch TS fallback (and sticky-disables via
   * isResolveWireError).
   */
  resolveBatch(refs: UnresolvedRef[], deps: NativeBatchDeps): DecodedBatch {
    const rawCtx = this.ctxBridge.rawCtxHandle();
    if (!rawCtx) throw new Error('resolve handle: ctx bridge closed');
    const ext = precomputeExternal(refs, deps);
    const wire = encodeResolveBatch(refs, ext, RESOLVE_FLAG_SWEEP_BATCH_FILES);
    const out = this.mod.resolveBatch(rawCtx, this.handle, wire);
    this.batchCount++;
    return decodeResolveBatch(out);
  }
}
