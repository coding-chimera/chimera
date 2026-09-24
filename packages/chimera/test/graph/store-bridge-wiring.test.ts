/**
 * R3a-3 production-wiring tests — the store bridge is the DEFAULT write arm
 * for read-write CodeGraph instances, never attached on readOnly opens, and
 * its handle lifecycle is paired with the connection lifecycle.
 *
 * Coverage:
 *   - attach on init/open/openSync (read-write) + native commits during indexAll
 *   - no attach with CODEGRAPH_STORE=0 (kill switch) or readOnly opens
 *     (crossProject states open readOnly — provenance.ts — so they are covered
 *     by the readOnly case)
 *   - handle release pairing: CodeGraph.close() → QueryBuilder.dispose() →
 *     StoreBridge.close() (isClosed), idempotent double close, post-dispose
 *     writes silently take the TS arm
 *   - CodeGraph-level dual-arm smoke: full index + incremental sync (modify +
 *     delete) with kill switch ON vs OFF produce IDENTICAL four-table dumps —
 *     the production re-index smoke for both arms, including the incremental
 *     sync path through the bridge (fused OP_STORE_FILE_RESULT /
 *     OP_DELETE_FILE+RESURRECT).
 *
 * Native tests skip when the local prebuild lacks the R3a store exports.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { CodeGraph } from '../../src/graph';
import { DatabaseConnection, getDatabasePath } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';
import { StoreBridge } from '../../src/graph/store/bridge';
import { resetStoreForTests, setStoreModuleForTests } from '../../src/graph/store/loader';
import type { StoreModule } from '../../src/graph/store/loader';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const prebuildPath = path.join(
  repoRoot,
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
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
// Fixture (pinned, per-step mtimes so sync's stat pre-filter sees changes)
// ---------------------------------------------------------------------------

const FIXTURE_V1: Array<[string, string]> = [
  [
    'mod.ts',
    [
      'export function helper(x: number): number {',
      '  return x + 1;',
      '}',
      'export function calculateTotal(a: number, b: number): number {',
      '  return helper(a) + b;',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'caller.ts',
    [
      "import { calculateTotal } from './mod';",
      'export function main(): number {',
      '  return calculateTotal(1, 2);',
      '}',
      '',
    ].join('\n'),
  ],
];

const MOD_RENAMED = [
  'export function helper(x: number): number {',
  '  return x + 1;',
  '}',
  'export function computeSum(a: number, b: number): number {',
  '  return helper(a) + b;',
  '}',
  '',
].join('\n');

function writeFixture(dir: string, mtimeMs: number): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of FIXTURE_V1) {
    const full = path.join(dir, rel);
    fs.writeFileSync(full, content, 'utf8');
    const d = new Date(mtimeMs);
    fs.utimesSync(full, d, d);
  }
}

function rewrite(dir: string, rel: string, content: string, mtimeMs: number): void {
  const full = path.join(dir, rel);
  fs.writeFileSync(full, content, 'utf8');
  const d = new Date(mtimeMs);
  fs.utimesSync(full, d, d);
}

/** Deterministic four-table dump (timing columns normalized to 0). */
function dump(dbPath: string): Record<string, string[]> {
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const db = conn.getDb();
    const q = (sql: string) => (db.prepare(sql).all() as unknown[]).map((r) => JSON.stringify(r));
    return {
      nodes: q(
        `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
                start_column, end_column, docstring, signature, visibility,
                is_exported, is_async, is_static, is_abstract, decorators, type_parameters,
                return_type, params_json, search_text, 0 AS updated_at
         FROM nodes ORDER BY id`
      ),
      edges: q(
        `SELECT source, target, kind, metadata, line, col, provenance FROM edges
         ORDER BY source, target, kind, IFNULL(line,-1), IFNULL(col,-1), IFNULL(provenance,'')`
      ),
      refs: q(
        `SELECT from_node_id, reference_name, reference_kind, line, col, candidates,
                file_path, language, status, name_tail FROM unresolved_refs
         ORDER BY from_node_id, reference_name, reference_kind, line, col`
      ),
      files: q(
        `SELECT path, content_hash, language, size, modified_at, 0 AS indexed_at, node_count, errors
         FROM files ORDER BY path`
      ),
    };
  } finally {
    conn.close();
  }
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

function tempRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-store-wiring-${tag}-`));
}

// ---------------------------------------------------------------------------
// Production attach defaults
// ---------------------------------------------------------------------------

nativeDescribe('production wiring — default attach on read-write opens', () => {
  it('CodeGraph.init attaches the bridge and indexAll writes through it', async () => {
    const dir = tempRoot('init');
    writeFixture(dir, 1_700_000_000_000);
    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.init(dir, { index: true });
      const bridge = cg.getStoreBridge();
      expect(bridge).not.toBeNull();
      expect(bridge!.live()).toBe(true);
      expect(bridge!.commitCount).toBeGreaterThan(0);
      // The canonical per-file store shape fused to OP_STORE_FILE_RESULT
      // (one per indexed file; resolution's single-op commits ride 'raw').
      expect(bridge!.fusionCounts.storeFileResult).toBeGreaterThanOrEqual(2);
      // Data actually landed (readable through the same instance).
      expect((cg as unknown as { queries: QueryBuilder }).queries.getFileCount()).toBe(2);
    } finally {
      await cg?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CodeGraph.open (read-write) attaches; openSync attaches', async () => {
    const dir = tempRoot('open');
    writeFixture(dir, 1_700_000_000_000);
    const bootstrap = await CodeGraph.init(dir, { index: false });
    await bootstrap.close();
    let rw: CodeGraph | null = null;
    let sync: CodeGraph | null = null;
    try {
      rw = await CodeGraph.open(dir);
      expect(rw.getStoreBridge()).not.toBeNull();
      sync = CodeGraph.openSync(dir);
      expect(sync.getStoreBridge()).not.toBeNull();
    } finally {
      await rw?.close();
      await sync?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readOnly opens NEVER attach (rusqlite handle would open read-write; crossProject is readOnly)', async () => {
    const dir = tempRoot('readonly');
    writeFixture(dir, 1_700_000_000_000);
    const bootstrap = await CodeGraph.init(dir, { index: false });
    await bootstrap.close();
    let ro: CodeGraph | null = null;
    try {
      ro = await CodeGraph.open(dir, { readOnly: true });
      expect(ro.getStoreBridge()).toBeNull();
    } finally {
      await ro?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CODEGRAPH_STORE=0 at construction keeps the TS arm (kill switch)', async () => {
    const dir = tempRoot('kill');
    writeFixture(dir, 1_700_000_000_000);
    process.env.CODEGRAPH_STORE = '0';
    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.init(dir, { index: true });
      expect(cg.getStoreBridge()).toBeNull();
      expect((cg as unknown as { queries: QueryBuilder }).queries.getFileCount()).toBe(2);
    } finally {
      await cg?.close();
      delete process.env.CODEGRAPH_STORE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Handle lifecycle pairing (R1: no unpaired resources)
// ---------------------------------------------------------------------------

nativeDescribe('handle lifecycle pairing', () => {
  it('CodeGraph.close() closes the bridge deterministically; double close is safe', async () => {
    const dir = tempRoot('close');
    writeFixture(dir, 1_700_000_000_000);
    const cg = await CodeGraph.init(dir, { index: false });
    const bridge = cg.getStoreBridge();
    expect(bridge).not.toBeNull();
    expect(bridge!.isClosed).toBe(false);
    await cg.close();
    expect(bridge!.isClosed).toBe(true);
    expect(bridge!.live()).toBe(false);
    await cg.close(); // idempotent
    await cg.destroy(); // deprecated alias, also idempotent
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('QueryBuilder.dispose() releases the handle and later writes take the TS arm', () => {
    const dir = tempRoot('dispose');
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const bridge = StoreBridge.open(dbPath);
    expect(bridge).not.toBeNull();
    const queries = new QueryBuilder(conn.getDb(), bridge);
    try {
      queries.dispose();
      expect(bridge!.isClosed).toBe(true);
      expect(queries.getStoreBridge()).toBeNull();
      // Post-dispose write: silently the TS arm, fully functional.
      queries.insertNodes([
        {
          id: 'function:post',
          kind: 'function',
          name: 'post',
          qualifiedName: 'post',
          filePath: 'p.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: 1700000000000,
        },
      ]);
      expect(queries.getNodeById('function:post')).not.toBeNull();
      expect(bridge!.commitCount).toBe(0);
    } finally {
      conn.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a closed native handle rejects further calls (Rust-side defense in depth)', () => {
    const dir = tempRoot('closed-handle');
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const bridge = StoreBridge.open(dbPath)!;
    try {
      bridge.close();
      // Direct module-level call against the closed handle must fail with the
      // closed error — the TS routing never does this (live() gates it), but
      // the Rust side defends independently.
      expect(bridge.live()).toBe(false);
      expect(() =>
        bridge.commit([
          {
            kind: 'insertNodes',
            nodes: [
              {
                id: 'function:x',
                kind: 'function',
                name: 'x',
                qualifiedName: 'x',
                filePath: 'x.ts',
                language: 'typescript',
                startLine: 1,
                endLine: 1,
                startColumn: 0,
                endColumn: 0,
                updatedAt: 1,
              },
            ],
          },
        ])
      ).toThrow(/closed/);
    } finally {
      conn.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CodeGraph-level dual-arm smoke: index + incremental sync (modify + delete)
// ---------------------------------------------------------------------------

nativeDescribe('dual-arm production smoke (kill switch ON vs OFF)', () => {
  async function runArm(tag: string, kill: boolean): Promise<{ phases: string[]; commits: number[]; dir: string }> {
    if (kill) process.env.CODEGRAPH_STORE = '0';
    else delete process.env.CODEGRAPH_STORE;
    const dir = tempRoot(`smoke-${tag}`);
    writeFixture(dir, 1_700_000_000_000);
    const dbPath = getDatabasePath(dir);
    const cg = await CodeGraph.init(dir, { index: true });
    const bridge = cg.getStoreBridge();
    if (!kill) expect(bridge).not.toBeNull();
    if (kill) expect(bridge).toBeNull();
    const phases: string[] = [];
    const commits: number[] = [];
    try {
      phases.push(JSON.stringify(dump(dbPath)));
      commits.push(bridge?.commitCount ?? 0);

      // Incremental sync step 1: modify mod.ts (rename) → re-extract + store
      // through the fused OP_STORE_FILE_RESULT, resurrecting caller's edge.
      rewrite(dir, 'mod.ts', MOD_RENAMED, 1_700_000_100_000);
      await cg.sync();
      phases.push(JSON.stringify(dump(dbPath)));
      commits.push(bridge?.commitCount ?? 0);

      // Incremental sync step 2: delete caller.ts → removeFileResurrectingRefs
      // through the fused OP_DELETE_FILE + RESURRECT.
      fs.rmSync(path.join(dir, 'caller.ts'));
      await cg.sync();
      phases.push(JSON.stringify(dump(dbPath)));
      commits.push(bridge?.commitCount ?? 0);
      return { phases, commits, dir };
    } finally {
      await cg.close();
    }
  }

  it('index + sync(modify) + sync(delete) are byte-identical across arms; sync writes route through the bridge', async () => {
    const native = await runArm('native', false);
    const ts = await runArm('ts', true);
    try {
      // Four-table dumps identical at every checkpoint.
      expect(native.phases).toEqual(ts.phases);
      // The native arm actually used the bridge during the incremental syncs
      // (commitCount grew after index AND across both sync steps).
      expect(native.commits[0]).toBeGreaterThan(0);
      expect(native.commits[1]).toBeGreaterThan(native.commits[0]);
      expect(native.commits[2]).toBeGreaterThan(native.commits[1]);
      // Resurrect semantics, checked on the arm-independent dumps: after the
      // rename (phase 1) caller's stamped edge became a ref naming
      // calculateTotal; after caller.ts was deleted (phase 2) only mod.ts
      // remains and caller's refs cascaded away with its nodes.
      const renamed = JSON.parse(native.phases[1]) as Record<string, unknown[]>;
      const renamedRefs = (renamed.refs as string[]).map((r) => JSON.parse(r) as Record<string, unknown>);
      expect(renamedRefs.some((r) => String(r.reference_name).includes('calculateTotal'))).toBe(true);
      const final = JSON.parse(native.phases[2]) as Record<string, unknown[]>;
      expect(final.files.length).toBe(1); // only mod.ts remains
      const finalRefs = (final.refs as string[]).map((r) => JSON.parse(r) as Record<string, unknown>);
      expect(finalRefs.every((r) => !String(r.from_node_id).includes('caller'))).toBe(true);
    } finally {
      delete process.env.CODEGRAPH_STORE;
      fs.rmSync(native.dir, { recursive: true, force: true });
      fs.rmSync(ts.dir, { recursive: true, force: true });
    }
  }, 180_000);
});
