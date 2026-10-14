/**
 * (B5) Default grammar idle-release window.
 *
 * The wasm grammar/parser caches are dropped after a whole-process idle gap.
 * The original 5s default thrashed (unload + reload) on intermittent use; the
 * default is now 60s. Env `CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS` still overrides
 * (0 disables). The idle logic itself is unchanged — only the default value.
 */
import { describe, expect, test } from 'bun:test';
import { grammarIdleUnloadMsForTest } from '@/graph/extraction/grammars';

const saved = process.env.CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS;

function restore() {
  if (saved === undefined) delete process.env.CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS;
  else process.env.CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS = saved;
}

describe('grammar idle window (B5)', () => {
  test('default idle-release window is 60s', () => {
    delete process.env.CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS;
    try {
      expect(grammarIdleUnloadMsForTest()).toBe(60_000);
    } finally {
      restore();
    }
  });

  test('env override is honored', () => {
    process.env.CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS = '1234';
    try {
      expect(grammarIdleUnloadMsForTest()).toBe(1234);
    } finally {
      restore();
    }
  });

  test('0 disables the idle release', () => {
    process.env.CODEGRAPH_GRAMMAR_IDLE_UNLOAD_MS = '0';
    try {
      expect(grammarIdleUnloadMsForTest()).toBe(0);
    } finally {
      restore();
    }
  });
});