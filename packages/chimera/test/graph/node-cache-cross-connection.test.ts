/**
 * QueryBuilder's node LRU cache is invalidated across connections.
 *
 * The cache used to be dropped only by writes on the SAME QueryBuilder, so a
 * long-lived reader (MCP server, WebUI, a second CodeGraph.open) kept serving
 * rows that another connection had already updated or deleted. Every cached
 * read now re-checks `getChangeStamp()` — this connection's `total_changes()`
 * plus `PRAGMA data_version`, which advances when any other connection
 * commits — so a cross-connection insert/update/delete is visible on the very
 * next `getNodeById` / `getNodesByIds`.
 *
 * Rows read inside a transaction are never cached: `total_changes()` counts
 * writes a ROLLBACK later undoes, so the stamp cannot distinguish them.
 */

import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { QueryBuilder } from '../../src/graph/db/queries';
import { DatabaseConnection } from '../../src/graph/db';
import type { Node } from '../../src/graph/types';

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function dbOf(cg: CodeGraph) {
  return (cg as unknown as { db: DatabaseConnection }).db.getDb();
}

function node(id: string, name: string): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    isExported: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    updatedAt: Date.now(),
  };
}

describe('node cache — cross-connection invalidation', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(async () => {
    for (const cg of open.splice(0)) await cg.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ writer: QueryBuilder; reader: QueryBuilder; writerGraph: CodeGraph }> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-cache-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n');
    const writerGraph = await CodeGraph.init(dir, { index: false });
    open.push(writerGraph);
    const readerGraph = await CodeGraph.open(dir);
    open.push(readerGraph);
    return { writer: queriesOf(writerGraph), reader: queriesOf(readerGraph), writerGraph };
  }

  it('getNodeById does not serve stale rows after another connection inserts, updates, or deletes', async () => {
    const { writer, reader } = await setup();

    // Insert on the writer, then read on the reader so the row is cached there.
    writer.insertNode(node('n1', 'before'));
    expect(reader.getNodeById('n1')?.name).toBe('before');

    // Update on the writer: the reader's cached copy must not win.
    writer.updateNode(node('n1', 'after'));
    expect(reader.getNodeById('n1')?.name).toBe('after');

    // A miss was answered as null before the other connection inserted.
    expect(reader.getNodeById('n2')).toBeNull();
    writer.insertNode(node('n2', 'two'));
    expect(reader.getNodeById('n2')?.name).toBe('two');

    // Delete on the writer: the reader must stop serving the cached row.
    expect(reader.getNodeById('n2')?.name).toBe('two');
    writer.deleteNode('n2');
    expect(reader.getNodeById('n2')).toBeNull();
  });

  it('getNodesByIds re-reads the batch after another connection mutates it', async () => {
    const { writer, reader } = await setup();

    writer.insertNodes([node('a', 'alpha'), node('b', 'beta')]);
    const first = reader.getNodesByIds(['a', 'b']);
    expect(first.get('a')?.name).toBe('alpha');
    expect(first.get('b')?.name).toBe('beta');

    writer.updateNode(node('a', 'alpha2'));
    writer.deleteNode('b');

    const second = reader.getNodesByIds(['a', 'b']);
    expect(second.get('a')?.name).toBe('alpha2');
    expect(second.has('b')).toBe(false);
  });

  it('does not cache rows read inside a rolled-back transaction', async () => {
    const { writer, writerGraph } = await setup();
    writer.insertNode(node('n1', 'committed'));
    expect(writer.getNodeById('n1')?.name).toBe('committed');

    const db = dbOf(writerGraph);
    db.exec('BEGIN');
    try {
      // Raw write so the manual transaction owns BEGIN/ROLLBACK (updateNode
      // would open its own nested transaction for the name-segment rows).
      db.exec("UPDATE nodes SET name = 'uncommitted' WHERE id = 'n1'");
      // The in-transaction read sees the uncommitted row, but it must not be
      // cached: total_changes() keeps counting after a ROLLBACK.
      expect(writer.getNodeById('n1')?.name).toBe('uncommitted');
    } finally {
      db.exec('ROLLBACK');
    }
    expect(writer.getNodeById('n1')?.name).toBe('committed');
  });
});