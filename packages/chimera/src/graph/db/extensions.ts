/**
 * Storage extension support for embedded consumers.
 *
 * Extensions let package consumers create their own namespaced overlay tables in
 * the CodeGraph database without reaching into core schema migrations.
 */

import { SqliteDatabase } from './sqlite-adapter';

export interface StorageExtensionMigration {
  version: number;
  description: string;
  sql: string;
}

export interface StorageExtension {
  id: string;
  namespace: string;
  migrations: readonly StorageExtensionMigration[];
}

export interface StorageExtensionMigrationRecord {
  extensionID: string;
  version: number;
  appliedAt: number;
  description: string | null;
}

interface StorageExtensionOptions {
  readOnly?: boolean;
}

const EXTENSION_TABLE = 'codegraph_storage_extension';
const EXTENSION_MIGRATION_TABLE = 'codegraph_storage_extension_migration';

function assertStorageExtensionIdentifier(kind: string, value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`Invalid storage extension ${kind}: ${value}`);
  }
}

function assertStorageExtensionNamespace(namespace: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*_$/.test(namespace)) {
    throw new Error(`Invalid storage extension namespace: ${namespace}`);
  }
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
}

function collectMatches(sql: string, regex: RegExp, names: string[]): string[] {
  const results: string[] = [];
  for (const match of sql.matchAll(regex)) {
    for (const name of names) {
      const value = match.groups?.[name];
      if (value) results.push(value);
    }
  }
  return results;
}

function collectSchemaObjects(sql: string): string[] {
  const source = stripSqlComments(sql);
  return [
    ...collectMatches(
      source,
      /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<table>[A-Za-z_][A-Za-z0-9_]*)/gi,
      ['table']
    ),
    ...collectMatches(
      source,
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<index>[A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(?<table>[A-Za-z_][A-Za-z0-9_]*)/gi,
      ['index', 'table']
    ),
    ...collectMatches(
      source,
      /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<trigger>[A-Za-z_][A-Za-z0-9_]*)[\s\S]*?\bON\s+(?<table>[A-Za-z_][A-Za-z0-9_]*)/gi,
      ['trigger', 'table']
    ),
    ...collectMatches(
      source,
      /\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<view>[A-Za-z_][A-Za-z0-9_]*)/gi,
      ['view']
    ),
    ...collectMatches(
      source,
      /\bALTER\s+TABLE\s+(?<table>[A-Za-z_][A-Za-z0-9_]*)/gi,
      ['table']
    ),
    ...collectMatches(
      source,
      /\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?(?<object>[A-Za-z_][A-Za-z0-9_]*)/gi,
      ['object']
    ),
    ...collectMatches(source, /\bREFERENCES\s+(?<table>[A-Za-z_][A-Za-z0-9_]*)/gi, ['table']),
  ];
}

function validateStorageExtension(extension: StorageExtension): StorageExtensionMigration[] {
  assertStorageExtensionIdentifier('id', extension.id);
  assertStorageExtensionNamespace(extension.namespace);

  const versions = new Set<number>();
  const migrations = [...extension.migrations].sort((a, b) => a.version - b.version);
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Invalid migration version for storage extension ${extension.id}: ${migration.version}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version for storage extension ${extension.id}: ${migration.version}`);
    }
    versions.add(migration.version);
    for (const objectName of collectSchemaObjects(migration.sql)) {
      if (!objectName.startsWith(extension.namespace)) {
        throw new Error(
          `Storage extension ${extension.id} migration ${migration.version} references non-namespaced schema object: ${objectName}`
        );
      }
    }
  }
  return migrations;
}

function ensureStorageExtensionCatalog(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EXTENSION_TABLE} (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${EXTENSION_MIGRATION_TABLE} (
      extension_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      description TEXT,
      PRIMARY KEY (extension_id, version),
      FOREIGN KEY (extension_id) REFERENCES ${EXTENSION_TABLE}(id) ON DELETE CASCADE
    );
  `);
}

function ensureStorageExtensionRegistration(db: SqliteDatabase, extension: StorageExtension): void {
  const row = db.prepare(`SELECT namespace FROM ${EXTENSION_TABLE} WHERE id = ?`).get(extension.id) as
    | { namespace: string }
    | undefined;
  if (row && row.namespace !== extension.namespace) {
    throw new Error(
      `Storage extension ${extension.id} is already registered with namespace ${row.namespace}, not ${extension.namespace}`
    );
  }
  db.prepare(`
    INSERT INTO ${EXTENSION_TABLE} (id, namespace, current_version, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, updated_at = excluded.updated_at
  `).run(extension.id, extension.namespace, Date.now());
}

export function getStorageExtensionVersion(db: SqliteDatabase, extensionID: string): number {
  try {
    const row = db
      .prepare(`SELECT current_version FROM ${EXTENSION_TABLE} WHERE id = ?`)
      .get(extensionID) as { current_version: number } | undefined;
    return row?.current_version ?? 0;
  } catch {
    return 0;
  }
}

export function getStorageExtensionHistory(db: SqliteDatabase, extensionID: string): StorageExtensionMigrationRecord[] {
  try {
    const rows = db
      .prepare(`
        SELECT extension_id, version, applied_at, description
        FROM ${EXTENSION_MIGRATION_TABLE}
        WHERE extension_id = ?
        ORDER BY version ASC
      `)
      .all(extensionID) as Array<{
        extension_id: string;
        version: number;
        applied_at: number;
        description: string | null;
      }>;
    return rows.map((row) => ({
      extensionID: row.extension_id,
      version: row.version,
      appliedAt: row.applied_at,
      description: row.description,
    }));
  } catch {
    return [];
  }
}

export function getPendingStorageExtensionMigrations(
  db: SqliteDatabase,
  extension: StorageExtension
): StorageExtensionMigration[] {
  const migrations = validateStorageExtension(extension);
  const currentVersion = getStorageExtensionVersion(db, extension.id);
  return migrations.filter((migration) => migration.version > currentVersion);
}

export function applyStorageExtension(
  db: SqliteDatabase,
  extension: StorageExtension,
  options: StorageExtensionOptions = {}
): void {
  const migrations = validateStorageExtension(extension);
  const currentVersion = getStorageExtensionVersion(db, extension.id);
  const pending = migrations.filter((migration) => migration.version > currentVersion);
  if (options.readOnly) {
    if (pending.length > 0) {
      throw new Error(`Storage extension ${extension.id} has pending migrations but the database is read-only`);
    }
    return;
  }

  ensureStorageExtensionCatalog(db);
  ensureStorageExtensionRegistration(db, extension);

  for (const migration of pending) {
    db.transaction(() => {
      if (migration.sql.trim()) db.exec(migration.sql);
      db.prepare(`
        INSERT INTO ${EXTENSION_MIGRATION_TABLE} (extension_id, version, applied_at, description)
        VALUES (?, ?, ?, ?)
      `).run(extension.id, migration.version, Date.now(), migration.description);
      db.prepare(`
        UPDATE ${EXTENSION_TABLE}
        SET current_version = ?, updated_at = ?
        WHERE id = ?
      `).run(migration.version, Date.now(), extension.id);
    })();
  }
}
