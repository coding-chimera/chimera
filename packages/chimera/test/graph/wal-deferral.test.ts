/**
 * WAL checkpoint deferral during bulk indexing (#1231, ported to chimera).
 *
 * The default 1000-page wal_autocheckpoint re-writes hot pages into the main
 * DB over and over during a bulk index (~95% of all disk I/O on slow
 * storage). indexAll defers auto-checkpointing for the whole run, a
 * WalCheckpointValve bounds WAL growth via separate-connection PASSIVE
 * checkpoints, and the interval is restored afterwards. These tests pin the
 * DB helpers, the valve's trigger/dedupe/backpressure logic, and the
 * end-to-end indexAll behavior (identical graph with and without deferral;
 * interval restored).
 *
 * Regression pin: checkpointWalPassive runs on a WRITABLE separate connection
 * (SQLite folds WAL frames by writing them into the main DB file; a
 * read-only connection raises SQLITE_READONLY and the WAL grows unbounded).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection, WAL_HEAL_THRESHOLD_BYTES, resolveWalHealBytes } from '../../src/graph/db';
import { WalCheckpointValve, WalValveAbortError, resolveWalValveMb } from '../../src/graph/db/wal-valve';
import CodeGraph from '../../src/graph';
import type { IndexResult } from '../../src/graph/extraction';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-deferral-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(): DatabaseConnection {
  return DatabaseConnection.initialize(path.join(tmpDir, 'test.db'));
}

/** Grow the WAL: with autocheckpoint off, every commit appends and nothing folds back. */
function writeRows(db: DatabaseConnection, rows: number): void {
  const raw = db.getDb();
  raw.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)');
  const stmt = raw.prepare('INSERT INTO t (blob) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.run('x'.repeat(4096));
}

describe('resolveWalValveMb', () => {
  it('honors a positive numeric override and falls back otherwise', () => {
    expect(resolveWalValveMb('64')).toBe(64);
    expect(resolveWalValveMb('64.9')).toBe(64);
    expect(resolveWalValveMb(undefined)).toBe(256);
    expect(resolveWalValveMb('')).toBe(256);
    expect(resolveWalValveMb('abc')).toBe(256);
    expect(resolveWalValveMb('0')).toBe(256);
    expect(resolveWalValveMb('-5')).toBe(256);
  });
});

describe('DatabaseConnection WAL helpers', () => {
  it('reads and writes the wal_autocheckpoint interval', () => {
    const db = openDb();
    expect(db.getWalAutocheckpoint()).toBe(1000); // SQLite default
    db.setWalAutocheckpoint(0);
    expect(db.getWalAutocheckpoint()).toBe(0);
    db.setWalAutocheckpoint(1000);
    expect(db.getWalAutocheckpoint()).toBe(1000);
    db.close();
  });

  it('reports WAL size that grows with deferred commits', () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    const before = db.getWalSizeBytes();
    writeRows(db, 200);
    expect(db.getWalSizeBytes()).toBeGreaterThan(before);
    db.close();
  });

  it('checkpointWalPassive backfills the WAL from a writable separate connection and reports the result', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    const res = await db.checkpointWalPassive();
    // Backfill moves the committed pages into the main DB file…
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore);
    // …and reports a full backfill (idle DB: every WAL frame checkpointed).
    expect(res).not.toBeNull();
    expect(res!.busy).toBe(0);
    expect(res!.log).toBeGreaterThan(0);
    expect(res!.checkpointed).toBe(res!.log);
    db.close();
  });

  it('checkpointWalTruncate folds frames and shrinks the WAL file', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const walFile = path.join(tmpDir, 'test.db-wal');
    const walSizeBefore = fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
    const res = await db.checkpointWalTruncate();
    expect(res).not.toBeNull();
    expect(res!.busy).toBe(0);
    expect(res!.checkpointed).toBe(res!.log);
    const walSizeAfter = fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
    // TRUNCATE reclaims the WAL file's high-water size (PASSIVE never does).
    expect(walSizeAfter).toBeLessThan(walSizeBefore);
    db.close();
  });

  it('reuses one cached checkpoint connection across passes, closed with the DB', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 300);
    const internals = db as unknown as { getCheckpointConnection: () => unknown; checkpointConn: unknown };
    const first = internals.getCheckpointConnection();
    expect(internals.getCheckpointConnection()).toBe(first); // cached, not reopened
    await db.checkpointWalPassive();
    await db.checkpointWalPassive();
    await db.checkpointWalTruncate(); // both modes run on the same reused handle
    expect(internals.getCheckpointConnection()).toBe(first);
    db.close();
    expect(internals.checkpointConn).toBeNull(); // sidecar closed with the DB
  });
});

describe('WalCheckpointValve', () => {
  it('check() fires a checkpoint once growth passes the soft threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500); // WAL well past a ~10-byte threshold
    const valve = new WalCheckpointValve(db, 0.00001); // ~10 bytes soft
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore);
    db.close();
  });

  it('advances its baseline on a full backfill — a wrapped WAL does not retrigger it', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    // soft 2MB ⇒ hard 4MB (the ~5-6MB WAL — 4KB blobs spill into overflow
    // pages — trips the GROWTH trigger) and file cap 8MB (the same WAL stays
    // under the file-size trigger, so the baseline semantics below are what's
    // being tested).
    const valve = new WalCheckpointValve(db, 2);
    valve.check();
    await valve.drain(); // full backfill on an idle DB → baseline = current file size
    // The WAL file keeps its high-water size, but growth is now 0: neither
    // the timer path nor backpressure may fire again (the pre-fix bug fired
    // on raw size forever and serialized every store behind a checkpoint).
    expect(valve.backpressure()).toBeNull();
    valve.check();
    await valve.drain(); // no-op drain: nothing in flight
    // New commits recycle wrapped frames — file size is flat, still no trigger.
    writeRows(db, 5);
    expect(valve.backpressure()).toBeNull();
    db.close();
  });

  it('does not fire below the soft threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 5);
    const valve = new WalCheckpointValve(db, 1024); // 1GB soft — never reached
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBe(mainSizeBefore);
    db.close();
  });

  it('backpressure() is null under the hard cap and a promise above it', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const relaxed = new WalCheckpointValve(db, 1024);
    expect(relaxed.backpressure()).toBeNull();
    const strict = new WalCheckpointValve(db, 0.0000001); // hard cap ~0.4 bytes
    const bp = strict.backpressure();
    expect(bp).toBeInstanceOf(Promise);
    await bp;
    await strict.drain();
    db.close();
  });

  it('foldNow() backfills everything at a phase boundary and resets growth', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 1024); // thresholds never reached on their own
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    await valve.foldNow();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore); // pages backfilled
    expect(valve.backpressure()).toBeNull(); // baseline advanced — growth is zero
    await valve.foldNow(); // second fold is a no-op (growth 0), must not spin
    db.close();
  });

  it('dedupes concurrent fires into one in-flight checkpoint', () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    const first = valve.backpressure();
    const second = valve.backpressure();
    expect(second).toBe(first); // same in-flight promise, not a second worker
    db.close();
    return first ?? undefined;
  });
});

/** A checkpoint row the fake DB returns for every passive pass. */
interface FakeCheckpointRow { busy: number; log: number; checkpointed: number }

const MB = 1024 * 1024;

/**
 * The three DatabaseConnection methods the valve's backfill path touches,
 * fakeable without a real DB — lets tests pin the pinned-WAL scenario
 * (checkpoints permanently busy) that a live SQLite file cannot reproduce
 * on demand.
 */
function fakeValveDb(opts: {
  walBytes: number;
  checkpoint: FakeCheckpointRow;
  pageSizeBytes?: number;
  truncate?: FakeCheckpointRow | null;
}) {
  let calls = 0;
  let truncateCalls = 0;
  const db = {
    getWalSizeBytes: () => opts.walBytes,
    getPageSizeBytes: () => opts.pageSizeBytes ?? 4096,
    checkpointWalPassive: async () => {
      calls++;
      return { ...opts.checkpoint };
    },
    checkpointWalTruncate: async () => {
      truncateCalls++;
      if (opts.truncate === undefined) return { busy: 0, log: 0, checkpointed: 0 };
      return opts.truncate ? { ...opts.truncate } : null;
    },
  } as unknown as DatabaseConnection;
  return { db, callCount: () => calls, truncateCount: () => truncateCalls };
}

describe('WalCheckpointValve pinned-WAL backoff (index-stall regression)', () => {
  it('waits between backfill passes: 10ms exponential backoff capped at 200ms', async () => {
    // A foreign reader pins the WAL: every PASSIVE pass reports busy with zero
    // frames folded. Pre-fix this loop fired 20 synchronous checkpoints with
    // no wait and a fresh connection each; now it is spaced out.
    const { db, callCount } = fakeValveDb({ walBytes: 10 * MB, checkpoint: { busy: 1, log: 5000, checkpointed: 0 } });
    const sleeps: number[] = [];
    const valve = new WalCheckpointValve(db, 1, 2000, () => {}, async (ms) => { sleeps.push(ms); });
    // The pinned 10MB WAL is past the 4MB file cap, so the round ends
    // fail-closed (upstream 9b8bb4aba) instead of releasing the writer —
    // the pass budget and backoff schedule are what this test pins.
    const bp = valve.backpressure();
    expect(bp).toBeInstanceOf(Promise);
    await expect(bp!).rejects.toBeInstanceOf(WalValveAbortError);
    expect(callCount()).toBe(20); // the bounded attempt budget is unchanged
    expect(sleeps).toEqual([10, 20, 40, 80, 160, ...Array.from({ length: 14 }, () => 200)]);
  });

  it('credits partial progress to the baseline so the next file passes without a storm', async () => {
    // The checkpoint folds 2500 of 5000 pages then sticks busy. Pre-fix the
    // baseline stayed at 0 → every subsequent file's backpressure re-ran the
    // full 20-pass storm for the same unfolded remainder.
    const { db, callCount } = fakeValveDb({ walBytes: 10 * MB, checkpoint: { busy: 1, log: 5000, checkpointed: 2500 } });
    // soft 4MB ⇒ hard 8MB (10MB growth parks the writer) and file cap 16MB
    // (the 10MB file stays under it — the partial-credit semantics, not the
    // file trigger, are what this test pins).
    const valve = new WalCheckpointValve(db, 4, 2000, () => {}, async () => {});
    await valve.backpressure();
    expect(callCount()).toBe(20); // one round still exhausts its budget (WAL never lands fully)
    const baseline = (valve as unknown as { sizeAtLastFullBackfill: number }).sizeAtLastFullBackfill;
    expect(baseline).toBe(2500 * 4096); // folded pages credited once, not 20×
    // growth = 10MB − 2500×4096 ≈ 240KB < hard cap (8MB), file < cap (16MB)
    // → next file never waits.
    expect(valve.backpressure()).toBeNull();
  });

  it('downgrades repeat backfills inside the cooldown to a single probe and rate-limits the give-up log', async () => {
    const logs: string[] = [];
    const { db, callCount } = fakeValveDb({ walBytes: 10 * MB, checkpoint: { busy: 1, log: 5000, checkpointed: 0 } });
    const valve = new WalCheckpointValve(db, 1, 2000, (m) => { logs.push(m); }, async () => {});
    // Over-cap pinned WAL: every round now ends fail-closed (9b8bb4aba); the
    // cooldown still bounds each round's COST (single probe), and the give-up
    // LOG stays rate-limited.
    await expect(valve.backpressure()!).rejects.toBeInstanceOf(WalValveAbortError); // round 1: full 20-pass attempt
    expect(callCount()).toBe(20);
    expect(logs.filter((l) => l.includes('gave up'))).toHaveLength(1);
    await expect(valve.backpressure()!).rejects.toBeInstanceOf(WalValveAbortError); // round 2 (inside BACKFILL_COOLDOWN_MS): one cheap probe
    expect(callCount()).toBe(21);
    expect(logs.filter((l) => l.includes('gave up'))).toHaveLength(1); // log rate-limited
    // Cooldown expiry restores the full attempt budget.
    (valve as unknown as { lastBackfillEndedAt: number }).lastBackfillEndedAt = 0;
    await expect(valve.backpressure()!).rejects.toBeInstanceOf(WalValveAbortError);
    expect(callCount()).toBe(41);
  });
});

describe('indexAll WAL deferral end-to-end', () => {
  function writeFixtureProject(): void {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(tmpDir, 'src', `mod${i}.ts`),
        `export function fn${i}(x: number): number { return helper${i}(x) + ${i}; }\n` +
        `function helper${i}(x: number): number { return x * ${i}; }\n`
      );
    }
  }

  it('produces the same graph with and without deferral, and restores the interval', async () => {
    writeFixtureProject();

    const counts1 = await (async () => {
      const cg1 = CodeGraph.initSync(tmpDir);
      const conn1 = (cg1 as unknown as { db: DatabaseConnection }).db;
      conn1.setWalAutocheckpoint(37);
      const checkpoint = spyOn(conn1, 'checkpointWalTruncate');
      try {
        const result = await cg1.indexAll();
        expect(result.success).toBe(true);
        expect(conn1.getWalAutocheckpoint()).toBe(37);
        // The final quiescent-DB truncate always runs; barrier folds
        // (foldNow/backpressure) may also TRUNCATE at parked barriers
        // (upstream 8c1e821), so the exact count is wiring-dependent.
        expect(checkpoint).toHaveBeenCalled();
        return { nodes: result.nodesCreated, edges: result.edgesCreated };
      } finally {
        checkpoint.mockRestore();
        await cg1.close();
      }
    })();

    fs.rmSync(path.join(tmpDir, '.chimera'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, '.codegraph'), { recursive: true, force: true });

    process.env.CODEGRAPH_NO_WAL_DEFER = '1';
    try {
      const cg2 = CodeGraph.initSync(tmpDir);
      try {
        const result = await cg2.indexAll();
        expect(result.success).toBe(true);
        expect({ nodes: result.nodesCreated, edges: result.edgesCreated }).toEqual(counts1);
      } finally {
        await cg2.close();
      }
    } finally {
      delete process.env.CODEGRAPH_NO_WAL_DEFER;
    }
  });

  it('folds the WAL and restores a custom interval when indexing throws', async () => {
    const cg = CodeGraph.initSync(tmpDir);
    const internals = cg as unknown as {
      db: DatabaseConnection;
      orchestrator: { indexAll: () => Promise<never> };
    };
    internals.db.setWalAutocheckpoint(37);
    let walSizeBeforeCleanup = 0;
    const indexAll = spyOn(internals.orchestrator, 'indexAll').mockImplementation(async () => {
      writeRows(internals.db, 200);
      walSizeBeforeCleanup = internals.db.getWalSizeBytes();
      throw new Error('forced index failure');
    });

    try {
      await expect(cg.indexAll()).rejects.toThrow('forced index failure');
      expect(walSizeBeforeCleanup).toBeGreaterThan(0);
      expect(internals.db.getWalSizeBytes()).toBeLessThan(walSizeBeforeCleanup);
      expect(internals.db.getWalAutocheckpoint()).toBe(37);
    } finally {
      indexAll.mockRestore();
      await cg.close();
    }
  });

  it('finalizes the WAL and restores a custom interval when indexing returns failure', async () => {
    const cg = CodeGraph.initSync(tmpDir);
    const internals = cg as unknown as {
      db: DatabaseConnection;
      orchestrator: { indexAll: () => Promise<IndexResult> };
    };
    internals.db.setWalAutocheckpoint(37);
    const checkpoint = spyOn(internals.db, 'checkpointWalTruncate');
    const indexAll = spyOn(internals.orchestrator, 'indexAll').mockResolvedValue({
      success: false,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 1,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [{ message: 'forced result failure', severity: 'error' }],
      durationMs: 1,
    });

    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(false);
      // The final quiescent-DB truncate always runs; the post-orchestrator
      // foldNow barrier may also TRUNCATE leftover schema-phase WAL frames
      // (upstream 8c1e821), so the exact count is wiring-dependent.
      expect(checkpoint).toHaveBeenCalled();
      expect(internals.db.getWalAutocheckpoint()).toBe(37);
    } finally {
      indexAll.mockRestore();
      checkpoint.mockRestore();
      await cg.close();
    }
  });
});

describe('WAL heal at open (upstream 02c0e2c, #1431)', () => {
  it('resolveWalHealBytes honors the MB override and falls back to 64MB', () => {
    expect(resolveWalHealBytes('32')).toBe(32 * 1024 * 1024);
    expect(resolveWalHealBytes('32.9')).toBe(Math.floor(32.9 * 1024 * 1024));
    expect(resolveWalHealBytes('0')).toBe(64 * 1024 * 1024);
    expect(resolveWalHealBytes('-5')).toBe(64 * 1024 * 1024);
    expect(resolveWalHealBytes('abc')).toBe(64 * 1024 * 1024);
    expect(resolveWalHealBytes('')).toBe(64 * 1024 * 1024);
    expect(resolveWalHealBytes(undefined)).toBe(64 * 1024 * 1024);
    expect(WAL_HEAL_THRESHOLD_BYTES).toBe(resolveWalHealBytes(process.env.CODEGRAPH_WAL_HEAL_MB));
  });

  it('clips resetting checkpoints via journal_size_limit on writable connections', () => {
    const db = openDb();
    const limit = db.getDb().pragma('journal_size_limit', { simple: true });
    expect(limit).toBe(WAL_HEAL_THRESHOLD_BYTES);
    db.close();
  });

  it('heals an oversized leftover WAL below the threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500); // ~2MB WAL — past the 1MB test threshold
    const before = db.getWalSizeBytes();
    expect(before).toBeGreaterThan(1024 * 1024);
    const res = await db.healOversizedWal(1024 * 1024);
    expect(res.healed).toBe(true);
    expect(res.beforeBytes).toBe(before);
    expect(res.afterBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(db.getWalSizeBytes()).toBeLessThanOrEqual(1024 * 1024);
    db.close();
  });

  it('is a statSync no-op when the WAL is healthy', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 5);
    const passive = spyOn(db, 'checkpointWalPassive');
    const res = await db.healOversizedWal(); // default 64MB threshold
    expect(res.healed).toBe(false);
    expect(res.afterBytes).toBe(res.beforeBytes);
    expect(passive).not.toHaveBeenCalled();
    passive.mockRestore();
    db.close();
  });

  it('single-flights concurrent heals into one checkpoint pass', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const passive = spyOn(db, 'checkpointWalPassive');
    const [a, b] = await Promise.all([
      db.healOversizedWal(1024 * 1024),
      db.healOversizedWal(1024 * 1024),
    ]);
    expect(a).toBe(b); // same shared in-flight pass, not two racing heals
    // Idle DB: the first PASSIVE+TRUNCATE pair lands under the threshold, so
    // the bounded retry loop runs exactly one pass.
    expect(passive).toHaveBeenCalledTimes(1);
    passive.mockRestore();
    db.close();
  });

  it('open() fires the heal for writable opens and never for read-only opens', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    DatabaseConnection.initialize(dbPath).close();
    const heal = spyOn(DatabaseConnection.prototype, 'healOversizedWal').mockImplementation(
      async () => ({ healed: false, beforeBytes: 0, afterBytes: 0 })
    );
    try {
      const ro = DatabaseConnection.open(dbPath, { readOnly: true });
      expect(heal).not.toHaveBeenCalled();
      ro.close();
      const rw = DatabaseConnection.open(dbPath);
      expect(heal).toHaveBeenCalledTimes(1);
      rw.close();
    } finally {
      heal.mockRestore();
    }
  });
});

describe('valve file-size trigger + barrier truncate (upstream 8c1e821/ca88d3b#1/2adc7f6)', () => {
  it('parks on raw file size past the cap even when the backlog is fully folded, and truncates at the barrier', async () => {
    // The §7a.1 pathology: a WAL that is completely backfilled yet keeps its
    // (or grows its) file because commits never find zero reader marks.
    // baseline == file size ⇒ growth 0; file 10MB > fileCap (4×1MB).
    const { db, callCount, truncateCount } = fakeValveDb({
      walBytes: 10 * MB,
      checkpoint: { busy: 0, log: 100, checkpointed: 100 },
    });
    const valve = new WalCheckpointValve(db, 1, 2000, () => {}, async () => {});
    (valve as unknown as { sizeAtLastFullBackfill: number }).sizeAtLastFullBackfill = 10 * MB;
    const bp = valve.backpressure();
    expect(bp).toBeInstanceOf(Promise); // file-size trigger, not growth
    await bp;
    expect(callCount()).toBe(1); // backlog already folded: one pass proves it
    expect(truncateCount()).toBe(1); // the parked barrier chops the FILE
  });

  it('never truncates from the timer path (2adc7f6: an active-writer race)', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const truncate = spyOn(db, 'checkpointWalTruncate');
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore); // passive fold ran
    expect(truncate).not.toHaveBeenCalled();
    truncate.mockRestore();
    db.close();
  });

  it('foldNow truncates the file at the phase barrier', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    expect(db.getWalSizeBytes()).toBeGreaterThan(0);
    const valve = new WalCheckpointValve(db, 1024); // thresholds never trip on their own
    await valve.foldNow();
    // TRUNCATE at the parked barrier reclaims the high-water size.
    expect(db.getWalSizeBytes()).toBe(0);
    db.close();
  });
});

describe('WAL valve fail-closed (upstream 9b8bb4aba, #1539)', () => {
  it('aborts with WalValveAbortError when parked backfills cannot progress past the file cap', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 800); // well past a 0.5MB soft / 2MB file cap
    expect(db.getWalSizeBytes()).toBeGreaterThan(2 * 1024 * 1024);

    const valve = new WalCheckpointValve(db, 0.5, 2000, () => {}, async () => {});
    // Simulate a reader pinning every PASSIVE/TRUNCATE attempt.
    db.checkpointWalPassive = async () => ({ busy: 1, log: 100, checkpointed: 0 });
    db.checkpointWalTruncate = async () => ({ busy: 1, log: 100, checkpointed: 0 });

    const bp = valve.backpressure();
    expect(bp).not.toBeNull();
    let err: WalValveAbortError | undefined;
    try { await bp; } catch (e) { err = e as WalValveAbortError; }
    expect(err).toBeInstanceOf(WalValveAbortError);
    expect(err!.name).toBe('WalValveAbortError');
    expect(err!.code).toBe('WAL_VALVE_ABORT');
    expect(err!.message).toMatch(/Aborting to avoid unbounded disk growth/);
    expect(err!.walBytes).toBeGreaterThan(err!.fileCapBytes);
    // Caps remain enforceable: a subsequent backpressure call still parks (no
    // futility latch / cooldown path that returns null and lets the writer
    // race past the cap). Inside the cooldown this is a single cheap probe
    // that fails closed again.
    const again = valve.backpressure();
    expect(again).not.toBeNull();
    await expect(again!).rejects.toBeInstanceOf(WalValveAbortError);
    db.close();
  });

  it('aborts when checkpoint machinery is unavailable while over the file cap', async () => {
    const { db } = fakeValveDb({ walBytes: 10 * MB, checkpoint: { busy: 0, log: 0, checkpointed: 0 } });
    (db as unknown as { checkpointWalPassive: () => Promise<null> }).checkpointWalPassive = async () => null;
    const valve = new WalCheckpointValve(db, 1, 2000, () => {}, async () => {});
    const bp = valve.backpressure();
    expect(bp).not.toBeNull();
    let err: WalValveAbortError | undefined;
    try { await bp; } catch (e) { err = e as WalValveAbortError; }
    expect(err).toBeInstanceOf(WalValveAbortError);
    expect(err!.message).toMatch(/machinery unavailable/);
  });

  it('does not abort a soft foldNow give-up that stays under both caps', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 50); // small WAL (~0.5MB)
    const valve = new WalCheckpointValve(db, 1024, 2000, () => {}, async () => {}); // 1GB soft — hard 2GB, fileCap 4GB
    db.checkpointWalPassive = async () => ({ busy: 1, log: 10, checkpointed: 0 });
    // foldNow calls backfillFully even with modest growth; under the caps the
    // give-up stays soft — a healthy run must not abort.
    await valve.foldNow();
    expect(valve.backpressure()).toBeNull();
    db.close();
  });
});
