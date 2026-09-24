/**
 * R3b-2 ctx-bridge tests — loader contract gate, CODEGRAPH_CTX kill switch
 * (both states), readOnly/no-store no-attach, decoder roundtrip against the
 * REAL Rust resolver_ctx, invalidation propagation (store-generation writes,
 * TS-arm write listener, clearCaches/warmCaches seams), lifecycle pairing
 * (resolver.dispose / CodeGraph.close), and silent TS fallback on ctx
 * failures.
 *
 * Native tests run against the locally staged prebuild (K-v2 precedent) and
 * skip when it is absent or pre-R3b (no ctx exports).
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { CodeGraph } from '../../src/graph';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';
import type { Node } from '../../src/graph/types';
import { StoreBridge } from '../../src/graph/store/bridge';
import {
  ctxEnabled,
  getCtxModule,
  resetStoreForTests,
  setCtxModuleForTests,
  setStoreModuleForTests,
  verifyCtxContract,
  type CtxModule,
} from '../../src/graph/store/loader';
import { CtxBridge } from '../../src/graph/resolution/ctx-bridge';
import { createResolver, type ReferenceResolver, type ResolutionContext } from '../../src/graph/resolution';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const prebuildPath = path.join(
  repoRoot,
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const ctxPrebuildAvailable = (() => {
  if (!fs.existsSync(prebuildPath)) return false;
  try {
    const mod = createRequire(import.meta.url)(prebuildPath) as Record<string, unknown>;
    return typeof mod.ctxContractInfo === 'function' && typeof mod.ctxOpen === 'function';
  } catch {
    return false;
  }
})();
const nativeDescribe = describe.skipIf(!ctxPrebuildAvailable);
const nativeIt = it.skipIf(!ctxPrebuildAvailable);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const APP_TS = [
  "import def from './lib';",
  "import * as ns from './lib';",
  "import { alpha as a, beta } from './lib';",
  "export { beta as b } from './lib';",
  "export * from './lib';",
  'export function useAll(): unknown {',
  '  return [def, ns, a, beta];',
  '}',
  '',
].join('\n');

const LIB_TS = [
  '/** Alpha docs. */',
  'export function alpha(x: number): number {',
  '  return x + 1;',
  '}',
  'export function beta(): string {',
  "  return 'b';",
  '}',
  '',
].join('\n');

function node(overrides: Partial<Node> & { id: string; name: string }): Node {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'lib.ts',
    language: 'typescript',
    startLine: 2,
    endLine: 4,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as Node;
}

interface Ctx {
  dir: string;
  dbPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  store: StoreBridge | null;
}

/** Temp project with fixture files on disk + a seeded graph DB. */
function makeCtx(withStore: boolean): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ctx-bridge-'));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.ts'), APP_TS, 'utf8');
  fs.writeFileSync(path.join(dir, 'lib.ts'), LIB_TS, 'utf8');
  fs.writeFileSync(path.join(dir, 'empty.ts'), '', 'utf8');
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const store = withStore ? StoreBridge.open(dbPath) : null;
  const queries = new QueryBuilder(conn.getDb(), store);
  return { dir, dbPath, conn, queries, store };
}

function seed(ctx: Ctx): void {
  ctx.queries.insertNodes([
    node({
      id: 'function:alpha',
      name: 'alpha',
      qualifiedName: 'lib.alpha',
      startLine: 2,
      endLine: 4,
      docstring: 'Alpha docs.',
      signature: '(x: number): number',
      returnType: 'number',
      isExported: true,
      params: [{ name: 'x', type: 'number' }],
    }),
    node({ id: 'function:beta', name: 'beta', qualifiedName: 'lib.beta', startLine: 5, endLine: 7, isExported: true }),
    node({ id: 'file:lib.ts', kind: 'file', name: 'lib.ts', filePath: 'lib.ts', startLine: 1, endLine: 8 }),
  ]);
  ctx.queries.upsertFile({
    path: 'lib.ts',
    contentHash: 'h-lib',
    language: 'typescript',
    size: LIB_TS.length,
    modifiedAt: 1_700_000_000_000,
    indexedAt: 1_700_000_000_000,
    nodeCount: 3,
  });
  ctx.queries.upsertFile({
    path: 'app.ts',
    contentHash: 'h-app',
    language: 'typescript',
    size: APP_TS.length,
    modifiedAt: 1_700_000_000_000,
    indexedAt: 1_700_000_000_000,
    nodeCount: 1,
  });
}

function disposeCtx(ctx: Ctx): void {
  try {
    ctx.queries.dispose();
  } catch {
    // ignore
  }
  try {
    ctx.conn.close();
  } catch {
    // ignore
  }
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

let envCtx: string | undefined;
let envStore: string | undefined;
beforeEach(() => {
  envCtx = process.env.CODEGRAPH_CTX;
  envStore = process.env.CODEGRAPH_STORE;
  delete process.env.CODEGRAPH_CTX;
  delete process.env.CODEGRAPH_STORE;
});
afterEach(() => {
  if (envCtx === undefined) delete process.env.CODEGRAPH_CTX;
  else process.env.CODEGRAPH_CTX = envCtx;
  if (envStore === undefined) delete process.env.CODEGRAPH_STORE;
  else process.env.CODEGRAPH_STORE = envStore;
  setCtxModuleForTests(null);
  setStoreModuleForTests(null);
  resetStoreForTests();
});

// ---------------------------------------------------------------------------
// Contract gate
// ---------------------------------------------------------------------------

describe('verifyCtxContract', () => {
  nativeIt('accepts the real module contract', () => {
    const mod = getCtxModule();
    expect(mod).not.toBeNull();
    expect(verifyCtxContract(mod!.ctxContractInfo())).toBe(true);
  });

  it('rejects ctx ABI mismatch (equality, independent numbering)', () => {
    const base = { ctxVersion: 'x', nodeRowSize: 140, gettersPresent: [], gettersAbsent: [], semantics: [] };
    expect(verifyCtxContract({ ...base, ctxAbi: 2 })).toBe(false);
    expect(verifyCtxContract({ ...base, ctxAbi: 0 })).toBe(false);
  });

  it('rejects a node-row layout mismatch (decoder identity)', () => {
    expect(
      verifyCtxContract({ ctxAbi: 1, ctxVersion: 'x', nodeRowSize: 96, gettersPresent: [], gettersAbsent: [], semantics: [] })
    ).toBe(false);
  });

  it('rejects a missing routed getter (capability-table subset gate)', () => {
    const present = [
      'getNodesInFile', 'getNodesByName', 'getNodesByQualifiedName', 'getNodesByKind',
      'fileExists', 'readFile', 'getAllFiles', 'getAllNodeNames', 'getNodesByLowerName',
      'getImportMappings', 'getReExports', 'listDirectories', 'getFileLines', 'getNodeById',
      // 'hasNames' missing
    ];
    expect(
      verifyCtxContract({ ctxAbi: 1, ctxVersion: 'x', nodeRowSize: 140, gettersPresent: present, gettersAbsent: [], semantics: [] })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kill switch + attach gating
// ---------------------------------------------------------------------------

describe('CODEGRAPH_CTX kill switch and attach gating', () => {
  nativeIt('ctxEnabled flips with the env per call', () => {
    expect(ctxEnabled()).toBe(true);
    process.env.CODEGRAPH_CTX = '0';
    expect(ctxEnabled()).toBe(false);
    delete process.env.CODEGRAPH_CTX;
    expect(ctxEnabled()).toBe(true);
  });

  nativeIt('CtxBridge.open returns null while the kill switch is on; live() re-checks per call', () => {
    const ctx = makeCtx(true);
    try {
      process.env.CODEGRAPH_CTX = '0';
      expect(CtxBridge.open(ctx.store, ctx.dir)).toBeNull();
      delete process.env.CODEGRAPH_CTX;
      const bridge = CtxBridge.open(ctx.store, ctx.dir);
      expect(bridge).not.toBeNull();
      expect(bridge!.live()).toBe(true);
      process.env.CODEGRAPH_CTX = '0';
      expect(bridge!.live()).toBe(false);
      delete process.env.CODEGRAPH_CTX;
      expect(bridge!.live()).toBe(true);
      bridge!.close();
    } finally {
      disposeCtx(ctx);
    }
  });

  nativeIt('no store bridge (readOnly/crossProject shape) → no ctx', () => {
    const ctx = makeCtx(false);
    try {
      expect(CtxBridge.open(null, ctx.dir)).toBeNull();
      // Resolver level: a QueryBuilder without a store bridge never gets a ctx.
      const resolver = createResolver(ctx.dir, ctx.queries);
      expect(resolver.getCtxBridge()).toBeNull();
    } finally {
      disposeCtx(ctx);
    }
  });

  nativeIt('resolver attaches the ctx when the store bridge is live', () => {
    const ctx = makeCtx(true);
    let resolver: ReferenceResolver | null = null;
    try {
      resolver = createResolver(ctx.dir, ctx.queries);
      expect(resolver.getCtxBridge()).not.toBeNull();
      expect(resolver.getCtxBridge()!.live()).toBe(true);
    } finally {
      resolver?.dispose();
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Decoder roundtrip vs the TS QueryBuilder getters
// ---------------------------------------------------------------------------

nativeDescribe('ctx getter roundtrip (native arm == TS arm)', () => {
  it('every routed getter is deep-equal to its TS counterpart', () => {
    const ctx = makeCtx(true);
    let bridge: CtxBridge | null = null;
    try {
      seed(ctx);
      bridge = CtxBridge.open(ctx.store, ctx.dir);
      expect(bridge).not.toBeNull();
      const q = ctx.queries;

      expect(bridge!.getNodesByName('alpha')).toEqual(q.getNodesByName('alpha'));
      expect(bridge!.getNodesByName('missing')).toEqual([]);
      expect(bridge!.getNodesInFile('lib.ts')).toEqual(q.getNodesByFile('lib.ts'));
      expect(bridge!.getNodesByQualifiedName('lib.alpha')).toEqual(q.getNodesByQualifiedNameExact('lib.alpha'));
      expect(bridge!.getNodesByLowerName('ALPHA')).toEqual(q.getNodesByLowerName('ALPHA'));
      expect(bridge!.getNodesByKind('function')).toEqual(q.getNodesByKind('function'));
      expect(bridge!.getNodesByKind('file')).toEqual(q.getNodesByKind('file'));
      expect(bridge!.getNodeById('function:alpha')).toEqual(q.getNodeById('function:alpha') as Node);
      expect(bridge!.getNodeById('function:nope')).toBeUndefined();
      expect(bridge!.getAllFiles()).toEqual(q.getAllFilePaths());
      expect(bridge!.getAllNodeNames()).toEqual(q.getAllNodeNames());

      // Rich-row decode parity (docstring/signature/params/flags/visibility).
      const alpha = bridge!.getNodesByName('alpha')[0];
      expect(alpha.docstring).toBe('Alpha docs.');
      expect(alpha.signature).toBe('(x: number): number');
      expect(alpha.returnType).toBe('number');
      expect(alpha.params).toEqual([{ name: 'x', type: 'number' }]);
      expect(alpha.isExported).toBe(true);
      expect(alpha.visibility).toBeNull(); // rowToNode passes NULL through
      expect(alpha.updatedAt).toBe(1_700_000_000_000);

      // fs getters
      expect(bridge!.readFile('lib.ts')).toBe(LIB_TS);
      expect(bridge!.readFile('empty.ts')).toBe('');
      expect(bridge!.readFile('nope/missing.ts')).toBeNull();
      expect(bridge!.getFileLines('empty.ts')).toEqual(['']);
      expect(bridge!.getFileLines('nope/missing.ts')).toEqual([]);
      expect(bridge!.getFileLines('lib.ts')).toEqual(LIB_TS.split('\n'));
      expect(bridge!.fileExists('lib.ts')).toBe(true);
      expect(bridge!.fileExists('nope/missing.ts')).toBe(false);
      expect(bridge!.fileExists('sub')).toBe(true); // directory counts (existsSync parity)
      expect(bridge!.listDirectories('.')).toEqual(['sub']);
      expect(bridge!.listDirectories('nope')).toEqual([]);

      // import analysis (regex-walker port)
      const mappings = bridge!.getImportMappings('app.ts', 'typescript');
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.isDefault && m.localName === 'def')).toBe(true);
      expect(mappings.some((m) => m.isNamespace && m.localName === 'ns')).toBe(true);
      expect(mappings.some((m) => m.localName === 'a' && m.exportedName === 'alpha')).toBe(true);
      const reExports = bridge!.getReExports('app.ts', 'typescript');
      expect(reExports.some((r) => r.kind === 'wildcard' && r.source === './lib')).toBe(true);
      expect(
        reExports.some((r) => r.kind === 'named' && r.exportedName === 'b' && r.originalName === 'beta')
      ).toBe(true);

      // batch faces
      expect(bridge!.hasNames(['alpha', 'beta', '__none__'])).toEqual([true, true, false]);
      expect(bridge!.fileExistsBatch(['lib.ts', 'nope.ts'])).toEqual([true, false]);
      expect(bridge!.getProjectRoot()).toBe(ctx.dir);
    } finally {
      bridge?.close();
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Invalidation propagation
// ---------------------------------------------------------------------------

nativeDescribe('invalidation propagation', () => {
  it('store-generation writes are visible without explicit invalidate; TS-arm writes invalidate via the listener', () => {
    const ctx = makeCtx(true);
    let bridge: CtxBridge | null = null;
    try {
      seed(ctx);
      bridge = CtxBridge.open(ctx.store, ctx.dir)!;
      expect(bridge.getNodesByName('gamma')).toEqual([]);

      // Native covered write → store commit generation bump → ctx refreshes
      // WITHOUT any explicit invalidate (the generation counter is shared).
      ctx.queries.insertNodes([node({ id: 'function:gamma', name: 'gamma' })]);
      expect(bridge.getNodesByName('gamma').map((n) => n.id)).toEqual(['function:gamma']);

      // TS-arm uncovered write (deleteNode) → StoreBridge.noteTsWrite →
      // CtxBridge invalidate listener → the deletion is visible. (updateNode
      // is not used here: it has a pre-existing SQL syntax bug unrelated to
      // R3b — see the report's Remaining risk.)
      ctx.queries.deleteNode('function:gamma');
      expect(bridge.getNodesByName('gamma')).toEqual([]);

      // The ctx survives the invalidation and keeps tracking native writes.
      ctx.queries.insertNodes([node({ id: 'function:delta', name: 'delta' })]);
      expect(bridge.getNodesByName('delta').map((n) => n.id)).toEqual(['function:delta']);
    } finally {
      bridge?.close();
      disposeCtx(ctx);
    }
  });

  it('resolver clearCaches/warmCaches hit the ctx seams', () => {
    const ctx = makeCtx(true);
    let resolver: ReferenceResolver | null = null;
    try {
      seed(ctx);
      resolver = createResolver(ctx.dir, ctx.queries);
      const bridge = resolver.getCtxBridge()!;
      expect(bridge).not.toBeNull();
      const c0 = bridge.callCount;
      resolver.warmCaches();
      const c1 = bridge.callCount;
      expect(c1).toBeGreaterThan(c0); // ctx_warm + batch index reads
      resolver.clearCaches();
      expect(bridge.callCount).toBeGreaterThan(c1); // ctx_invalidate
      // Post-warm membership reads agree with the TS queries.
      expect(bridge.getAllNodeNames()).toEqual(ctx.queries.getAllNodeNames());
    } finally {
      resolver?.dispose();
      disposeCtx(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle pairing
// ---------------------------------------------------------------------------

nativeDescribe('ctx lifecycle pairing', () => {
  it('resolver.dispose closes the ctx (idempotent); resolver stays usable on TS', () => {
    const ctx = makeCtx(true);
    let resolver: ReferenceResolver | null = null;
    try {
      seed(ctx);
      resolver = createResolver(ctx.dir, ctx.queries);
      const bridge = resolver.getCtxBridge()!;
      expect(bridge.isClosed).toBe(false);
      resolver.dispose();
      expect(bridge.isClosed).toBe(true);
      expect(bridge.live()).toBe(false);
      expect(resolver.getCtxBridge()).toBeNull();
      resolver.dispose(); // idempotent
      // The resolver still resolves reads through the TS arm after dispose.
      const context = (resolver as unknown as { context: ResolutionContext }).context;
      expect(context.getNodesByName('alpha').map((n) => n.id)).toEqual(['function:alpha']);
    } finally {
      resolver?.dispose();
      disposeCtx(ctx);
    }
  });

  it('CodeGraph.close closes ctx BEFORE the store handle (reverse construction order)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ctx-close-'));
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export function x(): void {}\n', 'utf8');
    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.init(dir, { index: false });
      const resolver = (cg as unknown as { resolver: ReferenceResolver }).resolver;
      const ctxBridge = resolver.getCtxBridge();
      const storeBridge = cg.getStoreBridge();
      expect(ctxBridge).not.toBeNull();
      expect(storeBridge).not.toBeNull();
      await cg.close();
      expect(ctxBridge!.isClosed).toBe(true);
      expect(storeBridge!.isClosed).toBe(true);
      await cg.close(); // idempotent
    } finally {
      await cg?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Silent TS fallback on ctx failure
// ---------------------------------------------------------------------------

describe('silent TS fallback on ctx failure', () => {
  nativeIt('a wire-shaped ctx failure degrades the getter to TS and disables the bridge sticky', () => {
    const ctx = makeCtx(true);
    let resolver: ReferenceResolver | null = null;
    try {
      seed(ctx);
      const real = getCtxModule()!;
      let threw = false;
      const fake = {
        ...real,
        ctxGetNodesByNames: () => {
          threw = true;
          throw new Error('ctx wire: nodes buffer truncated');
        },
      } as unknown as CtxModule;
      setCtxModuleForTests(fake);
      resolver = createResolver(ctx.dir, ctx.queries);
      const bridge = resolver.getCtxBridge()!;
      expect(bridge).not.toBeNull();

      const context = (resolver as unknown as { context: ResolutionContext }).context;
      const rows = context.getNodesByName('alpha'); // native throws → TS fallback
      expect(threw).toBe(true);
      expect(rows.map((n) => n.id)).toEqual(['function:alpha']); // correct rows from the TS arm
      expect(bridge.isDisabled).toBe(true); // sticky: systematic fault degrades once

      // Subsequent reads take the TS arm without touching the broken native one.
      threw = false;
      expect(context.getNodesByName('beta').map((n) => n.id)).toEqual(['function:beta']);
      expect(threw).toBe(false);
      setCtxModuleForTests(null);
    } finally {
      resolver?.dispose();
      setCtxModuleForTests(null);
      disposeCtx(ctx);
    }
  });
});
