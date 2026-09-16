/**
 * Shared helpers for the kernel tests — synthetic five-table buffer builder
 * (byte layout per src/graph/extraction/kernel/layout.ts) and the local
 * prebuild probe.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { NODE_KINDS } from '../../src/graph/types';
import { EDGE_KINDS } from '../../src/graph/extraction/kernel/layout';
import type { KernelBuffers, KernelModule } from '../../src/graph/extraction/kernel/loader';
import {
  EDGE,
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
} from '../../src/graph/extraction/kernel/layout';

/** Repo root from packages/chimera/test/graph/. */
export const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** Path to the locally staged prebuild (may not exist). */
export const prebuildPath = path.join(
  repoRoot,
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);

export function hasPrebuild(): boolean {
  return fs.existsSync(prebuildPath);
}

/** Require the local prebuild directly (bypasses the loader contract gate). */
export function requirePrebuild(): KernelModule {
  return createRequire(import.meta.url)(prebuildPath) as KernelModule;
}

// ---------------------------------------------------------------------------
// Synthetic buffer builder
// ---------------------------------------------------------------------------

export interface SyntheticNode {
  kind: string; // NodeKind name (fork table index resolved here)
  name: string;
  qualifiedName?: string; // defaults to name
  id?: string; // defaults to `${kind}:${qualifiedName}`
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  docstring?: string;
  signature?: string;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
  extraJson?: Record<string, unknown>;
}

export interface SyntheticEdge {
  source: number | string; // node row index, or literal id string (NONE path)
  target: number | string;
  kind: string; // EdgeKind name
  line?: number;
  column?: number;
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';
  metadata?: Record<string, unknown>;
}

export interface SyntheticRef {
  from: number | string; // node row index, or literal fromNodeId string
  kind: string | 'function_ref'; // EdgeKind name, or the wire-code-200 kind
  referenceName: string;
  line?: number;
  column?: number;
  candidates?: string[];
  flagFilePath?: boolean;
}

export function buildKernelBuffers(opts: {
  nodes?: SyntheticNode[];
  edges?: SyntheticEdge[];
  refs?: SyntheticRef[];
  errors?: Array<Record<string, unknown>>;
  abiVersion?: number;
}): KernelBuffers {
  const nodesIn = opts.nodes ?? [];
  const edgesIn = opts.edges ?? [];
  const refsIn = opts.refs ?? [];

  // Single arena: every string is interned (in write order) while the rows
  // are filled; the arena buffer is materialized once at the end.
  const chunks: string[] = [];
  let arenaLen = 0;
  const intern = (s: string): [number, number] => {
    const off = arenaLen;
    const len = Buffer.byteLength(s, 'utf8');
    chunks.push(s);
    arenaLen += len;
    return [off, len];
  };

  const meta = Buffer.alloc(META_SIZE);
  meta.writeUInt8(opts.abiVersion ?? KERNEL_ABI_VERSION, META.version);
  meta.writeUInt32LE(nodesIn.length, META.nodeCount);
  meta.writeUInt32LE(edgesIn.length, META.edgeCount);
  meta.writeUInt32LE(refsIn.length, META.refCount);

  const nodes = Buffer.alloc(nodesIn.length * NODE_ROW_SIZE);
  const edges = Buffer.alloc(edgesIn.length * EDGE_ROW_SIZE);
  const refs = Buffer.alloc(refsIn.length * REF_ROW_SIZE);

  const putStr = (row: Buffer, at: number, s: string | undefined) => {
    if (s === undefined) {
      row.writeUInt32LE(NONE, at);
      row.writeUInt32LE(0, at + 4);
      return;
    }
    const [off, len] = intern(s);
    row.writeUInt32LE(off, at);
    row.writeUInt32LE(len, at + 4);
  };

  const errorsRef = opts.errors ? putStrMeta(JSON.stringify(opts.errors)) : undefined;
  function putStrMeta(s: string): [number, number] {
    return intern(s);
  }

  nodesIn.forEach((n, i) => {
    const row = nodes.subarray(i * NODE_ROW_SIZE, (i + 1) * NODE_ROW_SIZE);
    const kindIdx = (NODE_KINDS as readonly string[]).indexOf(n.kind);
    if (kindIdx < 0) throw new Error(`synthetic builder: unknown node kind ${n.kind}`);
    row.writeUInt8(kindIdx, NODE.kind);
    row.writeUInt8(n.visibility ? VISIBILITIES.indexOf(n.visibility) : 0, NODE.visibility);
    let flags = 0;
    const setFlag = (pair: number, v: boolean | undefined) => {
      if (v === undefined) return;
      flags |= 1 << (pair * 2);
      if (v) flags |= 1 << (pair * 2 + 1);
    };
    setFlag(FLAG.isExported, n.isExported);
    setFlag(FLAG.isAsync, n.isAsync);
    setFlag(FLAG.isStatic, n.isStatic);
    setFlag(FLAG.isAbstract, n.isAbstract);
    row.writeUInt16LE(flags, NODE.flags);
    row.writeUInt32LE(n.startLine ?? 1, NODE.startLine);
    row.writeUInt32LE(n.endLine ?? n.startLine ?? 1, NODE.endLine);
    row.writeUInt32LE(n.startColumn ?? 0, NODE.startColumn);
    row.writeUInt32LE(n.endColumn ?? 0, NODE.endColumn);
    const qn = n.qualifiedName ?? n.name;
    putStr(row, NODE.name, n.name);
    putStr(row, NODE.qualifiedName, qn);
    putStr(row, NODE.id, n.id ?? `${n.kind}:${qn}`);
    putStr(row, NODE.docstring, n.docstring);
    putStr(row, NODE.signature, n.signature);
    putStr(row, NODE.decorators, n.decorators?.join('\0'));
    putStr(row, NODE.typeParameters, n.typeParameters?.join('\0'));
    putStr(row, NODE.returnType, n.returnType);
    putStr(row, NODE.extraJson, n.extraJson !== undefined ? JSON.stringify(n.extraJson) : undefined);
    row.writeUInt32LE(NONE, NODE.metrics);
  });

  edgesIn.forEach((e, i) => {
    const row = edges.subarray(i * EDGE_ROW_SIZE, (i + 1) * EDGE_ROW_SIZE);
    const kindIdx = (EDGE_KINDS as readonly string[]).indexOf(e.kind);
    if (kindIdx < 0) throw new Error(`synthetic builder: unknown edge kind ${e.kind}`);
    if (typeof e.source === 'number') {
      row.writeUInt32LE(e.source, EDGE.sourceIdx);
      row.writeUInt32LE(NONE, EDGE.sourceIdStr);
      row.writeUInt32LE(0, EDGE.sourceIdStr + 4);
    } else {
      row.writeUInt32LE(NONE, EDGE.sourceIdx);
      putStr(row, EDGE.sourceIdStr, e.source);
    }
    if (typeof e.target === 'number') {
      row.writeUInt32LE(e.target, EDGE.targetIdx);
      row.writeUInt32LE(NONE, EDGE.targetIdStr);
      row.writeUInt32LE(0, EDGE.targetIdStr + 4);
    } else {
      row.writeUInt32LE(NONE, EDGE.targetIdx);
      putStr(row, EDGE.targetIdStr, e.target);
    }
    row.writeUInt8(kindIdx, EDGE.kind);
    row.writeUInt8(e.provenance ? PROVENANCES.indexOf(e.provenance) : 0, EDGE.provenance);
    row.writeUInt32LE(e.line ?? NONE, EDGE.line);
    row.writeUInt32LE(e.column ?? NONE, EDGE.column);
    putStr(row, EDGE.metadataJson, e.metadata !== undefined ? JSON.stringify(e.metadata) : undefined);
  });

  refsIn.forEach((r, i) => {
    const row = refs.subarray(i * REF_ROW_SIZE, (i + 1) * REF_ROW_SIZE);
    if (typeof r.from === 'number') {
      row.writeUInt32LE(r.from, REF.fromIdx);
      row.writeUInt32LE(NONE, REF.fromIdStr);
      row.writeUInt32LE(0, REF.fromIdStr + 4);
    } else {
      row.writeUInt32LE(NONE, REF.fromIdx);
      putStr(row, REF.fromIdStr, r.from);
    }
    row.writeUInt8(
      r.kind === 'function_ref' ? FUNCTION_REF_CODE : (EDGE_KINDS as readonly string[]).indexOf(r.kind),
      REF.kind
    );
    row.writeUInt8(r.flagFilePath ? REF_FLAG_FILE_PATH : 0, REF.flags);
    row.writeUInt32LE(r.line ?? 1, REF.line);
    row.writeUInt32LE(r.column ?? 0, REF.column);
    putStr(row, REF.referenceName, r.referenceName);
    putStr(row, REF.candidates, r.candidates?.join('\0'));
  });

  const arena = Buffer.from(chunks.join(''), 'utf8');
  meta.writeUInt32LE(arena.length, META.arenaLen);
  if (errorsRef) {
    meta.writeUInt32LE(errorsRef[0], META.errorsOff);
    meta.writeUInt32LE(errorsRef[1], META.errorsLen);
  } else {
    meta.writeUInt32LE(NONE, META.errorsOff);
    meta.writeUInt32LE(0, META.errorsLen);
  }
  meta.writeDoubleLE(0, META.durationMs);

  return { meta, nodes, edges, refs, arena };
}
