/**
 * Graph writer client
 *
 * Main-thread facade for the per-root graph write worker. It owns the queue,
 * backpressure, abort handling, and crash cleanup; the worker owns the single
 * read-write CodeGraph handle.
 *
 * Guarantees:
 * - exactly one worker per resolved project root;
 * - writes for a root run one at a time, in enqueue order;
 * - at most GRAPH_WRITER_MAX_PENDING accepted-but-unsettled writes per root,
 *   including the in-flight one (enqueue rejects past that);
 * - syncFiles/indexFiles file lists are deduped before they cross the port;
 * - progress/result/error frames carry the RPC id and settle only that write;
 * - an aborted queued write never runs, an aborted in-flight write rejects
 *   immediately and its late result is dropped;
 * - an unexpected worker exit rejects every outstanding write and drops the
 *   root's registry entry so the next ensure spawns a fresh worker;
 * - close drains, lets the worker close its graph, then terminates it.
 *
 * Everything is promise/message based: the main thread never blocks on
 * Atomics.wait or a synchronous worker handshake.
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import type { IndexProgress } from '../extraction';
import {
  GRAPH_WRITER_MAX_PENDING,
  type GraphWriteKind,
  type GraphWriteResult,
  type GraphWriterInitMessage,
  type GraphWriterRequest,
  type GraphWriterResponse,
  type GraphWriterRunMessage,
  type SerializedGraphWriterError,
} from './protocol';
import { hasInlineWriteLock } from './inline-write-guard';

export interface GraphWriterProgressOptions {
  /** Aborts a queued write; an in-flight write rejects and its result is dropped. */
  signal?: AbortSignal;
  /** Forwarded from the worker for the matching write id. */
  onProgress?: (progress: IndexProgress) => void;
}

export type GraphWrite =
  | ({ kind: 'sync' } & GraphWriterProgressOptions)
  | ({ kind: 'syncFiles'; files: string[] } & GraphWriterProgressOptions)
  | ({ kind: 'indexAll' } & GraphWriterProgressOptions)
  | ({ kind: 'indexFiles'; files: string[] } & GraphWriterProgressOptions);

export interface GraphWriterOutcome<T extends GraphWriteResult = GraphWriteResult> {
  result: T;
  /** The worker followed a database replaced on disk before this write. */
  databaseReplaced: boolean;
}

export interface GraphWriterHandle {
  readonly root: string;
  busy(): boolean;
  enqueue(write: GraphWrite): Promise<GraphWriterOutcome>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export class GraphWriterBackpressureError extends Error {
  readonly code = 'GRAPH_WRITER_BACKPRESSURE';

  constructor(
    readonly root: string,
    readonly pending: number,
  ) {
    super(
      `graph writer for ${root} is at capacity: ${pending}/${GRAPH_WRITER_MAX_PENDING} writes pending`,
    );
    this.name = 'GraphWriterBackpressureError';
  }
}

export class GraphWriterCrashError extends Error {
  readonly code = 'GRAPH_WRITER_CRASHED';

  constructor(
    readonly root: string,
    message: string,
  ) {
    super(message);
    this.name = 'GraphWriterCrashError';
  }
}

export class GraphWriterAbortError extends Error {
  readonly code = 'GRAPH_WRITER_ABORTED';

  constructor() {
    super('graph write aborted');
    this.name = 'AbortError';
  }
}

interface PendingWrite {
  id: number;
  write: GraphWrite;
  files?: string[];
  resolve: (outcome: GraphWriterOutcome) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  detachAbort?: () => void;
}

interface WriterState {
  root: string;
  worker: Worker;
  ready: Promise<void>;
  readyResolve: () => void;
  readyReject: (error: unknown) => void;
  pending: PendingWrite[];
  inflight: PendingWrite | null;
  nextId: number;
  closing: boolean;
  closed: boolean;
  terminating: boolean;
  closePromise?: Promise<void>;
  drainWaiters: Array<() => void>;
  closeWaiters: Array<() => void>;
}

const writers = new Map<string, WriterState>();

const resolveRoot = (root: string): string => path.resolve(root);

const outstanding = (state: WriterState): number => state.pending.length + (state.inflight ? 1 : 0);

/**
 * Cleanups still unwinding after a crashed writer, keyed by root. A crash can
 * leave the graph file lock behind (worker threads share the process pid, so
 * the lock is not detectable as stale); ensure() waits for the terminated
 * worker and the same-process lock sweep before opening a replacement.
 */
const cleanups = new Map<string, Promise<void>>();

const settleWaiters = (waiters: Array<() => void>): void => {
  const pending = waiters.splice(0);
  for (const waiter of pending) waiter();
};

const deserializeError = (error: SerializedGraphWriterError): Error => {
  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  if (error.stack) deserialized.stack = error.stack;
  return deserialized;
};

const releaseSameProcessLock = (root: string): void => {
  // The same-pid sweep is only safe under the offload single-writer contract:
  // the main thread never holds a same-root write lock while a writer worker
  // exists, so a same-pid lock here belongs to the crashed worker. If an
  // inline writer is active in this process, leave its lock alone.
  if (hasInlineWriteLock(root)) return;
  const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    // Only a lock written by this process can belong to the crashed worker;
    // a foreign pid's lock is never touched.
    if (owner.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    // No lock, or it disappeared/unreadable: nothing to sweep.
  }
};

const failWriter = (state: WriterState, error: Error): void => {
  if (state.closed) return;
  state.closed = true;
  state.terminating = true;
  state.readyReject(error);
  const outstandingWrites = state.inflight ? [state.inflight, ...state.pending] : [...state.pending];
  state.inflight = null;
  state.pending.length = 0;
  for (const write of outstandingWrites) {
    if (write.settled) continue;
    write.settled = true;
    write.detachAbort?.();
    write.reject(error);
  }
  settleWaiters(state.drainWaiters);
  settleWaiters(state.closeWaiters);
  writers.delete(state.root);
  const cleanup = state.worker
    .terminate()
    .catch(() => {})
    .then(() => releaseSameProcessLock(state.root))
    .finally(() => cleanups.delete(state.root));
  cleanups.set(state.root, cleanup);
};

const pump = (state: WriterState): void => {
  if (state.closed) return;
  while (!state.inflight && state.pending.length > 0) {
    const write = state.pending.shift();
    if (!write) break;
    if (write.settled) continue;
    state.inflight = write;
    const message: GraphWriterRunMessage = { type: 'run', id: write.id, kind: write.write.kind };
    if (write.files) message.files = write.files;
    state.worker.postMessage(message);
  }
  if (!state.inflight && state.pending.length === 0) settleWaiters(state.drainWaiters);
};

const settleInflight = (
  state: WriterState,
  id: number,
  apply: (write: PendingWrite) => void,
): void => {
  const write = state.inflight;
  if (!write || write.id !== id) return;
  state.inflight = null;
  if (!write.settled) {
    write.settled = true;
    write.detachAbort?.();
    apply(write);
  }
  pump(state);
};

const onWorkerMessage = (state: WriterState, message: GraphWriterResponse): void => {
  switch (message.type) {
    case 'ready':
      state.readyResolve();
      return;
    case 'progress': {
      const write = state.inflight;
      if (!write || write.id !== message.id || write.settled) return;
      try {
        write.write.onProgress?.(message.progress);
      } catch {
        // A caller's progress callback must not tear down the worker channel.
      }
      return;
    }
    case 'result':
      settleInflight(state, message.id, (write) =>
        write.resolve({ result: message.result, databaseReplaced: message.databaseReplaced }),
      );
      return;
    case 'error':
      settleInflight(state, message.id, (write) => write.reject(deserializeError(message.error)));
      return;
    case 'fatal':
      failWriter(state, deserializeError(message.error));
      return;
    case 'closed':
      state.closed = true;
      settleWaiters(state.closeWaiters);
      return;
  }
};

/**
 * Resolve the worker entry. Source runs and tests use the literal sibling URL;
 * a compiled single-binary build injects the bundled entry path via
 * CHIMERA_GRAPH_WRITER_WORKER_PATH (see script/build.ts).
 */
declare const CHIMERA_GRAPH_WRITER_WORKER_PATH: string;
const resolveGraphWriterWorkerPath = (): string | URL => {
  if (typeof CHIMERA_GRAPH_WRITER_WORKER_PATH !== 'undefined') return CHIMERA_GRAPH_WRITER_WORKER_PATH;
  return new URL('./graph-writer.worker.ts', import.meta.url);
};

/**
 * Spawn counters kept independently of the `writers` map: a double-spawn
 * overwrites the map entry and would otherwise be invisible, so tests (and
 * crash triage) need a spawn/live count that cannot be masked by the map.
 */
let spawnedWriters = 0;
const spawnedByRoot = new Map<string, number>();
const liveWorkers = new Set<Worker>();

const createWriter = (root: string): WriterState => {
  const worker = new Worker(resolveGraphWriterWorkerPath());
  spawnedWriters += 1;
  spawnedByRoot.set(root, (spawnedByRoot.get(root) ?? 0) + 1);
  liveWorkers.add(worker);
  let readyResolve: () => void = () => {};
  let readyReject: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const state: WriterState = {
    root,
    worker,
    ready,
    readyResolve,
    readyReject,
    pending: [],
    inflight: null,
    nextId: 1,
    closing: false,
    closed: false,
    terminating: false,
    drainWaiters: [],
    closeWaiters: [],
  };
  // Register synchronously: two ensure() calls can never both pass the map
  // check and spawn a worker for the same root.
  writers.set(root, state);
  worker.on('message', (message: GraphWriterResponse) => onWorkerMessage(state, message));
  worker.on('error', (error) =>
    failWriter(state, new GraphWriterCrashError(root, `graph writer worker error: ${error.message}`)),
  );
  worker.on('exit', (code) => {
    liveWorkers.delete(worker);
    if (state.terminating) return;
    failWriter(state, new GraphWriterCrashError(root, `graph writer worker exited with code ${code}`));
  });
  const init: GraphWriterInitMessage = {
    type: 'init',
    root,
    readOnly: false,
    sync: false,
    offload: false,
  };
  worker.postMessage(init);
  return state;
};

const abortWrite = (state: WriterState, write: PendingWrite): void => {
  if (write.settled) return;
  write.settled = true;
  write.detachAbort?.();
  write.reject(new GraphWriterAbortError());
  if (state.inflight === write) {
    if (!state.closed) {
      const message: GraphWriterRequest = { type: 'abort', id: write.id };
      try {
        state.worker.postMessage(message);
      } catch {
        // The worker already exited; the caller still gets AbortError and
        // the crash path settles the slot, so this must not mask it.
      }
    }
    // Keep the slot occupied until the worker answers: the next write must not
    // overlap the one the worker is still unwinding.
    return;
  }
  const index = state.pending.indexOf(write);
  if (index >= 0) state.pending.splice(index, 1);
  if (!state.inflight && state.pending.length === 0) settleWaiters(state.drainWaiters);
};

const dedupeFiles = (write: GraphWrite): string[] | undefined => {
  if (write.kind !== 'syncFiles' && write.kind !== 'indexFiles') return undefined;
  return [...new Set(write.files)];
};

const toHandle = (state: WriterState): GraphWriterHandle => ({
  root: state.root,
  busy: () => busyGraphWriter(state.root),
  enqueue: (write) => enqueueGraphWrite(state.root, write),
  drain: () => drainGraphWriter(state.root),
  close: () => closeGraphWriter(state.root),
});

/**
 * Ensure the single writer worker for `root` is open and ready.
 *
 * Concurrent calls for the same root share one worker and one ready promise.
 * If the root's writer is closing, this waits for the close before spawning a
 * replacement.
 */
export async function ensureGraphWriterReady(root: string): Promise<GraphWriterHandle> {
  const key = resolveRoot(root);
  // Every await can observe a close/crash/cleanup that landed in between, so
  // the whole decision is re-evaluated from the maps after each wait. Without
  // the loop two callers parked on the same closePromise would each spawn a
  // replacement, and one worker would be orphaned (the map keeps only one).
  for (;;) {
    const existing = writers.get(key);
    if (existing) {
      if (existing.closing || existing.closed) {
        if (existing.closePromise) await existing.closePromise;
        continue;
      }
      await existing.ready;
      // ready may resolve just as a close/crash claims the writer.
      if (existing.closing || existing.closed) continue;
      return toHandle(existing);
    }
    const cleanup = cleanups.get(key);
    if (cleanup) {
      await cleanup;
      continue;
    }
    // createWriter registers the state synchronously, so no await can
    // interleave between this check and the registration.
    const created = createWriter(key);
    await created.ready;
    if (created.closing || created.closed) continue;
    return toHandle(created);
  }
}

/**
 * Enqueue one write for an already-ensured root.
 *
 * Rejects with GraphWriterBackpressureError when the root already has
 * GRAPH_WRITER_MAX_PENDING unsettled writes (the in-flight write counts), and
 * with GraphWriterAbortError when the signal is already aborted.
 */
export function enqueueGraphWrite(
  root: string,
  write: GraphWrite,
): Promise<GraphWriterOutcome> {
  const state = writers.get(resolveRoot(root));
  if (!state || state.closed || state.closing) {
    return Promise.reject(new Error(`graph writer for ${root} is not ready`));
  }
  if (write.signal?.aborted) return Promise.reject(new GraphWriterAbortError());
  const pending = outstanding(state);
  if (pending >= GRAPH_WRITER_MAX_PENDING) {
    return Promise.reject(new GraphWriterBackpressureError(state.root, pending));
  }
  const files = dedupeFiles(write);
  return new Promise<GraphWriterOutcome>((resolve, reject) => {
    const queued: PendingWrite = {
      id: state.nextId++,
      write,
      files,
      resolve,
      reject,
      settled: false,
    };
    if (write.signal) {
      const signal = write.signal;
      const onAbort = () => abortWrite(state, queued);
      signal.addEventListener('abort', onAbort, { once: true });
      queued.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }
    state.pending.push(queued);
    pump(state);
  });
}

/** Resolve once the root has no queued or in-flight writes. */
export function drainGraphWriter(root: string): Promise<void> {
  const state = writers.get(resolveRoot(root));
  if (!state || state.closed || outstanding(state) === 0) return Promise.resolve();
  return new Promise<void>((resolve) => state.drainWaiters.push(resolve));
}

/**
 * Drain outstanding writes, ask the worker to close its graph, then terminate
 * the worker. Idempotent; concurrent calls share one close.
 */
export function closeGraphWriter(root: string): Promise<void> {
  const key = resolveRoot(root);
  const state = writers.get(key);
  if (!state) return Promise.resolve();
  if (state.closed) {
    writers.delete(key);
    return Promise.resolve();
  }
  if (state.closePromise) return state.closePromise;
  state.closing = true;
  state.closePromise = (async () => {
    await drainGraphWriter(key);
    if (state.closed) {
      writers.delete(key);
      return;
    }
    await new Promise<void>((resolve) => {
      state.closeWaiters.push(resolve);
      const message: GraphWriterRequest = { type: 'shutdown' };
      state.worker.postMessage(message);
    });
    state.terminating = true;
    await state.worker.terminate();
    state.closed = true;
    writers.delete(key);
  })();
  return state.closePromise;
}

/** True while the root has a live writer with queued or in-flight writes. */
export function busyGraphWriter(root: string): boolean {
  const state = writers.get(resolveRoot(root));
  return Boolean(state && !state.closed && outstanding(state) > 0);
}

/**
 * Test-only: kill the root's writer worker to exercise crash cleanup. Returns
 * false when no live writer exists.
 */
export function __crashGraphWriterForTest(root: string): boolean {
  const state = writers.get(resolveRoot(root));
  if (!state || state.closed) return false;
  const message: GraphWriterRequest = { type: '__crash' };
  state.worker.postMessage(message);
  return true;
}

/** Test-only: registry size for one root (0/1), or all roots when omitted. */
export function graphWriterCountForTest(root?: string): number {
  if (root === undefined) return writers.size;
  return writers.has(resolveRoot(root)) ? 1 : 0;
}

/** Test-only: whether a writer is registered for the root. */
export function hasGraphWriterForTest(root: string): boolean {
  return writers.has(resolveRoot(root));
}

/** Test-only: cumulative worker spawns, optionally scoped to one root. */
export function graphWriterSpawnCountForTest(root?: string): number {
  if (root === undefined) return spawnedWriters;
  return spawnedByRoot.get(resolveRoot(root)) ?? 0;
}

/** Test-only: workers that have been spawned and not yet exited. */
export function graphWriterLiveCountForTest(): number {
  return liveWorkers.size;
}

export type { GraphWriteKind, GraphWriteResult };