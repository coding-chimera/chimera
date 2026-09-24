#!/usr/bin/env bun
/**
 * store-parity — R3a dual-arm graph-store parity harness (sibling of
 * script/kernel-parity.ts, the extraction-parity precedent).
 *
 * Proves the R3a acceptance gate: routing the QueryBuilder write path through
 * the native codegraph-kernel store bridge produces a BYTE-IDENTICAL four-table
 * graph (nodes / edges / unresolved_refs / files) to the TS QueryBuilder arm on
 * the same fixture ingest. Zero diff → the bridge may be enabled without an
 * EXTRACTION_SEMANTICS_VERSION bump (R3_PROPOSAL §3 R3a "不 bump"); any diff
 * blocks routing and must be attributed.
 *
 * Arms (each on its OWN temp fixture copy + temp DB, so they never share state):
 *   - TS arm     : QueryBuilder, no bridge (CODEGRAPH_STORE=0). The untouched
 *                  original write path — the parity oracle.
 *   - native arm : QueryBuilder.attachStore(StoreBridge.open(db)) — covered
 *                  writes route through store_commit_batch (per-file
 *                  OP_STORE_FILE_RESULT fusion + resurrect/re-attach).
 * Both arms run the SAME pipeline: ExtractionOrchestrator.indexAll (extract +
 * store) → resolver.runPostExtract → resolveAndPersistBatched (resolution writes
 * the stamped cross-file edges the resurrect flow depends on). Extraction and
 * resolution are deterministic and identical across arms; only the STORE
 * mechanism differs, which is exactly what this harness isolates.
 *
 * Scenarios:
 *   full      — full ingest, four-table dump diff (the primary gate).
 *   resurrect — ingest, then rename a cross-file symbol and re-index its file:
 *               the incoming stamped edge MISSES the (kind,name) re-attach map
 *               and must resurrect as its ORIGINAL pending ref (#899/#1240).
 *   reattach  — ingest, then shift a file's lines (keeping names) and re-index:
 *               node ids move but (kind,name) survives, so the incoming edge
 *               RE-ATTACHES to the new id with metadata preserved.
 *
 * Timing columns (nodes.updated_at, files.indexed_at) are normalized to 0 —
 * both arms stamp Date.now() at store time. files.modified_at is stable because
 * fixture mtimes are pinned. Every other column is compared verbatim.
 *
 * Usage:
 *   bun scripts/store-parity.ts [--scenario <full|resurrect|reattach|all>]
 *       [--keep] [--out <report.json>]
 *
 *   --keep   retain the temp fixture/DB dirs (print their paths) for inspection.
 *   --out    write the JSON report here in addition to stdout.
 *
 * Exit codes: 0 = zero diff on every scenario attempted, 1 = diffs found,
 * 3 = setup error (native store module unavailable — the harness cannot prove
 * parity with one arm). Requires a staged contract-verified kernel prebuild
 * with the R3a store exports (script/build-kernel.sh host leg). Run from
 * packages/chimera. Reads the repo only — never writes graph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/graph/db';
import { QueryBuilder } from '../src/graph/db/queries';
import { ExtractionOrchestrator } from '../src/graph/extraction';
import { createResolver, type ReferenceResolver } from '../src/graph/resolution';
import { StoreBridge } from '../src/graph/store/bridge';
import { getStoreModule, storeEnabled } from '../src/graph/store/loader';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argVal(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const scenarioFilter = argVal('--scenario') ?? 'all';
const keep = argv.includes('--keep');
const outPath = argVal('--out');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Fixed epoch for pinned mtimes → deterministic files.modified_at. */
const FIXED_MTIME = new Date(1_700_000_000_000);

interface FixtureFile {
  rel: string;
  content: string;
}

/** Phase-1 fixture: caller.ts imports + calls a cross-file symbol in mod.ts,
 *  so resolution mints a stamped caller→mod.calculateTotal edge. */
const FIXTURE_V1: FixtureFile[] = [
  {
    rel: 'mod.ts',
    content: [
      'export function helper(x: number): number {',
      '  return x + 1;',
      '}',
      'export function calculateTotal(a: number, b: number): number {',
      '  return helper(a) + b;',
      '}',
      '',
    ].join('\n'),
  },
  {
    rel: 'caller.ts',
    content: [
      "import { calculateTotal } from './mod';",
      'export function main(): number {',
      '  return calculateTotal(1, 2);',
      '}',
      '',
    ].join('\n'),
  },
];

/** RESURRECT mutation: rename calculateTotal → computeSum (the caller's stamped
 *  edge can no longer re-attach by name → resurrect). */
const MOD_RENAMED = [
  'export function helper(x: number): number {',
  '  return x + 1;',
  '}',
  'export function computeSum(a: number, b: number): number {',
  '  return helper(a) + b;',
  '}',
  '',
].join('\n');

/** REATTACH mutation: same names, but a leading banner shifts every line so the
 *  line-embedded node ids move while (kind,name) survives → re-attach. */
const MOD_LINESHIFT = [
  '// banner line 1',
  '// banner line 2',
  '// banner line 3',
  'export function helper(x: number): number {',
  '  return x + 1;',
  '}',
  'export function calculateTotal(a: number, b: number): number {',
  '  return helper(a) + b;',
  '}',
  '',
].join('\n');

function writeFixture(dir: string, files: FixtureFile[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const full = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
    fs.utimesSync(full, FIXED_MTIME, FIXED_MTIME);
  }
}

function rewriteFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.writeFileSync(full, content, 'utf8');
  fs.utimesSync(full, FIXED_MTIME, FIXED_MTIME);
}

// ---------------------------------------------------------------------------
// Arm
// ---------------------------------------------------------------------------

interface Arm {
  label: string;
  fixtureDir: string;
  dbPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  orchestrator: ExtractionOrchestrator;
  resolver: ReferenceResolver;
  bridge: StoreBridge | null;
}

async function buildArm(label: string, useBridge: boolean): Promise<Arm> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `store-parity-${label}-`));
  const fixtureDir = path.join(root, 'repo');
  const dbPath = path.join(root, 'codegraph.db');
  writeFixture(fixtureDir, FIXTURE_V1);

  const conn = DatabaseConnection.initialize(dbPath);
  const queries = new QueryBuilder(conn.getDb());
  let bridge: StoreBridge | null = null;
  if (useBridge) {
    bridge = StoreBridge.open(dbPath);
    if (!bridge) {
      conn.close();
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error(`native arm: StoreBridge.open failed for ${dbPath} (store module unavailable?)`);
    }
    queries.attachStore(bridge);
  }
  const orchestrator = new ExtractionOrchestrator(fixtureDir, queries);
  const resolver = createResolver(fixtureDir, queries);
  return { label, fixtureDir, dbPath, conn, queries, orchestrator, resolver, bridge };
}

/** Full ingest: extraction + store, then resolution (mirrors CodeGraph.indexAll). */
async function ingest(arm: Arm): Promise<void> {
  await arm.orchestrator.indexAll();
  arm.resolver.initialize();
  arm.resolver.runPostExtract();
  await arm.resolver.resolveAndPersistBatched();
}

/** Re-extract + store one changed file (the store-level re-attach/resurrect seam). */
async function reindex(arm: Arm, rel: string, content: string): Promise<void> {
  rewriteFile(arm.fixtureDir, rel, content);
  await arm.orchestrator.indexFile(rel);
}

function dispose(arm: Arm): void {
  try {
    arm.conn.close();
  } catch {
    // ignore
  }
  if (!keep) fs.rmSync(path.dirname(arm.fixtureDir), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Dump (timing-normalized four tables, deterministic order)
// ---------------------------------------------------------------------------

function dump(arm: Arm): Record<string, string[]> {
  const db = arm.conn.getDb();
  const q = (sql: string) => (db.prepare(sql).all() as unknown[]).map((row) => JSON.stringify(row));
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
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

interface TableDiff {
  table: string;
  tsCount: number;
  nativeCount: number;
  missingInNative: string[];
  extraInNative: string[];
}
interface PhaseResult {
  phase: string;
  diffs: TableDiff[];
  identical: boolean;
}

function comparePhase(phase: string, ts: Record<string, string[]>, native: Record<string, string[]>): PhaseResult {
  const diffs: TableDiff[] = [];
  for (const table of Object.keys(ts)) {
    const a = ts[table];
    const b = native[table];
    // Multiset diff (rows are already deterministically ordered, so positional
    // equality is the strongest check; report set deltas for attribution).
    const setA = new Map<string, number>();
    for (const r of a) setA.set(r, (setA.get(r) ?? 0) + 1);
    const setB = new Map<string, number>();
    for (const r of b) setB.set(r, (setB.get(r) ?? 0) + 1);
    const missingInNative: string[] = [];
    const extraInNative: string[] = [];
    for (const [row, n] of setA) {
      const m = setB.get(row) ?? 0;
      for (let i = 0; i < n - m; i++) missingInNative.push(row);
    }
    for (const [row, n] of setB) {
      const m = setA.get(row) ?? 0;
      for (let i = 0; i < n - m; i++) extraInNative.push(row);
    }
    const positionalMismatch = a.length === b.length && a.some((row, i) => row !== b[i]);
    if (missingInNative.length || extraInNative.length || positionalMismatch || a.length !== b.length) {
      diffs.push({ table, tsCount: a.length, nativeCount: b.length, missingInNative, extraInNative });
    }
  }
  return { phase, diffs, identical: diffs.length === 0 };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioReport {
  scenario: string;
  phases: PhaseResult[];
  assertions: { name: string; ok: boolean; detail: string }[];
  nativeCommits: number;
  nativeFusions: Record<string, number>;
  identical: boolean;
}

async function runScenario(
  name: string,
  mutate: (arm: Arm) => Promise<void>,
  assert: (native: Arm, ts: Arm) => { name: string; ok: boolean; detail: string }[]
): Promise<ScenarioReport> {
  const ts = await buildArm('ts', false);
  const native = await buildArm('native', true);
  const phases: PhaseResult[] = [];
  try {
    await ingest(ts);
    await ingest(native);
    phases.push(comparePhase('ingest', dump(ts), dump(native)));

    if (mutate) {
      await mutate(ts);
      await mutate(native);
      phases.push(comparePhase('mutate', dump(ts), dump(native)));
    }

    const assertions = assert(native, ts);
    const bridge = native.bridge!;
    return {
      scenario: name,
      phases,
      assertions,
      nativeCommits: bridge.commitCount,
      nativeFusions: { storeFileResult: 0, deleteFileResurrect: 0, raw: 0, ...countFusions(bridge) },
      identical: phases.every((p) => p.identical),
    };
  } finally {
    dispose(ts);
    dispose(native);
  }
}

/** Fusion-kind tally is last-value-only on the bridge; re-derive from commitCount. */
function countFusions(bridge: StoreBridge): Record<string, number> {
  // The bridge exposes lastFusion (most recent). For a coarse report we surface
  // the last kind; the parity gate does not depend on it.
  return { [bridge.lastFusion]: bridge.commitCount };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!storeEnabled() || !getStoreModule()) {
    console.error(
      'store-parity: native store module unavailable (no contract-verified prebuild with R3a store exports).\n' +
        'Build it first: packages/chimera/script/build-kernel.sh   (host leg)\n' +
        'This harness needs BOTH arms; refusing to fake parity with one.'
    );
    process.exit(3);
  }

  const scenarios: ScenarioReport[] = [];
  const want = (s: string) => scenarioFilter === 'all' || scenarioFilter === s;

  if (want('full')) {
    scenarios.push(
      await runScenario(
        'full',
        async () => {
          /* no mutation — pure full-ingest parity */
        },
        (native) => [
          {
            name: 'native arm actually used the bridge',
            ok: native.bridge!.commitCount > 0,
            detail: `commitCount=${native.bridge!.commitCount}`,
          },
          {
            name: 'graph is non-trivial (resolution minted cross-file edges)',
            ok: (native.conn.getDb().prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c > 0,
            detail: 'edges present',
          },
        ]
      )
    );
  }

  if (want('resurrect')) {
    scenarios.push(
      await runScenario(
        'resurrect',
        (arm) => reindex(arm, 'mod.ts', MOD_RENAMED),
        (native) => {
          const db = native.conn.getDb();
          const pendingRefs = (
            db
              .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE status = 'pending'`)
              .get() as { c: number }
          ).c;
          const oldEdges = (
            db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE target LIKE '%calculateTotal%'`).get() as { c: number }
          ).c;
          return [
            {
              name: 'renamed symbol resurrected a pending ref',
              ok: pendingRefs > 0,
              detail: `pending unresolved_refs=${pendingRefs}`,
            },
            {
              name: 'stale edge to the renamed symbol is gone',
              ok: oldEdges === 0,
              detail: `edges targeting *calculateTotal*=${oldEdges}`,
            },
            {
              name: 'native arm used the bridge',
              ok: native.bridge!.commitCount > 0,
              detail: `commitCount=${native.bridge!.commitCount}`,
            },
          ];
        }
      )
    );
  }

  if (want('reattach')) {
    scenarios.push(
      await runScenario(
        'reattach',
        (arm) => reindex(arm, 'mod.ts', MOD_LINESHIFT),
        (native) => {
          const db = native.conn.getDb();
          // After a line shift the calculateTotal node id moved; the caller's
          // edge must have re-attached to the NEW id (some edge still targets a
          // calculateTotal node), and no pending ref was resurrected for it.
          const reattached = (
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM edges e JOIN nodes n ON n.id = e.target
                 WHERE n.name = 'calculateTotal' AND e.kind != 'contains'`
              )
              .get() as { c: number }
          ).c;
          const pendingForCalculate = (
            db
              .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_name LIKE '%calculateTotal%'`)
              .get() as { c: number }
          ).c;
          return [
            {
              name: 'name-kept line shift re-attached the cross-file edge',
              ok: reattached > 0,
              detail: `re-attached edges into calculateTotal=${reattached}`,
            },
            {
              name: 'no spurious resurrection on a clean re-attach',
              ok: pendingForCalculate === 0,
              detail: `pending refs naming calculateTotal=${pendingForCalculate}`,
            },
          ];
        }
      )
    );
  }

  // ---- report ----
  let allIdentical = true;
  let allAssertionsOk = true;
  const report = { generatedAt: FIXED_MTIME.toISOString(), scenarios };
  for (const s of scenarios) {
    const identical = s.identical;
    allIdentical = allIdentical && identical;
    const assertsOk = s.assertions.every((a) => a.ok);
    allAssertionsOk = allAssertionsOk && assertsOk;
    console.log(
      `\n[${s.scenario}] four-table parity: ${identical ? 'IDENTICAL ✓' : 'DIFF ✗'}  (native commits=${s.nativeCommits})`
    );
    for (const p of s.phases) {
      if (p.identical) {
        console.log(`  phase ${p.phase}: 0 diffs`);
      } else {
        for (const d of p.diffs) {
          console.log(
            `  phase ${p.phase} table ${d.table}: ts=${d.tsCount} native=${d.nativeCount} ` +
              `missingInNative=${d.missingInNative.length} extraInNative=${d.extraInNative.length}`
          );
          for (const row of d.missingInNative.slice(0, 5)) console.log(`    - ts-only: ${row}`);
          for (const row of d.extraInNative.slice(0, 5)) console.log(`    + native-only: ${row}`);
        }
      }
    }
    for (const a of s.assertions) {
      console.log(`  assert ${a.ok ? '✓' : '✗'} ${a.name} (${a.detail})`);
    }
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nreport written to ${outPath}`);
  }

  const ok = allIdentical && allAssertionsOk;
  console.log(`\nstore-parity: ${ok ? 'PASS (zero diff, all assertions)' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

await main();
