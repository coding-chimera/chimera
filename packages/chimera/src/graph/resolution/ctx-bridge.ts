/**
 * CtxBridge — the native resolution read context (R3b-2).
 *
 * One CtxHandle per graph root, symbiotic with that root's StoreBridge:
 * ctx_open borrows the store handle's db path + commit-generation counter
 * and holds its OWN rusqlite read connection (WAL — readers never block the
 * store writer). Every ResolutionContext getter the contract declares as
 * present routes through the batch wire functions here (single-key getters
 * ride a batch-of-one; hasNames/fileExistsBatch expose the true batch face
 * for R3c). The four declared-absent getters (getProjectAliases, getGoModule,
 * getCppIncludeDirs, resolveImport) keep their TS arm BY DESIGN — R3b-1 did
 * not implement them and this bridge does not expose them.
 *
 * Invalidation: native store commits bump the shared generation counter
 * (automatic). TS-arm writes bypass it, so this bridge subscribes to
 * StoreBridge.onTsWrite and calls ctx_invalidate at those seams; the resolver
 * additionally invalidates at its clearCaches() seam and warms at
 * warmCaches().
 *
 * Lifecycle (R1 pairing discipline): ReferenceResolver.dispose() closes this
 * bridge BEFORE QueryBuilder.dispose() closes the store handle — the ctx
 * borrows the store's generation counter, so ctx closes first. The napi GC
 * finalizer is only the crash fallback.
 *
 * Failure discipline: every method THROWS on native failure; the resolver's
 * ctxRead() wrapper catches, falls back to the TS getter for that call, and
 * sticky-disables the bridge on wire/handle-shaped errors (a systematic
 * decoder bug degrades once, not per call). A missing module, contract
 * mismatch, CODEGRAPH_CTX=0 kill switch (checked per call via live()), or a
 * closed/disabled store bridge all resolve to `null` at open — the TS
 * createContext arm remains and resolution never fails because of the bridge.
 *
 * Thread discipline (v1): synchronous napi calls on the caller's thread —
 * the same posture as today's synchronous bun:sqlite getter reads (NOT a
 * regression; the parent's formal amendment to R3_PROPOSAL §2 acceptance #4
 * applies to R3b as well). Worker-thread migration is a recorded follow-up.
 */

import type { Language, Node } from '../types';
import {
  ctxDebug,
  ctxEnabled,
  getCtxModule,
  type CtxHandle,
  type CtxModule,
} from '../store/loader';
import type { StoreBridge } from '../store/bridge';
import type { ImportMapping, ReExport } from './types';
import { decodeCtxImportMappings, decodeCtxNodes, decodeCtxReExports, decodeCtxStrings } from './ctx-decode';

/** True for errors indicating a systematic bridge/wire/handle fault (sticky disable). */
export function isCtxWireError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ctx wire') || msg.includes('ctx handle');
}

export class CtxBridge {
  private disabled = false;
  private disabledReason = '';
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  /** Count of native ctx calls (test/telemetry surface). */
  callCount = 0;

  private constructor(
    readonly projectRoot: string,
    private readonly mod: CtxModule,
    private readonly handle: CtxHandle
  ) {}

  /**
   * Open the read context for a LIVE store bridge's database. Null on any
   * failure (no store bridge — which is exactly the readOnly/crossProject and
   * kill-switched-store cases —, CODEGRAPH_CTX=0, missing/pre-R3b module,
   * contract mismatch, ctx_open error): the caller keeps the TS arm silently.
   */
  static open(store: StoreBridge | null, projectRoot: string): CtxBridge | null {
    if (!store?.live()) return null;
    if (!ctxEnabled()) return null;
    const mod = getCtxModule();
    if (!mod) return null;
    const raw = store.rawHandle();
    if (!raw) return null;
    try {
      const bridge = new CtxBridge(projectRoot, mod, mod.ctxOpen(raw, projectRoot));
      // TS-arm writes bypass the store generation counter — invalidate here.
      bridge.unsubscribe = store.onTsWrite(() => bridge.invalidateQuiet());
      ctxDebug(`ctx opened for ${projectRoot}`);
      return bridge;
    } catch (err) {
      ctxDebug(`ctx_open(${projectRoot}) failed — staying on the TS read context: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Per-call routing gate: open, not disabled, kill switch off. */
  live(): boolean {
    return !this.disabled && !this.closed && ctxEnabled();
  }

  disable(reason: string): void {
    if (!this.disabled) {
      this.disabled = true;
      this.disabledReason = reason;
      ctxDebug(`ctx bridge disabled for ${this.projectRoot}: ${reason}`);
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
   * Deterministic release, paired with ReferenceResolver.dispose() (which
   * CodeGraph.close() runs BEFORE QueryBuilder.dispose() closes the store
   * handle). Idempotent; unsubscribes from the store's TS-write seam.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.mod.ctxClose(this.handle);
    } catch (err) {
      ctxDebug(`ctxClose failed for ${this.projectRoot}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** warmCaches parity: build the knownFiles/knownNames indexes NOW. */
  warm(): void {
    this.callCount++;
    this.mod.ctxWarm(this.handle);
  }

  /** clearCaches parity for writes the generation counter cannot see. */
  invalidate(): void {
    this.callCount++;
    this.mod.ctxInvalidate(this.handle);
  }

  private invalidateQuiet(): void {
    if (this.closed) return;
    try {
      this.mod.ctxInvalidate(this.handle);
    } catch {
      // best-effort: a failed invalidate must not wedge the TS write path
    }
  }

  // --- node getters (batch wire under the hood; single-key = batch-of-one) ---

  getNodesInFile(filePath: string): Node[] {
    this.callCount++;
    return decodeCtxNodes(this.mod.ctxGetNodesInFiles(this.handle, [filePath]))[0] ?? [];
  }
  getNodesByName(name: string): Node[] {
    this.callCount++;
    return decodeCtxNodes(this.mod.ctxGetNodesByNames(this.handle, [name]))[0] ?? [];
  }
  getNodesByQualifiedName(qualifiedName: string): Node[] {
    this.callCount++;
    return decodeCtxNodes(this.mod.ctxGetNodesByQualifiedNames(this.handle, [qualifiedName]))[0] ?? [];
  }
  getNodesByLowerName(lowerName: string): Node[] {
    this.callCount++;
    return decodeCtxNodes(this.mod.ctxGetNodesByLowerNames(this.handle, [lowerName]))[0] ?? [];
  }
  getNodesByKind(kind: string): Node[] {
    this.callCount++;
    return decodeCtxNodes(this.mod.ctxGetNodesByKind(this.handle, kind))[0] ?? [];
  }
  /** Empty group = the `undefined` miss (queries.getNodeById parity). */
  getNodeById(id: string): Node | undefined {
    this.callCount++;
    const groups = decodeCtxNodes(this.mod.ctxGetNodeById(this.handle, id));
    return groups[0]?.[0];
  }
  /** Batched knownNames membership — the R3c seam for hasAnyPossibleMatch. */
  hasNames(names: string[]): boolean[] {
    this.callCount++;
    return this.mod.ctxHasNames(this.handle, names);
  }

  // --- string/fs getters ---

  getAllFiles(): string[] {
    this.callCount++;
    return (decodeCtxStrings(this.mod.ctxGetAllFiles(this.handle))[0] ?? []).filter(
      (s): s is string => s !== null
    );
  }
  getAllNodeNames(): string[] {
    this.callCount++;
    return (decodeCtxStrings(this.mod.ctxGetAllNodeNames(this.handle))[0] ?? []).filter(
      (s): s is string => s !== null
    );
  }
  /** One absent str row = the readFile `null` outcome (failures cache like TS). */
  readFile(filePath: string): string | null {
    this.callCount++;
    const group = decodeCtxStrings(this.mod.ctxReadFiles(this.handle, [filePath]))[0] ?? [];
    return group.length > 0 ? group[0] : null;
  }
  /** Empty group = unreadable `[]` (NOT lines-cached, TS parity). */
  getFileLines(filePath: string): string[] {
    this.callCount++;
    return (decodeCtxStrings(this.mod.ctxGetFileLines(this.handle, [filePath]))[0] ?? []).filter(
      (s): s is string => s !== null
    );
  }
  fileExists(filePath: string): boolean {
    this.callCount++;
    return this.mod.ctxFileExists(this.handle, [filePath])[0] === true;
  }
  /** Batched fileExists — one crossing for many paths. */
  fileExistsBatch(filePaths: string[]): boolean[] {
    this.callCount++;
    return this.mod.ctxFileExists(this.handle, filePaths);
  }
  /** Lexical order (declared contract semantics; JS readdir order is platform-dependent). */
  listDirectories(relativePath: string): string[] {
    this.callCount++;
    return (decodeCtxStrings(this.mod.ctxListDirectories(this.handle, [relativePath]))[0] ?? []).filter(
      (s): s is string => s !== null
    );
  }

  // --- import analysis getters ---

  getImportMappings(filePath: string, language: Language): ImportMapping[] {
    this.callCount++;
    return decodeCtxImportMappings(this.mod.ctxGetImportMappings(this.handle, [filePath], [language]))[0] ?? [];
  }
  getReExports(filePath: string, language: Language): ReExport[] {
    this.callCount++;
    return decodeCtxReExports(this.mod.ctxGetReExports(this.handle, [filePath], [language]))[0] ?? [];
  }

  getProjectRoot(): string {
    this.callCount++;
    return this.mod.ctxGetProjectRoot(this.handle);
  }
}
