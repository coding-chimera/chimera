/**
 * Graph writer worker entry
 *
 * Owns one read-write CodeGraph handle for a project root. The main thread
 * sends run/abort/shutdown frames over the worker port; writes execute one at
 * a time on the worker's serial chain, so the queue and the connection can
 * never race each other.
 *
 * The open is deliberately `{ readOnly: false, sync: false }`: a writer must
 * be able to mutate, and the caller's explicit writes drive sync (an implicit
 * sync on open would mutate behind the queue's back).
 */

import { parentPort } from 'worker_threads';
import CodeGraph from '../index';
import type { IndexProgress } from '../extraction';
import type {
  GraphWriteResult,
  GraphWriterAbortMessage,
  GraphWriterCrashMessage,
  GraphWriterInitMessage,
  GraphWriterRequest,
  GraphWriterResponse,
  GraphWriterRunMessage,
  GraphWriterShutdownMessage,
  SerializedGraphWriterError,
} from './protocol';

const port = parentPort;
if (!port) throw new Error('graph writer worker requires a parent port');

const post = (message: GraphWriterResponse): void => port.postMessage(message);

const serializeError = (error: unknown): SerializedGraphWriterError => {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: 'Error', message: String(error) };
};

const abortError = (): Error => {
  const error = new Error('graph write aborted');
  error.name = 'AbortError';
  return error;
};

let graph: CodeGraph | null = null;
const controllers = new Map<number, AbortController>();
let chain: Promise<void> = Promise.resolve();

const runWrite = async (
  instance: CodeGraph,
  message: GraphWriterRunMessage,
  onProgress: (progress: IndexProgress) => void,
  signal: AbortSignal,
): Promise<GraphWriteResult> => {
  switch (message.kind) {
    case 'sync':
      return instance.sync({ onProgress, signal });
    case 'syncFiles':
      return instance.syncFiles(message.files ?? [], { onProgress, signal });
    case 'indexAll':
      return instance.indexAll({ onProgress, signal });
    case 'indexFiles':
      // indexFiles() has no signal option; abort is honored before the call
      // and by the main thread dropping the result once it aborts.
      return instance.indexFiles(message.files ?? []);
    default:
      throw new Error(`unknown graph write kind: ${String((message as { kind?: unknown }).kind)}`);
  }
};

const execute = async (
  message: GraphWriterRunMessage,
): Promise<{ result: GraphWriteResult; databaseReplaced: boolean }> => {
  const instance = graph;
  if (!instance) throw new Error('graph writer is not ready');
  const controller = controllers.get(message.id) ?? new AbortController();
  controllers.set(message.id, controller);
  const signal = controller.signal;
  if (signal.aborted) throw abortError();
  // Follow a database replaced on disk (full rebuild / recreated data root)
  // before writing, and report it so callers can invalidate caches.
  const databaseReplaced = instance.reopenIfReplaced();
  const onProgress = (progress: IndexProgress) => post({ type: 'progress', id: message.id, progress });
  const result = await runWrite(instance, message, onProgress, signal);
  return { result, databaseReplaced };
};

const init = (message: GraphWriterInitMessage): void => {
  if (message.readOnly !== false || message.sync !== false || message.offload !== false) {
    post({
      type: 'fatal',
      error: { name: 'Error', message: 'graph writer requires readOnly:false, sync:false, offload:false' },
    });
    return;
  }
  chain = chain.then(async () => {
    try {
      graph = await CodeGraph.open(message.root, { readOnly: false, sync: false, offload: false });
      post({ type: 'ready' });
    } catch (error) {
      post({ type: 'fatal', error: serializeError(error) });
    }
  });
};

const run = (message: GraphWriterRunMessage): void => {
  controllers.set(message.id, controllers.get(message.id) ?? new AbortController());
  chain = chain.then(async () => {
    try {
      const { result, databaseReplaced } = await execute(message);
      post({ type: 'result', id: message.id, result, databaseReplaced });
    } catch (error) {
      post({ type: 'error', id: message.id, error: serializeError(error) });
    } finally {
      controllers.delete(message.id);
    }
  });
};

const abort = (message: GraphWriterAbortMessage): void => {
  controllers.get(message.id)?.abort();
};

const shutdown = (message: GraphWriterShutdownMessage): void => {
  void message;
  chain = chain.then(async () => {
    try {
      await graph?.close();
    } finally {
      graph = null;
      post({ type: 'closed' });
    }
  });
};

const crash = (message: GraphWriterCrashMessage): void => {
  void message;
  process.exit(1);
};

port.on('message', (message: GraphWriterRequest) => {
  switch (message.type) {
    case 'init':
      return init(message);
    case 'run':
      return run(message);
    case 'abort':
      return abort(message);
    case 'shutdown':
      return shutdown(message);
    case '__crash':
      return crash(message);
  }
});