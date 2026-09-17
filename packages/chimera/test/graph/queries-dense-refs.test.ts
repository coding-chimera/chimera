/**
 * Dense unresolved-ref loads (upstream d8f2eea, #1558/#1576 + the #540
 * input-chunking gap the fork never took).
 *
 * getUnresolvedReferencesByFiles and getRetryableFailedReferences chunk their
 * INPUT under the SQLite parameter limit, but each chunk's RESULT rows are
 * unbounded: a dense recovery sync (upstream's #1541 self-heal re-indexing
 * 919 files produced 234,440 rows) returns more rows per chunk than the JS
 * engine accepts as function arguments, and the old `rows.push(...chunkRows)`
 * spread died with "Maximum call stack size exceeded" mid-resolution — the
 * graph stayed hundreds of thousands of edges short until another sync
 * resumed the orphans. V8's argument limit is ~125k; bun/JSC tolerates more
 * but still throws past ~1M, so these tests seed 1.05M rows to reproduce the
 * failure on the fork's actual runtime. Both readers now append with a loop.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dense-refs-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(): DatabaseConnection {
  return DatabaseConnection.initialize(path.join(tmpDir, 'test.db'));
}

/** unresolved_refs.from_node_id is FK-bound to nodes — seed the anchor node. */
function seedNode(db: DatabaseConnection, id: string, filePath: string): void {
  db.getDb().prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
       start_line, end_line, start_column, end_column, updated_at)
     VALUES (?, 'function', 'dense', 'dense', ?, 'typescript', 1, 2, 0, 1, 1)`
  ).run(id, filePath);
}

function seedRefs(
  db: DatabaseConnection,
  count: number,
  opts: { status: 'pending' | 'failed'; fileFor: (i: number) => string; nameFor: (i: number) => string }
): void {
  const stmt = db.getDb().prepare(
    `INSERT INTO unresolved_refs
       (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail)
     VALUES ('n1', ?, 'calls', 1, 0, ?, 'typescript', ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const name = opts.nameFor(i);
      stmt.run(name, opts.fileFor(i), opts.status, opts.status === 'failed' ? name : '');
    }
  });
}

describe('dense unresolved-ref loads (upstream d8f2eea #1558)', () => {
  it('loads >1M dense rows through both readers without a spread RangeError', () => {
    const db = openDb();
    const q = new QueryBuilder(db.getDb());
    seedNode(db, 'n1', 'src/a.ts');
    seedRefs(db, 1_050_000, { status: 'pending', fileFor: () => 'src/a.ts', nameFor: () => 'dense' });

    // byFiles: a SINGLE input chunk (one file) whose RESULT rows exceed the
    // engine's argument limit — the exact d8f2eea crash shape. The old
    // spread form throws RangeError here on bun/JSC (>~1M args).
    const pending = q.getUnresolvedReferencesByFiles(['src/a.ts']);
    expect(pending.length).toBe(1_050_000);
    expect(pending[0]!.referenceName).toBe('dense');
    expect(pending[0]!.fromNodeId).toBe('n1');

    // Flip to parked-failed and load through the retry reader: same unbounded
    // result rows per input chunk, same hazard, same loop-append fix.
    db.getDb().prepare(`UPDATE unresolved_refs SET status = 'failed', name_tail = 'dense'`).run();
    const retryable = q.getRetryableFailedReferences(['dense'], 2_000_000);
    expect(retryable.length).toBe(1_050_000);

    // The per-name ceiling still skips pathological populations (external /
    // builtin noise one new definition cannot resolve).
    expect(q.getRetryableFailedReferences(['dense'])).toEqual([]);
    db.close();
  }, 120_000);

  it('chunks a >500-file input under the SQLite parameter limit (#540)', () => {
    const db = openDb();
    const q = new QueryBuilder(db.getDb());
    seedNode(db, 'n1', 'src/f0.ts');
    const files = Array.from({ length: 1200 }, (_, i) => `src/f${i}.ts`);
    seedRefs(db, 6000, {
      status: 'pending',
      fileFor: (i) => files[i % files.length]!,
      nameFor: (i) => `sym${i}`,
    });
    // 1200 file paths > SQLITE_PARAM_CHUNK_SIZE (500): the pre-fix fork sent
    // them in ONE statement — fine under bun's 32766-param ceiling, fatal
    // under builds compiled with the historical 999-param default.
    expect(q.getUnresolvedReferencesByFiles(files).length).toBe(6000);
    expect(q.getUnresolvedReferencesByFiles(files.slice(0, 10)).length).toBe(50);
    expect(q.getUnresolvedReferencesByFiles([]).length).toBe(0);
    db.close();
  });
});
