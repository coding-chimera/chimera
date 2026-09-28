/**
 * R3c-2 resolve-bridge tests — loader contract gate (ABI equality, row-size
 * identity, strategy-manifest reconciliation in BOTH directions,
 * RESOLVER_RANK equality), CODEGRAPH_RESOLVE kill switch (both states),
 * wire framing (encodeResolveBatch meta/refs/ext layout, decodeResolveBatch
 * header validation), ResolveBridge lifecycle (open gating, per-call live()
 * re-check, sticky disable, idempotent close, dispose-before-ctx pairing),
 * per-batch TS fallback on resolve_batch failure (wire vs non-wire errors),
 * the resolveOne double-write guard while the native arm is live, and
 * end-to-end dual-arm stored-graph equality (compact sibling of
 * scripts/resolution-parity.ts — that script remains the routing gate on the
 * full strategy fixture).
 *
 * Native tests run against the locally staged prebuild (K-v2 precedent) and
 * skip when it is absent or pre-R3c (no resolve exports).
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';
import type { Node, UnresolvedReference } from '../../src/graph/types';
import { StoreBridge } from '../../src/graph/store/bridge';
import {
  RESOLVE_ABI_VERSION,
  RESOLVE_EXPECTED_RANK,
  RESOLVE_TS_STRATEGY_TABLE,
  getResolveModule,
  resetStoreForTests,
  resolveEnabled,
  setResolveModuleForTests,
  verifyResolveContract,
  type ResolveContractInfo,
  type ResolveModule,
} from '../../src/graph/store/loader';
import type { CtxBridge } from '../../src/graph/resolution/ctx-bridge';
import { ResolveBridge, isResolveWireError } from '../../src/graph/resolution/resolve-bridge';
import {
  RESOLVE_EDGE_ROW_SIZE,
  RESOLVE_EXT_HEADER_SIZE,
  RESOLVE_FLAG_SWEEP_BATCH_FILES,
  RESOLVE_OUT_HEADER_SIZE,
  RESOLVE_REF_ROW_SIZE,
  decodeResolveBatch,
  encodeResolveBatch,
  type ExternalWireInput,
  type ResolveBuffersOut,
} from '../../src/graph/resolution/resolve-encode';
import type { FrameworkResolver, UnresolvedRef } from '../../src/graph/resolution/types';
import { createResolver, type ReferenceResolver } from '../../src/graph/resolution';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const prebuildPath = path.join(
  repoRoot,
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const resolvePrebuildAvailable = (() => {
  if (!fs.existsSync(prebuildPath)) return false;
  try {
    const mod = createRequire(import.meta.url)(prebuildPath) as Record<string, unknown>;
    return (
      typeof mod.resolveContractInfo === 'function' &&
      typeof mod.resolveOpen === 'function' &&
      typeof mod.resolveBatch === 'function' &&
      typeof mod.ctxOpen === 'function'
    );
  } catch {
    return false;
  }
})();
const nativeIt = it.skipIf(!resolvePrebuildAvailable);

// ---------------------------------------------------------------------------
// Fixture — real files on disk (import mappings parse from content) + a
// manually seeded graph: one import-arm resolvable ref and one gate-dropped
// ref (failed terminal state), so both arms exercise resolve + fail + sweep.
// ---------------------------------------------------------------------------

const LIB_TS = ['export function alpha(x: number): number {', '  return x + 1;', '}', ''].join('\n');
const APP_TS = [
  "import { alpha } from './lib';",
  'export function main(): number {',
  '  return alpha(1) + ghost(2);',
  '}',
  '',
].join('\n');

function node(overrides: Partial<Node> & { id: string; name: string }): Node {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'lib.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as Node;
}

interface Fix {
  dir: string;
  dbPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  store: StoreBridge | null;
}

function makeFixture(): Fix {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resolve-bridge-'));
  fs.writeFileSync(path.join(dir, 'lib.ts'), LIB_TS, 'utf8');
  fs.writeFileSync(path.join(dir, 'app.ts'), APP_TS, 'utf8');
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const store = StoreBridge.open(dbPath);
  const queries = new QueryBuilder(conn.getDb(), store);
  return { dir, dbPath, conn, queries, store };
}

function seed(fix: Fix, extraRefs: UnresolvedReference[] = []): void {
  fix.queries.insertNodes([
    node({ id: 'function:alpha', name: 'alpha', qualifiedName: 'lib.alpha', isExported: true }),
    node({
      id: 'function:main',
      name: 'main',
      qualifiedName: 'app.main',
      filePath: 'app.ts',
      startLine: 2,
      endLine: 4,
      isExported: true,
    }),
    node({ id: 'file:lib.ts', kind: 'file', name: 'lib.ts', filePath: 'lib.ts', startLine: 1, endLine: 4 }),
    node({ id: 'file:app.ts', kind: 'file', name: 'app.ts', filePath: 'app.ts', startLine: 1, endLine: 5 }),
  ]);
  fix.queries.upsertFile({
    path: 'lib.ts',
    contentHash: 'h-lib',
    language: 'typescript',
    size: LIB_TS.length,
    modifiedAt: 1_700_000_000_000,
    indexedAt: 1_700_000_000_000,
    nodeCount: 2,
  });
  fix.queries.upsertFile({
    path: 'app.ts',
    contentHash: 'h-app',
    language: 'typescript',
    size: APP_TS.length,
    modifiedAt: 1_700_000_000_000,
    indexedAt: 1_700_000_000_000,
    nodeCount: 2,
  });
  fix.queries.insertUnresolvedRefsBatch([
    {
      fromNodeId: 'function:main',
      referenceName: 'alpha',
      referenceKind: 'calls',
      line: 3,
      column: 9,
      filePath: 'app.ts',
      language: 'typescript',
    },
    {
      fromNodeId: 'function:main',
      referenceName: 'ghost',
      referenceKind: 'calls',
      line: 3,
      column: 20,
      filePath: 'app.ts',
      language: 'typescript',
    },
    ...extraRefs,
  ] as UnresolvedReference[]);
}

function disposeFixture(fix: Fix): void {
  try {
    fix.queries.dispose();
  } catch {
    // ignore
  }
  try {
    fix.conn.close();
  } catch {
    // ignore
  }
  fs.rmSync(fix.dir, { recursive: true, force: true });
}

function dumpEdges(dbPath: string): string[] {
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const rows = conn
      .getDb()
      .prepare(
        `SELECT source, target, kind, metadata, line, col FROM edges
         ORDER BY source, target, kind, IFNULL(line,-1), IFNULL(col,-1), IFNULL(metadata,'')`
      )
      .all() as unknown[];
    return rows.map((r) => JSON.stringify(r));
  } finally {
    conn.close();
  }
}

function dumpRefs(dbPath: string): string[] {
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const rows = conn
      .getDb()
      .prepare(
        `SELECT from_node_id, reference_name, reference_kind, line, col, status FROM unresolved_refs
         ORDER BY from_node_id, reference_name, reference_kind, line, col`
      )
      .all() as unknown[];
    return rows.map((r) => JSON.stringify(r));
  } finally {
    conn.close();
  }
}

interface Arm {
  fix: Fix;
  resolver: ReferenceResolver;
  stats: { total: number; resolved: number; unresolved: number; byMethod: Record<string, number> };
}

/** One full resolve pass; `native` toggles CODEGRAPH_RESOLVE (the ONLY switch). */
interface ArmOpts {
  extraRefs?: UnresolvedReference[];
  customize?: (resolver: ReferenceResolver) => void;
}

async function buildArm(native: boolean, opts: ArmOpts = {}): Promise<Arm> {
  if (native) delete process.env.CODEGRAPH_RESOLVE;
  else process.env.CODEGRAPH_RESOLVE = '0';
  const fix = makeFixture();
  seed(fix, opts.extraRefs);
  const resolver = createResolver(fix.dir, fix.queries);
  resolver.runPostExtract();
  opts.customize?.(resolver);
  const result = await resolver.resolveAndPersistBatched();
  return { fix, resolver, stats: result.stats };
}

function disposeArm(arm: Arm): void {
  try {
    arm.resolver.dispose();
  } catch {
    // ignore
  }
  disposeFixture(arm.fix);
}

// ---------------------------------------------------------------------------
// Contract + fakes
// ---------------------------------------------------------------------------

function validContractInfo(): ResolveContractInfo {
  return {
    resolveAbi: RESOLVE_ABI_VERSION,
    resolveVersion: 'test',
    strategies: [...RESOLVE_TS_STRATEGY_TABLE],
    resolverRank: Object.entries(RESOLVE_EXPECTED_RANK).map(([k, v]) => `${k}:${v}`),
    builtinsVersion: 'test-builtins',
    ambiguousNameCeiling: 500,
    refRowSize: RESOLVE_REF_ROW_SIZE,
    edgeRowSize: RESOLVE_EDGE_ROW_SIZE,
  };
}

function fakeResolveModule(overrides: Partial<ResolveModule> = {}): ResolveModule {
  return {
    resolveContractInfo: validContractInfo,
    resolveOpen: () => ({}),
    resolveBatch: () => {
      throw new Error('unused fake');
    },
    resolveClose: () => {},
    ...overrides,
  };
}

function stubCtxBridge(live = true, handle: object | null = {}): CtxBridge {
  return { live: () => live, rawCtxHandle: () => handle } as unknown as CtxBridge;
}

const EMPTY_EXT: ExternalWireInput = {
  importResults: [],
  jvmImportResults: [],
  frameworkResults: [],
  claimedNames: [],
  importPaths: [],
};

const SAMPLE_REF: UnresolvedRef = {
  id: 5,
  fromNodeId: 'function:main',
  referenceName: 'alpha',
  referenceKind: 'calls',
  line: 3,
  column: 2,
  filePath: 'app.ts',
  language: 'typescript',
};

let envResolve: string | undefined;
let envCtx: string | undefined;
let envStore: string | undefined;
beforeEach(() => {
  envResolve = process.env.CODEGRAPH_RESOLVE;
  envCtx = process.env.CODEGRAPH_CTX;
  envStore = process.env.CODEGRAPH_STORE;
  delete process.env.CODEGRAPH_RESOLVE;
  delete process.env.CODEGRAPH_CTX;
  delete process.env.CODEGRAPH_STORE;
});
afterEach(() => {
  if (envResolve === undefined) delete process.env.CODEGRAPH_RESOLVE;
  else process.env.CODEGRAPH_RESOLVE = envResolve;
  if (envCtx === undefined) delete process.env.CODEGRAPH_CTX;
  else process.env.CODEGRAPH_CTX = envCtx;
  if (envStore === undefined) delete process.env.CODEGRAPH_STORE;
  else process.env.CODEGRAPH_STORE = envStore;
  // Clears every injected fake AND the real-module caches (undefined = re-detect).
  resetStoreForTests();
});

// ---------------------------------------------------------------------------
// Contract gate
// ---------------------------------------------------------------------------

describe('verifyResolveContract', () => {
  it('accepts a fully matching contract', () => {
    expect(verifyResolveContract(validContractInfo())).toBe(true);
  });

  it('rejects an ABI mismatch (equality, independent numbering)', () => {
    expect(verifyResolveContract({ ...validContractInfo(), resolveAbi: 0 })).toBe(false);
    expect(verifyResolveContract({ ...validContractInfo(), resolveAbi: 2 })).toBe(false);
  });

  it('rejects a wire row-size mismatch (encoder identity)', () => {
    expect(verifyResolveContract({ ...validContractInfo(), refRowSize: RESOLVE_REF_ROW_SIZE - 1 })).toBe(false);
    expect(verifyResolveContract({ ...validContractInfo(), edgeRowSize: RESOLVE_EDGE_ROW_SIZE + 1 })).toBe(false);
  });

  it('rejects a kernel-only strategy (kernel ⊆ fork: no silent unknown)', () => {
    expect(
      verifyResolveContract({ ...validContractInfo(), strategies: [...RESOLVE_TS_STRATEGY_TABLE, 'time-travel'] })
    ).toBe(false);
  });

  it('rejects a missing strategy (fork ⊆ kernel: routing never drops one)', () => {
    expect(
      verifyResolveContract({
        ...validContractInfo(),
        strategies: RESOLVE_TS_STRATEGY_TABLE.filter((s) => s !== 'fuzzy'),
      })
    ).toBe(false);
  });

  it('rejects a RESOLVER_RANK value or count mismatch (arbitration is load-bearing)', () => {
    const tampered = Object.entries(RESOLVE_EXPECTED_RANK).map(([k, v]) => (k === 'import' ? 'import:5' : `${k}:${v}`));
    expect(verifyResolveContract({ ...validContractInfo(), resolverRank: tampered })).toBe(false);
    expect(
      verifyResolveContract({
        ...validContractInfo(),
        resolverRank: Object.entries(RESOLVE_EXPECTED_RANK)
          .slice(0, -1)
          .map(([k, v]) => `${k}:${v}`),
      })
    ).toBe(false);
  });

  nativeIt('accepts the real module contract', () => {
    const mod = getResolveModule();
    expect(mod).not.toBeNull();
    expect(verifyResolveContract(mod!.resolveContractInfo())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Kill switch + open gating + lifecycle (fake-module unit level)
// ---------------------------------------------------------------------------

describe('CODEGRAPH_RESOLVE kill switch and ResolveBridge gating', () => {
  it('resolveEnabled flips with the env per call', () => {
    setResolveModuleForTests(fakeResolveModule());
    expect(resolveEnabled()).toBe(true);
    process.env.CODEGRAPH_RESOLVE = '0';
    expect(resolveEnabled()).toBe(false);
    delete process.env.CODEGRAPH_RESOLVE;
    expect(resolveEnabled()).toBe(true);
  });

  it('open returns null without a live ctx bridge', () => {
    setResolveModuleForTests(fakeResolveModule());
    expect(ResolveBridge.open(null)).toBeNull();
    expect(ResolveBridge.open(stubCtxBridge(false))).toBeNull();
  });

  it('open returns null while the kill switch is on', () => {
    setResolveModuleForTests(fakeResolveModule());
    process.env.CODEGRAPH_RESOLVE = '0';
    expect(ResolveBridge.open(stubCtxBridge())).toBeNull();
  });

  it('open returns null when the ctx handle is gone (closed ctx)', () => {
    setResolveModuleForTests(fakeResolveModule());
    expect(ResolveBridge.open(stubCtxBridge(true, null))).toBeNull();
  });

  it('open returns null when resolveOpen throws (silent TS arm)', () => {
    setResolveModuleForTests(
      fakeResolveModule({
        resolveOpen: () => {
          throw new Error('resolve handle: open exploded');
        },
      })
    );
    expect(ResolveBridge.open(stubCtxBridge())).toBeNull();
  });

  it('live() re-checks the kill switch per call; disable is sticky; close is idempotent', () => {
    let closeCalls = 0;
    setResolveModuleForTests(fakeResolveModule({ resolveClose: () => void closeCalls++ }));
    const bridge = ResolveBridge.open(stubCtxBridge());
    expect(bridge).not.toBeNull();
    expect(bridge!.live()).toBe(true);
    process.env.CODEGRAPH_RESOLVE = '0';
    expect(bridge!.live()).toBe(false);
    delete process.env.CODEGRAPH_RESOLVE;
    expect(bridge!.live()).toBe(true);
    bridge!.disable('injected');
    expect(bridge!.live()).toBe(false);
    expect(bridge!.isDisabled).toBe(true);
    expect(bridge!.disableReason).toBe('injected');
    bridge!.close();
    bridge!.close();
    expect(bridge!.isClosed).toBe(true);
    expect(bridge!.live()).toBe(false);
    expect(closeCalls).toBe(1);
  });

  it('isResolveWireError classifies systematic bridge/wire faults only', () => {
    expect(isResolveWireError(new Error('resolve wire: output header truncated'))).toBe(true);
    expect(isResolveWireError(new Error('resolve handle: ctx bridge closed'))).toBe(true);
    expect(isResolveWireError('resolve wire: string form')).toBe(true);
    expect(isResolveWireError(new Error('kaboom'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire framing (pure encode/decode — no native needed)
// ---------------------------------------------------------------------------

describe('resolve wire framing', () => {
  it('encodeResolveBatch writes the ABI-1 input frame', () => {
    const wire = encodeResolveBatch([SAMPLE_REF], EMPTY_EXT, RESOLVE_FLAG_SWEEP_BATCH_FILES);
    expect(wire.meta.length).toBe(16);
    expect(wire.meta.readUInt8(0)).toBe(RESOLVE_ABI_VERSION);
    expect(wire.meta.readUInt32LE(4)).toBe(1);
    expect(wire.meta.readUInt32LE(8)).toBe(RESOLVE_FLAG_SWEEP_BATCH_FILES);
    expect(wire.meta.readUInt32LE(12)).toBe(wire.arena.length);
    expect(wire.refs.length).toBe(RESOLVE_REF_ROW_SIZE);
    // Ref row: i64 id, then strRefs — fromNodeId sits at offset 8.
    expect(Number(wire.refs.readBigInt64LE(0))).toBe(5);
    const off = wire.refs.readUInt32LE(8);
    const len = wire.refs.readUInt32LE(12);
    expect(wire.arena.toString('utf8', off, off + len)).toBe('function:main');
    // Empty external tables = header only (abi byte + 7 count u32s).
    expect(wire.external.length).toBe(RESOLVE_EXT_HEADER_SIZE);
    expect(wire.external.readUInt8(0)).toBe(RESOLVE_ABI_VERSION);
    for (let at = 4; at < RESOLVE_EXT_HEADER_SIZE; at += 4) {
      expect(wire.external.readUInt32LE(at)).toBe(0);
    }
  });

  it('encodeResolveBatch rejects an unknown resolvedBy (wire-shaped, sticky-disable class)', () => {
    const ext: ExternalWireInput = {
      ...EMPTY_EXT,
      frameworkResults: [
        {
          filePath: 'app.ts',
          referenceName: 'alpha',
          referenceKind: 'call',
          line: 3,
          col: 2,
          candidates: [
            {
              targetNodeId: 'function:alpha',
              resolvedBy: 'time-travel',
              authoritative: false,
              edgeKind: null,
              metadata: null,
              alsoTargets: [],
            },
          ],
        },
      ],
    };
    expect(() => encodeResolveBatch([], ext, 0)).toThrow(/resolve wire/);
  });

  it('decodeResolveBatch reads a zero-count output frame', () => {
    const header = Buffer.alloc(RESOLVE_OUT_HEADER_SIZE);
    header.writeUInt8(RESOLVE_ABI_VERSION, 0);
    header.writeUInt32LE(0, 24); // arenaLen
    header.writeUInt32LE(9, 28); // total
    header.writeUInt32LE(4, 32); // resolved
    header.writeUInt32LE(5, 36); // unresolved
    const empty = Buffer.alloc(0);
    const out: ResolveBuffersOut = { header, edges: empty, refs: empty, files: empty, stats: empty, arena: empty };
    const decoded = decodeResolveBatch(out);
    expect(decoded.batchEdges).toEqual([]);
    expect(decoded.resolved).toEqual([]);
    expect(decoded.failed).toEqual([]);
    expect(decoded.sweeps).toEqual([]);
    expect(decoded.stats).toEqual({ total: 9, resolved: 4, unresolved: 5, byMethod: {} });
  });

  it('decodeResolveBatch rejects truncated and foreign-ABI frames', () => {
    const empty = Buffer.alloc(0);
    const short: ResolveBuffersOut = {
      header: Buffer.alloc(RESOLVE_OUT_HEADER_SIZE - 1),
      edges: empty,
      refs: empty,
      files: empty,
      stats: empty,
      arena: empty,
    };
    expect(() => decodeResolveBatch(short)).toThrow(/resolve wire/);
    const badAbi = Buffer.alloc(RESOLVE_OUT_HEADER_SIZE);
    badAbi.writeUInt8(RESOLVE_ABI_VERSION + 1, 0);
    expect(() => decodeResolveBatch({ ...short, header: badAbi })).toThrow(/resolve wire/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end (real kernel): dual-arm equality, fallback discipline, guards
// ---------------------------------------------------------------------------

describe('native resolve arm end-to-end', () => {
  nativeIt('dual-arm stored-graph equality (edges, refs, stats) + routing assertions', async () => {
    const ts = await buildArm(false);
    const nat = await buildArm(true);
    try {
      // Routing: the kill switch alone decides the arm.
      expect(ts.resolver.getResolveBridge()).toBeNull();
      const bridge = nat.resolver.getResolveBridge();
      expect(bridge).not.toBeNull();
      expect(bridge!.batchCount).toBeGreaterThan(0);

      // The fixture must actually exercise both terminal states + the sweep.
      expect(ts.stats.resolved).toBeGreaterThan(0);
      expect(ts.stats.unresolved).toBeGreaterThan(0);
      const tsEdges = dumpEdges(ts.fix.dbPath);
      expect(tsEdges.some((e) => e.includes('"function:alpha"') && e.includes('"kind":"calls"'))).toBe(true);
      expect(tsEdges.some((e) => e.includes('"file:lib.ts"') && e.includes('"imports"'))).toBe(true);

      // Equality faces (the parity script's gates on the compact fixture).
      expect(dumpEdges(nat.fix.dbPath)).toEqual(tsEdges);
      expect(dumpRefs(nat.fix.dbPath)).toEqual(dumpRefs(ts.fix.dbPath));
      expect(nat.stats.total).toBe(ts.stats.total);
      expect(nat.stats.resolved).toBe(ts.stats.resolved);
      expect(nat.stats.unresolved).toBe(ts.stats.unresolved);
      expect(nat.stats.byMethod).toEqual(ts.stats.byMethod);

      // resolveOne double-write guard while the native arm is live.
      expect(nat.resolver.resolveOne(SAMPLE_REF)).toBeNull();

      // dispose() closes the resolve bridge (before ctx/store — R1 pairing).
      nat.resolver.dispose();
      expect(bridge!.isClosed).toBe(true);
    } finally {
      disposeArm(ts);
      disposeArm(nat);
    }
  });

  nativeIt('wire-error resolve_batch falls back to the TS batch and sticky-disables', async () => {
    let calls = 0;
    setResolveModuleForTests(
      fakeResolveModule({
        resolveBatch: () => {
          calls++;
          throw new Error('resolve wire: injected meta truncation');
        },
      })
    );
    const ts = await buildArm(false);
    const nat = await buildArm(true);
    try {
      expect(calls).toBeGreaterThan(0);
      const bridge = nat.resolver.getResolveBridge();
      expect(bridge).not.toBeNull();
      expect(bridge!.isDisabled).toBe(true);
      expect(bridge!.disableReason).toContain('resolve wire');
      // The batch still resolved correctly through the TS fallback arm.
      expect(dumpEdges(nat.fix.dbPath)).toEqual(dumpEdges(ts.fix.dbPath));
      expect(dumpRefs(nat.fix.dbPath)).toEqual(dumpRefs(ts.fix.dbPath));
      expect(nat.stats.resolved).toBe(ts.stats.resolved);
      expect(nat.stats.unresolved).toBe(ts.stats.unresolved);
      // Sticky: the disabled bridge never crosses again.
      const after = calls;
      expect(bridge!.live()).toBe(false);
      expect(calls).toBe(after);
    } finally {
      disposeArm(ts);
      disposeArm(nat);
    }
  });

  nativeIt('non-wire resolve_batch failure falls back per batch WITHOUT disabling', async () => {
    let calls = 0;
    setResolveModuleForTests(
      fakeResolveModule({
        resolveBatch: () => {
          calls++;
          throw new Error('kaboom: transient native failure');
        },
      })
    );
    const ts = await buildArm(false);
    const nat = await buildArm(true);
    try {
      expect(calls).toBeGreaterThan(0);
      const bridge = nat.resolver.getResolveBridge();
      expect(bridge).not.toBeNull();
      expect(bridge!.isDisabled).toBe(false);
      expect(dumpEdges(nat.fix.dbPath)).toEqual(dumpEdges(ts.fix.dbPath));
      expect(nat.stats.resolved).toBe(ts.stats.resolved);
      expect(nat.stats.unresolved).toBe(ts.stats.unresolved);
    } finally {
      disposeArm(ts);
      disposeArm(nat);
    }
  });

  nativeIt('position-dependent framework candidates key per ref position (vue-router adjudication)', async () => {
    // Stub framework mimicking a POSITION-DEPENDENT resolver: it claims 'nav'
    // (the name-prefilter escape) but resolves only the call site at line 3 —
    // like vue-router's router.push parsing the literal argument at the ref's
    // own position. A name-keyed table would feed the line-3 candidate to the
    // line-5 ref (the adjudicated regression).
    const stub: FrameworkResolver = {
      name: 'stub-position-fw',
      detect: () => true,
      claimsReference: (name) => name === 'nav',
      resolve: (ref) =>
        ref.line === 3
          ? { original: ref, targetNodeId: 'function:alpha', resolvedBy: 'framework', metadata: { via: 'stub' } }
          : null,
    };
    const opts: ArmOpts = {
      extraRefs: [
        {
          fromNodeId: 'function:main',
          referenceName: 'nav',
          referenceKind: 'calls',
          line: 3,
          column: 30,
          filePath: 'app.ts',
          language: 'typescript',
        },
        {
          fromNodeId: 'function:main',
          referenceName: 'nav',
          referenceKind: 'calls',
          line: 5,
          column: 30,
          filePath: 'app.ts',
          language: 'typescript',
        },
      ] as UnresolvedReference[],
      customize: (r) => {
        (r as unknown as { frameworks: FrameworkResolver[] }).frameworks = [stub];
      },
    };
    const ts = await buildArm(false, opts);
    const nat = await buildArm(true, opts);
    try {
      expect(nat.resolver.getResolveBridge()!.batchCount).toBeGreaterThan(0);
      const tsEdges = dumpEdges(ts.fix.dbPath);
      // The line-3 nav resolves through the stub; the line-5 nav must NOT.
      // (Row metadata is re-escaped inside the dumped row JSON — parse it
      // instead of substring-matching the outer serialization.)
      const fwCount = (rows: string[]): number =>
        rows
          .map((r) => JSON.parse(r) as { metadata: string | null })
          .filter((r) => r.metadata?.includes('"resolvedBy":"framework"')).length;
      expect(fwCount(tsEdges)).toBe(1);
      const tsRefs = dumpRefs(ts.fix.dbPath);
      expect(tsRefs.filter((r) => r.includes('"nav"') && r.includes('"failed"')).length).toBe(1);
      expect(dumpEdges(nat.fix.dbPath)).toEqual(tsEdges);
      expect(dumpRefs(nat.fix.dbPath)).toEqual(tsRefs);
      expect(nat.stats.resolved).toBe(ts.stats.resolved);
      expect(nat.stats.unresolved).toBe(ts.stats.unresolved);
      expect(nat.stats.byMethod).toEqual(ts.stats.byMethod);
    } finally {
      disposeArm(ts);
      disposeArm(nat);
    }
  });
});
