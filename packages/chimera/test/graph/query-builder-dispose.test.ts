/**
 * (R1 A10) QueryBuilder.dispose: prepared statements are finalized and the
 * stmts/node caches dropped deterministically, instead of living until the
 * whole SQLite connection closes. Idempotent, and statements re-prepare
 * transparently after a dispose on an open connection.
 */
import { describe, it, expect } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';

describe('QueryBuilder.dispose (R1 A10)', () => {
  it('releases prepared statements and caches, is idempotent, and re-prepares after', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-dispose-'));
    try {
      const db = DatabaseConnection.initialize(path.join(tempDir, 'test.db'));
      const queries = new QueryBuilder(db.getDb());

      // Materialize a few lazily-prepared statements.
      expect(queries.getNodesByFile('a.ts')).toEqual([]);
      expect(queries.getNodeById('missing')).toBeNull();

      const stmts = (queries as unknown as { stmts: Record<string, unknown> }).stmts;
      const prepared = Object.keys(stmts).length;
      expect(prepared).toBeGreaterThan(0);

      queries.dispose();
      expect(Object.keys(stmts).length).toBe(0);

      // Idempotent: a second dispose is a safe no-op.
      queries.dispose();

      // The connection is still open: statements re-prepare transparently.
      expect(queries.getNodesByFile('a.ts')).toEqual([]);
      expect(Object.keys(stmts).length).toBeGreaterThan(0);

      queries.dispose();
      db.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
