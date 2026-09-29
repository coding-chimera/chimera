/**
 * A schema-less codegraph.db does not make a project initialized
 * (upstream #1895 / #2083).
 *
 * Before the fix, isInitialized() accepted any existing database file, so an
 * empty or table-less file in an ANCESTOR directory (an interrupted init, a
 * stray touch, a never-populated ~/.chimera/) captured the upward walk of
 * findNearestCodeGraphRoot for every project beneath it and made the real
 * sub-project index unreachable. An initialized project is now one whose db
 * carries the schema; a db we cannot inspect fails OPEN (still initialized),
 * and `init` repairs a schema-less file in place while refusing a non-SQLite
 * file by name.
 */

import { describe, it, expect, afterEach } from './vitest';
const { isInitialized, hasSchemalessDb, hasForeignDbFile, findNearestCodeGraphRoot, getGraphDataRootInfo } = await import('../../src/graph/directory');
const { default: CodeGraph } = await import('../../src/graph/index');
const { createDatabase } = await import('../../src/graph/db/sqlite-adapter');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-schemaless-')));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function writeDbFile(dir: string, kind: 'empty' | 'no-schema' | 'foreign'): string {
  const info = getGraphDataRootInfo(dir);
  fs.mkdirSync(info.dataRoot, { recursive: true });
  const dbPath = info.databasePath;
  if (kind === 'empty') {
    fs.writeFileSync(dbPath, '');
  } else if (kind === 'foreign') {
    // >100 bytes of definitely-not-SQLite content.
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all\n'.repeat(8));
  } else {
    // A real SQLite file with a table, but none of the graph tables.
    const conn = createDatabase(dbPath);
    conn.db.exec('CREATE TABLE unrelated (x INTEGER)');
    conn.db.close();
  }
  return dbPath;
}

describe('schema-less db is not initialized (upstream #1895/#2083)', () => {
  it('rejects an empty db file', () => {
    const dir = makeDir();
    writeDbFile(dir, 'empty');
    expect(isInitialized(dir)).toBe(false);
    expect(hasSchemalessDb(dir)).toBe(true);
    expect(hasForeignDbFile(dir)).toBe(false);
  });

  it('rejects a SQLite db without the graph tables', () => {
    const dir = makeDir();
    writeDbFile(dir, 'no-schema');
    expect(isInitialized(dir)).toBe(false);
    expect(hasSchemalessDb(dir)).toBe(true);
    expect(hasForeignDbFile(dir)).toBe(false);
  });

  it('rejects a non-SQLite file and names it foreign (not repairable)', () => {
    const dir = makeDir();
    writeDbFile(dir, 'foreign');
    expect(isInitialized(dir)).toBe(false);
    expect(hasSchemalessDb(dir)).toBe(false);
    expect(hasForeignDbFile(dir)).toBe(true);
  });

  it('accepts a real graph database', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;');
    const cg = CodeGraph.initSync(dir);
    try {
      expect(isInitialized(dir)).toBe(true);
      expect(hasSchemalessDb(dir)).toBe(false);
      expect(hasForeignDbFile(dir)).toBe(false);
    } finally {
      cg.destroy();
    }
  });

  it('a schema-less ancestor db no longer captures findNearestCodeGraphRoot', () => {
    const parent = makeDir();
    writeDbFile(parent, 'empty'); // the stray ancestor file
    const child = path.join(parent, 'packages', 'real-project');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'index.ts'), 'export const y = 2;');
    const cg = CodeGraph.initSync(child);
    cg.destroy();

    // Before the fix the walk stopped at `parent` (its empty db counted as
    // initialized) and the child's real index was unreachable.
    expect(findNearestCodeGraphRoot(child)).toBe(child);
  });

  it('init repairs a schema-less db in place', () => {
    const dir = makeDir();
    writeDbFile(dir, 'no-schema');
    expect(isInitialized(dir)).toBe(false);
    const cg = CodeGraph.initSync(dir);
    try {
      expect(isInitialized(dir)).toBe(true);
      expect(hasSchemalessDb(dir)).toBe(false);
    } finally {
      cg.destroy();
    }
  });

  it('init refuses a foreign db file instead of promising a rebuild', () => {
    const dir = makeDir();
    const dbPath = writeDbFile(dir, 'foreign');
    const before = fs.readFileSync(dbPath);
    expect(() => CodeGraph.initSync(dir)).toThrow(/not a SQLite database/);
    // Nothing touched the file.
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});
