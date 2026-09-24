#!/usr/bin/env bun
/**
 * ctx-parity — R3b dual-arm resolution read-context parity harness (sibling
 * of scripts/store-parity.ts, the R3a write-path gate).
 *
 * Proves the R3b acceptance gate: every ResolutionContext getter routed
 * through the native resolver_ctx arm returns a DEEP-EQUAL result to the TS
 * createContext arm over the same fixture DB — including the load-bearing
 * surfaces:
 *   - getNodesByName multi-candidate ordering (ORDER BY file_path, start_line
 *     — CG-33; same-name candidate arbitration binds to the first row)
 *   - batch group order (one group per requested key, REQUEST ORDER)
 *   - readFile null (miss) vs '' (empty file) vs lossy U+FFFD (invalid UTF-8)
 *   - getFileLines [''] (empty file) vs [] (unreadable)
 *   - fileExists normalization (raw + `\`→`/` knownFiles membership, fs
 *     fallback for unindexed paths, directories)
 *   - import mappings / re-exports (default/namespace/renamed, named/wildcard)
 *   - node-row decode parity with queries.ts rowToNode (visibility null vs
 *     undefined, params/decorators JSON, flags === 1 semantics)
 * Plus an end-to-end leg: both arms run the FULL pipeline (indexAll +
 * resolution) and the four-table dumps must be identical — resolution output
 * is a function of the context, so any getter drift that changes binding
 * shows up as a stored-edge diff.
 *
 * Arms (each on its own temp fixture copy + temp DB; both keep the store
 * bridge attached so the WRITE path is identical — CODEGRAPH_CTX alone
 * toggles the read-context arm):
 *   - TS arm     : CODEGRAPH_CTX=0 → resolver ctx = null → TS getters.
 *   - native arm : ctx unset → CtxBridge live → routed getters.
 *
 * Usage:
 *   bun scripts/ctx-parity.ts [--keep] [--out <report.json>]
 *
 * Exit codes: 0 = zero diff on every probe + identical four-table dumps,
 * 1 = diffs found, 3 = setup error (store/ctx module unavailable — the
 * harness cannot prove parity with one arm). Requires the locally staged
 * contract-verified kernel prebuild (script/build-kernel.sh host leg).
 * Run from packages/chimera. Reads the repo only — never writes graph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection, getDatabasePath } from '../src/graph/db';
import { QueryBuilder } from '../src/graph/db/queries';
import { ExtractionOrchestrator } from '../src/graph/extraction';
import { createResolver, type ReferenceResolver, type ResolutionContext } from '../src/graph/resolution';
import { StoreBridge } from '../src/graph/store/bridge';
import { getCtxModule, getStoreModule } from '../src/graph/store/loader';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const outPath = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 ? argv[i + 1] : undefined;
})();

// ---------------------------------------------------------------------------
// Fixture — every getter gets at least one exercising file
// ---------------------------------------------------------------------------

const FIXED_MTIME = new Date(1_700_000_000_000);

interface FixtureFile {
  rel: string;
  content: string | Buffer;
}

const FIXTURE: FixtureFile[] = [
  {
    rel: 'mod.ts',
    content: [
      '/**',
      ' * Totals things.',
      ' */',
      'export function helper(x: number): number {',
      '  return x + 1;',
      '}',
      'export class Totaller {',
      '  private factor = 2;',
      '  async scale<T extends number>(values: T[]): Promise<T> {',
      '    return values[0];',
      '  }',
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
  // Same symbol name in two files at DIFFERENT lines — the CG-33
  // getNodesByName ordering fixture (arbitration binds to the first row).
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
  // Import/re-export forms for getImportMappings / getReExports.
  {
    rel: 'imports.ts',
    content: [
      "import def from './mod';",
      "import * as ns from './mod';",
      "import { calculateTotal as ct, helper } from './mod';",
      "export { helper as h } from './mod';",
      "export * from './sub/dup2';",
      'export function useAll(): unknown {',
      '  return [def, ns, ct, helper];',
      '}',
      '',
    ].join('\n'),
  },
  // Empty file → readFile '', getFileLines [''].
  { rel: 'empty.ts', content: '' },
  // Invalid UTF-8 (never indexed — not a source extension) → readFile lossy
  // U+FFFD parity between Node's utf8 decode and Rust's from_utf8_lossy.
  { rel: 'raw/data.dat', content: Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x41, 0x0a]) },
];

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FIXTURE) {
    const full = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (typeof f.content === 'string') fs.writeFileSync(full, f.content, 'utf8');
    else fs.writeFileSync(full, f.content);
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
  context: ResolutionContext;
  store: StoreBridge | null;
}

async function buildArm(label: string, ctxNative: boolean): Promise<Arm> {
  if (ctxNative) delete process.env.CODEGRAPH_CTX;
  else process.env.CODEGRAPH_CTX = '0';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ctx-parity-${label}-`));
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
  await resolver.resolveAndPersistBatched();
  const ctx = resolver.getCtxBridge();
  if (ctxNative && !ctx) throw new Error('native arm: resolver did not attach a CtxBridge (contract/loader failure?)');
  if (!ctxNative && ctx) throw new Error('TS arm: CODEGRAPH_CTX=0 still attached a CtxBridge');
  return {
    label,
    dir,
    dbPath,
    conn,
    queries,
    resolver,
    context: (resolver as unknown as { context: ResolutionContext }).context,
    store,
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

function dumpTables(dbPath: string): string {
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const db = conn.getDb();
    const q = (sql: string) => (db.prepare(sql).all() as unknown[]).map((r) => JSON.stringify(r));
    return JSON.stringify({
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
    });
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Probes — identical call sequence on both arms' ResolutionContext
// ---------------------------------------------------------------------------

interface Probe {
  name: string;
  run: (ctx: ResolutionContext, keys: ProbeKeys) => unknown;
}

/** DB-derived keys so both arms probe the SAME ids/qualified names. */
interface ProbeKeys {
  nodeId: string;
  qualifiedName: string;
  methodName: string;
}

function deriveKeys(arm: Arm): ProbeKeys {
  const db = arm.conn.getDb();
  const nodeRow = db
    .prepare(`SELECT id, qualified_name FROM nodes WHERE name = 'calculateTotal' AND kind = 'function' LIMIT 1`)
    .get() as { id: string; qualified_name: string } | undefined;
  if (!nodeRow) throw new Error('fixture produced no calculateTotal function node');
  const methodRow = db
    .prepare(`SELECT name FROM nodes WHERE kind = 'method' LIMIT 1`)
    .get() as { name: string } | undefined;
  return {
    nodeId: nodeRow.id,
    qualifiedName: nodeRow.qualified_name,
    methodName: methodRow?.name ?? 'scale',
  };
}

const PROBES: Probe[] = [
  // --- node getters -------------------------------------------------------
  { name: 'getNodesInFile(mod.ts)', run: (c) => c.getNodesInFile('mod.ts') },
  { name: 'getNodesInFile(imports.ts)', run: (c) => c.getNodesInFile('imports.ts') },
  { name: 'getNodesInFile(missing)', run: (c) => c.getNodesInFile('nope/missing.ts') },
  { name: 'getNodesInFile(empty.ts)', run: (c) => c.getNodesInFile('empty.ts') },
  // Multi-candidate ORDER (CG-33 load-bearing): 'dup' lives in two files at
  // different lines — the row order IS the arbitration input.
  { name: 'getNodesByName(dup) [CG-33 order]', run: (c) => c.getNodesByName('dup') },
  { name: 'getNodesByName(calculateTotal)', run: (c) => c.getNodesByName('calculateTotal') },
  { name: 'getNodesByName(helper)', run: (c) => c.getNodesByName('helper') },
  { name: 'getNodesByName(missing)', run: (c) => c.getNodesByName('__no_such_symbol__') },
  { name: 'getNodesByQualifiedName(hit)', run: (c, k) => c.getNodesByQualifiedName(k.qualifiedName) },
  { name: 'getNodesByQualifiedName(miss)', run: (c) => c.getNodesByQualifiedName('__no.such.qn__') },
  { name: 'getNodesByLowerName(mixed case)', run: (c) => c.getNodesByLowerName('CALCULATETOTAL') },
  { name: 'getNodesByLowerName(dup)', run: (c) => c.getNodesByLowerName('dup') },
  { name: 'getNodesByKind(function)', run: (c) => c.getNodesByKind('function') },
  { name: 'getNodesByKind(file)', run: (c) => c.getNodesByKind('file') },
  { name: 'getNodesByKind(class)', run: (c) => c.getNodesByKind('class') },
  { name: 'getNodesByKind(method) [rich row decode]', run: (c) => c.getNodesByKind('method') },
  { name: 'getNodeById(hit)', run: (c, k) => c.getNodeById?.(k.nodeId) },
  { name: 'getNodeById(miss → undefined)', run: (c) => c.getNodeById?.('__missing_id__') },
  // --- string/fs getters ---------------------------------------------------
  { name: 'getAllFiles', run: (c) => c.getAllFiles() },
  { name: 'fileExists(indexed)', run: (c) => c.fileExists('mod.ts') },
  { name: 'fileExists(missing)', run: (c) => c.fileExists('nope/missing.ts') },
  { name: 'fileExists(directory)', run: (c) => c.fileExists('sub') },
  { name: 'fileExists(backslash form)', run: (c) => c.fileExists('sub\\dup2.ts') },
  { name: 'readFile(mod.ts)', run: (c) => c.readFile('mod.ts') },
  { name: 'readFile(empty → \'\')', run: (c) => c.readFile('empty.ts') },
  { name: 'readFile(missing → null)', run: (c) => c.readFile('nope/missing.ts') },
  { name: 'readFile(invalid utf8 → lossy U+FFFD)', run: (c) => c.readFile('raw/data.dat') },
  { name: 'getFileLines(mod.ts)', run: (c) => c.getFileLines?.('mod.ts') },
  { name: "getFileLines(empty → [''])", run: (c) => c.getFileLines?.('empty.ts') },
  { name: 'getFileLines(missing → [])', run: (c) => c.getFileLines?.('nope/missing.ts') },
  // Each arm has its own temp root; the fixture dir basename is 'repo' for
  // both, so compare the basename (getProjectRoot returns the fixture root).
  { name: 'getProjectRoot (basename)', run: (c) => path.basename(c.getProjectRoot()) },
  { name: "listDirectories('.')", run: (c) => [...(c.listDirectories?.('.') ?? [])].sort() },
  { name: "listDirectories('sub')", run: (c) => [...(c.listDirectories?.('sub') ?? [])].sort() },
  { name: 'listDirectories(missing → [])', run: (c) => c.listDirectories?.('nope') },
  // --- import analysis -----------------------------------------------------
  { name: 'getImportMappings(imports.ts)', run: (c) => c.getImportMappings('imports.ts', 'typescript') },
  { name: 'getImportMappings(mod.ts → [])', run: (c) => c.getImportMappings('mod.ts', 'typescript') },
  { name: 'getImportMappings(missing → [])', run: (c) => c.getImportMappings('nope/missing.ts', 'typescript') },
  { name: 'getReExports(imports.ts)', run: (c) => c.getReExports?.('imports.ts', 'typescript') },
  { name: 'getReExports(mod.ts → [])', run: (c) => c.getReExports?.('mod.ts', 'typescript') },
  // --- batch group order (the batch wire contract) -------------------------
  {
    name: 'batch group order [dup, missing, calculateTotal]',
    run: (c, k) => {
      // Exercise a multi-key sequence through the SAME context calls the
      // production getters make, in a fixed order, so group ordering drift
      // between arms surfaces deterministically.
      return [c.getNodesByName('dup'), c.getNodesByName('__none__'), c.getNodesByName('calculateTotal'), c.getNodeById?.(k.nodeId)];
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ProbeResult {
  name: string;
  equal: boolean;
  tsSample?: string;
  nativeSample?: string;
}

/**
 * Timing exemption (same class as store-parity's normalized updated_at and
 * kernel-parity's per-node updatedAt): extraction stamps updatedAt=Date.now()
 * at store time, so the two arms legitimately differ on that ONE field — the
 * ctx wire carries the raw DB value faithfully (proven by the normalized
 * four-table dump). Zero every `updatedAt` on plain objects recursively so
 * the probe comparison isolates real getter drift from ingest-time skew.
 */
function normalizeTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTiming);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'updatedAt' ? 0 : normalizeTiming(v);
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  if (!getStoreModule() || !getCtxModule()) {
    console.error(
      'ctx-parity: store/ctx module unavailable (no contract-verified prebuild with R3a+R3b exports).\n' +
        'Build it first: packages/chimera/script/build-kernel.sh   (host leg)\n' +
        'This harness needs BOTH arms; refusing to fake parity with one.'
    );
    process.exit(3);
  }

  const ts = await buildArm('ts', false);
  const native = await buildArm('native', true);
  const results: ProbeResult[] = [];
  let tableDumpsEqual = false;
  try {
    // Warm both arms (warmCaches → ctx_warm seam on the native side).
    ts.resolver.warmCaches();
    native.resolver.warmCaches();
    const nativeCtx = native.resolver.getCtxBridge()!;
    const callsAfterWarm = nativeCtx.callCount;
    if (callsAfterWarm === 0) throw new Error('native arm: warmCaches made zero ctx calls (routing broken?)');

    const keys = deriveKeys(ts);
    for (const probe of PROBES) {
      const a = normalizeTiming(probe.run(ts.context, keys));
      const b = normalizeTiming(probe.run(native.context, keys));
      const equal = Bun.deepEquals(a, b);
      results.push({
        name: probe.name,
        equal,
        ...(equal
          ? {}
          : {
              tsSample: JSON.stringify(a)?.slice(0, 400),
              nativeSample: JSON.stringify(b)?.slice(0, 400),
            }),
      });
    }

    // End-to-end leg: the full pipeline already ran per arm — the four-table
    // dumps must be identical (resolution output is a function of the ctx).
    tableDumpsEqual = dumpTables(ts.dbPath) === dumpTables(native.dbPath);

    if (nativeCtx.callCount <= callsAfterWarm) {
      results.push({ name: 'native getters actually crossed the boundary', equal: false });
    }
  } finally {
    disposeArm(ts);
    disposeArm(native);
    delete process.env.CODEGRAPH_CTX;
  }

  const diffs = results.filter((r) => !r.equal);
  for (const r of results) {
    console.log(`${r.equal ? '✓' : '✗'} ${r.name}`);
    if (!r.equal) {
      console.log(`    ts     : ${r.tsSample}`);
      console.log(`    native : ${r.nativeSample}`);
    }
  }
  console.log(`\nfour-table end-to-end dumps: ${tableDumpsEqual ? 'IDENTICAL ✓' : 'DIFF ✗'}`);
  const summary = {
    generatedAt: new Date().toISOString(),
    probes: results.length,
    diffs: diffs.length,
    tableDumpsEqual,
    failures: diffs,
  };
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`report written to ${outPath}`);
  }
  const ok = diffs.length === 0 && tableDumpsEqual;
  console.log(`ctx-parity: ${ok ? 'PASS (zero diff on every getter + identical tables)' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

await main();
