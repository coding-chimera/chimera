/**
 * WAL checkpoint valve — bounds WAL growth while auto-checkpointing is
 * deferred during a bulk index (upstream #1231, ported to chimera).
 *
 * Why deferral: SQLite's default `wal_autocheckpoint` (1000 pages) re-writes
 * hot B-tree/FTS pages into the main DB file over and over during a bulk
 * index — measured at ~95% of ALL disk I/O upstream, and the difference
 * between 45s and 19+ minutes on HDD-class storage. Deferring checkpoints
 * turns the store into pure sequential WAL appends; each backfill pass writes
 * distinct pages once, in page order (≈ sequential).
 *
 * Why a valve: unbounded deferral is its own failure mode — the WAL
 * duplicates hot pages per COMMIT and grows far faster than the DB, filling
 * the disk and poisoning every subsequent read that must page through it.
 * The valve watches WAL growth on a timer and, past a soft threshold,
 * backfills with `PRAGMA wal_checkpoint(PASSIVE)` on a separate connection —
 * PASSIVE never blocks the writer.
 *
 * The load-bearing subtlety: a WAL file's SIZE never shrinks. After a full
 * backfill, the writer's next commit RESTARTS the WAL from the top and the
 * frames recycle inside the same file — so raw size says nothing about the
 * un-backfilled backlog. The valve tracks `sizeAtLastFullBackfill` and
 * triggers on GROWTH beyond that baseline.
 *
 * Backpressure: if the writer outruns the checkpointer past a hard cap of
 * growth (2× soft), {@link backpressure} pauses the writer (at a safe,
 * between-transactions boundary) until a FULL backfill lands. A second,
 * independent trigger guards the FILE size (4× soft): a fully-backfilled WAL
 * still grows on disk whenever commits land while foreign readers hold marks
 * — the writer only restarts the WAL at frame 0 when a commit finds ZERO
 * readers, which in practice never happens. At the parked barrier the
 * no-reader window IS guaranteed, so that is where the file gets chopped
 * with wal_checkpoint(TRUNCATE) — and exclusively there (upstream 2adc7f6:
 * a timer-path truncate against an active writer wins the lock race, blocks
 * the writer for its whole backfill, and fails the index with "database is
 * locked" once the writer's 5s busy_timeout is exceeded).
 *
 * (File cap + barrier truncate: upstream 8c1e821 + ca88d3b#1, barrier-only
 * terminal form per 2adc7f6.)
 *
 * Anti-spin: when a foreign process pins the WAL (a reader snapshot or a
 * held write lock), no passive pass can complete. The backfill loop must
 * then degrade gracefully — bounded backoff between passes, partial
 * progress credited to the baseline, and a cooldown that downgrades repeat
 * triggers to a single probe — instead of re-running a full pass storm for
 * every indexed file (a stall that pinned the main thread for minutes).
 * The writer pause itself is never weakened: past the hard cap the writer
 * still waits for the WAL to fall back below it.
 */

import type { DatabaseConnection } from './index';

/** Soft WAL-growth threshold (MB) that triggers a passive checkpoint. */
const DEFAULT_WAL_VALVE_MB = 256;
/** Hard cap = this × soft threshold; past it the writer pauses for a full backfill. */
const HARD_CAP_MULTIPLIER = 2;
/** File cap = this × soft threshold; past it the barrier also TRUNCATEs the file. */
const FILE_CAP_MULTIPLIER = 4;
/** Passes attempted per writer pause before giving up (a pinned reader could stall forever). */
const MAX_PAUSED_BACKFILL_PASSES = 20;
/** First backoff wait between backfill passes; doubles up to the cap. */
const BACKFILL_PASS_BACKOFF_BASE_MS = 10;
const BACKFILL_PASS_BACKOFF_CAP_MS = 200;
/**
 * After a backfill round ends (success or give-up), a new round starting
 * inside this window is downgraded to a single passive pass. A persistently
 * pinned WAL gets one cheap probe per writer file, not a 20-pass storm per file.
 */
const BACKFILL_COOLDOWN_MS = 2000;
/** Min gap between give-up logs — a pinned WAL triggers one per file otherwise. */
const BUSY_GIVEUP_LOG_INTERVAL_MS = 30_000;
/** How often the timer looks at the WAL file size. */
const CHECK_INTERVAL_MS = 2000;

/**
 * Resolve the valve's soft threshold from the `CODEGRAPH_WAL_VALVE_MB`
 * override; non-numeric / non-positive values fall back to the default.
 */
export function resolveWalValveMb(envVal: string | undefined): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_WAL_VALVE_MB;
}

/**
 * Event-loop-friendly wait between backfill passes. The whole pause path is
 * async (callers `await backpressure()`), so a timer parks only the writer —
 * unlike a synchronous Atomics.wait, the pinned reader's process and all
 * other async work keep making progress.
 */
const sleepTimer = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class WalCheckpointValve {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  /** Writer pause in progress (hard cap breached): passes loop until a full backfill. */
  private pause: Promise<void> | null = null;
  /**
   * WAL file size observed when a checkpoint last reported the ENTIRE WAL
   * backfilled. Growth is measured against this baseline — see the header
   * comment for why absolute size cannot be used.
   */
  private sizeAtLastFullBackfill = 0;
  /**
   * Cumulative checkpointed-frame position observed in the current WAL
   * stream. The delta between passes is what a PASSIVE checkpoint actually
   * folded — the only reliable progress signal, since a PASSIVE pass never
   * shrinks the WAL file itself.
   */
  private checkpointedPagesSeen = 0;
  /** When the last backfill round ended (success or give-up) — cooldown gate. */
  private lastBackfillEndedAt = 0;
  /** Last give-up log timestamp, for the rate limit. */
  private lastGiveUpLoggedAt = 0;
  /** Final checkpoint row of the current round, for the give-up log. */
  private lastPassResult: { busy: number; log: number; checkpointed: number } | null = null;
  private readonly softBytes: number;
  private readonly hardBytes: number;
  private readonly fileCapBytes: number;

  constructor(
    private readonly db: DatabaseConnection,
    softMb: number = resolveWalValveMb(process.env.CODEGRAPH_WAL_VALVE_MB),
    private readonly intervalMs: number = CHECK_INTERVAL_MS,
    log: (msg: string) => void = () => {},
    /** Injectable for tests: records the requested backoff delays without spending real time. */
    private readonly sleep: (ms: number) => Promise<void> = sleepTimer
  ) {
    this.softBytes = softMb * 1024 * 1024;
    this.hardBytes = this.softBytes * HARD_CAP_MULTIPLIER;
    this.fileCapBytes = this.softBytes * FILE_CAP_MULTIPLIER;
    // CODEGRAPH_WAL_VALVE_DEBUG=1 surfaces valve decisions to stderr without
    // needing the caller's verbose plumbing — the observability gap that let
    // an upstream kernel-scale run fail silently (give-ups were verbose-gated
    // and invisible; 8c1e821).
    this.log = process.env.CODEGRAPH_WAL_VALVE_DEBUG
      ? (m) => console.error(`[wal-valve] ${m}`)
      : log;
  }

  private readonly log: (msg: string) => void;

  private mb(n: number): string {
    return `${Math.round(n / 1024 / 1024)}MB`;
  }

  /** Un-backfilled growth estimate: bytes the WAL has grown past the last full backfill. */
  private growthBytes(): number {
    return this.db.getWalSizeBytes() - this.sizeAtLastFullBackfill;
  }

  /** Begin watching the WAL. Idempotent; the timer never holds the loop open. */
  start(): void {
    if (this.timer) return;
    // One armed line per run under the diagnostics env: upstream burned three
    // 25-minute cycles before "is the valve even alive?" could be answered
    // (ca88d3b#1 observability).
    if (process.env.CODEGRAPH_WAL_VALVE_DEBUG) {
      console.error(`[wal-valve] armed soft=${this.mb(this.softBytes)} hard=${this.mb(this.hardBytes)} fileCap=${this.mb(this.fileCapBytes)} wal=${this.mb(this.db.getWalSizeBytes())}`);
    }
    let ticks = 0;
    this.timer = setInterval(() => {
      if ((++ticks % 15) === 0) {
        this.log(`alive: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)} inflight=${this.inflight ? 'y' : 'n'} paused=${this.pause ? 'y' : 'n'}`);
      }
      this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop watching. Any in-flight checkpoint keeps running — await drain(). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll: fire a passive checkpoint when growth passes the soft threshold. */
  check(): void {
    if (!this.pause && !this.inflight && this.growthBytes() > this.softBytes) this.fire();
  }

  /**
   * Writer-side backstop, called at a between-transactions boundary. Returns
   * null (no wait) while growth is under the hard cap; past it, returns a
   * promise that resolves only once a FULL backfill has landed.
   */
  backpressure(): Promise<void> | null {
    if (this.pause) return this.pause;
    // Two independent triggers (8c1e821 + ca88d3b#1):
    //  - growth: un-backfilled BACKLOG past the hard cap (the original valve).
    //  - file size: a WAL can stay fully backfilled and still grow without
    //    bound — the writer only restarts at frame 0 if a commit finds no
    //    reader marks, which the upstream instrumented run showed never
    //    happens in practice (file marched 361→721MB through two COMPLETE
    //    backfills). Past the file cap, park and TRUNCATE at the barrier —
    //    the backfill part is instant when the backlog is already folded.
    if (this.growthBytes() <= this.hardBytes && this.db.getWalSizeBytes() <= this.fileCapBytes) return null;
    this.log(`backpressure: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)} — pausing writer for full backfill`);
    const t0 = Date.now();
    this.pause = this.backfillFully().finally(() => {
      this.pause = null;
      this.log(`backpressure released after ${Date.now() - t0}ms: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)}`);
    });
    return this.pause;
  }

  /** Await any in-flight checkpoint and writer pause. */
  async drain(): Promise<void> {
    while (this.pause || this.inflight) {
      if (this.pause) await this.pause;
      if (this.inflight) await this.inflight;
    }
  }

  /**
   * Phase-boundary fold: backfill the ENTIRE WAL now. Called between bulk
   * phases — e.g. after parsing, before resolution's first reads — so the
   * next phase never pages a bulk-write-sized WAL on the main thread.
   */
  async foldNow(): Promise<void> {
    await this.drain();
    if (this.growthBytes() <= 0) return;
    this.log(`foldNow: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)}`);
    this.pause = this.backfillFully().finally(() => { this.pause = null; });
    await this.pause;
  }

  /**
   * With the writer parked on the returned promise, loop passive passes until
   * one reports the entire WAL backfilled. Bounded two ways:
   *  - within a round: MAX_PAUSED_BACKFILL_PASSES, with an exponential
   *    backoff sleep (10ms → 200ms cap) between passes. A pinned reader needs
   *    external progress; hammering checkpoints every microsecond cannot make
   *    it happen, and each pass used to be a fresh connection open/close.
   *  - across rounds: a round starting within BACKFILL_COOLDOWN_MS of the
   *    previous round's end runs a SINGLE pass. This is the fix for the
   *    per-file storm: hundreds of files each re-running 20 sync native
   *    checkpoints while one external process holds the WAL.
   * The writer pause itself is preserved: backpressure() still resolves only
   * on a full backfill or after the (now cheap, now progressing) attempt.
   */
  private async backfillFully(): Promise<void> {
    const inCooldown = Date.now() - this.lastBackfillEndedAt < BACKFILL_COOLDOWN_MS;
    const maxPasses = inCooldown ? 1 : MAX_PAUSED_BACKFILL_PASSES;
    try {
      for (let i = 0; i < maxPasses; i++) {
        if (this.inflight) await this.inflight; // fold in the stale in-flight pass first
        const res = await this.db.checkpointWalPassive();
        if (!res) {
          // Checkpoint machinery unavailable (e.g. not in WAL mode, or a
          // transient write failure) — surface it instead of silently spinning.
          this.log('backfill pass: checkpoint machinery unavailable, giving up this cycle');
          return;
        }
        this.lastPassResult = res;
        this.log(`backfill pass ${i + 1}: busy=${res.busy} log=${res.log} checkpointed=${res.checkpointed} wal=${this.mb(this.db.getWalSizeBytes())}`);
        if (res.busy === 0 && res.log === res.checkpointed) {
          // Backfill complete AND we are at a parked barrier (backfillFully
          // only runs under a writer pause): the no-reader window is
          // guaranteed, so chop the FILE too — a fully-backfilled WAL
          // otherwise keeps growing whenever commits land while foreign
          // readers hold marks (upstream §7a.1: 22GB on disk despite
          // complete backfills). A racing reader turns this into a no-op
          // (busy=1); the passive result above still stands.
          const trunc = await this.db.checkpointWalTruncate();
          if (trunc) this.log(`truncate: busy=${trunc.busy} wal=${this.mb(this.db.getWalSizeBytes())}`);
          this.sizeAtLastFullBackfill = this.db.getWalSizeBytes();
          this.checkpointedPagesSeen = 0; // the writer's next commit restarts the WAL stream
          return;
        }
        this.creditPartialProgress(res);
        if (i + 1 < maxPasses) {
          await this.sleep(Math.min(BACKFILL_PASS_BACKOFF_BASE_MS * 2 ** i, BACKFILL_PASS_BACKOFF_CAP_MS));
        }
      }
      this.logGiveUp(maxPasses);
    } finally {
      this.lastBackfillEndedAt = Date.now();
    }
  }

  /**
   * Baseline advance by ACTUAL progress. A PASSIVE checkpoint reports the
   * cumulative frame position it reached (`checkpointed` of `log`); a larger
   * number than last seen means that many more pages folded into the main DB,
   * so their bytes no longer count toward the un-backfilled backlog. Crediting
   * them keeps growthBytes() honest across rounds: a partial pass no longer
   * leaves the NEXT file's growth at the hard cap and re-triggering a fresh
   * full pass storm. The credit is clamped to the WAL's current size (it can
   * never exceed what is physically on disk), so a stale or oversized delta
   * only ever under-counts growth, which is the safe direction.
   */
  private creditPartialProgress(res: { log: number; checkpointed: number }): void {
    if (res.log < this.checkpointedPagesSeen) this.checkpointedPagesSeen = 0; // WAL stream restarted
    const delta = res.checkpointed - this.checkpointedPagesSeen;
    this.checkpointedPagesSeen = Math.max(this.checkpointedPagesSeen, res.checkpointed);
    if (delta <= 0) return;
    // A WAL frame is page_size + 24B of frame header; crediting raw page
    // bytes slightly under-counts the folded size — conservative, see above.
    this.sizeAtLastFullBackfill = Math.min(
      this.sizeAtLastFullBackfill + delta * this.db.getPageSizeBytes(),
      this.db.getWalSizeBytes()
    );
  }

  /** Rate-limited forensics line: the give-up fires once per file otherwise. */
  private logGiveUp(passesRun: number): void {
    const now = Date.now();
    if (now - this.lastGiveUpLoggedAt < BUSY_GIVEUP_LOG_INTERVAL_MS) return;
    this.lastGiveUpLoggedAt = now;
    const last = this.lastPassResult;
    this.log(
      `backfill gave up after ${passesRun} pass(es) — WAL stays unbounded this cycle` +
        `${last ? ` (last pass busy=${last.busy} log=${last.log} checkpointed=${last.checkpointed})` : ''}` +
        ` wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)}`
    );
  }

  private fire(): void {
    const p = this.db
      .checkpointWalPassive()
      .then((res) => {
        // Full backfill (busy 0, every log frame checkpointed) ⇒ the writer's
        // next commit wraps the WAL; the file's current size becomes the new
        // growth baseline. A partial pass leaves the baseline alone, so the
        // next tick fires again and copies the remainder.
        if (res && res.busy === 0 && res.log === res.checkpointed) {
          this.sizeAtLastFullBackfill = this.db.getWalSizeBytes();
          // NO truncate here (upstream 2adc7f6). A truncate checkpoint that
          // starts against an ACTIVE writer wins the lock race and then
          // blocks that writer for its entire backfill — after a multi-GB
          // single-transaction burst that exceeds the writer's 5s
          // busy_timeout and fails the index with "database is locked".
          // The file chop happens exclusively at parked barriers
          // (backpressure/foldNow), where the writer is awaiting us by
          // construction and cannot collide.
        }
      })
      .catch((err) => {
        // best-effort: log so a broken checkpoint path is not invisible
        this.log(`fire: checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
  }
}
