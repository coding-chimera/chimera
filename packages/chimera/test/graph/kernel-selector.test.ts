/**
 * Kernel selector gating tests (P0-2a acceptance):
 * - DEFAULT_ROUTED is EMPTY ⇒ with no CODEGRAPH_KERNEL_LANGS env, extractFromSource
 *   never consults the kernel and its output is identical to the pre-kernel wasm
 *   behavior (the byte-equivalence iron rule; the full 345-case
 *   extraction.test.ts suite is the repository-wide proof).
 * - CODEGRAPH_KERNEL_LANGS opts a language in ⇒ TS files take the kernel arm
 *   and the decoded ExtractionResult flows through extractFromSource.
 * - `defer:` signals fall back to the wasm arm (error recovery canonical) and
 *   the one-slot memo short-circuits repeat attempts.
 * - A framework extract() hook hit skips the kernel arm.
 * - CODEGRAPH_KERNEL=0 kill switch wins over routing env.
 *
 * The kernel arm is exercised with an INJECTED fake module (setKernelForTests):
 * the real vendored binary is contract-rejected at P0 (NODE_KINDS divergence —
 * see kernel-loader.test.ts), which is precisely the state these gates must
 * survive.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from './vitest';
import { NODE_KINDS, type ExtractionResult } from '../../src/graph/types';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';
import {
  resetKernelForTests,
  setKernelForTests,
  resetKernelRoutingForTests,
  kernelRoutes,
  type KernelModule,
} from '../../src/graph/extraction/kernel';
import { EDGE_KINDS } from '../../src/graph/extraction/kernel/layout';
import { buildKernelBuffers } from './kernel-testutil';

const TS_SOURCE = `export class Svc {\n  run(x: number): string { return String(x); }\n}\n`;
const PY_SOURCE = `def top(a):\n    return a\n`;

/** Deterministic projection for byte-equivalence assertions (timestamps out). */
function normalize(result: ExtractionResult): unknown {
  return JSON.parse(
    JSON.stringify(result, (key, value) =>
      key === 'updatedAt' || key === 'durationMs' ? undefined : value
    )
  );
}

function makeFakeKernel(opts?: { defer?: boolean }): { mod: KernelModule; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  const buffers = buildKernelBuffers({
    nodes: [
      { kind: 'file', name: 'marker-file', id: 'file:marker' },
      { kind: 'function', name: 'kernelMarker', id: 'function:kernelMarker' },
    ],
    edges: [{ source: 0, target: 1, kind: 'contains' }],
    refs: [{ from: 1, kind: 'calls', referenceName: 'String' }],
  });
  const mod: KernelModule = {
    extractFile(filePath, content, language) {
      calls.push([filePath, content, language]);
      if (opts?.defer) throw new Error('defer: parse tree contains errors — wasm recovery is canonical');
      return buffers;
    },
    contractInfo() {
      return {
        abiVersion: 2,
        kernelVersion: 'fake-test-kernel',
        nodeKinds: [...NODE_KINDS],
        edgeKinds: [...EDGE_KINDS],
        languages: ['typescript', 'python', 'go'],
      };
    },
    grammarInfo() {
      return null;
    },
  };
  return { mod, calls };
}

describe('extractFromSource kernel selector gating', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let wasmBaselineTs: ExtractionResult;
  let wasmBaselinePy: ExtractionResult;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    // Pure-wasm baselines (no kernel injected, no env).
    for (const key of ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_PATH']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetKernelForTests();
    wasmBaselineTs = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    wasmBaselinePy = extractFromSource('top.py', PY_SOURCE, 'python');
  });

  beforeEach(() => {
    delete process.env.CODEGRAPH_KERNEL;
    delete process.env.CODEGRAPH_KERNEL_LANGS;
    resetKernelForTests();
    resetKernelRoutingForTests();
  });

  afterEach(() => {
    resetKernelForTests();
    resetKernelRoutingForTests();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('P0 iron rule: DEFAULT_ROUTED empty + no env ⇒ kernel never consulted, wasm output unchanged', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    expect(kernelRoutes('typescript')).toBe(false);
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls.length).toBe(0);
    expect(normalize(result)).toEqual(normalize(wasmBaselineTs));
    // sanity: the wasm baseline is the real extractor output
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(true);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(false);
  });

  it('CODEGRAPH_KERNEL_LANGS=typescript ⇒ TS files take the kernel arm and decode', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    expect(kernelRoutes('typescript')).toBe(true);
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls).toEqual([['svc.ts', TS_SOURCE, 'typescript']]);
    const marker = result.nodes.find((n) => n.name === 'kernelMarker');
    expect(marker?.kind).toBe('function');
    expect(marker?.filePath).toBe('svc.ts');
    expect(marker?.language).toBe('typescript');
    expect(result.edges).toEqual([
      { source: 'file:marker', target: 'function:kernelMarker', kind: 'contains' },
    ]);
    expect(result.unresolvedReferences).toEqual([
      expect.objectContaining({ fromNodeId: 'function:kernelMarker', referenceName: 'String', referenceKind: 'calls' }),
    ]);
    expect(typeof result.durationMs).toBe('number');
  });

  it('non-routed languages stay on the wasm arm even when another language is opted in', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    const result = extractFromSource('top.py', PY_SOURCE, 'python');
    expect(calls.length).toBe(0);
    expect(normalize(result)).toEqual(normalize(wasmBaselinePy));
  });

  it('CODEGRAPH_KERNEL_LANGS=all routes every supported language', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = extractFromSource('top.py', PY_SOURCE, 'python');
    expect(calls.length).toBe(1);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
  });

  it('kill switch CODEGRAPH_KERNEL=0 beats the routing env', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    process.env.CODEGRAPH_KERNEL = '0';
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls.length).toBe(0);
    expect(normalize(result)).toEqual(normalize(wasmBaselineTs));
  });

  it('`defer:` signal ⇒ wasm arm output, and the one-slot memo skips the repeat native parse', () => {
    const { mod, calls } = makeFakeKernel({ defer: true });
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    const first = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls.length).toBe(1);
    expect(normalize(first)).toEqual(normalize(wasmBaselineTs));
    // Same (file, source, language) again: deferred memo short-circuits — no
    // second native parse; the wasm arm answers directly.
    const second = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls.length).toBe(1);
    expect(normalize(second)).toEqual(normalize(wasmBaselineTs));
    // A DIFFERENT file still attempts the kernel (slot is one-entry, last-deferred).
    extractFromSource('other.ts', TS_SOURCE, 'typescript');
    expect(calls.length).toBe(2);
  });

  it('framework extract() hook hit ⇒ kernel arm skipped, merge pass still runs', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    // 'react' is language-applicable for typescript and has an extract() hook.
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript', ['react']);
    expect(calls.length).toBe(0);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(false);
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(true);
  });

  it('framework names without an applicable extract() hook do NOT block the kernel arm', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    // 'drupal' is php/yaml-oriented — not applicable to typescript.
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript', ['drupal']);
    expect(calls.length).toBe(1);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
  });

  it('languages the binary does not support never route (kernelSupports gate)', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    expect(kernelRoutes('ruby')).toBe(false); // fake binary lists ts/py/go only
    // ruby isn't in the fake's languages ⇒ wasm arm (grammars loaded in beforeAll)
    const result = extractFromSource('x.rb', 'def a; end\n', 'ruby');
    expect(calls.length).toBe(0);
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});
