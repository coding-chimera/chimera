/**
 * R3a store-bridge tests — loader contract gate, kill switch (both states),
 * silent TS fallback, encoder↔decoder roundtrip against the REAL Rust store,
 * op fusion shapes, resurrect/re-attach through the production QueryBuilder
 * seam, and dual-connection (rusqlite + bun:sqlite on one WAL file) coexistence.
 *
 * Tests that need the native module run against the locally staged prebuild
 * (codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node — the
 * K-v2 campaign precedent: build artifacts are loadable by bun tests) and
 * skip when it is absent or pre-R3a (no store exports). Fallback/kill-switch
 * tests use fake StoreModules and run everywhere.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';
import type { Edge, FileRecord, Node, UnresolvedReference } from '../../src/graph/types';
import {
  getStoreModule,
  resetStoreForTests,
  setStoreModuleForTests,
  storeEnabled,
  verifyStoreContract,
  type StoreModule,
} from '../../src/graph/store/loader';
import { StoreBridge, planStoreFusion, type RecordedOp } from '../../src/graph/store/bridge';
import { StoreBuffersBuilder } from '../../src/graph/store/encoder';
import { STORE_ABI_VERSION } from '../../src/graph/store/layout';
import { buildSearchText } from '../../src/graph/search/query-utils';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const prebuildPath = path.join(
  repoRoot,
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);

/** True when the locally staged prebuild exists AND carries the R3a store exports. */
const storePrebuildAvailable = (() => {
  if (!fs.existsSync(prebuildPath)) return false;
  try {
    const mod = createRequire(import.meta.url)(prebuildPath) as Partial<StoreModule>;
    return typeof mod.storeContractInfo === 'function' && typeof mod.storeOpen === 'function';
  } catch {
    return false;
  }
})();

const nativeDescribe = describe.skipIf(!storePrebuildAvailable);
const nativeIt = it.skipIf(!storePrebuildAvailable);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function node(overrides: Partial<Node> & { id: string; name: string }): Node {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1700000000000,
    ...overrides,
  } as Node;
}

function fileRecord(overrides: Partial<FileRecord> & { path: string }): FileRecord {
  return {
    contentHash: 'h1',
    language: 'typescript',
    size: 10,
    modifiedAt: 1000.5,
    indexedAt: 1700000000000,
    nodeCount: 1,
    ...overrides,
  } as FileRecord;
}

interface Ctx {
  dir: string;
  dbPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
}

function makeCtx(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-bridge-'));
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  return { dir, dbPath, conn, queries: new QueryBuilder(conn.getDb()) };
}

function disposeCtx(ctx: Ctx): void {
  try {
    ctx.conn.close();
  } catch {
    // ignore
  }
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

/** Deterministic four-table dump (timing columns normalized to 0). */
function dumpTables(conn: DatabaseConnection): Record<string, unknown[]> {
  const db = conn.getDb();
  return {
    nodes: db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
                start_column, end_column, docstring, signature, visibility,
                is_exported, is_async, is_static, is_abstract, decorators, type_parameters,
                return_type, params_json, search_text, 0 AS updated_at
         FROM nodes ORDER BY id`
      )
      .all(),
    edges: db
      .prepare(
        `SELECT id, source, target, kind, metadata, line, col, provenance FROM edges
         ORDER BY id, source, target, kind`
      )
      .all(),
    refs: db
      .prepare(
        `SELECT id, from_node_id, reference_name, reference_kind, line, col, candidates,
                file_path, language, status, name_tail FROM unresolved_refs ORDER BY id`
      )
      .all(),
    files: db
      .prepare(
        `SELECT path, content_hash, language, size, modified_at, 0 AS indexed_at, node_count, errors
         FROM files ORDER BY path`
      )
      .all(),
  };
}

/** The rich object graph both arms write in the roundtrip test. */
function richNodeSet(): { nodes: Node[]; edges: Edge[]; refs: UnresolvedReference[]; file: FileRecord } {
  const nodes: Node[] = [
    node({
      id: 'file:a.ts',
      kind: 'file',
      name: 'a.ts',
      qualifiedName: 'a.ts',
      startLine: 0,
      endLine: 0,
      isExported: true,
    }),
    node({
      id: 'function:a:1',
      name: 'calculateTotal',
      qualifiedName: 'mod.calculateTotal',
      startLine: 3,
      endLine: 9,
      startColumn: 2,
      endColumn: 14,
      docstring: 'Totals things.',
      signature: 'calculateTotal(a: number, b: number): number',
      visibility: 'public',
      isExported: true,
      isAsync: false,
      isStatic: true,
      isAbstract: false,
      decorators: ['deprecated', 'logged'],
      typeParameters: ['T extends number'],
      returnType: 'number',
      params: [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'Queue<T>' },
      ],
      updatedAt: 1700000000123,
    }),
    // Invalid row (empty name) — both arms must skip it identically.
    node({ id: 'function:bad', name: '', updatedAt: 1700000000123 }),
  ];
  const edges: Edge[] = [
    {
      source: 'file:a.ts',
      target: 'function:a:1',
      kind: 'contains',
      line: 3,
      column: 0,
      provenance: 'tree-sitter',
    },
    {
      source: 'function:a:1',
      target: 'file:a.ts',
      kind: 'references',
      metadata: { refName: 'mod.calculateTotal', refKind: 'calls', score: 0.5 },
      line: 4,
      column: 2,
      provenance: 'heuristic',
    },
    // Dangling target — both arms drop it via the endpoint filter.
    { source: 'function:a:1', target: 'function:ghost', kind: 'calls' },
  ];
  const refs: UnresolvedReference[] = [
    {
      fromNodeId: 'function:a:1',
      referenceName: 'util.greet',
      referenceKind: 'calls',
      line: 5,
      column: 4,
      candidates: ['util.greet', 'other.greet'],
      filePath: 'a.ts',
      language: 'typescript',
    },
  ];
  const file = fileRecord({
    path: 'a.ts',
    nodeCount: 3, // PRE-validity-filter count (result.nodes.length contract)
    errors: [{ message: 'partial parse', severity: 'warning' as const, code: 'x1' }],
  });
  return { nodes, edges, refs, file };
}

let envStore: string | undefined;
beforeEach(() => {
  envStore = process.env.CODEGRAPH_STORE;
  delete process.env.CODEGRAPH_STORE;
});
afterEach(() => {
  if (envStore === undefined) delete process.env.CODEGRAPH_STORE;
  else process.env.CODEGRAPH_STORE = envStore;
  setStoreModuleForTests(null);
  resetStoreForTests();
});

// ---------------------------------------------------------------------------
// Loader / contract verification
// ---------------------------------------------------------------------------

describe('verifyStoreContract', () => {
  nativeIt('accepts the real module contract (abi equality + kind subset)', () => {
    const mod = getStoreModule();
    expect(mod).not.toBeNull();
    const info = mod!.storeContractInfo();
    expect(info.abiVersion).toBe(STORE_ABI_VERSION);
    expect(verifyStoreContract(info)).toBe(true);
  });

  it('rejects an ABI mismatch (equality, not ordering)', () => {
    expect(
      verifyStoreContract({ abiVersion: STORE_ABI_VERSION + 1, storeVersion: 'x', nodeKinds: [], edgeKinds: [] })
    ).toBe(false);
    expect(
      verifyStoreContract({ abiVersion: 0, storeVersion: 'x', nodeKinds: [], edgeKinds: [] })
    ).toBe(false);
  });

  it('rejects kernel-only kinds (kernel ⊆ fork direction is fixed)', () => {
    expect(
      verifyStoreContract({
        abiVersion: STORE_ABI_VERSION,
        storeVersion: 'x',
        nodeKinds: ['function', 'smuggled-kind'],
        edgeKinds: ['calls'],
      })
    ).toBe(false);
    expect(
      verifyStoreContract({
        abiVersion: STORE_ABI_VERSION,
        storeVersion: 'x',
        nodeKinds: ['function'],
        edgeKinds: ['calls', 'future-edge'],
      })
    ).toBe(false);
  });

  it('accepts a strict subset (fork-only kinds are legal divergence)', () => {
    expect(
      verifyStoreContract({ abiVersion: STORE_ABI_VERSION, storeVersion: 'x', nodeKinds: ['function'], edgeKinds: [] })
    ).toBe(true);
  });
});

describe('store loader degradation', () => {
  it('returns null for a garbage CODEGRAPH_STORE_PATH and never throws', () => {
    const garbage = path.join(os.tmpdir(), `cg-store-garbage-${process.pid}.node`);
    fs.writeFileSync(garbage, 'not an addon');
    const prev = process.env.CODEGRAPH_STORE_PATH;
    process.env.CODEGRAPH_STORE_PATH = garbage;
    resetStoreForTests();
    try {
      // The garbage candidate fails dlopen; search falls through to the other
      // candidates — with the prebuild staged the module still resolves, so
      // assert only the no-throw + shape contract here.
      const mod = getStoreModule();
      expect(mod === null || typeof mod.storeContractInfo === 'function').toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_STORE_PATH;
      else process.env.CODEGRAPH_STORE_PATH = prev;
      fs.rmSync(garbage, { force: true });
      resetStoreForTests();
    }
  });

  it('setStoreModuleForTests installs a fake module verbatim', () => {
    const fake = { storeContractInfo: () => ({ abiVersion: 1, storeVersion: 'fake', nodeKinds: [], edgeKinds: [] }) } as unknown as StoreModule;
    setStoreModuleForTests(fake);
    expect(getStoreModule()).toBe(fake);
    setStoreModuleForTests(null);
    expect(getStoreModule()).not.toBe(fake);
    resetStoreForTests();
  });
});

describe('CODEGRAPH_STORE kill switch (per-call, both states)', () => {
  nativeIt('storeEnabled flips with the env at call time', () => {
    expect(storeEnabled()).toBe(true);
    process.env.CODEGRAPH_STORE = '0';
    expect(storeEnabled()).toBe(false);
    delete process.env.CODEGRAPH_STORE;
    expect(storeEnabled()).toBe(true);
  });

  nativeIt('StoreBridge.open returns null while the kill switch is on', () => {
    const ctx = makeCtx();
    try {
      process.env.CODEGRAPH_STORE = '0';
      expect(StoreBridge.open(ctx.dbPath)).toBeNull();
      delete process.env.CODEGRAPH_STORE;
      const bridge = StoreBridge.open(ctx.dbPath);
      expect(bridge).not.toBeNull();
      // live() re-checks per call: flipping the env disables routing on an
      // ALREADY-OPEN bridge, flipping back re-enables it.
      expect(bridge!.live()).toBe(true);
      process.env.CODEGRAPH_STORE = '0';
      expect(bridge!.live()).toBe(false);
      delete process.env.CODEGRAPH_STORE;
      expect(bridge!.live()).toBe(true);
    } finally {
      disposeCtx(ctx);
    }
  });

  nativeIt('routes writes to TS while the kill switch is on, native after', () => {
    const ctx = makeCtx();
    try {
      const bridge = StoreBridge.open(ctx.dbPath)!;
      expect(bridge).not.toBeNull();
      ctx.queries.attachStore(bridge);

      process.env.CODEGRAPH_STORE = '0';
      ctx.queries.insertNodes([node({ id: 'function:ts-arm', name: 'tsArm' })]);
      expect(bridge.commitCount).toBe(0);
      expect(ctx.queries.getNodeById('function:ts-arm')).not.toBeNull();

      delete process.env.CODEGRAPH_STORE;
      ctx.queries.insertNodes([node({ id: 'function:native-arm', name: 'nativeArm' })]);
      expect(bridge.commitCount).toBe(1);
      expect(ctx.queries.getNodeById('function:native-arm')).not.toBeNull();
      // kill switch 关 = 行为字节不变: the TS-written row reads back identically.
      expect(ctx.queries.getNodeById('function:ts-arm')?.name).toBe('tsArm');
    } finally {
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback discipline
// ---------------------------------------------------------------------------

describe('silent TS fallback', () => {
  nativeIt('store_open on an uninitialized DB degrades to null (no bridge, no throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-bare-'));
    const bare = path.join(dir, 'bare.db');
    fs.writeFileSync(bare, '');
    try {
      expect(StoreBridge.open(bare)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function fakeModule(commitError: Error): { mod: StoreModule; calls: number } {
    const state = { mod: null as unknown as StoreModule, calls: 0 };
    state.mod = {
      storeContractInfo: () => ({ abiVersion: STORE_ABI_VERSION, storeVersion: 'fake', nodeKinds: [], edgeKinds: [] }),
      storeOpen: () => ({}),
      storeCommitBatch: () => {
        state.calls++;
        throw commitError;
      },
    } as unknown as StoreModule;
    return state;
  }

  it('a wire-shaped commit failure falls back to TS AND disables the bridge (sticky)', () => {
    const ctx = makeCtx();
    try {
      const fake = fakeModule(new Error('store wire: abi 9 != STORE_ABI_VERSION 1'));
      setStoreModuleForTests(fake.mod);
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);

      const nodes = [node({ id: 'function:fb1', name: 'fb1' })];
      ctx.queries.insertNodes(nodes); // throws inside → handleStoreFailure → TS body
      expect(bridge.isDisabled).toBe(true);
      expect(ctx.queries.getNodeById('function:fb1')).not.toBeNull();

      // Sticky: subsequent writes take the TS arm without touching the bridge.
      const callsBefore = fake.calls;
      ctx.queries.insertNodes([node({ id: 'function:fb2', name: 'fb2' })]);
      expect(fake.calls).toBe(callsBefore);
      expect(ctx.queries.getNodeById('function:fb2')).not.toBeNull();
    } finally {
      disposeCtx(ctx);
    }
  });

  it('a SQL-shaped commit failure falls back to TS but keeps the bridge live (BUSY posture)', () => {
    const ctx = makeCtx();
    try {
      const fake = fakeModule(new Error('store sql: SQLITE_BUSY: database is locked'));
      setStoreModuleForTests(fake.mod);
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);

      ctx.queries.insertNodes([node({ id: 'function:busy1', name: 'busy1' })]);
      expect(bridge.isDisabled).toBe(false);
      expect(bridge.live()).toBe(true);
      expect(ctx.queries.getNodeById('function:busy1')).not.toBeNull();
    } finally {
      disposeCtx(ctx);
    }
  });

  nativeIt('an uncovered write inside a recorded transaction downgrades the WHOLE unit to TS', () => {
    const ctx = makeCtx();
    try {
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);
      ctx.queries.insertNodes([node({ id: 'function:keep', name: 'keep' })]);
      const commitsBefore = bridge.commitCount;

      ctx.queries.transaction(() => {
        ctx.queries.insertNodes([node({ id: 'function:in-txn', name: 'inTxn' })]);
        // deleteNode is uncovered → abort native recording, re-run on TS.
        ctx.queries.deleteNode('function:keep');
      });

      expect(bridge.commitCount).toBe(commitsBefore); // nothing flushed natively
      expect(ctx.queries.getNodeById('function:in-txn')).not.toBeNull(); // replayed on TS
      expect(ctx.queries.getNodeById('function:keep')).toBeNull(); // delete honored
    } finally {
      disposeCtx(ctx);
    }
  });

  it('a recorded-transaction flush failure replays the log on TS atomically', () => {
    const ctx = makeCtx();
    try {
      const fake = fakeModule(new Error('store sql: disk I/O error'));
      setStoreModuleForTests(fake.mod);
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);

      ctx.queries.transaction(() => {
        ctx.queries.insertNodes([node({ id: 'function:rep1', name: 'rep1' })]);
        ctx.queries.upsertFile(fileRecord({ path: 'a.ts' }));
      });

      // Flush failed → TS replay wrote everything (bridge stays live: SQL error).
      expect(bridge.isDisabled).toBe(false);
      expect(ctx.queries.getNodeById('function:rep1')).not.toBeNull();
      expect(ctx.queries.getFileByPath('a.ts')).not.toBeNull();
    } finally {
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Encoder ↔ Rust decoder roundtrip (dual-arm byte equality)
// ---------------------------------------------------------------------------

nativeDescribe('encoder roundtrip — native arm vs TS arm write identical rows', () => {
  it('four-table dumps are deep-equal across arms for a rich object graph', () => {
    const tsCtx = makeCtx();
    const nativeCtx = makeCtx();
    try {
      const bridge = StoreBridge.open(nativeCtx.dbPath)!;
      expect(bridge).not.toBeNull();
      nativeCtx.queries.attachStore(bridge);
      const { nodes, edges, refs, file } = richNodeSet();

      // TS arm: the untouched QueryBuilder implementations.
      tsCtx.queries.transaction(() => {
        tsCtx.queries.insertNodes(nodes.map((n) => ({ ...n })));
        tsCtx.queries.insertEdges(edges.map((e) => ({ ...e })));
        tsCtx.queries.insertUnresolvedRefsBatch(refs.map((r) => ({ ...r })));
        tsCtx.queries.upsertFile({ ...file });
      });

      // Native arm: the same calls, routed through the bridge (the outer
      // transaction records + flushes as ONE store_commit_batch).
      nativeCtx.queries.transaction(() => {
        nativeCtx.queries.insertNodes(nodes.map((n) => ({ ...n })));
        nativeCtx.queries.insertEdges(edges.map((e) => ({ ...e })));
        nativeCtx.queries.insertUnresolvedRefsBatch(refs.map((r) => ({ ...r })));
        nativeCtx.queries.upsertFile({ ...file });
      });
      expect(bridge.commitCount).toBe(1);

      expect(dumpTables(nativeCtx.conn)).toEqual(dumpTables(tsCtx.conn));
    } finally {
      disposeCtx(tsCtx);
      disposeCtx(nativeCtx);
    }
  });

  nativeIt('encoder-derived fields match the TS bindings exactly (search_text, params_json, decorators)', () => {
    const ctx = makeCtx();
    try {
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);
      const n = node({
        id: 'function:derived',
        name: 'calculateTotal',
        qualifiedName: 'mod.calculateTotal',
        params: [{ name: 'a', type: 'number' }],
        decorators: ['dep'],
        typeParameters: ['T'],
      });
      ctx.queries.insertNodes([n]);
      const row = ctx.conn
        .getDb()
        .prepare('SELECT search_text, params_json, decorators, type_parameters, qualified_name FROM nodes WHERE id = ?')
        .get('function:derived') as Record<string, unknown>;
      expect(row.search_text).toBe(buildSearchText('calculateTotal', 'mod.calculateTotal'));
      expect(row.params_json).toBe(JSON.stringify([{ n: 'a', t: 'number' }]));
      expect(row.decorators).toBe(JSON.stringify(['dep']));
      expect(row.type_parameters).toBe(JSON.stringify(['T']));
      expect(row.qualified_name).toBe('mod.calculateTotal');
    } finally {
      disposeCtx(ctx);
    }
  });

  nativeIt('ref-lifecycle ops roundtrip: delete-by-ids counts and markReferencesFailed name_tail', () => {
    const ctx = makeCtx();
    try {
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);
      ctx.queries.insertNodes([node({ id: 'function:n1', name: 'n1' })]);
      ctx.queries.insertUnresolvedRefsBatch([
        { fromNodeId: 'function:n1', referenceName: 'util.greet', referenceKind: 'calls', line: 2, column: 0 },
        { fromNodeId: 'function:n1', referenceName: 'other', referenceKind: 'references', line: 3, column: 0 },
      ]);
      const ids = ctx.queries
        .getUnresolvedReferences()
        .map((r) => r.id!)
        .sort((a, b) => a - b);

      const deleted = ctx.queries.deleteUnresolvedReferencesByIds([ids[0], ids[0]]); // dedup parity
      expect(deleted).toBe(1);

      ctx.queries.markReferencesFailed([
        { fromNodeId: 'function:n1', referenceName: 'other', referenceKind: 'references' },
      ]);
      const row = ctx.conn
        .getDb()
        .prepare('SELECT status, name_tail FROM unresolved_refs WHERE reference_name = ?')
        .get('other') as Record<string, unknown>;
      expect(row.status).toBe('failed');
      expect(row.name_tail).toBe('other');

      const removed = ctx.queries.deleteSpecificResolvedReferences([
        { fromNodeId: 'function:n1', referenceName: 'other', referenceKind: 'references' },
      ]);
      expect(removed).toBe(1);
      expect(ctx.queries.getUnresolvedReferences().length).toBe(0);
    } finally {
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Op fusion (pure shape validation)
// ---------------------------------------------------------------------------

describe('planStoreFusion — canonical shapes only', () => {
  const n = node({ id: 'function:a:1', name: 'a', filePath: 'a.ts' });
  const f = fileRecord({ path: 'a.ts' });
  const ins = { kind: 'insertNodes', nodes: [n] } as RecordedOp;
  const insEdges = { kind: 'insertEdges', edges: [] } as RecordedOp;
  const insRefs = { kind: 'insertRefs', refs: [] } as RecordedOp;
  const del = { kind: 'deleteFile', path: 'a.ts' } as RecordedOp;
  const ups = { kind: 'upsertFile', file: f } as RecordedOp;

  it('fuses the storeExtractionResultTxn shape (with and without delete/reattach ops)', () => {
    expect(planStoreFusion([del, ins, insEdges, insRefs, insEdges, insRefs, ups])).toEqual({
      kind: 'storeFileResult',
      file: f,
    });
    expect(planStoreFusion([ins, ups]).kind).toBe('storeFileResult');
    expect(planStoreFusion([del, ups]).kind).toBe('storeFileResult');
    expect(planStoreFusion([ins, insEdges, ups]).kind).toBe('storeFileResult');
  });

  it('fuses the removeFileResurrectingRefs shape into deleteFileResurrect', () => {
    expect(planStoreFusion([insRefs, del])).toEqual({ kind: 'deleteFileResurrect', path: 'a.ts' });
  });

  it('keeps everything else raw', () => {
    // A lone deleteFile is the PLAIN cascade — never resurrect-fused.
    expect(planStoreFusion([del]).kind).toBe('raw');
    expect(planStoreFusion([ups]).kind).toBe('raw');
    expect(planStoreFusion([]).kind).toBe('raw');
    // deleteFile path ≠ upsertFile path
    expect(planStoreFusion([{ kind: 'deleteFile', path: 'b.ts' }, ins, ups]).kind).toBe('raw');
    // nodes from another file
    expect(
      planStoreFusion([{ kind: 'insertNodes', nodes: [{ ...n, filePath: 'other.ts' }] }, ups]).kind
    ).toBe('raw');
    // wrong order: edges before nodes
    expect(planStoreFusion([insEdges, ins, ups]).kind).toBe('raw');
    // too many edge ops
    expect(planStoreFusion([ins, insEdges, insEdges, insEdges, ups]).kind).toBe('raw');
    // trailing op after upsertFile
    expect(planStoreFusion([ins, ups, insEdges]).kind).toBe('raw');
    // value ops never fuse
    expect(planStoreFusion([{ kind: 'deleteUnresolvedByIds', ids: [1] }]).kind).toBe('raw');
  });
});

// ---------------------------------------------------------------------------
// Resurrect / re-attach through the production seam (OP_STORE_FILE_RESULT)
// ---------------------------------------------------------------------------

nativeDescribe('fused OP_STORE_FILE_RESULT resurrect semantics (native arm)', () => {
  /** Store one file the way storeExtractionResultTxn does. */
  function storeFile(ctx: Ctx, filePath: string, hash: string, nodes: Node[]): void {
    ctx.queries.transaction(() => {
      const existing = ctx.queries.getFileByPath(filePath);
      if (existing) ctx.queries.deleteFile(filePath);
      if (nodes.length > 0) ctx.queries.insertNodes(nodes);
      ctx.queries.upsertFile(
        fileRecord({ path: filePath, contentHash: hash, nodeCount: nodes.length, indexedAt: 1700000000000 })
      );
    });
  }

  it('rename → resurrect as original pending ref; line shift with name kept → re-attach', () => {
    const ctx = makeCtx();
    try {
      const bridge = StoreBridge.open(ctx.dbPath)!;
      ctx.queries.attachStore(bridge);

      // a.ts v1 + a stamped resolution-era edge from caller.ts.
      storeFile(ctx, 'a.ts', 'h1', [node({ id: 'function:a:1', name: 'hello', startLine: 1 })]);
      ctx.queries.insertNodes([node({ id: 'function:caller', name: 'caller', filePath: 'caller.ts' })]);
      ctx.queries.insertEdges([
        {
          source: 'function:caller',
          target: 'function:a:1',
          kind: 'calls',
          metadata: { refName: 'mod.hello', refKind: 'calls' },
          line: 7,
          column: 2,
          provenance: 'heuristic' as Edge['provenance'],
        },
      ]);

      // Re-index a.ts with the symbol RENAMED and lines shifted: the
      // (kind,name) re-attach map misses → the edge resurrects as its
      // ORIGINAL pending ref (#899/#1240).
      storeFile(ctx, 'a.ts', 'h2', [node({ id: 'function:a:5', name: 'hello2', startLine: 5 })]);
      expect(bridge.lastFusion).toBe('storeFileResult');

      expect(ctx.queries.getIncomingEdges('function:a:1').length).toBe(0); // old edge cascaded
      const refs = ctx.queries.getUnresolvedReferences();
      expect(refs.length).toBe(1);
      expect(refs[0].fromNodeId).toBe('function:caller');
      expect(refs[0].referenceName).toBe('mod.hello');
      expect(refs[0].referenceKind).toBe('calls');
      expect(refs[0].line).toBe(7);
      expect(refs[0].column).toBe(2);
      expect(refs[0].filePath).toBe('caller.ts');

      // Seed a fresh stamped edge, keep the NAME, shift the line → re-attach
      // to the new id with metadata preserved byte-identical.
      ctx.queries.deleteUnresolvedReferencesByIds(refs.map((r) => r.id!));
      ctx.queries.insertEdges([
        {
          source: 'function:caller',
          target: 'function:a:5',
          kind: 'calls',
          metadata: { refName: 'hello2', refKind: 'references' },
          line: 8,
          column: 0,
          provenance: 'heuristic' as Edge['provenance'],
        },
      ]);
      storeFile(ctx, 'a.ts', 'h3', [node({ id: 'function:a:9', name: 'hello2', startLine: 9 })]);
      const edges = ctx.queries.getOutgoingEdges('function:caller');
      expect(edges.length).toBe(1);
      expect(edges[0].target).toBe('function:a:9');
      expect(edges[0].metadata).toEqual({ refName: 'hello2', refKind: 'references' });
      expect(edges[0].line).toBe(8);
      expect(edges[0].provenance).toBe('heuristic');
      expect(ctx.queries.getUnresolvedReferences().length).toBe(0);

      // Skip guard: same content hash → the whole op is skipped.
      const commits = bridge.commitCount;
      storeFile(ctx, 'a.ts', 'h3', [node({ id: 'function:a:9', name: 'hello2', startLine: 9 })]);
      expect(bridge.commitCount).toBe(commits + 1);
      expect(bridge.lastStats?.filesSkippedUnchanged).toBe(1);
    } finally {
      disposeCtx(ctx);
    }
  });

  it('[insertRefs, deleteFile] fuses to OP_DELETE_FILE + RESURRECT and both arms agree', () => {
    const tsCtx = makeCtx();
    const nativeCtx = makeCtx();
    try {
      const bridge = StoreBridge.open(nativeCtx.dbPath)!;
      nativeCtx.queries.attachStore(bridge);

      for (const ctx of [tsCtx, nativeCtx]) {
        // caller.ts → a.ts stamped edge + the file records.
        ctx.queries.insertNodes([
          node({ id: 'function:a:1', name: 'hello', filePath: 'a.ts' }),
          node({ id: 'function:caller', name: 'caller', filePath: 'caller.ts' }),
        ]);
        ctx.queries.insertEdges([
          {
            source: 'function:caller',
            target: 'function:a:1',
            kind: 'calls',
            metadata: { refName: 'mod.hello', refKind: 'calls' },
            line: 7,
            column: 2,
          },
        ]);
        ctx.queries.upsertFile(fileRecord({ path: 'a.ts' }));
        ctx.queries.upsertFile(fileRecord({ path: 'caller.ts', contentHash: 'h2' }));

        // removeFileResurrectingRefs shape: resurrect incoming, then delete.
        ctx.queries.transaction(() => {
          const incoming = ctx.queries.getCrossFileIncomingEdgesWithTarget('a.ts');
          const resurrected = incoming.flatMap((e) => {
            const refName = (e.metadata as Record<string, unknown> | undefined)?.refName;
            if (typeof refName !== 'string' || refName.length === 0) return [];
            const refKind = (e.metadata as Record<string, unknown>)?.refKind;
            return [
              {
                fromNodeId: e.source,
                referenceName: refName,
                referenceKind: (typeof refKind === 'string' ? refKind : e.kind) as UnresolvedReference['referenceKind'],
                line: e.line ?? 0,
                column: e.column ?? 0,
                filePath: e.sourceFilePath,
                language: e.sourceLanguage,
              } as UnresolvedReference,
            ];
          });
          if (resurrected.length > 0) ctx.queries.insertUnresolvedRefsBatch(resurrected);
          ctx.queries.deleteFile('a.ts');
        });
      }
      expect(bridge.lastFusion).toBe('deleteFileResurrect');
      expect(bridge.lastStats?.refsResurrected).toBe(1);
      expect(dumpTables(nativeCtx.conn)).toEqual(dumpTables(tsCtx.conn));
      expect(nativeCtx.queries.getFileByPath('a.ts')).toBeNull();
      expect(nativeCtx.queries.getUnresolvedReferences().length).toBe(1);
    } finally {
      disposeCtx(tsCtx);
      disposeCtx(nativeCtx);
    }
  });
});

// ---------------------------------------------------------------------------
// Dual-connection coexistence (rusqlite handle + TS adapter on one WAL file)
// ---------------------------------------------------------------------------

nativeDescribe('dual-connection coexistence', () => {
  it('interleaved TS/bidge writes are mutually visible (WAL, busy_timeout mirrored)', () => {
    const ctx = makeCtx();
    try {
      const bridge = StoreBridge.open(ctx.dbPath)!;
      expect(ctx.conn.getJournalMode()).toBe('wal');

      // TS write (no bridge routing on the raw TS arm) → Rust read/write sees it.
      const tsQueries = new QueryBuilder(ctx.conn.getDb());
      tsQueries.insertNodes([node({ id: 'function:ts1', name: 'ts1' })]);
      ctx.queries.attachStore(bridge);
      // The native edge insert's dangling filter must SEE the TS-committed node
      // through the Rust connection.
      ctx.queries.insertNodes([node({ id: 'function:rs1', name: 'rs1' })]);
      ctx.queries.insertEdges([{ source: 'function:ts1', target: 'function:rs1', kind: 'calls', line: 1 }]);
      expect(bridge.lastStats?.edgesInserted).toBe(1);

      // TS read sees the native-committed rows.
      expect(tsQueries.getNodeById('function:rs1')).not.toBeNull();
      expect(tsQueries.getOutgoingEdges('function:ts1').length).toBe(1);

      // 50 interleaved rounds keep both connections agreeing (no BUSY storm,
      // no lost writes).
      for (let i = 0; i < 50; i++) {
        ctx.queries.insertNodes([node({ id: `function:n${i}`, name: `n${i}` })]);
        tsQueries.insertNodes([node({ id: `function:t${i}`, name: `t${i}` })]);
      }
      const count = (
        ctx.conn.getDb().prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }
      ).c;
      expect(count).toBe(2 + 100);
    } finally {
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire builder self-check (header invariants the Rust decoder validates)
// ---------------------------------------------------------------------------

describe('StoreBuffersBuilder wire shape', () => {
  nativeIt('finish() emits a header the Rust decoder accepts (counts + arena length)', () => {
    const b = new StoreBuffersBuilder();
    const fi = b.file(fileRecord({ path: 'x.ts' }));
    b.node(node({ id: 'function:x', name: 'x', filePath: 'x.ts' }));
    b.opStoreFileResult(fi, [0, 1], null, null);
    const bufs = b.finish();
    expect(bufs.meta.readUInt8(0)).toBe(STORE_ABI_VERSION);
    expect(bufs.meta.readUInt32LE(4)).toBe(1); // op_count
    expect(bufs.meta.readUInt32LE(8)).toBe(1); // file_count
    expect(bufs.meta.readUInt32LE(12)).toBe(1); // node_count
    expect(bufs.meta.readUInt32LE(24)).toBe(bufs.arena.length);
    expect(bufs.nodes.length).toBe(140);
    // The real decoder accepts it end-to-end:
    const ctx = makeCtx();
    try {
      const mod = getStoreModule()!;
      const handle = mod.storeOpen(ctx.dbPath);
      const stats = mod.storeCommitBatch(handle, bufs);
      expect(stats.filesUpserted).toBe(1);
      expect(stats.nodesInserted).toBe(1);
    } finally {
      disposeCtx(ctx);
    }
  });
});
