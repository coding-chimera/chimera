import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection, type StorageExtension } from '../../src/graph/db';

function tableExists(db: DatabaseConnection, table: string): boolean {
  return Boolean(
    db.getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  );
}

describe('storage extensions', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-storage-extension-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies extension migrations in version order and records history', () => {
    const extension: StorageExtension = {
      id: 'example',
      namespace: 'example_',
      migrations: [
        {
          version: 2,
          description: 'Add label column',
          sql: 'ALTER TABLE example_item ADD COLUMN label TEXT;',
        },
        {
          version: 1,
          description: 'Create items',
          sql: 'CREATE TABLE IF NOT EXISTS example_item (id TEXT PRIMARY KEY);',
        },
      ],
    };

    const db = DatabaseConnection.initialize(dbPath, { storageExtensions: [extension] });
    try {
      expect(tableExists(db, 'example_item')).toBe(true);
      expect(db.getStorageExtensionVersion('example')).toBe(2);
      expect(db.getStorageExtensionHistory('example').map((row) => row.version)).toEqual([1, 2]);
      expect(
        db.getDb()
          .prepare('PRAGMA table_info(example_item)')
          .all()
          .map((row) => (row as { name: string }).name)
      ).toContain('label');
    } finally {
      db.close();
    }
  });

  it('is idempotent when the same extension is applied again', () => {
    const extension: StorageExtension = {
      id: 'repeatable',
      namespace: 'repeatable_',
      migrations: [
        {
          version: 1,
          description: 'Create repeatable table',
          sql: 'CREATE TABLE IF NOT EXISTS repeatable_item (id TEXT PRIMARY KEY);',
        },
      ],
    };

    const db = DatabaseConnection.initialize(dbPath, { storageExtensions: [extension] });
    try {
      db.applyStorageExtension(extension);
      expect(db.getStorageExtensionVersion('repeatable')).toBe(1);
      expect(db.getStorageExtensionHistory('repeatable')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rejects migrations that touch non-namespaced schema objects', () => {
    const db = DatabaseConnection.initialize(dbPath);
    try {
      expect(() => db.applyStorageExtension({
        id: 'bad',
        namespace: 'bad_',
        migrations: [
          {
            version: 1,
            description: 'Touch core nodes',
            sql: 'CREATE INDEX IF NOT EXISTS bad_nodes_idx ON nodes(id);',
          },
        ],
      })).toThrow(/non-namespaced schema object: nodes/);
    } finally {
      db.close();
    }
  });

  it('opens read-only when migrations are current and rejects pending migrations', () => {
    const extension: StorageExtension = {
      id: 'readonly',
      namespace: 'readonly_',
      migrations: [
        {
          version: 1,
          description: 'Create read-only table',
          sql: 'CREATE TABLE IF NOT EXISTS readonly_item (id TEXT PRIMARY KEY);',
        },
      ],
    };
    DatabaseConnection.initialize(dbPath, { storageExtensions: [extension] }).close();

    const db = DatabaseConnection.open(dbPath, { readOnly: true, storageExtensions: [extension] });
    try {
      expect(db.isReadOnly()).toBe(true);
      expect(db.getStorageExtensionVersion('readonly')).toBe(1);
      expect(() => db.getDb().exec('CREATE TABLE readonly_probe (id TEXT);')).toThrow();
    } finally {
      db.close();
    }

    expect(() => DatabaseConnection.open(dbPath, {
      readOnly: true,
      storageExtensions: [{
        ...extension,
        migrations: [
          ...extension.migrations,
          {
            version: 2,
            description: 'Pending read-only migration',
            sql: 'CREATE TABLE IF NOT EXISTS readonly_next (id TEXT PRIMARY KEY);',
          },
        ],
      }],
    })).toThrow(/read-only/);
  });
});
