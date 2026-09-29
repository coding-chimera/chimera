/**
 * getDominantFile() is computed once per database state (#2086, fork port of
 * upstream __tests__/dominant-file-cache.test.ts, #1864).
 *
 * The dominant-file heuristic (context ranking's core-directory boost) is a
 * whole-graph aggregation whose answer does not depend on the query, yet it
 * ran on every generic explore — seconds per call on a large index. It is now
 * memoized against a database change stamp (total_changes + data_version).
 * These tests pin both halves: repeated reads reuse the answer, and any
 * write — by this connection or by another process's sync — makes the next
 * call see the new graph. A result computed inside a transaction is never
 * kept, so a ROLLBACK cannot leave it describing deleted edges.
 *
 * Fork adaptations: CodeGraph.init/open statics, `.chimera` data root via
 * getGraphDataRootInfo, no QueryBuilder.rebind case (the fork has no rebind —
 * a replaced database builds a fresh QueryBuilder in
 * reopenReplacedDatabase, which drops the memo with the old instance).
 */

import { describe, it, expect, afterEach, vi, mock } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { QueryBuilder } from '../../src/graph/db/queries';
import { DatabaseConnection } from '../../src/graph/db';
import { getGraphDataRootInfo } from '../../src/graph/directory';

/** A file whose functions call each other in a chain: `n` in-file call edges. */
function chain(prefix: string, n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? `${prefix}${i + 1}();` : '';
    lines.push(`export function ${prefix}${i}(): void { ${next} }`);
  }
  return lines.join('\n') + '\n';
}

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function spyCompute(cg: CodeGraph) {
  return vi.spyOn(
    queriesOf(cg) as unknown as { computeDominantFile: () => unknown },
    'computeDominantFile'
  );
}

describe('dominant file — computed once per index state (#2086)', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(async () => {
    for (const cg of open.splice(0)) await cg.destroy();
    mock.restore();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dominant-'));
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'ext'));
    fs.writeFileSync(path.join(dir, 'core', 'engine.ts'), chain('engineStep', 40));
    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 5));
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  it('reuses the answer across explores while the database is unchanged', async () => {
    const cg = await setup();
    const compute = spyCompute(cg);

    for (const q of ['engine step', 'plugin step', 'how does the engine run']) {
      await cg.findRelevantContext(q);
    }
    expect(compute).toHaveBeenCalledTimes(1);
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('core/engine.ts');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('sees a new dominant file after a sync changes the graph', async () => {
    const cg = await setup();
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('core/engine.ts');

    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
    await cg.sync();

    const compute = spyCompute(cg);
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('ext/plugin.ts');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('sees a sync made through another connection (another process)', async () => {
    const writer = await setup();
    const reader = await CodeGraph.open(dir);
    open.push(reader);
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('core/engine.ts');

    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
    await writer.sync();

    // data_version moves on the reader's next call — no write path had to
    // invalidate anything.
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('ext/plugin.ts');
  });

  it('does not keep a result read inside a transaction that is rolled back', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const before = q.getDominantFile();
    const db = (cg as unknown as { db: DatabaseConnection }).db.getDb();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM edges');
      expect(q.getDominantFile()).toBeNull();
    } finally {
      db.exec('ROLLBACK');
    }
    expect(q.getDominantFile()).toEqual(before);
  });

  it('drops the memo with a rebuilt-and-reopened connection', async () => {
    const reader = await setup();
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('core/engine.ts');
    // A fresh QueryBuilder over the same file starts with no memo and sees
    // the current graph — the rebind hazard the fork avoids by rebuilding
    // the QueryBuilder instead of rebinding it.
    const conn = DatabaseConnection.open(getGraphDataRootInfo(dir).databasePath);
    try {
      const q = new QueryBuilder(conn.getDb());
      expect(q.getDominantFile()?.filePath).toBe('core/engine.ts');
      fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
      await reader.sync();
      expect(q.getDominantFile()?.filePath).toBe('ext/plugin.ts');
    } finally {
      conn.close();
    }
  });
});
