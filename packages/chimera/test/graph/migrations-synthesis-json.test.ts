/**
 * Synthesis metadata JSON boundaries and migration (#2038, fork port of
 * upstream __tests__/migrations-synthesis-json.test.ts).
 *
 * An edge row whose `metadata` is not valid JSON used to make every
 * `json_extract` over the edges table throw — including the partial
 * idx_edges_synthesis_site build/scans and the ownership predicates the sync
 * refresh trigger rides. The guarded expression
 * `CASE WHEN json_valid(metadata) THEN json_extract(...) END` short-circuits
 * malformed rows to NULL: they are ordinary edges for ownership purposes and
 * never enter the partial index.
 *
 * Fork adaptations: chimera schema numbers (v12 legacy → v13/v14), no
 * legacy Go-containment backfill case (the fork has no go-method-contains
 * pass), bun-test shim imports, and `connection.getPath()` from the fork's
 * DatabaseConnection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../../src/graph/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../../src/graph/db/migrations';
import { QueryBuilder } from '../../src/graph/db/queries';
import { SynthesisStage } from '../../src/graph/db/synthesis-stage';

describe('synthesis metadata JSON boundaries and migration', () => {
  let dir: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synthesis-json-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.insertNodes(['a', 'b'].map((id) => ({
      id, name: id, qualifiedName: id, kind: 'function' as const, language: 'typescript' as const,
      filePath: `${id}.ts`, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
      updatedAt: 0,
    })));
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const insertRaw = (metadata: string | null, line = 1) => connection.getDb().prepare(
    "INSERT INTO edges(source, target, kind, metadata, line) VALUES ('a', 'b', 'calls', ?, ?)"
  ).run(metadata, line);

  it.each([null, 'broken json {{{', 'null', '[]', '{}', '{"registeredAt":"wiring.ts:1"}'])
  ('treats unowned metadata %s as an ordinary edge', (metadata) => {
    insertRaw(metadata);
    expect(queries.getOutgoingEdges('a')).toHaveLength(1);
    expect(queries.hasSynthesizedEdgesTouchingFile('a.ts')).toBe(false);
    expect(queries.hasSynthesizedEdgesTouchingFile('b.ts')).toBe(false);
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(false);
  });

  it('keeps the third-file range lookup indexed while tolerating malformed neighbors', () => {
    insertRaw('broken json {{{');
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'event-emitter', registeredAt: 'wiring.ts:12' } });
    expect(queries.hasSynthesizedEdgesTouchingFile('a.ts')).toBe(true);
    expect(queries.hasSynthesizedEdgesTouchingFile('b.ts')).toBe(true);
    const prepare = vi.spyOn(connection.getDb(), 'prepare');
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(true);
    const sql = (prepare.mock.calls as Array<[string]>)
      .map(([sql]) => sql).find((sql) => sql.includes('FROM edges e WHERE'))!;
    expect(sql).toBeDefined();
    prepare.mockRestore();
    const plan = connection.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all('wiring.ts:', 'wiring.ts;');
    expect(plan.map((row: { detail: string }) => row.detail).join('\n'))
      .toMatch(/SEARCH e USING INDEX idx_edges_synthesis_site/);
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.tsx')).toBe(false);
  });

  it('preserves malformed base edges while staging and publishing owned replacements', async () => {
    insertRaw('broken json {{{');
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'old-pass', registeredAt: 'old.ts:1' } });
    const stage = new SynthesisStage(connection.getPath());
    try {
      // The overlay hides the owned base edge; the malformed row stays visible.
      expect(stage.queries.getOutgoingEdges('a').map((edge) => edge.line)).toEqual([1]);
      // The overlay must not shadow an existing base edge, even if its JSON is bad.
      stage.queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 1,
        metadata: { synthesizedBy: 'new-pass' } });
      stage.queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 3,
        metadata: { synthesizedBy: 'new-pass', registeredAt: 'new.ts:1' } });
      stage.publish();
    } finally { stage.close(); }
    expect(connection.getDb().prepare('SELECT line, metadata FROM edges ORDER BY line').all()).toEqual([
      { line: 1, metadata: 'broken json {{{' },
      { line: 3, metadata: JSON.stringify({ synthesizedBy: 'new-pass', registeredAt: 'new.ts:1' }) },
    ]);
  });

  it('upgrades a pre-v13 database holding malformed metadata', () => {
    const raw = connection.getDb();
    raw.exec(`DROP INDEX idx_edges_synthesis_site;
      DROP TABLE synthesis_inputs;
      DELETE FROM schema_versions WHERE version >= 13;`);
    insertRaw('broken json {{{');
    // The guarded v13 index build and the v14 rebuild both scan the malformed
    // row without throwing, and it stays an ordinary edge afterwards.
    runMigrations(raw, 12);
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    expect(queries.getOutgoingEdges('a', ['calls'])[0]!.metadata).toBeUndefined();
    expect(queries.hasSynthesizedEdgesTouchingFile('a.ts')).toBe(false);
    insertRaw('still malformed', 2);
    expect(queries.getOutgoingEdges('a')).toHaveLength(2);
  });

  it('replaces a shipped-unguarded v13 index on open and safely replays the replacement', () => {
    const raw = connection.getDb();
    // The v13 shape as first shipped (unguarded), recorded at version 13.
    raw.exec(`DROP INDEX idx_edges_synthesis_site;
      CREATE INDEX idx_edges_synthesis_site ON edges(json_extract(metadata, '$.registeredAt'))
        WHERE json_extract(metadata, '$.synthesizedBy') IS NOT NULL;
      DELETE FROM schema_versions WHERE version >= 14;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (13, 0, 'legacy fixture');`);
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'event-emitter', registeredAt: 'wiring.ts:12' } });
    connection.close();
    connection = DatabaseConnection.open(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    expect(getCurrentVersion(connection.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    // The guarded index tolerates a malformed neighbor the unguarded one
    // would have thrown on.
    insertRaw('broken json {{{');
    const before = connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all();
    // Replay the v14 DDL over its own output with bad JSON already present.
    connection.getDb().exec('DELETE FROM schema_versions WHERE version >= 14');
    runMigrations(connection.getDb(), 13);
    runMigrations(connection.getDb(), getCurrentVersion(connection.getDb()));
    expect(connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(before);
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(true);
  });
});
