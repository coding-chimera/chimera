/**
 * Foundation Tests
 *
 * Tests for the CodeGraph foundation layer.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import { Node, Edge } from '../../src/graph/types';
import { getCodeGraphDir, getGraphDataRootInfo, isInitialized, migrateLegacyGraphData, probeLegacyGraphDataRoot, readIndexJob, validateDirectory } from '../../src/graph/directory';
import { DatabaseConnection, getDatabasePath } from '../../src/graph/db';
import { createDatabase } from '../../src/graph/db/sqlite-adapter';
import { CURRENT_SCHEMA_VERSION } from '../../src/graph/db/migrations';

const GRAPH_CLI = path.resolve(__dirname, 'fixtures/graph-cli.ts');

async function runGraphCli(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, GRAPH_CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('CodeGraph Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('Initialization', () => {
    it('should initialize a new project', () => {
      const cg = CodeGraph.initSync(tempDir);

      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(fs.existsSync(getDatabasePath(tempDir))).toBe(true);

      cg.close();
    });

    it('should initialize graph data in .chimera', () => {
      const cg = CodeGraph.initSync(tempDir);
      const dataRoot = getGraphDataRootInfo(tempDir);

      expect(dataRoot.dataRootStatus).toBe('current');
      expect(dataRoot.dataRoot).toBe(path.join(path.resolve(tempDir), '.chimera'));
      expect(fs.existsSync(path.join(tempDir, '.chimera', 'codegraph.db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(false);

      cg.close();
    });

    it('should write init job status during bootstrap', () => {
      const cg = CodeGraph.initSync(tempDir);
      const job = readIndexJob(tempDir);

      expect(job?.kind).toBe('init');
      expect(job?.status).toBe('succeeded');
      expect(job?.phase).toBe('bootstrap');

      cg.close();
    });

    it('should open legacy .codegraph databases without migration', () => {
      const legacyDb = path.join(tempDir, '.codegraph', 'codegraph.db');
      DatabaseConnection.initialize(legacyDb).close();

      const dataRoot = getGraphDataRootInfo(tempDir);
      const cg = CodeGraph.openSync(tempDir);

      expect(dataRoot.dataRootStatus).toBe('legacy');
      expect(getCodeGraphDir(tempDir)).toBe(path.join(path.resolve(tempDir), '.codegraph'));
      expect(cg.getProjectRoot()).toBe(path.resolve(tempDir));
      expect(fs.existsSync(path.join(tempDir, '.chimera'))).toBe(false);

      cg.close();
    });

    it('should not create graph data during read-only open of a fresh project', async () => {
      await expect(CodeGraph.open(tempDir, { readOnly: true })).rejects.toThrow(/not initialized/i);
      expect(fs.existsSync(path.join(tempDir, '.chimera'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, '.codegraph'))).toBe(false);
    });


    it('graph index should require explicit initialization', async () => {
      fs.writeFileSync(path.join(tempDir, 'subject.ts'), 'export const subject = 1\n');

      const result = await runGraphCli(['index', tempDir, '--quiet'], tempDir);

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('not initialized');
      expect(fs.existsSync(path.join(tempDir, '.chimera', 'codegraph.db'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(false);
    });

    it('graph sync should require explicit initialization', async () => {
      fs.writeFileSync(path.join(tempDir, 'subject.ts'), 'export const subject = 1\n');

      const result = await runGraphCli(['sync', tempDir], tempDir);

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('run "chimera graph init" first');
      expect(fs.existsSync(path.join(tempDir, '.chimera', 'codegraph.db'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(false);
    });

    it('should dry-run compatible legacy migration without creating .chimera', () => {
      const legacyDb = path.join(tempDir, '.codegraph', 'codegraph.db');
      DatabaseConnection.initialize(legacyDb).close();

      const result = migrateLegacyGraphData(tempDir, { dryRun: true, mode: 'copy' });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.probe.status).toBe('compatible-chimera-legacy');
      expect(fs.existsSync(path.join(tempDir, '.chimera'))).toBe(false);
    });

    it('should copy compatible legacy .codegraph data into .chimera', () => {
      const legacyDb = path.join(tempDir, '.codegraph', 'codegraph.db');
      DatabaseConnection.initialize(legacyDb).close();
      fs.mkdirSync(path.join(tempDir, '.codegraph', 'chimera'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.codegraph', 'chimera', 'tool-provenance.jsonl'), '', 'utf-8');

      const result = migrateLegacyGraphData(tempDir, { mode: 'copy', now: '2026-01-01T00:00:00.000Z' });
      const migration = JSON.parse(fs.readFileSync(path.join(tempDir, '.chimera', 'migration.json'), 'utf-8'));

      expect(result.success).toBe(true);
      expect(result.copiedFiles).toContain('codegraph.db');
      expect(result.verification?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.verification?.integrityCheck).toBe('ok');
      expect(fs.existsSync(path.join(tempDir, '.chimera', 'codegraph.db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.chimera', 'chimera', 'tool-provenance.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(true);
      expect(migration.probe.status).toBe('compatible-chimera-legacy');
      expect(migration.verification.integrityCheck).toBe('ok');
      expect(getGraphDataRootInfo(tempDir).dataRootStatus).toBe('mixed');
      const cg = CodeGraph.openSync(tempDir);
      expect(cg.getProjectRoot()).toBe(path.resolve(tempDir));
      cg.close();
    });

    it('should move compatible legacy .codegraph data by renaming the old root aside', () => {
      const legacyDb = path.join(tempDir, '.codegraph', 'codegraph.db');
      DatabaseConnection.initialize(legacyDb).close();

      const result = migrateLegacyGraphData(tempDir, { mode: 'move', now: '2026-01-01T00:00:00.000Z' });

      expect(result.success).toBe(true);
      expect(result.movedLegacyTo).toBe(path.join(tempDir, '.codegraph.legacy-20260101000000'));
      expect(fs.existsSync(path.join(tempDir, '.chimera', 'codegraph.db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.codegraph'))).toBe(false);
      expect(fs.existsSync(result.movedLegacyTo!)).toBe(true);
      expect(getGraphDataRootInfo(tempDir).dataRootStatus).toBe('current');
    });

    it('should reject original CodeGraph shaped .codegraph data', () => {
      const originalDb = path.join(tempDir, '.codegraph', 'codegraph.db');
      fs.mkdirSync(path.dirname(originalDb), { recursive: true });
      const db = createDatabase(originalDb);
      try {
        db.db.exec('CREATE TABLE original_codegraph_nodes (id TEXT PRIMARY KEY, payload TEXT)');
      } finally {
        db.db.close();
      }

      const probe = probeLegacyGraphDataRoot(tempDir);
      const result = migrateLegacyGraphData(tempDir, { mode: 'copy' });

      expect(probe.status).toBe('incompatible-original-codegraph');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('schema_versions');
      expect(fs.existsSync(path.join(tempDir, '.chimera'))).toBe(false);
    });

    it('should create .gitignore in .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*.db');

      cg.close();
    });

    it('should throw if already initialized', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      expect(() => CodeGraph.initSync(tempDir)).toThrow(/already initialized/i);
    });
  });

  describe('Opening Projects', () => {
    it('should open an existing project', () => {
      // First initialize
      const cg1 = CodeGraph.initSync(tempDir);
      cg1.close();

      // Then open
      const cg2 = CodeGraph.openSync(tempDir);
      expect(cg2.getProjectRoot()).toBe(path.resolve(tempDir));
      cg2.close();
    });

    it('should throw if not initialized', () => {
      expect(() => CodeGraph.openSync(tempDir)).toThrow(/not initialized/i);
    });
  });

  describe('Static Methods', () => {
    it('isInitialized should return false for new directory', () => {
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });

    it('isInitialized should return true after init', () => {
      const cg = CodeGraph.initSync(tempDir);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
      cg.close();
    });
  });

  describe('Database', () => {
    it('should create database with correct schema', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Check that we can get stats (requires tables to exist)
      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.fileCount).toBe(0);

      cg.close();
    });

    it('should return correct database size', () => {
      const cg = CodeGraph.initSync(tempDir);
      const stats = cg.getStats();

      // Database should have some size (at least the schema)
      expect(stats.dbSizeBytes).toBeGreaterThan(0);

      cg.close();
    });

    it('should support optimize operation', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Should not throw
      expect(() => cg.optimize()).not.toThrow();

      cg.close();
    });

    it('should support clear operation', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Should not throw
      expect(() => cg.clear()).not.toThrow();

      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);

      cg.close();
    });
  });

  describe('Directory Management', () => {
    it('should validate directory structure', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect invalid directory', () => {
      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Uninitialize', () => {
    it('should remove .CodeGraph directory', async () => {
      const cg = CodeGraph.initSync(tempDir);

      await cg.uninitialize();

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(false);
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });
  });

  describe('Close/Destroy', () => {
    it('should close database but keep .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.destroy(); // destroy is alias for close

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
    });
  });

  describe('Graph Query Methods', () => {
    it('should throw "Node not found" for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // getContext throws for non-existent nodes
      expect(() => cg.getContext('non-existent')).toThrow(/not found/i);

      cg.close();
    });

    it('should return empty results for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // These methods return empty results instead of throwing
      const traverseResult = cg.traverse('non-existent');
      expect(traverseResult.nodes.size).toBe(0);

      const callGraph = cg.getCallGraph('non-existent');
      expect(callGraph.nodes.size).toBe(0);

      const typeHierarchy = cg.getTypeHierarchy('non-existent');
      expect(typeHierarchy.nodes.size).toBe(0);

      const usages = cg.findUsages('non-existent');
      expect(usages.length).toBe(0);

      cg.close();
    });

  });
});

describe('Database Connection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should initialize new database', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    expect(db.isOpen()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    db.close();
  });

  it('should get schema version', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const version = db.getSchemaVersion();
    expect(version).not.toBeNull();
    expect(version?.version).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('should migrate schema v5 databases to v6 and backfill node search text', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const created = createDatabase(dbPath);
    const raw = created.db;
    raw.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      INSERT INTO schema_versions (version, applied_at, description)
      VALUES (5, 0, 'Simulated v5 schema');

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL,
        end_column INTEGER NOT NULL,
        docstring TEXT,
        signature TEXT,
        visibility TEXT,
        is_exported INTEGER DEFAULT 0,
        is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0,
        is_abstract INTEGER DEFAULT 0,
        decorators TEXT,
        type_parameters TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id,
        name,
        qualified_name,
        docstring,
        signature,
        content='nodes',
        content_rowid='rowid'
      );
    `);
    raw.prepare(`
      INSERT INTO nodes (
        id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column,
        docstring, signature, visibility,
        is_exported, is_async, is_static, is_abstract,
        decorators, type_parameters, updated_at
      ) VALUES (
        'node:1', 'function', 'buildSystemPrompt', 'prompt.buildSystemPrompt', 'src/prompt.ts', 'typescript',
        1, 1, 0, 0,
        NULL, NULL, NULL,
        1, 0, 0, 0,
        NULL, NULL, 0
      )
    `).run();
    raw.close();

    const db = DatabaseConnection.open(dbPath);
    const columns = (db.getDb().prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(columns).toContain('search_text');
    expect(db.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);

    const row = db.getDb()
      .prepare("SELECT search_text FROM nodes WHERE id = 'node:1'")
      .get() as { search_text: string };
    expect(row.search_text).toContain('system');
    expect(row.search_text).toContain('prompt');

    const ftsRows = db.getDb()
      .prepare(`
        SELECT nodes.name
        FROM nodes_fts
        JOIN nodes ON nodes_fts.id = nodes.id
        WHERE nodes_fts MATCH ?
      `)
      .all('"prompt"*') as Array<{ name: string }>;
    expect(ftsRows.map((item) => item.name)).toContain('buildSystemPrompt');

    db.close();
  });

  it('should support transactions', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const result = db.transaction(() => {
      return 42;
    });

    expect(result).toBe(42);

    db.close();
  });

  it('should throw when opening non-existent database', () => {
    const dbPath = path.join(tempDir, 'nonexistent.db');

    expect(() => DatabaseConnection.open(dbPath)).toThrow(/not found/i);
  });
});

describe('Query Builder', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
    cg = CodeGraph.initSync(tempDir);
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  it('should return null for non-existent node', () => {
    const node = cg.getNode('nonexistent');
    expect(node).toBeNull();
  });

  it('should return empty array for nodes in non-existent file', () => {
    const nodes = cg.getNodesInFile('nonexistent.ts');
    expect(nodes).toEqual([]);
  });

  it('should return empty array for edges from non-existent node', () => {
    const edges = cg.getOutgoingEdges('nonexistent');
    expect(edges).toEqual([]);
  });

  it('should return null for non-existent file', () => {
    const file = cg.getFile('nonexistent.ts');
    expect(file).toBeNull();
  });

  it('should return empty array for files when none tracked', () => {
    const files = cg.getFiles();
    expect(files).toEqual([]);
  });
});
