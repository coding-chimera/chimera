/**
 * SQLite backend reporting.
 *
 * CodeGraph uses the host runtime's built-in SQLite backend. In the bundled
 * Node runtime this is node:sqlite; under Bun tests it is bun:sqlite. Pin that
 * DatabaseConnection / CodeGraph report the active backend and come up in WAL.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../../src/graph/db';
import { CodeGraph } from '../../src/graph';

const expectedBackend = typeof (process.versions as Record<string, string | undefined>).bun === 'string'
  ? 'bun-sqlite'
  : 'node-sqlite';

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the active SQLite backend in WAL for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getBackend()).toBe(expectedBackend);
    expect(conn.getJournalMode()).toBe('wal');
    conn.close();
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe(expectedBackend);
    } finally {
      cg.destroy();
    }
  });
});
