/**
 * CTX wire decoders — TS side of codegraph-kernel/src/resolver_ctx.rs
 * (R3b-2). Byte tables per the resolver_ctx.rs module docs; the node row is
 * BYTE-IDENTICAL to the store wire's 140-byte row (store/layout.ts offsets),
 * so the field slots are reused from there — only the READ-side mapping
 * differs (queries.ts rowToNode parity, not the store's insert bindings):
 *
 *   - visibility absent → null (rowToNode passes row.visibility through with
 *     a type cast; null, NOT undefined — deep-equal parity is load-bearing)
 *   - docstring/signature/returnType absent → undefined (`?? undefined`)
 *   - decorators/typeParameters present → safeJsonParse(text, undefined)
 *   - params present → parseParamsJson (compact [{"n","t"}], malformed
 *     entries dropped, empty → undefined)
 *   - updated_at carries the raw DB value; search_text is always NONE and
 *     never mapped (rowToNode doesn't read it)
 *   - booleans fold into the flags byte with STRICT `=== 1` semantics
 */

import type { Language, Node, NodeKind } from '../types';
import { safeJsonParse } from '../utils';
import { NONE, STORE_NODE_ROW_SIZE } from '../store/layout';
import type { CtxImportMappingsOut, CtxNodesOut, CtxReExportsOut, CtxStringsOut } from '../store/loader';
import type { ImportMapping, ReExport } from './types';

/** CTX wire sizes (resolver_ctx.rs CTX_*_SIZE constants). */
const CTX_NODES_HEADER_SIZE = 20;
const CTX_STRINGS_HEADER_SIZE = 16;
const CTX_MAPPINGS_HEADER_SIZE = 20;
const CTX_REEXPORTS_HEADER_SIZE = 20;
const CTX_GROUP_ROW_SIZE = 8;
const CTX_STR_ROW_SIZE = 8;
const CTX_MAPPING_ROW_SIZE = 36;
const CTX_REEXPORT_ROW_SIZE = 28;

/** Mirror of queries.ts parseParamsJson (private there; kept behavior-equal). */
function parseParamsJson(json: string): Node['params'] {
  const entries = safeJsonParse(json, [] as Array<{ n?: unknown; t?: unknown }>);
  const params = entries.flatMap((e) =>
    typeof e.n === 'string' && typeof e.t === 'string' ? [{ name: e.n, type: e.t }] : []
  );
  return params.length > 0 ? params : undefined;
}

function ctxWireErr(msg: string): Error {
  return new Error(`ctx wire: ${msg}`);
}

/** Read an (offset,len) arena string; NONE offset → null. */
function arenaStr(row: Buffer, at: number, arena: Buffer): string | null {
  const off = row.readUInt32LE(at);
  if (off === NONE) return null;
  const len = row.readUInt32LE(at + 4);
  if (off + len > arena.length) throw ctxWireErr(`arena ref ${off}+${len} out of bounds (${arena.length})`);
  return arena.toString('utf8', off, off + len);
}

/**
 * Decode ONE 140-byte node row into the exact object queries.ts rowToNode
 * would build for the same DB row (field order included, for cleanliness —
 * deep-equal ignores it but drift stays visible in snapshots).
 */
function decodeNodeRow(row: Buffer, arena: Buffer): Node {
  const id = arenaStr(row, 0, arena);
  const kind = arenaStr(row, 8, arena);
  const name = arenaStr(row, 16, arena);
  const qualifiedName = arenaStr(row, 24, arena);
  const filePath = arenaStr(row, 32, arena);
  const language = arenaStr(row, 40, arena);
  if (id === null || kind === null || name === null || qualifiedName === null || filePath === null || language === null) {
    throw ctxWireErr('node row with a NULL required column');
  }
  const docstring = arenaStr(row, 64, arena);
  const signature = arenaStr(row, 72, arena);
  const visibility = arenaStr(row, 80, arena);
  const flags = row.readUInt8(88);
  const decoratorsJson = arenaStr(row, 92, arena);
  const typeParametersJson = arenaStr(row, 100, arena);
  const returnType = arenaStr(row, 108, arena);
  const paramsJson = arenaStr(row, 116, arena);
  return {
    id,
    kind: kind as NodeKind,
    name,
    qualifiedName,
    filePath,
    language: language as Language,
    startLine: row.readUInt32LE(48),
    endLine: row.readUInt32LE(52),
    startColumn: row.readUInt32LE(56),
    endColumn: row.readUInt32LE(60),
    docstring: docstring ?? undefined,
    signature: signature ?? undefined,
    returnType: returnType ?? undefined,
    // rowToNode casts the nullable column straight through: NULL stays null.
    visibility: visibility as Node['visibility'],
    isExported: (flags & 1) === 1,
    isAsync: ((flags >>> 1) & 1) === 1,
    isStatic: ((flags >>> 2) & 1) === 1,
    isAbstract: ((flags >>> 3) & 1) === 1,
    decorators: decoratorsJson ? safeJsonParse(decoratorsJson, undefined) : undefined,
    typeParameters: typeParametersJson ? safeJsonParse(typeParametersJson, undefined) : undefined,
    params: paramsJson ? parseParamsJson(paramsJson) : undefined,
    updatedAt: Number(row.readBigInt64LE(132)),
  };
}

function readGroups(groups: Buffer, groupCount: number): Array<[number, number]> {
  if (groups.length < groupCount * CTX_GROUP_ROW_SIZE) {
    throw ctxWireErr(`groups buffer ${groups.length} < ${groupCount} group rows`);
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < groupCount; i++) {
    out.push([groups.readUInt32LE(i * CTX_GROUP_ROW_SIZE), groups.readUInt32LE(i * CTX_GROUP_ROW_SIZE + 4)]);
  }
  return out;
}

/** CtxNodesOut → one Node[] per requested key, REQUEST ORDER. */
export function decodeCtxNodes(out: CtxNodesOut): Node[][] {
  if (out.header.length < CTX_NODES_HEADER_SIZE) throw ctxWireErr('nodes header truncated');
  const groupCount = out.header.readUInt32LE(4);
  const nodeCount = out.header.readUInt32LE(8);
  if (out.nodes.length < nodeCount * STORE_NODE_ROW_SIZE) throw ctxWireErr('nodes buffer truncated');
  const groups = readGroups(out.groups, groupCount);
  return groups.map(([start, end]) => {
    const rows: Node[] = [];
    for (let i = start; i < end && i < nodeCount; i++) {
      rows.push(decodeNodeRow(out.nodes.subarray(i * STORE_NODE_ROW_SIZE, (i + 1) * STORE_NODE_ROW_SIZE), out.arena));
    }
    return rows;
  });
}

/** CtxStringsOut → one (string|null)[] per requested key, REQUEST ORDER.
 *  A NONE str row is the `null` outcome (readFile miss); an EMPTY group is
 *  the `[]` outcome (getFileLines unreadable / listDirectories missing). */
export function decodeCtxStrings(out: CtxStringsOut): Array<Array<string | null>> {
  if (out.header.length < CTX_STRINGS_HEADER_SIZE) throw ctxWireErr('strings header truncated');
  const groupCount = out.header.readUInt32LE(4);
  const strCount = out.header.readUInt32LE(8);
  if (out.strs.length < strCount * CTX_STR_ROW_SIZE) throw ctxWireErr('strs buffer truncated');
  const groups = readGroups(out.groups, groupCount);
  return groups.map(([start, end]) => {
    const rows: Array<string | null> = [];
    for (let i = start; i < end && i < strCount; i++) {
      rows.push(arenaStr(out.strs.subarray(i * CTX_STR_ROW_SIZE, (i + 1) * CTX_STR_ROW_SIZE), 0, out.arena));
    }
    return rows;
  });
}

/** CtxImportMappingsOut → one ImportMapping[] per requested path, REQUEST ORDER. */
export function decodeCtxImportMappings(out: CtxImportMappingsOut): ImportMapping[][] {
  if (out.header.length < CTX_MAPPINGS_HEADER_SIZE) throw ctxWireErr('mappings header truncated');
  const groupCount = out.header.readUInt32LE(4);
  const mappingCount = out.header.readUInt32LE(8);
  if (out.mappings.length < mappingCount * CTX_MAPPING_ROW_SIZE) throw ctxWireErr('mappings buffer truncated');
  const groups = readGroups(out.groups, groupCount);
  return groups.map(([start, end]) => {
    const rows: ImportMapping[] = [];
    for (let i = start; i < end && i < mappingCount; i++) {
      const row = out.mappings.subarray(i * CTX_MAPPING_ROW_SIZE, (i + 1) * CTX_MAPPING_ROW_SIZE);
      const localName = arenaStr(row, 0, out.arena);
      const exportedName = arenaStr(row, 8, out.arena);
      const source = arenaStr(row, 16, out.arena);
      // resolved_path is ALWAYS NONE on the wire (extractImportMappings never
      // sets it; resolveViaImport resolves later, TS-side).
      const resolvedPath = arenaStr(row, 24, out.arena);
      const flags = row.readUInt8(32);
      if (localName === null || exportedName === null || source === null) {
        throw ctxWireErr('mapping row with a NULL required column');
      }
      const mapping: ImportMapping = {
        localName,
        exportedName,
        source,
        isDefault: (flags & 1) === 1,
        isNamespace: ((flags >>> 1) & 1) === 1,
      };
      if (resolvedPath !== null) mapping.resolvedPath = resolvedPath;
      rows.push(mapping);
    }
    return rows;
  });
}

/** CtxReExportsOut → one ReExport[] per requested path, REQUEST ORDER. */
export function decodeCtxReExports(out: CtxReExportsOut): ReExport[][] {
  if (out.header.length < CTX_REEXPORTS_HEADER_SIZE) throw ctxWireErr('reexports header truncated');
  const groupCount = out.header.readUInt32LE(4);
  const reexportCount = out.header.readUInt32LE(8);
  if (out.reexports.length < reexportCount * CTX_REEXPORT_ROW_SIZE) throw ctxWireErr('reexports buffer truncated');
  const groups = readGroups(out.groups, groupCount);
  return groups.map(([start, end]) => {
    const rows: ReExport[] = [];
    for (let i = start; i < end && i < reexportCount; i++) {
      const row = out.reexports.subarray(i * CTX_REEXPORT_ROW_SIZE, (i + 1) * CTX_REEXPORT_ROW_SIZE);
      const kindCode = row.readUInt8(0);
      const source = arenaStr(row, 20, out.arena);
      if (source === null) throw ctxWireErr('reexport row with a NULL source');
      if (kindCode === 2) {
        rows.push({ kind: 'wildcard' as const, source });
        continue;
      }
      if (kindCode !== 1) throw ctxWireErr(`unknown reexport kind code ${kindCode}`);
      const exportedName = arenaStr(row, 4, out.arena);
      const originalName = arenaStr(row, 12, out.arena);
      if (exportedName === null || originalName === null) throw ctxWireErr('named reexport row with a NULL name');
      rows.push({ kind: 'named' as const, exportedName, originalName, source });
    }
    return rows;
  });
}
