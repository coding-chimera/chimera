/**
 * Decode the kernel's flat buffers into an ExtractionResult — the single
 * JS-side pass over the per-file tables. See layout.ts for the byte layout
 * and codegraph-kernel/src/buffers.rs for the writer.
 *
 * Fork adaptations (P0-2a, relaxed by the P1 subset batch) vs upstream
 * src/extraction/kernel/decode.ts:
 * - Kind tables default to the fork contract (NODE_KINDS in src/graph/types.ts,
 *   EDGE_KINDS in ./layout.ts), but `nodeKinds`/`edgeKinds` are OPTIONAL
 *   overrides carrying the kernel binary's OWN wire tables
 *   (loader.kernelWireTables(), captured from contractInfo() at verify time).
 *   The contract gate is a NAME-based subset check (kernel ⊆ fork), not an
 *   index-equality one — so wire rows are ALWAYS decoded through the
 *   kernel's own tables at production call sites; the fork tables only serve
 *   the subset check and tests that build synthetic fork-indexed buffers.
 * - FUNCTION_REF_CODE (200) rows are DROPPED: the fork's
 *   UnresolvedReference.referenceKind is EdgeKind, which has no 'function_ref'
 *   member (upstream ReferenceKind does). Re-enabling them needs a fork
 *   types.ts decision (plan §5 item F) — reported, not smuggled in here.
 */

import type {
  Edge,
  EdgeKind,
  ExtractionError,
  ExtractionResult,
  Language,
  Node,
  NodeKind,
  UnresolvedReference,
} from '../../types';
import { NODE_KINDS } from '../../types';
import type { KernelBuffers } from './loader';
import {
  EDGE,
  EDGE_KINDS,
  EDGE_ROW_SIZE,
  FLAG,
  FUNCTION_REF_CODE,
  KERNEL_ABI_VERSION,
  META,
  META_SIZE,
  NODE,
  NODE_ROW_SIZE,
  NONE,
  PROVENANCES,
  REF,
  REF_FLAG_FILE_PATH,
  REF_ROW_SIZE,
  VISIBILITIES,
} from './layout';

/** Read an (offset, len) arena string; undefined when absent. */
function str(arena: Buffer, row: Buffer, at: number): string | undefined {
  const off = row.readUInt32LE(at);
  if (off === NONE) return undefined;
  const len = row.readUInt32LE(at + 4);
  return arena.toString('utf8', off, off + len);
}

/** NUL-joined list field; undefined when absent. */
function strList(arena: Buffer, row: Buffer, at: number): string[] | undefined {
  const joined = str(arena, row, at);
  return joined === undefined ? undefined : joined.split('\0');
}

/** Tri-state boolean from a (present, value) bit pair. */
function flag(flags: number, pair: number): boolean | undefined {
  if ((flags & (1 << (pair * 2))) === 0) return undefined;
  return (flags & (1 << (pair * 2 + 1))) !== 0;
}

function u32opt(row: Buffer, at: number): number | undefined {
  const v = row.readUInt32LE(at);
  return v === NONE ? undefined : v;
}

export function decodeExtractBuffers(
  buffers: KernelBuffers,
  filePath: string,
  language: Language,
  nodeKinds: readonly string[] = NODE_KINDS,
  edgeKinds: readonly string[] = EDGE_KINDS
): ExtractionResult {
  const { meta, arena } = buffers;
  if (meta.length < META_SIZE) throw new Error(`kernel meta too short: ${meta.length}`);
  const version = meta.readUInt8(META.version);
  if (version !== KERNEL_ABI_VERSION) {
    throw new Error(`kernel buffer ABI ${version} != expected ${KERNEL_ABI_VERSION}`);
  }
  const nodeCount = meta.readUInt32LE(META.nodeCount);
  const edgeCount = meta.readUInt32LE(META.edgeCount);
  const refCount = meta.readUInt32LE(META.refCount);

  const now = Date.now();
  const nodes: Node[] = new Array(nodeCount);
  // Node-table row index → node id, for edge/ref endpoint resolution.
  const idByRow: string[] = new Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    const row = buffers.nodes.subarray(i * NODE_ROW_SIZE, (i + 1) * NODE_ROW_SIZE);
    const id = str(arena, row, NODE.id)!;
    idByRow[i] = id;
    const flags = row.readUInt16LE(NODE.flags);
    const node: Node = {
      id,
      kind: nodeKinds[row.readUInt8(NODE.kind)] as NodeKind,
      name: str(arena, row, NODE.name)!,
      qualifiedName: str(arena, row, NODE.qualifiedName)!,
      filePath,
      language,
      startLine: row.readUInt32LE(NODE.startLine),
      endLine: row.readUInt32LE(NODE.endLine),
      startColumn: row.readUInt32LE(NODE.startColumn),
      endColumn: row.readUInt32LE(NODE.endColumn),
      updatedAt: now,
    };
    const docstring = str(arena, row, NODE.docstring);
    if (docstring !== undefined) node.docstring = docstring;
    const signature = str(arena, row, NODE.signature);
    if (signature !== undefined) node.signature = signature;
    const visibility = VISIBILITIES[row.readUInt8(NODE.visibility)];
    if (visibility !== undefined) node.visibility = visibility;
    const isExported = flag(flags, FLAG.isExported);
    if (isExported !== undefined) node.isExported = isExported;
    const isAsync = flag(flags, FLAG.isAsync);
    if (isAsync !== undefined) node.isAsync = isAsync;
    const isStatic = flag(flags, FLAG.isStatic);
    if (isStatic !== undefined) node.isStatic = isStatic;
    const isAbstract = flag(flags, FLAG.isAbstract);
    if (isAbstract !== undefined) node.isAbstract = isAbstract;
    const decorators = strList(arena, row, NODE.decorators);
    if (decorators !== undefined) node.decorators = decorators;
    const typeParameters = strList(arena, row, NODE.typeParameters);
    if (typeParameters !== undefined) node.typeParameters = typeParameters;
    const returnType = str(arena, row, NODE.returnType);
    if (returnType !== undefined) node.returnType = returnType;
    const extraJson = str(arena, row, NODE.extraJson);
    if (extraJson !== undefined) Object.assign(node, JSON.parse(extraJson) as Partial<Node>);
    nodes[i] = node;
  }

  const edges: Edge[] = new Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const row = buffers.edges.subarray(i * EDGE_ROW_SIZE, (i + 1) * EDGE_ROW_SIZE);
    const sourceIdx = row.readUInt32LE(EDGE.sourceIdx);
    const targetIdx = row.readUInt32LE(EDGE.targetIdx);
    const edge: Edge = {
      source: sourceIdx === NONE ? str(arena, row, EDGE.sourceIdStr)! : idByRow[sourceIdx]!,
      target: targetIdx === NONE ? str(arena, row, EDGE.targetIdStr)! : idByRow[targetIdx]!,
      kind: edgeKinds[row.readUInt8(EDGE.kind)] as EdgeKind,
    };
    const line = u32opt(row, EDGE.line);
    if (line !== undefined) edge.line = line;
    const column = u32opt(row, EDGE.column);
    if (column !== undefined) edge.column = column;
    const provenance = PROVENANCES[row.readUInt8(EDGE.provenance)];
    if (provenance !== undefined) edge.provenance = provenance;
    const metadataJson = str(arena, row, EDGE.metadataJson);
    if (metadataJson !== undefined) edge.metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    edges[i] = edge;
  }

  const unresolvedReferences: UnresolvedReference[] = [];
  for (let i = 0; i < refCount; i++) {
    const row = buffers.refs.subarray(i * REF_ROW_SIZE, (i + 1) * REF_ROW_SIZE);
    const kindByte = row.readUInt8(REF.kind);
    // Fork adaptation: 'function_ref' (wire code 200, upstream #756) has no
    // fork ReferenceKind — drop the row instead of poisoning the store with an
    // unknown kind string. See the file header; plan §5 item F tracks the
    // types.ts decision that would let these flow through.
    if (kindByte === FUNCTION_REF_CODE) continue;
    const fromIdx = row.readUInt32LE(REF.fromIdx);
    // No filePath/language on ordinary refs: the wasm extractors emit them
    // WITHOUT the denormalized fields (the store fills `ref.filePath ??
    // filePath`), and the kernel must match the extractFromSource seam
    // exactly. The ONE exception is flagged (REF_FLAG_FILE_PATH): the
    // ruby/php visitNode hooks set `filePath: ctx.filePath` on their
    // mixin/trait `implements` refs — re-attach the decode call's own
    // filePath, which is that exact value.
    const ref: UnresolvedReference = {
      fromNodeId: fromIdx === NONE ? str(arena, row, REF.fromIdStr)! : idByRow[fromIdx]!,
      referenceName: str(arena, row, REF.referenceName)!,
      referenceKind: edgeKinds[kindByte] as EdgeKind,
      line: row.readUInt32LE(REF.line),
      column: row.readUInt32LE(REF.column),
    };
    if ((row.readUInt8(REF.flags) & REF_FLAG_FILE_PATH) !== 0) ref.filePath = filePath;
    const candidates = strList(arena, row, REF.candidates);
    if (candidates !== undefined) ref.candidates = candidates;
    unresolvedReferences.push(ref);
  }

  let errors: ExtractionError[] = [];
  const errorsOff = meta.readUInt32LE(META.errorsOff);
  if (errorsOff !== NONE) {
    const errorsLen = meta.readUInt32LE(META.errorsLen);
    errors = JSON.parse(arena.toString('utf8', errorsOff, errorsOff + errorsLen)) as ExtractionError[];
  }

  return { nodes, edges, unresolvedReferences, errors, durationMs: 0 };
}
