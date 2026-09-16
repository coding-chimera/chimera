/**
 * Extraction-semantics versioning (Rust-kernel plan P0-3).
 *
 * Pins the stamp contract: a full index (or a fresh-database sync) records
 * EXTRACTION_SEMANTICS_VERSION in project_metadata; a read-only open against a
 * mismatched stamp reports needsReindex on the CodeGraph status surface, the
 * chimera_status/chimera_search tool faces, and `chimera graph status`, without
 * ever writing, restamping, or migrating; an unstamped legacy database is
 * treated leniently (no signal).
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import fsSync from 'fs';
import fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Effect, Layer } from 'effect';
import { CodeGraph, codegraphVersion } from '../../src/graph';
import { getDatabasePath } from '../../src/graph/db';
import { createDatabase } from '../../src/graph/db/sqlite-adapter';
import {
  EXTRACTION_SEMANTICS_METADATA_KEY,
  EXTRACTION_SEMANTICS_VERSION,
  checkExtractionSemantics,
} from '../../src/graph/db/extraction-version';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion } from '../../src/graph/db/migrations';
import { Bus } from '@/bus';
import { Chimera } from '@/chimera';
import { ChimeraPromptContext } from '@/chimera/prompt-context';
import { Agent } from '@/agent/agent';
import { MessageID, SessionID } from '@/session/schema';
import { ChimeraSearchTool, ChimeraStatusTool } from '@/tool/chimera';
import { Tool } from '@/tool/tool';
import { Truncate } from '@/tool/truncate';
import { disposeAllInstances, TestInstance } from '../fixture/fixture';
import { testEffect } from '../lib/effect';

const GRAPH_CLI = path.resolve(__dirname, 'fixtures/graph-cli.ts');

async function runGraphCli(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, GRAPH_CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function readStampRow(root: string): string | null {
  const raw = createDatabase(getDatabasePath(root));
  try {
    const row = raw.db
      .prepare('SELECT value FROM project_metadata WHERE key = ?')
      .get(EXTRACTION_SEMANTICS_METADATA_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    raw.db.close();
  }
}

function writeStampRow(root: string, value: string): void {
  const raw = createDatabase(getDatabasePath(root));
  try {
    raw.db
      .prepare(
        'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(EXTRACTION_SEMANTICS_METADATA_KEY, value, Date.now());
  } finally {
    raw.db.close();
  }
}

/** Persistent-state fingerprint of a project dir: every file path + size + mtime. */
function dirSnapshot(dir: string): Array<{ rel: string; size: number; mtimeMs: number }> {
  const entries: Array<{ rel: string; size: number; mtimeMs: number }> = [];
  const walk = (current: string): void => {
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fsSync.statSync(full);
      entries.push({ rel: path.relative(dir, full), size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(dir);
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

// SQLite WAL coordination files are transient open-time artifacts of the
// connection lifecycle, not persisted graph state; purity is asserted on the
// main database file and the full path set.
const TRANSIENT_SQLITE = (rel: string): boolean => /\.(?:db-wal|db-shm)$/.test(rel);

const staleStamp = JSON.stringify({
  version: EXTRACTION_SEMANTICS_VERSION + 7,
  codegraphVersion: '9.9.9-stale-test',
});

async function createIndexedProject(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'sample.ts'), 'export const trackedSample = 1;\n');
  const cg = await CodeGraph.init(dir, { index: true });
  await cg.close();
}

let tempDir: string;

beforeEach(() => {
  tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-version-'));
});

afterEach(async () => {
  await disposeAllInstances();
  fsSync.rmSync(tempDir, { recursive: true, force: true });
});

describe('extraction semantics stamp (db layer)', () => {
  it('records the version key plus codegraphVersion after a full index', async () => {
    await createIndexedProject(tempDir);

    const stamp = JSON.parse(readStampRow(tempDir)!) as { version: number; codegraphVersion: string };
    expect(stamp.version).toBe(EXTRACTION_SEMANTICS_VERSION);
    expect(stamp.codegraphVersion).toBe(codegraphVersion);

    const cg = await CodeGraph.open(tempDir, { readOnly: true });
    try {
      expect(cg.getExtractionSemanticsStatus()).toEqual({
        needsReindex: false,
        storedVersion: EXTRACTION_SEMANTICS_VERSION,
        currentVersion: EXTRACTION_SEMANTICS_VERSION,
        storedCodegraphVersion: codegraphVersion,
      });
    } finally {
      await cg.close();
    }
  });

  it('treats an unstamped legacy database leniently (no signal, version unknown)', () => {
    const cg = CodeGraph.initSync(tempDir);
    try {
      expect(readStampRow(tempDir)).toBeNull();
      expect(cg.getExtractionSemanticsStatus()).toEqual({
        needsReindex: false,
        storedVersion: null,
        currentVersion: EXTRACTION_SEMANTICS_VERSION,
        storedCodegraphVersion: null,
      });
    } finally {
      cg.destroy();
    }
  });

  it('treats an unparseable stamp as unstamped', async () => {
    await createIndexedProject(tempDir);
    writeStampRow(tempDir, 'not-json');

    const conn = createDatabase(getDatabasePath(tempDir));
    try {
      expect(checkExtractionSemantics(conn.db)).toEqual({
        needsReindex: false,
        storedVersion: null,
        currentVersion: EXTRACTION_SEMANTICS_VERSION,
        storedCodegraphVersion: null,
      });
    } finally {
      conn.db.close();
    }
  });

  it('flags a present-but-mismatched stamp as needsReindex in either direction', async () => {
    await createIndexedProject(tempDir);
    writeStampRow(tempDir, staleStamp);

    const conn = createDatabase(getDatabasePath(tempDir));
    try {
      const status = checkExtractionSemantics(conn.db);
      expect(status.needsReindex).toBe(true);
      expect(status.storedVersion).toBe(EXTRACTION_SEMANTICS_VERSION + 7);
      expect(status.storedCodegraphVersion).toBe('9.9.9-stale-test');
    } finally {
      conn.db.close();
    }
  });

  it('stamps a fresh-database sync but never restamps over existing content', async () => {
    // Tool/MCP graph creation indexes through sync (empty database): that is a
    // complete fresh extraction, so it earns the stamp like indexAll.
    await fs.writeFile(path.join(tempDir, 'sample.ts'), 'export const trackedSample = 1;\n');
    let cg = await CodeGraph.init(tempDir, { index: false });
    await cg.sync();
    await cg.close();
    const stamp = JSON.parse(readStampRow(tempDir)!) as { version: number };
    expect(stamp.version).toBe(EXTRACTION_SEMANTICS_VERSION);

    // Once content exists, a sync re-extracts only a subset: an existing
    // (even mismatched) stamp must survive untouched.
    writeStampRow(tempDir, staleStamp);
    cg = await CodeGraph.open(tempDir);
    await cg.sync();
    await cg.close();
    expect(readStampRow(tempDir)).toBe(staleStamp);
  });
});

describe('needsReindex on the CLI status surface', () => {
  it('reports needsReindex in JSON and text without writing or migrating (read-only purity)', async () => {
    await createIndexedProject(tempDir);
    writeStampRow(tempDir, staleStamp);
    const schemaBefore = (() => {
      const raw = createDatabase(getDatabasePath(tempDir));
      try {
        return getCurrentVersion(raw.db);
      } finally {
        raw.db.close();
      }
    })();

    const json = await runGraphCli(['status', tempDir, '--json'], tempDir);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      needsReindex: boolean;
      extractionSemanticsVersion: number | null;
      requiredExtractionSemanticsVersion: number;
    };
    expect(parsed.needsReindex).toBe(true);
    expect(parsed.extractionSemanticsVersion).toBe(EXTRACTION_SEMANTICS_VERSION + 7);
    expect(parsed.requiredExtractionSemanticsVersion).toBe(EXTRACTION_SEMANTICS_VERSION);

    const text = await runGraphCli(['status', tempDir], tempDir);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('does not match');
    expect(text.stdout).toContain('chimera graph index');
    expect(text.stdout).toContain('re-extract');

    // Read-only surfaces never repair: stamp, schema, and persistent files all unchanged.
    expect(readStampRow(tempDir)).toBe(staleStamp);
    const raw = createDatabase(getDatabasePath(tempDir));
    try {
      expect(getCurrentVersion(raw.db)).toBe(schemaBefore);
    } finally {
      raw.db.close();
    }
  });

  it('stays silent for a matching stamp and for an unstamped legacy database', async () => {
    await createIndexedProject(tempDir);
    const matched = await runGraphCli(['status', tempDir, '--json'], tempDir);
    expect(JSON.parse(matched.stdout).needsReindex).toBe(false);
    const matchedText = await runGraphCli(['status', tempDir], tempDir);
    expect(matchedText.stdout).not.toContain('re-extract');

    const legacyDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-version-legacy-'));
    try {
      const cg = CodeGraph.initSync(legacyDir);
      cg.destroy();
      const legacy = await runGraphCli(['status', legacyDir, '--json'], legacyDir);
      const parsed = JSON.parse(legacy.stdout) as { needsReindex: boolean; extractionSemanticsVersion: number | null };
      expect(parsed.needsReindex).toBe(false);
      expect(parsed.extractionSemanticsVersion).toBeNull();
    } finally {
      fsSync.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

// Tool-face assertions exercise the real Effect tools (no mocks), mirroring
// test/tool/chimera.test.ts needsMigration coverage.
const ctx = {
  sessionID: SessionID.make('ses_test-extraction-version'),
  messageID: MessageID.make('msg_test-extraction-version'),
  callID: 'call_extraction_version',
  agent: 'build',
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
};

const toolIt = testEffect(Layer.mergeAll(Bus.layer, Agent.defaultLayer, Truncate.defaultLayer, ChimeraPromptContext.layer));

const runStatus = Effect.fn('ExtractionVersionTest.runStatus')(function* (
  args: Tool.InferParameters<typeof ChimeraStatusTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraStatusTool;
  const tool = yield* info.init();
  return yield* tool.execute(args, next);
});

const runSearch = Effect.fn('ExtractionVersionTest.runSearch')(function* (
  args: Tool.InferParameters<typeof ChimeraSearchTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ChimeraSearchTool;
  const tool = yield* info.init();
  return yield* tool.execute(args, next);
});

describe('needsReindex on the chimera tool surfaces', () => {
  toolIt.instance('status/search report the mismatch read-only and the recovery command', () =>
    Effect.gen(function* () {
      const test = yield* TestInstance;
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, 'tracked.ts'), 'export const tracked = 1\n'));
      yield* Chimera.initProjectGraph({ watch: false });

      // Fresh tool-created graph: the empty-database sync stamped the current
      // version, so the check runs and reports no signal.
      const fresh = yield* runStatus({ refresh: false });
      expect(fresh.metadata.needsReindex).toBe(false);
      expect(fresh.metadata.extractionSemanticsVersion).toBe(EXTRACTION_SEMANTICS_VERSION);
      expect(fresh.output).not.toContain('re-extract');

      yield* Effect.sync(() => writeStampRow(test.directory, staleStamp));

      const status = yield* runStatus({ refresh: false });
      expect(status.metadata.needsReindex).toBe(true);
      expect(status.metadata.extractionSemanticsVersion).toBe(EXTRACTION_SEMANTICS_VERSION + 7);
      expect(status.metadata.requiredExtractionSemanticsVersion).toBe(EXTRACTION_SEMANTICS_VERSION);
      expect(status.output).toContain('does not match the current extractor');
      expect(status.output).toContain('chimera graph index');

      const search = yield* runSearch({ query: 'tracked', refresh: false });
      expect(search.metadata.needsReindex).toBe(true);
      expect(search.output).toContain('chimera graph index');
      // Report-only posture: the stale-semantics index still answers queries.
      expect(search.metadata.results.length).toBeGreaterThan(0);

      // Read-only purity: the tool faces neither restamp nor migrate the mismatch.
      expect(yield* Effect.sync(() => readStampRow(test.directory))).toBe(staleStamp);
    }),
  );

  toolIt.instance('check paths create no files and never touch the database (read-only purity)', () =>
    Effect.gen(function* () {
      const test = yield* TestInstance;
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, 'tracked.ts'), 'export const tracked = 1\n'));
      yield* Chimera.initProjectGraph({ watch: false });
      yield* Effect.sync(() => writeStampRow(test.directory, staleStamp));

      // Baseline after all writable flows are done and closed: only the
      // read-only status/search checks run between the two snapshots.
      const before = dirSnapshot(test.directory);
      yield* runStatus({ refresh: false });
      yield* runSearch({ query: 'tracked', refresh: false });
      const after = dirSnapshot(test.directory);

      expect(after.map((entry) => entry.rel)).toEqual(before.map((entry) => entry.rel));
      expect(after.filter((entry) => !TRANSIENT_SQLITE(entry.rel))).toEqual(
        before.filter((entry) => !TRANSIENT_SQLITE(entry.rel)),
      );
    }),
  );
});
