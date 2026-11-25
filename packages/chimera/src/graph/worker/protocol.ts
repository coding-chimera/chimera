/**
 * Graph write worker protocol
 *
 * One writer worker per project root. The main thread owns the queue and the
 * worker owns the single read-write CodeGraph handle, so every mutation of a
 * root is serialized through exactly one connection.
 *
 * The protocol is intentionally small: init → ready, run → result/error with
 * progress frames, abort for an in-flight write, and shutdown → closed.
 */

import type { IndexProgress, IndexResult, SyncResult } from '../extraction';

/**
 * Maximum number of accepted-but-unsettled writes per root, including the one
 * currently executing. Enqueuing beyond this rejects with
 * GraphWriterBackpressureError instead of growing an unbounded queue.
 */
export const GRAPH_WRITER_MAX_PENDING = 64;

export type GraphWriteKind = 'sync' | 'syncFiles' | 'indexAll' | 'indexFiles';

export type GraphWriteResult = IndexResult | SyncResult;

export interface SerializedGraphWriterError {
  name: string;
  message: string;
  stack?: string;
}

export interface GraphWriterInitMessage {
  type: 'init';
  root: string;
  /** Read-write handle: writes must never run against a read-only open. */
  readOnly: false;
  /** Callers enqueue explicit writes; the open itself must not sync. */
  sync: false;
  /**
   * Future graph offload is explicitly disabled. Keeping the field on the
   * wire (rather than omitting it) makes a future offload mode an intentional
   * protocol change instead of an accidental default flip.
   */
  offload: false;
}

export interface GraphWriterRunMessage {
  type: 'run';
  id: number;
  kind: GraphWriteKind;
  /** Present for syncFiles/indexFiles; already deduped by the main thread. */
  files?: string[];
}

export interface GraphWriterAbortMessage {
  type: 'abort';
  id: number;
}

export interface GraphWriterShutdownMessage {
  type: 'shutdown';
}

/** Test-only fault injection used to exercise crash cleanup. */
export interface GraphWriterCrashMessage {
  type: '__crash';
}

export type GraphWriterRequest =
  | GraphWriterInitMessage
  | GraphWriterRunMessage
  | GraphWriterAbortMessage
  | GraphWriterShutdownMessage
  | GraphWriterCrashMessage;

export type GraphWriterResponse =
  | { type: 'ready' }
  | { type: 'fatal'; error: SerializedGraphWriterError }
  | { type: 'progress'; id: number; progress: IndexProgress }
  | {
      type: 'result';
      id: number;
      result: GraphWriteResult;
      /** True when the worker followed a database replaced on disk before writing. */
      databaseReplaced: boolean;
    }
  | { type: 'error'; id: number; error: SerializedGraphWriterError }
  | { type: 'closed' };