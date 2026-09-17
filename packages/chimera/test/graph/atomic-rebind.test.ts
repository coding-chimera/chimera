/**
 * Atomic edge rebinding (fork adaptation of upstream 58c07e874, #1833).
 *
 * A file re-index store is a REBIND: deleteFile cascades away the file's
 * nodes and every edge targeting them, then the snapshot re-attach/resurrect
 * puts the cross-file edges back (or re-queues them as pending refs). A crash
 * between the delete and the re-insert used to lose those edges permanently —
 * the next run's snapshot comes back empty and the caller files are never
 * revisited. The removal path (resurrect refs + cascade delete) had the
 * mirror hazard: a failure between the two left resurrected refs whose edges
 * ALSO survived, so a later rebind could keep both rows.
 *
 * The fork shape wraps both units in one transaction (QueryBuilder.transaction
 * + nesting-joining adapter transactions), so any failure rolls the whole
 * unit back. These tests inject the failure at each seam and assert the
 * database still holds the exact pre-store state.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/graph';
import { DatabaseConnection } from '../../src/graph/db';
import type { QueryBuilder } from '../../src/graph/db/queries';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-atomic-rebind-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(): void {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'a.ts'),
    'export function target(x: number): number { return x + 1; }\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'b.ts'),
    `import { target } from './a';\nexport function caller(n: number): number { return target(n); }\n`
  );
}

function dbOf(cg: CodeGraph): DatabaseConnection {
  return (cg as unknown as { db: DatabaseConnection }).db;
}

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function crossFileEdgeCount(cg: CodeGraph): number {
  const row = dbOf(cg).getDb().prepare(
    `SELECT COUNT(*) AS c FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
      WHERE s.file_path = 'src/b.ts' AND t.file_path = 'src/a.ts'`
  ).get() as { c: number };
  return row.c;
}

/** Edges from b.ts onto the SYMBOL named `target` in a.ts — the rebind unit.
 * (The file-level b.ts→a.ts imports edge is a separate row: its target file
 * node survives a symbol rename and is legitimately re-attached, so counting
 * ALL cross-file edges would mask the symbol-level rebind.) */
function targetEdgeCount(cg: CodeGraph): number {
  const row = dbOf(cg).getDb().prepare(
    `SELECT COUNT(*) AS c FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
      WHERE s.file_path = 'src/b.ts' AND t.file_path = 'src/a.ts' AND t.name = 'target'`
  ).get() as { c: number };
  return row.c;
}

function nodeNames(cg: CodeGraph, filePath: string): string[] {
  const rows = dbOf(cg).getDb().prepare(
    'SELECT name FROM nodes WHERE file_path = ? ORDER BY name'
  ).all(filePath) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function refCount(cg: CodeGraph, status: 'pending' | 'failed'): number {
  const row = dbOf(cg).getDb().prepare(
    'SELECT COUNT(*) AS c FROM unresolved_refs WHERE status = ?'
  ).get(status) as { c: number };
  return row.c;
}

describe('atomic file re-index store (upstream 58c07e874)', () => {
  it('rolls the WHOLE rebind back when the resurrect insert fails mid-store', async () => {
    writeFixture();
    const cg = CodeGraph.initSync(tmpDir);
    try {
      const indexed = await cg.indexAll();
      expect(indexed.success).toBe(true);
      expect(targetEdgeCount(cg)).toBeGreaterThanOrEqual(1);

      // Rename the target so the re-index must RESURRECT the incoming edge
      // as its original ref — then fail the resurrect insert.
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'a.ts'),
        'export function renamedTarget(x: number): number { return x + 1; }\n'
      );
      const queries = queriesOf(cg);
      const insert = spyOn(queries, 'insertUnresolvedRefsBatch').mockImplementation(() => {
        throw new Error('forced mid-store failure');
      });

      await cg.indexFiles(['src/a.ts']).catch(() => { /* surfaced or collected — the DB state is the assertion */ });

      // Pre-fix: deleteFile had already cascaded — the old nodes and the
      // b.ts→a.ts edge were gone and the refs were never inserted (permanent
      // silent edge loss). Now: the whole unit rolled back.
      expect(nodeNames(cg, 'src/a.ts')).toContain('target');
      expect(nodeNames(cg, 'src/a.ts')).not.toContain('renamedTarget');
      expect(targetEdgeCount(cg)).toBeGreaterThanOrEqual(1);
      expect(refCount(cg, 'pending')).toBe(0);

      // The rolled-back state is cleanly replayable: the same re-index
      // succeeds once the injected failure is gone.
      insert.mockRestore();
      await cg.indexFiles(['src/a.ts']);
      expect(nodeNames(cg, 'src/a.ts')).toContain('renamedTarget');
      expect(targetEdgeCount(cg)).toBe(0); // old symbol edge consumed by the rebind
      expect(refCount(cg, 'pending')).toBeGreaterThanOrEqual(1); // resurrected ref awaits resolution
    } finally {
      await cg.close();
    }
  });

  it('rolls the removal pair back when the cascade delete fails after the resurrect', async () => {
    writeFixture();
    const cg = CodeGraph.initSync(tmpDir);
    try {
      const indexed = await cg.indexAll();
      expect(indexed.success).toBe(true);
      expect(targetEdgeCount(cg)).toBeGreaterThanOrEqual(1);

      fs.rmSync(path.join(tmpDir, 'src', 'a.ts'));
      const queries = queriesOf(cg);
      const del = spyOn(queries, 'deleteFile').mockImplementation(() => {
        throw new Error('forced delete failure');
      });

      await expect(cg.sync()).rejects.toThrow('forced delete failure');

      // Pre-fix: the resurrected refs were already committed while the edges
      // ALSO survived — a later rebind could keep both. Now: all-or-nothing.
      expect(refCount(cg, 'pending')).toBe(0);
      expect(targetEdgeCount(cg)).toBeGreaterThanOrEqual(1);
      expect(queries.getFileByPath('src/a.ts')).not.toBeNull();

      // Replay without the injected failure: the removal completes and the
      // resurrected ref parks as failed (its target is gone for good).
      del.mockRestore();
      await cg.sync();
      expect(queries.getFileByPath('src/a.ts')).toBeNull();
      expect(targetEdgeCount(cg)).toBe(0);
      expect(refCount(cg, 'pending') + refCount(cg, 'failed')).toBeGreaterThanOrEqual(1);
    } finally {
      await cg.close();
    }
  });
});

describe('nesting-joining adapter transactions', () => {
  it('inner transaction() calls join the outer unit and roll back with it', () => {
    const db = DatabaseConnection.initialize(path.join(tmpDir, 'nest.db'));
    const raw = db.getDb();
    raw.exec('CREATE TABLE t (v INTEGER)');
    const insertOne = raw.transaction(() => {
      raw.prepare('INSERT INTO t (v) VALUES (1)').run();
    });
    const failing = raw.transaction(() => {
      insertOne(); // pre-fix: "cannot start a transaction within a transaction"
      insertOne();
      throw new Error('forced outer failure');
    });
    expect(() => failing()).toThrow('forced outer failure');
    const count = () => (raw.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count()).toBe(0); // both inner inserts rolled back WITH the outer unit

    const ok = raw.transaction(() => { insertOne(); });
    ok();
    expect(count()).toBe(1); // clean nested run commits with the outer unit
    db.close();
  });
});
