import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';

const PHASE_NAMES: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  storing: 'Storing data',
  resolving: 'Resolving refs',
};

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
}

export interface ShimmerProgress {
  onProgress: (progress: IndexProgress) => void;
  stop: () => Promise<void>;
}

export function createShimmerProgress(): ShimmerProgress {
  let lastPhase = '';

  // The worker file is not shipped next to the binary, so prefer the
  // executable-relative location and degrade to a no-op progress when the
  // file is missing (e.g. installed packages) instead of failing.
  const workerPath = [
    path.join(path.dirname(process.execPath), 'shimmer-worker.js'),
    path.join(import.meta.dirname, 'shimmer-worker.js'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!workerPath) {
    return {
      onProgress() {},
      stop: async () => {},
    };
  }
  const worker = new Worker(workerPath, {
    workerData: { startTime: Date.now() },
  });
  worker.on('error', () => {});

  return {
    onProgress(progress: IndexProgress) {
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;

      if (progress.phase !== lastPhase && lastPhase) {
        worker.postMessage({ type: 'finish-phase' });
      }
      lastPhase = progress.phase;

      let percent = -1;
      let count = 0;
      if (progress.total > 0) {
        percent = Math.round((progress.current / progress.total) * 100);
      } else if (progress.current > 0) {
        count = progress.current;
      }

      worker.postMessage({
        type: 'update',
        phase: progress.phase,
        phaseName,
        percent,
        count,
      });
    },

    stop() {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate().then(() => resolve());
        }, 2000);

        worker.on('message', (msg: { type: string }) => {
          if (msg.type === 'stopped') {
            clearTimeout(timeout);
            worker.terminate().then(() => resolve());
          }
        });

        worker.postMessage({ type: 'stop' });
      });
    },
  };
}
