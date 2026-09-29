/**
 * Incremental sync must refresh the synthesis-owned edge set (#2033, fork
 * port of upstream #1988's sync-rebuild-convergence synthesis block).
 *
 * The fork's scoped sync already RE-RAN synthesis additively, but an
 * insert-only pass can never REMOVE an obsolete dispatch edge: a registration
 * that moved or vanished, a dispatcher that lost its emit pattern, or a
 * channel that crossed the fan-out cap all left stale `calls` edges behind
 * until a full re-index. The staged refresh (SynthesisStage overlay +
 * atomic publish) replaces the whole owned set from the ordinary base graph,
 * so a synced index converges to a rebuild.
 *
 * Fork adaptation of upstream __tests__/sync-rebuild-convergence.test.ts
 * (Synthesized edges converge after sync): the fork has no fn-pointer-dispatch,
 * go-implements or go-method-contains passes, so those cases are dropped; the
 * rebuild is clear() + indexAll on the live handle (the fork has no
 * CodeGraph.recreate), same as the CG-33 suite.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { createDatabase } from '../../src/graph/db/sqlite-adapter';
import { getGraphDataRootInfo } from '../../src/graph/directory';
import { QueryBuilder } from '../../src/graph/db/queries';

describe('Synthesized edges converge after sync (#2033)', () => {
  let dir: string;
  let cg: CodeGraph;

  const dbPath = (): string => getGraphDataRootInfo(dir).databasePath;

  const write = (file: string, content: string) => {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  // String-keyed EventEmitter channel: `fire()` dispatches 'ping', wiring.ts
  // registers `onPing`. The synthesized edge is fire → onPing with
  // synthesizedBy 'event-emitter' and registeredAt '<wiring file>:<line>'.
  const bus = `import { EventEmitter } from 'events';
export const bus = new EventEmitter();
export function fire(): void { bus.emit('ping'); }
export function onPing(): void {}
`;
  const wiring = "import { bus, onPing } from './bus';\nbus.on('ping', onPing);\n";
  const importOnly = "import { bus, onPing } from './bus';\n";

  const readEdges = (synthesized = true) => {
    const { db } = createDatabase(dbPath(), { readOnly: true });
    try {
      return db.prepare(`SELECT source, target, kind, metadata, line, col, provenance FROM edges
        ${synthesized ? "WHERE json_extract(metadata, '$.synthesizedBy') IS NOT NULL" : ''}
        ORDER BY source, target, kind, line, col, metadata`).all() as Array<{
        source: string; target: string; kind: string; metadata: string | null;
        line: number | null; col: number | null; provenance: string | null;
      }>;
    } finally {
      db.close();
    }
  };

  const metadataOf = (key: string): string | null => {
    const { db } = createDatabase(dbPath(), { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  };

  const pendingRefCount = (): number => {
    const { db } = createDatabase(dbPath(), { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM unresolved_refs WHERE status = 'pending'").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  const synthesisInputs = (): string[] => {
    const { db } = createDatabase(dbPath(), { readOnly: true });
    try {
      return (db.prepare('SELECT file_path FROM synthesis_inputs ORDER BY file_path').all() as Array<{
        file_path: string;
      }>).map((row) => row.file_path);
    } finally {
      db.close();
    }
  };

  const load = async () => {
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  };

  /** The synced graph must equal a from-scratch rebuild of the same tree. */
  const converges = async () => {
    const synced = readEdges();
    cg.clear();
    await cg.indexAll();
    expect(synced).toEqual(readEdges());
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-synthesis-'));
  });

  afterEach(async () => {
    if (cg) await cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([false, true])('adds and removes a registration without changing endpoints (scoped=%s)', async (scoped) => {
    write('bus.ts', bus);
    write('wiring.ts', importOnly);
    await load();
    expect(readEdges()).toHaveLength(0);

    // Registration appears: only wiring.ts changed, and no owned edge
    // touched it before — the content-pattern gate must fire the refresh.
    write('wiring.ts', wiring);
    await (scoped ? cg.syncFiles(['wiring.ts']) : cg.sync());
    expect(readEdges()).toHaveLength(1);
    await converges();

    // Registration vanishes again: the stale edge must NOT survive.
    write('wiring.ts', importOnly);
    await (scoped ? cg.syncFiles(['wiring.ts']) : cg.sync());
    expect(readEdges()).toHaveLength(0);
    await converges();
  });

  it('adds, renames and deletes a separate registration file', async () => {
    write('bus.ts', bus);
    await load();

    write('wiring.ts', wiring);
    await cg.syncFiles(['wiring.ts']);
    expect(readEdges()).toHaveLength(1);
    await converges();

    fs.renameSync(path.join(dir, 'wiring.ts'), path.join(dir, 'renamed.ts'));
    await cg.syncFiles(['wiring.ts', 'renamed.ts']);
    const edges = readEdges();
    expect(edges).toHaveLength(1);
    expect(JSON.parse(edges[0]!.metadata!).registeredAt).toBe('renamed.ts:2');
    await converges();

    fs.unlinkSync(path.join(dir, 'renamed.ts'));
    await cg.syncFiles(['renamed.ts']);
    expect(readEdges()).toHaveLength(0);
    await converges();
  });

  it('refreshes when a dispatcher loses its emit pattern before its edges cascade', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    await load();
    expect(readEdges()).toHaveLength(1);

    // The fire() node id survives the edit (name/line stable), so the
    // synthesized edge is NOT cascade-deleted — only the refresh removes it.
    write('bus.ts', bus.replace("bus.emit('ping');", ''));
    await cg.syncFiles(['bus.ts']);
    expect(readEdges()).toHaveLength(0);
    await converges();
  });

  it('skips the refresh for no-op syncs and unrelated ordinary edits', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    write('math.ts', 'export function square(n: number) { return n * n; }\n');
    await load();
    const before = readEdges();
    // A fresh index never arms the marker: only migration v13 or a triggered
    // sync writes it, and a no-op sync must leave it untouched.
    expect(metadataOf('synthesis_pending')).toBeNull();

    // No-op full reconcile: nothing changed, no refresh.
    await cg.sync();
    expect(metadataOf('synthesis_pending')).toBeNull();
    expect(readEdges()).toEqual(before);

    // Unrelated edit through the scoped path: math.ts owns no synthesized
    // edge, was no synthesis input, and its content has no pattern.
    write('math.ts', 'export function square(n: number) { return n * n + 1; }\n');
    await cg.syncFiles(['math.ts']);
    expect(metadataOf('synthesis_pending')).toBeNull();
    expect(readEdges()).toEqual(before);
    await converges();
  });

  it('refreshes all event channels when a registration crosses the fan-out cap', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    for (let i = 0; i < 5; i++) {
      write(`handler${i}.ts`, `import { bus } from './bus';\nfunction handler${i}() {}\nbus.on('ping', handler${i});\n`);
    }
    await load();
    // wiring + 5 handlers = 6 registrations, at the cap: all dispatch.
    expect(readEdges()).toHaveLength(6);

    // A 7th registration crosses EVENT_FANOUT_CAP: the whole channel drops.
    write('extra.ts', "import { bus } from './bus';\nfunction extra() {}\nbus.on('ping', extra);\n");
    await cg.syncFiles(['extra.ts']);
    expect(readEdges()).toHaveLength(0);
    await converges();

    // Removing it makes the channel viable again — the input gate recorded
    // extra.ts even while it produced NO edges.
    fs.unlinkSync(path.join(dir, 'extra.ts'));
    await cg.syncFiles(['extra.ts']);
    expect(readEdges()).toHaveLength(6);
    await converges();
  });

  it('maintains synthesis_inputs rows through replaceSynthesisInputs', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    write('math.ts', 'export function square(n: number) { return n * n; }\n');
    await load();

    // Both wiring files are recorded source gates; the pattern-free math.ts
    // file is not.
    expect(synthesisInputs()).toEqual(['bus.ts', 'wiring.ts']);

    // A refresh REPLACES the whole set: rewriting wiring.ts without any
    // registrar/dispatcher-shaped content (the old `onPing` import alone
    // would still gate it) leaves only bus.ts. The pre-cascade touching
    // check on the old registeredAt site is what fires the refresh.
    write('wiring.ts', "import { bus } from './bus';\nexport const wired = bus;\n");
    await cg.syncFiles(['wiring.ts']);
    expect(synthesisInputs()).toEqual(['bus.ts']);
  });

  it('recovers synthesis after extraction was interrupted before resolution', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    await load();

    // indexFiles absorbs the edit but never resolves/synthesizes it.
    fs.appendFileSync(path.join(dir, 'bus.ts'), '// interrupted index\n');
    await cg.indexFiles(['bus.ts']);
    expect(pendingRefCount()).toBeGreaterThan(0);

    // The next sync detects the orphaned pending refs BEFORE adding its own
    // and runs the staged refresh even though this sync changes nothing.
    const result = await cg.sync();
    expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
    expect(readEdges()).toHaveLength(1);
    expect(metadataOf('synthesis_pending')).toBe('0');
    await converges();
  });

  it('migrates an existing index and repairs synthesis without a file edit', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    await load();
    await cg.destroy();

    // Simulate the pre-v13 state: no synthesis tracking, owned edges gone.
    const { db } = createDatabase(dbPath());
    try {
      db.exec(`DELETE FROM schema_versions WHERE version >= 13;
        INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (12, 0, 'legacy fixture');
        DROP TABLE synthesis_inputs;
        DROP INDEX idx_edges_synthesis_site;
        DROP INDEX idx_nodes_kind;
        CREATE INDEX idx_nodes_kind ON nodes(kind);
        DELETE FROM edges WHERE provenance = 'heuristic'`);
    } finally {
      db.close();
    }

    // Reopen runs migration v13, which arms synthesis_pending; the no-op
    // sync then rebuilds the owned set without any file edit.
    cg = CodeGraph.openSync(dir);
    await cg.sync();
    expect(readEdges()).toHaveLength(1);
    expect(metadataOf('synthesis_pending')).toBe('0');
    await converges();
  });

  it('rolls back a failed replacement without removing ordinary or old synthesized edges', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    await load();
    const before = readEdges();
    const ordinary = readEdges(false).filter((e) => e.provenance !== 'heuristic');

    // Make the publish's INSERT fail: every staged edge carries provenance
    // 'heuristic'. The old owned set and every ordinary edge must survive,
    // and synthesis_pending stays armed for the retry.
    const { db } = createDatabase(dbPath());
    try {
      db.exec(`CREATE TRIGGER fail_synthesis BEFORE INSERT ON edges
        WHEN NEW.provenance = 'heuristic' BEGIN SELECT RAISE(FAIL, 'publish failed'); END`);
    } finally {
      db.close();
    }

    write('wiring.ts', wiring + '// changed registration file\n');
    let threw = false;
    try {
      await cg.syncFiles(['wiring.ts']);
    } catch (error) {
      threw = /publish failed/.test(String(error));
    }
    expect(threw).toBe(true);
    expect(readEdges()).toEqual(before);
    expect(readEdges(false).filter((e) => e.provenance !== 'heuristic')).toEqual(ordinary);
    expect(metadataOf('synthesis_pending')).toBe('1');

    const { db: db2 } = createDatabase(dbPath());
    try {
      db2.exec('DROP TRIGGER fail_synthesis');
    } finally {
      db2.close();
    }

    // The retry converges to the rebuild's answer.
    await cg.syncFiles(['wiring.ts']);
    expect(readEdges()).toEqual(before);
    expect(metadataOf('synthesis_pending')).toBe('0');
    await converges();
  });

  it('exposes the pre-cascade predicates on QueryBuilder', async () => {
    write('bus.ts', bus);
    write('wiring.ts', wiring);
    await load();

    const { db } = createDatabase(dbPath(), { readOnly: true });
    try {
      const queries = new QueryBuilder(db);
      // Both endpoint files and the third-file registration site are found.
      expect(queries.hasSynthesizedEdgesTouchingFile('bus.ts')).toBe(true);
      expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(true);
      expect(queries.hasSynthesizedEdgesTouchingFile('math.ts')).toBe(false);
      expect(queries.wasSynthesisInput('bus.ts')).toBe(true);
      expect(queries.wasSynthesisInput('math.ts')).toBe(false);
    } finally {
      db.close();
    }
  });
});
