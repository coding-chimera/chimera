/**
 * Stale-extraction-semantics rebuild on writer open (fork port of the
 * upstream v1.6.1 #2034 daemon catch-up semantics: "MCP daemon catch-up
 * rebuilds a stale index on start so the watcher does not keep serving the
 * hole after upgrade").
 *
 * Pins the four contract points:
 *  - a stale stamp on a WRITER-open catch-up triggers exactly one background
 *    `indexAll()` and re-stamps the database, so the next writer open is a
 *    no-op (one-shot; never loops);
 *  - a READ-ONLY engine open never triggers the rebuild and never touches the
 *    stamp (the read side only reports needsReindex);
 *  - a failed rebuild (exception or file-lock contention) logs, keeps serving
 *    the stale content, and retries on the next writer open;
 *  - a current stamp does zero rebuild work.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/graph/index';
import { MCPEngine } from '../../src/graph/mcp/engine';
import { getDatabasePath } from '../../src/graph/db';
import { createDatabase } from '../../src/graph/db/sqlite-adapter';
import {
  EXTRACTION_SEMANTICS_METADATA_KEY,
  EXTRACTION_SEMANTICS_VERSION,
} from '../../src/graph/db/extraction-version';
import { getCodeGraphDir } from '../../src/graph/directory';
import { FileLock } from '../../src/graph/utils';

let tempDir: string;
let engines: MCPEngine[];
let indexAllCalls: number;
let failNextIndexAll: boolean;
const originalIndexAll = CodeGraph.prototype.indexAll;

function stampVersion(dir: string): number | null {
  const raw = createDatabase(getDatabasePath(dir));
  try {
    const row = raw.db
      .prepare('SELECT value FROM project_metadata WHERE key = ?')
      .get(EXTRACTION_SEMANTICS_METADATA_KEY) as { value: string } | undefined;
    if (!row) return null;
    return (JSON.parse(row.value) as { version?: number }).version ?? null;
  } finally {
    raw.db.close();
  }
}

function writeStamp(dir: string, version: number): void {
  const raw = createDatabase(getDatabasePath(dir));
  try {
    raw.db
      .prepare(
        'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(
        EXTRACTION_SEMANTICS_METADATA_KEY,
        JSON.stringify({ version, codegraphVersion: 'stale-rebuild-test' }),
        Date.now(),
      );
  } finally {
    raw.db.close();
  }
}

/** Open a writer engine on the project and drain its catch-up chain via the
 * first tool call (gate timeout 0 = wait for the full rebuild+sync chain). */
async function runWriterCatchUp(dir: string): Promise<{ text: string; isError: boolean | undefined }> {
  const engine = new MCPEngine({ watch: false });
  engines.push(engine);
  await engine.ensureInitialized(dir);
  const previous = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
  try {
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'trackedSample' });
    return { text: result.content[0].text, isError: result.isError };
  } finally {
    if (previous === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = previous;
  }
}

beforeEach(async () => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stale-rebuild-')));
  engines = [];
  indexAllCalls = 0;
  failNextIndexAll = false;
  fs.writeFileSync(path.join(tempDir, 'sample.ts'), 'export const trackedSample = 1;\n');
  const cg = await CodeGraph.init(tempDir, { index: true });
  await cg.close();
  CodeGraph.prototype.indexAll = async function (this: CodeGraph, ...args: Parameters<typeof originalIndexAll>) {
    indexAllCalls++;
    if (failNextIndexAll) {
      failNextIndexAll = false;
      throw new Error('simulated rebuild failure');
    }
    return originalIndexAll.apply(this, args);
  };
});

afterEach(() => {
  CodeGraph.prototype.indexAll = originalIndexAll;
  for (const engine of engines) {
    try { engine.stop(); } catch { /* ignore */ }
  }
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('stale-extraction rebuild on writer open (#2034 catch-up port)', () => {
  it('rebuilds a stale-stamped index once and re-stamps it; the next writer open is a no-op', async () => {
    writeStamp(tempDir, EXTRACTION_SEMANTICS_VERSION - 1);

    const first = await runWriterCatchUp(tempDir);
    expect(first.isError).toBeFalsy();
    expect(first.text).toMatch(/trackedSample/);
    expect(indexAllCalls).toBe(1);
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION);

    // One-shot: stamp now matches, so a second writer open does no rebuild.
    for (const engine of engines.splice(0)) {
      try { engine.stop(); } catch { /* ignore */ }
    }
    const second = await runWriterCatchUp(tempDir);
    expect(second.isError).toBeFalsy();
    expect(indexAllCalls).toBe(1);
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION);
  });

  it('never triggers on a read-only engine open and leaves the stale stamp untouched', async () => {
    writeStamp(tempDir, EXTRACTION_SEMANTICS_VERSION - 1);

    const engine = new MCPEngine({ readOnly: true, watch: false });
    engines.push(engine);
    await engine.ensureInitialized(tempDir);
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'trackedSample' });
    // Give any erroneously-scheduled async rebuild a window to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/trackedSample/);
    expect(indexAllCalls).toBe(0);
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION - 1);
  });

  it('a throwing rebuild logs, keeps serving stale content, and retries on the next writer open', async () => {
    writeStamp(tempDir, EXTRACTION_SEMANTICS_VERSION - 1);
    failNextIndexAll = true;

    const failed = await runWriterCatchUp(tempDir);
    // The engine survives the failure and still answers from the stale index.
    expect(failed.isError).toBeFalsy();
    expect(failed.text).toMatch(/trackedSample/);
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION - 1);
    expect(indexAllCalls).toBe(1);

    for (const engine of engines.splice(0)) {
      try { engine.stop(); } catch { /* ignore */ }
    }
    const retried = await runWriterCatchUp(tempDir);
    expect(retried.isError).toBeFalsy();
    expect(indexAllCalls).toBe(2);
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION);
  });

  it('file-lock contention degrades to serving stale content and retries when the lock frees', async () => {
    writeStamp(tempDir, EXTRACTION_SEMANTICS_VERSION - 1);
    const held = new FileLock(path.join(getCodeGraphDir(tempDir), 'codegraph.lock'));
    held.acquire();
    try {
      const contended = await runWriterCatchUp(tempDir);
      expect(contended.isError).toBeFalsy();
      expect(contended.text).toMatch(/trackedSample/);
      expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION - 1);
    } finally {
      held.release();
    }

    for (const engine of engines.splice(0)) {
      try { engine.stop(); } catch { /* ignore */ }
    }
    const retried = await runWriterCatchUp(tempDir);
    expect(retried.isError).toBeFalsy();
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION);
    // Two attempts: the contended one (graceful success:false) + the retry.
    expect(indexAllCalls).toBe(2);
  });

  it('does zero rebuild work when the stamp is current', async () => {
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION);

    const result = await runWriterCatchUp(tempDir);
    expect(result.isError).toBeFalsy();
    expect(result.text).toMatch(/trackedSample/);
    expect(indexAllCalls).toBe(0);
    expect(stampVersion(tempDir)).toBe(EXTRACTION_SEMANTICS_VERSION);
  });
});
