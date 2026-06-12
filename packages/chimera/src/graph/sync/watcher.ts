/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers debounced sync
 * operations to keep the code graph up-to-date.
 *
 * Uses chokidar, whose `ignored` callback filters directories BEFORE they are
 * watched — so we never register inotify watches on excluded trees like
 * node_modules/, dist/, .git/ (fixes #276: recursive fs.watch exhausted the
 * kernel watch budget on large repos). The ignore decision reuses the indexer's
 * `buildDefaultIgnore` (built-in default-ignore dirs + the project's .gitignore)
 * so the watcher watches exactly the set the indexer indexes — in particular,
 * node_modules/build/cache dirs are excluded even when the repo has no
 * .gitignore (#407), which a .gitignore-only filter would miss.
 */

import * as path from 'path';
import type { Stats } from 'fs';
import { execFileSync } from 'child_process';
import chokidar, { FSWatcher } from 'chokidar';
import type { Ignore } from 'ignore';
import { isSourceFile, buildDefaultIgnore } from '../extraction';
import type { SyncResult } from '../extraction';
import type { CodeGraphSnapshot } from '../types';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';
import { watchDisabledReason } from './watch-policy';

export type WatchEventKind = 'add' | 'change' | 'unlink';
export type WatchEventSource = 'filesystem' | 'git';

export interface WatchEvent {
  /** Project-relative POSIX path (e.g. "src/foo.ts"). */
  path: string;
  /** Filesystem event kind normalized from chokidar. */
  event: WatchEventKind;
  /** Source that produced this event. */
  source: WatchEventSource;
  /** Wall-clock ms at the first event we saw for this path since the last sync. */
  firstSeenMs: number;
  /** Wall-clock ms at the most recent event we saw for this path. */
  lastSeenMs: number;
}

export interface WatchBatch {
  /** Stable-enough process-local id for correlating callbacks and logs. */
  id: string;
  /** Absolute project root being watched. */
  projectRoot: string;
  /** Debounced file events included in this flush. */
  events: WatchEvent[];
  /** Event source when homogeneous, or mixed when a flush combined sources. */
  source: WatchEventSource | 'mixed';
  /** Unique project-relative paths from events, preserving event insertion order. */
  files: string[];
  /** Wall-clock ms at which this batch started flushing. */
  startedAtMs: number;
}

export interface WatchSyncSummary {
  filesChanged: number;
  durationMs: number;
}

export interface WatchBatchApi {
  snapshot: () => CodeGraphSnapshot;
  sync: () => Promise<SyncResult>;
  syncFiles: (files: string[]) => Promise<SyncResult>;
  getPendingFiles: () => PendingFile[];
}

/**
 * Options for the file watcher
 */
export interface WatchOptions {
  /**
   * Debounce delay in milliseconds.
   * After the last file change, wait this long before triggering sync.
   * Default: 2000ms
   */
  debounceMs?: number;

  /**
   * Whether the watcher should run the default sync after each debounced batch.
   * Default: true. Set to false when an embedding wants to record provenance
   * and call `api.sync()` / `api.syncFiles()` manually from `onBatch`.
   */
  autoSync?: boolean;

  /**
   * Include non-source files in watch batches. Default: false, preserving
   * CodeGraph's index-freshness behavior. Chimera-style provenance collectors
   * can enable this to capture docs/config changes as weak mutation seeds.
   */
  includeNonSource?: boolean;

  /**
   * Also watch Git HEAD/current-branch ref changes. Default: false. This is
   * intended for provenance collectors that need branch checkout/pull signals;
   * CodeGraph's default index-freshness watcher keeps ignoring `.git/`.
   */
  watchGitHead?: boolean;

  /**
   * Callback for a debounced batch before the default sync runs. Embeddings can
   * set `autoSync: false` and use the provided API to control when sync happens.
   */
  onBatch?: (batch: WatchBatch, api: WatchBatchApi) => void | SyncResult | WatchSyncSummary | Promise<void | SyncResult | WatchSyncSummary>;

  /**
   * Callback when a sync completes (for logging/diagnostics).
   */
  onSyncComplete?: (result: WatchSyncSummary, batch?: WatchBatch) => void;

  /**
   * Callback when a sync errors (for logging/diagnostics).
   */
  onSyncError?: (error: Error, batch?: WatchBatch) => void;
}

/**
 * Thrown by a `syncFn` to signal that the underlying sync couldn't acquire
 * the cross-process write lock (#449). The watcher treats this as "no
 * progress" — preserves `pendingFiles`, skips `onSyncComplete`, and the
 * `finally` block reschedules. Quiet (debug-only) because a long-running
 * external indexer can hit this every debounce cycle.
 */
export class LockUnavailableError extends Error {
  constructor(message = 'CodeGraph file lock unavailable; another process is writing') {
    super(message);
    this.name = 'LockUnavailableError';
  }
}

/**
 * Per-file pending entry — tracks a source file the watcher saw an event for
 * but hasn't yet synced into the index. Exposed via {@link FileWatcher.getPendingFiles}
 * so MCP tool responses can mark stale results without forcing a wait.
 */
export interface PendingFile {
  /** Project-relative POSIX path (e.g. "src/foo.ts"). */
  path: string;
  /** Wall-clock ms at the first event we saw for this path since the last sync. */
  firstSeenMs: number;
  /** Wall-clock ms at the most recent event we saw for this path. */
  lastSeenMs: number;
  /**
   * True when a sync is currently in flight that began AFTER this file's most
   * recent event — i.e. the next successful sync will pick it up. False when
   * the file is still in the debounce window (no sync running yet).
   */
  indexing: boolean;
}

function normalizeWatchEvent(event: string): WatchEventKind | undefined {
  if (event === 'add') return 'add';
  if (event === 'change') return 'change';
  if (event === 'unlink') return 'unlink';
  return undefined;
}

function toWatchSummary(result: SyncResult | WatchSyncSummary): WatchSyncSummary {
  if ('filesAdded' in result) {
    return {
      filesChanged: result.filesAdded + result.filesModified + result.filesRemoved,
      durationMs: result.durationMs,
    };
  }
  return result;
}

function toSyncResult(result: SyncResult | WatchSyncSummary, batch: WatchBatch): SyncResult {
  if ('filesAdded' in result) return result;
  return {
    filesChecked: batch.files.length,
    filesAdded: 0,
    filesModified: result.filesChanged,
    filesRemoved: 0,
    nodesUpdated: 0,
    durationMs: result.durationMs,
    changedFilePaths: batch.files.length > 0 ? batch.files : undefined,
  };
}

/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (chokidar filters excluded directories before
 *   registering an inotify watch — see module docs / #276)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters to supported source files by extension
 * - Ignores .codegraph/ and .git/ regardless of .gitignore
 * - Tracks per-file pending state so MCP tools can flag stale results
 *   without blocking on a sync (issue #403)
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Files seen by the watcher since the last successful sync — populated on
   * every chokidar event, cleared at the start of a sync, and re-populated by
   * events that arrive mid-sync (or restored on sync failure). Keyed by the
   * same project-relative POSIX path the rest of the codebase uses, so a
   * caller can intersect tool-response file paths against this map cheaply.
   */
  private pendingEvents = new Map<string, { event: WatchEventKind; source: WatchEventSource; firstSeenMs: number; lastSeenMs: number }>();
  /**
   * Wall-clock ms at which the in-flight sync began. Combined with
   * {@link pendingFiles}'s `lastSeenMs`, this distinguishes "still in the
   * debounce window" (lastSeen > syncStarted, sync hasn't started yet for
   * this edit) from "currently being indexed" (lastSeen <= syncStarted).
   */
  private syncStartedMs = 0;
  private syncing = false;
  private stopped = false;
  /**
   * False until chokidar fires its `ready` event. Gates `pendingFiles`
   * insertion so the initial crawl's `add` events (one per pre-existing
   * source file) don't pollute the per-file staleness signal. The events
   * still flow into `scheduleSync()` to preserve the previous "initial
   * scan triggers a reconciling sync" behavior.
   */
  private chokidarReady = false;
  /**
   * Callbacks that resolve when chokidar fires `ready`. Used by tests (and
   * any production caller that cares about a clean baseline) to deterministically
   * gate on the end of the initial scan instead of guessing at a sleep duration.
   */
  private readyWaiters: Array<() => void> = [];
  // The shared ignore matcher (built-in defaults + project .gitignore), built
  // once at start(). Same source of truth the indexer uses, so watcher scope
  // can never diverge from index scope.
  private ignoreMatcher: Ignore | null = null;

  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly autoSync: boolean;
  private readonly includeNonSource: boolean;
  private readonly watchGitHead: boolean;
  private readonly syncFn: (batch: WatchBatch) => Promise<SyncResult | WatchSyncSummary>;
  private readonly batchApi?: WatchBatchApi;
  private readonly onBatch?: WatchOptions['onBatch'];
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];
  private batchSeq = 0;
  private watchedGitRelPaths = new Set<string>();

  constructor(
    projectRoot: string,
    syncFn: (batch: WatchBatch) => Promise<SyncResult | WatchSyncSummary>,
    options: WatchOptions = {},
    batchApi?: WatchBatchApi
  ) {
    this.projectRoot = projectRoot;
    this.syncFn = syncFn;
    this.debounceMs = options.debounceMs ?? 2000;
    this.autoSync = options.autoSync ?? true;
    this.includeNonSource = options.includeNonSource ?? false;
    this.watchGitHead = options.watchGitHead ?? false;
    this.onBatch = options.onBatch;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
    this.batchApi = batchApi;
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.watcher) return true; // Already watching
    this.stopped = false;

    // Some environments make filesystem watching unusable — most notably
    // WSL2 /mnt/ drives, where the underlying fs.watch calls block long
    // enough to break MCP startup handshakes (issue #199). Skip watching
    // there; callers fall back to manual `chimera sync` or git sync hooks.
    const disabledReason = watchDisabledReason(this.projectRoot);
    if (disabledReason) {
      logDebug('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot });
      return false;
    }

    // Reuse the indexer's ignore set so the watcher and indexer agree on scope.
    // chokidar only registers an inotify watch on directories that pass this
    // filter — that's the #276 fix.
    this.ignoreMatcher = buildDefaultIgnore(this.projectRoot);
    const gitWatchPaths = this.watchGitHead ? this.resolveGitWatchPaths() : [];
    this.watchedGitRelPaths = new Set(gitWatchPaths.map((file) => normalizePath(path.relative(this.projectRoot, file))));

    try {
      this.watcher = chokidar.watch([this.projectRoot, ...gitWatchPaths], {
        // chokidar calls this for every path it encounters and only watches
        // those that pass — so excluded trees (node_modules/, dist/, .git/, …)
        // never get an inotify watch in the first place.
        ignored: (testPath: string, stats?: Stats) => this.shouldIgnore(testPath, stats),
      });

      // Chokidar emits `add` for every pre-existing source file during its
      // initial scan. Those events should still trigger the post-startup
      // reconciling sync (preserving prior behavior), but they must NOT land
      // in pendingFiles — otherwise every file in the project shows up as
      // "edited but not indexed" on startup, which is the opposite of the
      // signal #403 is supposed to provide. Flip the flag on chokidar's
      // `ready` event; from then on, real edits populate pendingFiles.
      //
      // We also clear `pendingFiles` here as defense-in-depth: chokidar can
      // emit late initial-scan `add` events via setImmediate AFTER the
      // `ready` callback runs (observed under test-parallelism load).
      // Clearing once at ready guarantees a clean baseline; real subsequent
      // edits repopulate the set normally.
      this.watcher.on('ready', () => {
        this.chokidarReady = true;
        this.pendingEvents.clear();
        for (const cb of this.readyWaiters) cb();
        this.readyWaiters.length = 0;
      });

      // chokidar emits 'all' for every event type; we only sync source files.
      this.watcher.on('all', (event: string, filePath: string) => {
        if (this.stopped) return;

        const kind = normalizeWatchEvent(event);
        if (!kind) return;

        const normalized = normalizePath(path.relative(this.projectRoot, filePath));
        const source: WatchEventSource = this.watchedGitRelPaths.has(normalized) ? 'git' : 'filesystem';

        // Defense in depth: `ignored` should already keep these out, but events
        // can still arrive during setup or via symlink traversal.
        if (source !== 'git' && this.isAlwaysIgnored(normalized)) return;
        if (source !== 'git' && !this.includeNonSource && !isSourceFile(normalized)) return;

        logDebug('File change detected', { file: normalized });
        // Only track events from after chokidar's initial scan as pending
        // edits — pre-existing files on disk are already represented by
        // (or about to be reconciled by) the index, not a user edit.
        if (this.chokidarReady) {
          const now = Date.now();
          const existing = this.pendingEvents.get(normalized);
          this.pendingEvents.set(normalized, {
            event: kind,
            source,
            firstSeenMs: existing?.firstSeenMs ?? now,
            lastSeenMs: now,
          });
        }
        this.scheduleSync();
      });

      // Handle watcher errors gracefully — don't crash, the user can restart.
      this.watcher.on('error', (err: unknown) => {
        logWarn('File watcher error', { error: String(err) });
      });

      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
      return true;
    } catch (err) {
      // Watcher setup failed (e.g., permission denied, missing directory).
      logWarn('Could not start file watcher', { error: String(err) });
      return false;
    }
  }

  /** Our own dirs are always ignored, regardless of .gitignore. */
  private isAlwaysIgnored(rel: string): boolean {
    const parts = rel.split('/');
    return parts.includes('.codegraph') || parts.includes('.git');
  }

  /**
   * chokidar `ignored` predicate — true for any path that should NOT be watched.
   * Uses chokidar's provided `stats` to decide directory-vs-file so a dir-only
   * rule like `build/` matches, without an extra `statSync` per path.
   */
  private shouldIgnore(testPath: string, stats?: Stats): boolean {
    const rel = normalizePath(path.relative(this.projectRoot, testPath));
    if (!rel || rel === '.' || rel.startsWith('..')) return false; // root / outside
    if (this.watchedGitRelPaths.has(rel)) return false;
    if (this.isAlwaysIgnored(rel)) return true;
    if (!this.ignoreMatcher) return false;
    if (stats) {
      return this.ignoreMatcher.ignores(stats.isDirectory() ? rel + '/' : rel);
    }
    // Stats unknown: test both forms so a directory match isn't missed.
    return this.ignoreMatcher.ignores(rel) || this.ignoreMatcher.ignores(rel + '/');
  }

  /**
   * Stop watching for file changes.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const watcher = this.watcher;
    this.watcher = null;

    this.pendingEvents.clear();
    this.chokidarReady = false;
    this.ignoreMatcher = null;
    this.watchedGitRelPaths.clear();
    if (watcher) await watcher.close();
    logDebug('File watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isActive(): boolean {
    return this.watcher !== null && !this.stopped;
  }

  private resolveGitWatchPaths(): string[] {
    const gitPath = (args: string[]) => {
      try {
        const out = execFileSync('git', args, {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }).trim();
        if (!out) return undefined;
        return path.isAbsolute(out) ? out : path.resolve(this.projectRoot, out);
      } catch {
        return undefined;
      }
    };
    const head = gitPath(['rev-parse', '--git-path', 'HEAD']);
    const symbolic = (() => {
      try {
        return execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }).trim();
      } catch {
        return undefined;
      }
    })();
    const branchRef = symbolic ? gitPath(['rev-parse', '--git-path', symbolic]) : undefined;
    return [...new Set([head, branchRef].filter((file): file is string => Boolean(file)))];
  }

  /**
   * Resolves once chokidar has fired its `ready` event (or immediately if
   * it has already done so). Useful for tests that need a deterministic
   * boundary before asserting on `pendingFiles` — guessing a sleep duration
   * is flaky under load because chokidar can take longer than expected to
   * finish its initial crawl on slow filesystems / parallel test runs.
   *
   * Production callers don't need this: `pendingFiles` is read continuously,
   * the staleness banner is always correct (empty or populated), and the
   * initial-scan window is a small one-time startup cost.
   */
  waitUntilReady(timeoutMs = 10000): Promise<void> {
    if (this.chokidarReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(handler);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        reject(new Error(`FileWatcher.waitUntilReady timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = () => { clearTimeout(t); resolve(); };
      this.readyWaiters.push(handler);
    });
  }

  /**
   * Schedule a debounced sync.
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * Flush pending changes by running sync.
   *
   * pendingFiles is NOT cleared at the start of sync — entries are removed
   * only after sync commits successfully, and only for entries whose
   * lastSeenMs <= syncStartedMs. That way, a query that arrives mid-sync
   * still sees the affected files marked stale (the DB hasn't been updated
   * yet), and an event that lands mid-sync persists into the follow-up.
   *
   * On sync failure pendingFiles is left untouched — every edit is still
   * unindexed, and the rescheduled sync will absorb the same set next time.
   */
  private async flush(): Promise<void> {
    // If already syncing, the post-sync check will re-trigger
    if (this.syncing || this.stopped) return;

    this.syncStartedMs = Date.now();
    this.syncing = true;

    try {
      const batch = this.createBatch(this.syncStartedMs);
      const api = this.createBatchApi(batch);
      const batchResult = await this.onBatch?.(batch, api);
      const result = this.autoSync
        ? await this.syncFn(batch)
        : batchResult
          ? toSyncResult(batchResult, batch)
          : { filesChecked: batch.files.length, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      // Remove entries whose most recent event predates this sync — those
      // edits are now in the DB. Entries with lastSeenMs > syncStartedMs
      // arrived mid-sync; whether the in-flight sync captured them depends
      // on when sync read that file, so we keep them as pending and let
      // the follow-up sync handle them. We prefer false positives ("shown
      // stale, actually fresh" → at worst one extra Read) over false
      // negatives ("shown fresh, actually stale" → misleads the agent).
      for (const [filePath, info] of this.pendingEvents) {
        if (info.lastSeenMs <= this.syncStartedMs) {
          this.pendingEvents.delete(filePath);
        }
      }
      this.onSyncComplete?.(toWatchSummary(result), batch);
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        // Lock-failure no-op (another writer holds the lock). pendingFiles
        // stays intact and the `finally` block reschedules. Debug-only —
        // a long external index would otherwise spam stderr every cycle.
        logDebug('Watch sync skipped: file lock unavailable', {
          pendingFiles: this.pendingEvents.size,
        });
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        logWarn('Watch sync failed', { error: error.message });
        this.onSyncError?.(error, this.createBatch(this.syncStartedMs));
      }
      // Failure: leave pendingFiles untouched. Every edit it tracks is
      // still unindexed; the rescheduled sync sees the same set.
    } finally {
      this.syncing = false;

      // If pending files remain (mid-sync events, or this sync failed),
      // schedule another pass.
      if (this.pendingEvents.size > 0 && !this.stopped) {
        this.scheduleSync();
      }
    }
  }

  private createBatch(startedAtMs: number): WatchBatch {
    const events: WatchEvent[] = [];
    for (const [filePath, info] of this.pendingEvents) {
      if (info.lastSeenMs > startedAtMs) continue;
      events.push({ path: filePath, event: info.event, source: info.source, firstSeenMs: info.firstSeenMs, lastSeenMs: info.lastSeenMs });
    }
    const sources = new Set(events.map((event) => event.source));
    return {
      id: `watch_${startedAtMs}_${++this.batchSeq}`,
      projectRoot: this.projectRoot,
      events,
      source: sources.size === 1 ? events[0]?.source ?? 'filesystem' : 'mixed',
      files: events.map((event) => event.path),
      startedAtMs,
    };
  }

  private createBatchApi(batch: WatchBatch): WatchBatchApi {
    return this.batchApi ?? {
      snapshot: () => {
        throw new Error('FileWatcher snapshot API is only available through CodeGraph.watch()');
      },
      sync: async () => toSyncResult(await this.syncFn(batch), batch),
      syncFiles: async () => toSyncResult(await this.syncFn(batch), batch),
      getPendingFiles: () => this.getPendingFiles(),
    };
  }

  /**
   * Snapshot of files seen by the watcher since the last successful sync.
   *
   * Used by MCP tool responses to mark stale results without blocking on a
   * sync: a tool that returns a hit in `src/foo.ts` while `src/foo.ts` is in
   * this list tells the agent "Read this file directly, the index lags."
   *
   * `indexing` is true when a sync is currently in flight whose start time is
   * AFTER this file's most recent event — i.e. that sync will absorb the
   * edit. False means the file is still inside the debounce window and no
   * sync has started yet (a follow-up call a few hundred ms later may show
   * `indexing: true` or the file may have left the list entirely).
   *
   * Cheap: O(pendingFiles.size), no I/O, no locks.
   */
  getPendingFiles(): PendingFile[] {
    const result: PendingFile[] = [];
    for (const [filePath, info] of this.pendingEvents) {
      result.push({
        path: filePath,
        firstSeenMs: info.firstSeenMs,
        lastSeenMs: info.lastSeenMs,
        indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
      });
    }
    return result;
  }
}
