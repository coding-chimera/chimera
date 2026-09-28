#!/usr/bin/env bun
/**
 * resolution-parity — R3c dual-arm resolution parity harness (sibling of
 * scripts/store-parity.ts (R3a) and scripts/ctx-parity.ts (R3b)).
 *
 * Proves the R3c acceptance gate (R3_PROPOSAL §5.2): the NATIVE resolve arm
 * (resolve_batch: Rust strategy tree + createEdges + file-level import sweep,
 * Plan A precomputed external tables) produces the SAME stored graph as the
 * TS arm (resolveBatchYielding + createEdges + materializeFileLevelImportEdges)
 * over one fixture repo:
 *   - resolved edge SET as (source, target, kind, refName) 4-tuples, plus
 *     the full metadata object (resolvedBy/refKind/fnRef/href stamps) —
 *     deep-equal, order-independent;
 *   - stored metadata BYTES (strict string compare — the native arm's TS-side
 *     stamp assembly must reproduce JS stringify key order exactly);
 *   - unresolved_refs terminal state (deleted vs failed distribution);
 *   - aggregate stats (total/resolved/unresolved + byMethod).
 * The fixture includes the load-bearing arbitration shapes: same-name
 * multi-candidate files (CG-33 row order → pickBestCandidate), import-arm
 * refs, Strategy 0.5 receiver evidence, extends→implements and
 * calls→instantiates promotions, function_ref edges, the zustand-shaped
 * store binding (synthetic holder-key path), and Python builtin gates.
 *
 * Arms (each its own temp fixture copy + temp DB; store AND ctx bridges stay
 * attached on both so writes/reads are identical — CODEGRAPH_RESOLVE alone
 * toggles the resolve arm):
 *   - TS arm     : CODEGRAPH_RESOLVE=0 → resolve bridge null → TS batches.
 *   - native arm : resolve unset → ResolveBridge live → resolve_batch.
 *
 * Usage:
 *   bun scripts/resolution-parity.ts [--keep] [--out <report.json>]
 *
 * Exit codes: 0 = zero diff on every face, 1 = diffs found (routing must
 * stay off / EXTRACTION_SEMANTICS_VERSION adjudication required), 3 = setup
 * error (a contract-verified kernel prebuild with the R3c resolve exports is
 * required — this harness refuses to fake parity with one arm).
 * Requires: packages/chimera/script/build-kernel.sh (host leg). Run from
 * packages/chimera. Reads the repo only — never writes graph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection, getDatabasePath } from '../src/graph/db';
import { QueryBuilder } from '../src/graph/db/queries';
import { ExtractionOrchestrator } from '../src/graph/extraction';
import { createResolver, type ReferenceResolver } from '../src/graph/resolution';
import { StoreBridge } from '../src/graph/store/bridge';
import { getResolveModule, getStoreModule, getCtxModule } from '../src/graph/store/loader';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const outPath = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 ? argv[i + 1] : undefined;
})();

// ---------------------------------------------------------------------------
// Fixture — one exercising file per strategy family (see header)
// ---------------------------------------------------------------------------

const FIXED_MTIME = new Date(1_700_000_000_000);

interface FixtureFile {
  rel: string;
  content: string;
}

const FIXTURE: FixtureFile[] = [
  {
    rel: 'math.ts',
    content: [
      'export function helper(x: number): number {',
      '  return x + 1;',
      '}',
      'export class Totaller {',
      '  private factor = 2;',
      '  scale(v: number): number {',
      '    return v * this.factor;',
      '  }',
      '}',
      'export function calculateTotal(a: number, b: number): number {',
      '  return helper(a) + b;',
      '}',
      '',
    ].join('\n'),
  },
  {
    // Import arm + `new Totaller()` (calls→instantiates promotion) +
    // Strategy 0.5 declaration evidence (`const t = new Totaller()` → t.scale).
    rel: 'user.ts',
    content: [
      "import { calculateTotal, Totaller } from './math';",
      'export function main(): number {',
      '  const t = new Totaller();',
      '  return calculateTotal(1, 2) + t.scale(3);',
      '}',
      '',
    ].join('\n'),
  },
  // Same-name multi-candidate arbitration (CG-33 row order): `dup` lives in
  // two files at DIFFERENT lines; dupuser imports exactly one of them.
  {
    rel: 'dup.ts',
    content: ['export function dup(): number {', '  return 1;', '}', '', 'export const other = 2;', ''].join('\n'),
  },
  {
    rel: 'sub/dup2.ts',
    content: [
      '// lead line 1',
      '// lead line 2',
      '// lead line 3',
      'export function dup(): number {',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
  },
  {
    rel: 'dupuser.ts',
    content: ["import { dup } from './dup';", 'export function go(): number {', '  return dup();', '}', ''].join('\n'),
  },
  // extends→implements promotion (class source targeting an interface).
  {
    rel: 'shape.ts',
    content: ['export interface Shape {', '  area(): number;', '}', 'export class Square {', '  area(): number {', '    return 4;', '  }', '}', ''].join('\n'),
  },
  {
    rel: 'extend.ts',
    content: ["import { Shape } from './shape';", 'export class Impl extends Shape {', '  area(): number {', '    return 1;', '  }', '}', ''].join('\n'),
  },
  // function_ref (#756): callback registration through an import.
  {
    rel: 'cb.ts',
    content: ['export function register(handler: () => void): void {', '  handler();', '}', ''].join('\n'),
  },
  {
    rel: 'cbuser.ts',
    content: [
      "import { register } from './cb';",
      'function onClick(): void {',
      '  // noop',
      '}',
      'export function wire(): void {',
      '  register(onClick);',
      '}',
      '',
    ].join('\n'),
  },
  // zustand-shaped store binding: object-literal member containment (#1573)
  // + destructured getState binding (#1683) + the synthetic holder-key
  // resolveImport path (R3c-1's named pit).
  {
    rel: 'store.ts',
    content: [
      'export function create(fn: (set: unknown, get: unknown) => unknown): unknown {',
      '  return fn(null, null);',
      '}',
      'export const useStore = create((set, get) => ({',
      '  fetchUser(): string {',
      "    return 'u';",
      '  },',
      '}));',
      '',
    ].join('\n'),
  },
  {
    rel: 'comp.ts',
    content: [
      "import { useStore } from './store';",
      'const { fetchUser } = useStore.getState();',
      'export function go(): string {',
      '  return fetchUser();',
      '}',
      '',
    ].join('\n'),
  },
  // barrel re-export chain (findExportedSymbol through getReExports).
  {
    rel: 'barrel.ts',
    content: ["export { helper as h } from './math';", "export * from './sub/dup2';", ''].join('\n'),
  },
  {
    rel: 'barreluser.ts',
    content: ["import { h } from './barrel';", 'export function go(): number {', '  return h(1);', '}', ''].join('\n'),
  },
  // Python builtin gates: print/len are external; `index` is a builtin-method
  // name WITH a project declaration (knownNames guard must keep the edge).
  {
    rel: 'py.py',
    content: ['def index():', '    return 1', '', '', 'def use():', '    print(len([1]))', '    return index()', ''].join('\n'),
  },
];

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FIXTURE) {
    const full = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
    fs.utimesSync(full, FIXED_MTIME, FIXED_MTIME);
  }
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Arm {
  label: string;
  dir: string;
  dbPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  resolver: ReferenceResolver;
  store: StoreBridge | null;
  stats: { total: number; resolved: number; unresolved: number; byMethod: Record<string, number> };
}

async function buildArm(label: string, resolveNative: boolean): Promise<Arm> {
  if (resolveNative) delete process.env.CODEGRAPH_RESOLVE;
  else process.env.CODEGRAPH_RESOLVE = '0';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `resolve-parity-${label}-`));
  const dir = path.join(root, 'repo');
  writeFixture(dir);
  const dbPath = getDatabasePath(dir);

  const conn = DatabaseConnection.initialize(dbPath);
  const store = StoreBridge.open(dbPath);
  if (!store) {
    conn.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`${label} arm: StoreBridge.open failed — cannot build a comparable pair`);
  }
  const queries = new QueryBuilder(conn.getDb(), store);
  const orchestrator = new ExtractionOrchestrator(dir, queries);
  await orchestrator.indexAll();
  const resolver = createResolver(dir, queries);
  resolver.initialize();
  resolver.runPostExtract();
  const result = await resolver.resolveAndPersistBatched();
  const bridge = resolver.getResolveBridge();
  if (resolveNative) {
    if (!bridge) throw new Error('native arm: resolver did not attach a ResolveBridge (contract/loader failure?)');
    if (bridge.batchCount === 0) throw new Error('native arm: zero resolve_batch crossings (routing broken?)');
  } else if (bridge) {
    throw new Error('TS arm: CODEGRAPH_RESOLVE=0 still attached a ResolveBridge');
  }
  return {
    label,
    dir,
    dbPath,
    conn,
    queries,
    resolver,
    store,
    stats: result.stats,
  };
}

function disposeArm(arm: Arm): void {
  try {
    arm.resolver.dispose();
  } catch {
    // ignore
  }
  try {
    arm.queries.dispose();
  } catch {
    // ignore
  }
  try {
    arm.conn.close();
  } catch {
    // ignore
  }
  if (!keep) fs.rmSync(path.dirname(arm.dir), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Comparison faces
// ---------------------------------------------------------------------------

interface EdgeFace {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
  refName: string | null;
  /** metadata WITHOUT refName (extraction-resurrect stamp — the TS arm sets
   *  it at extract time, the native arm never sees those refs; its presence
   *  is asserted separately as TS-arm-only). */
  meta: Record<string, unknown> | null;
  metaStrict: string;
}

function dumpEdges(dbPath: string): { faces: EdgeFace[]; strict: string[]; resurrectNames: string[] } {
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const db = conn.getDb();
    const rows = db
      .prepare(
        `SELECT source, target, kind, metadata, line, col FROM edges
         ORDER BY source, target, kind, IFNULL(line,-1), IFNULL(col,-1), IFNULL(metadata,'')`
      )
      .all() as Array<{ source: string; target: string; kind: string; metadata: string | null; line: number | null; col: number | null }>;
    const faces: EdgeFace[] = [];
    const strict: string[] = [];
    const resurrectNames: string[] = [];
    for (const r of rows) {
      let refName: string | null = null;
      let meta: Record<string, unknown> | null = null;
      if (r.metadata) {
        try {
          const m = JSON.parse(r.metadata) as Record<string, unknown>;
          refName = typeof m.refName === 'string' ? m.refName : null;
          meta = { ...m };
          delete meta.refName;
        } catch {
          meta = { raw: r.metadata };
        }
      }
      if (refName) resurrectNames.push(`${r.source}\u0000${r.target}\u0000${refName}`);
      faces.push({ source: r.source, target: r.target, kind: r.kind, line: r.line, col: r.col, refName, meta, metaStrict: r.metadata ?? '' });
      strict.push(`${r.source}|${r.target}|${r.kind}|${r.line}|${r.col}|${r.metadata ?? ''}`);
    }
    return { faces, strict, resurrectNames };
  } finally {
    conn.close();
  }
}

function dumpRefs(dbPath: string): string[] {
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const db = conn.getDb();
    const rows = db
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface FaceResult {
  name: string;
  equal: boolean;
  tsSample?: string;
  nativeSample?: string;
}

function compare(name: string, a: unknown, b: unknown, results: FaceResult[]): void {
  const equal = Bun.deepEquals(a, b);
  results.push({
    name,
    equal,
    ...(equal
      ? {}
      : {
          tsSample: JSON.stringify(a)?.slice(0, 600),
          nativeSample: JSON.stringify(b)?.slice(0, 600),
        }),
  });
}

async function main(): Promise<void> {
  if (!getStoreModule() || !getCtxModule() || !getResolveModule()) {
    console.error(
      'resolution-parity: store/ctx/resolve module unavailable (need a contract-verified\n' +
        'prebuild with the R3a+R3b+R3c exports).\n' +
        'Build it first: packages/chimera/script/build-kernel.sh   (host leg)\n' +
        'This harness needs BOTH arms; refusing to fake parity with one.'
    );
    process.exit(3);
  }

  const ts = await buildArm('ts', false);
  const native = await buildArm('native', true);
  const results: FaceResult[] = [];
  try {
    const tsEdges = dumpEdges(ts.dbPath);
    const nativeEdges = dumpEdges(native.dbPath);

    // Gate 1: the resolved-edge 4-tuple set + full metadata objects.
    compare(
      'edge faces (source,target,kind,line,col,refName,metadata-object)',
      tsEdges.faces.map(({ metaStrict: _drop, ...rest }) => rest),
      nativeEdges.faces.map(({ metaStrict: _drop, ...rest }) => rest),
      results
    );
    // Gate 2: stored metadata BYTES (key-order parity — the TS-side stamp
    // assembly from wire stamps must reproduce the TS arm's stringify order).
    compare('edge metadata strict bytes', tsEdges.strict, nativeEdges.strict, results);
    // Gate 3: unresolved_refs terminal state.
    compare('unresolved_refs terminal state', dumpRefs(ts.dbPath), dumpRefs(native.dbPath), results);
    // Gate 4: aggregate stats (byMethod compared as objects — key order free).
    compare('stats.total', ts.stats.total, native.stats.total, results);
    compare('stats.resolved', ts.stats.resolved, native.stats.resolved, results);
    compare('stats.unresolved', ts.stats.unresolved, native.stats.unresolved, results);
    compare('stats.byMethod', ts.stats.byMethod, native.stats.byMethod, results);
    // The refName resurrection stamp is TS-arm-only by design (the native arm
    // never touches extraction re-attach); assert it EXISTS on the TS arm so
    // gate 1's refName:null normalization is provably scoped to that source.
    results.push({
      name: 'TS arm carries extraction refName stamps (native-arm exemption is scoped)',
      equal: tsEdges.resurrectNames.length > 0,
    });
  } finally {
    disposeArm(ts);
    disposeArm(native);
    delete process.env.CODEGRAPH_RESOLVE;
  }

  const diffs = results.filter((r) => !r.equal);
  for (const r of results) {
    console.log(`${r.equal ? '✓' : '✗'} ${r.name}`);
    if (!r.equal) {
      console.log(`    ts     : ${r.tsSample}`);
      console.log(`    native : ${r.nativeSample}`);
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    faces: results.length,
    diffs: diffs.length,
    failures: diffs,
  };
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`report written to ${outPath}`);
  }
  const ok = diffs.length === 0;
  console.log(`resolution-parity: ${ok ? 'PASS (zero diff on every face)' : 'FAIL — routing must stay off; adjudicate each diff'}`);
  process.exit(ok ? 0 : 1);
}

await main();
