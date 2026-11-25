/**
 * In-process inline-write registry
 *
 * The graph writer worker and an inline (non-offload) CodeGraph writer share
 * the process pid, so a lock file owned by "this pid" cannot by itself prove
 * the crashed worker owned it. Under the offload single-writer contract the
 * main thread never acquires a same-root write lock; this registry records the
 * windows where an inline writer DOES hold one, so crash cleanup can refuse to
 * sweep a live inline writer's lock.
 *
 * Only `src/graph/index.ts` (the inline file-lock acquire/release sites) and
 * the writer client's crash cleanup touch this module.
 */

import * as path from 'path';

const active = new Map<string, number>();

const keyOf = (root: string): string => path.resolve(root);

export function beginInlineWrite(root: string): void {
  const key = keyOf(root);
  active.set(key, (active.get(key) ?? 0) + 1);
}

export function endInlineWrite(root: string): void {
  const key = keyOf(root);
  const next = (active.get(key) ?? 1) - 1;
  if (next > 0) active.set(key, next);
  else active.delete(key);
}

/** True while this process holds a same-root inline write lock. */
export function hasInlineWriteLock(root: string): boolean {
  return (active.get(keyOf(root)) ?? 0) > 0;
}

/** Test seam: observe the registry without acquiring a lock. */
export function hasInlineWriteLockForTest(root: string): boolean {
  return hasInlineWriteLock(root);
}