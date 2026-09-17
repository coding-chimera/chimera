/**
 * Kernel selector gating tests (P0-2a acceptance, updated for the wave-4
 * K-v2 P5-2 opening — DEFAULT_ROUTED = lua+luau + typescript/tsx/javascript/jsx +
 * kotlin/scala/dart + go/java/python/rust/c/cpp/php/ruby/csharp/swift; the
 * only kernel-supported language left non-routed is `r`, awaiting a parity
 * corpus):
 * - Non-routed languages (`r`) with no CODEGRAPH_KERNEL_LANGS env:
 *   extractFromSource never consults the kernel (the byte-equivalence iron
 *   rule for the wasm arm; the python byte-equivalence rides the env-
 *   replacement and kill-switch tests below, and the full 345-case
 *   extraction.test.ts suite is the repository-wide proof — it pins
 *   CODEGRAPH_KERNEL=0 to stay on the wasm arm).
 * - Default-routed languages (lua/luau wave 1; the tsjs family wave 2;
 *   kotlin/scala/dart wave 3; the nine residual modules wave 4) take
 *   the kernel arm with NO env, and the CODEGRAPH_KERNEL=0 kill switch
 *   still returns them to wasm.
 * - CODEGRAPH_KERNEL_LANGS REPLACES the default set: opting typescript-only
 *   in pulls default-routed python back to wasm.
 * - `defer:` signals fall back to the wasm arm (error recovery canonical)
 *   and the one-slot memo short-circuits repeat attempts.
 * - A framework extract() hook hit skips the kernel arm.
 * - CODEGRAPH_KERNEL=0 kill switch wins over routing env.
 * The kernel arm is exercised with an INJECTED fake module
 * (setKernelForTests). The wasm baselines are computed with
 * CODEGRAPH_KERNEL=0 pinned: on a dev checkout the REAL vendored prebuild
 * (codegraph-kernel/prebuilds/<platform>-<arch>) is a loader candidate and
 * would otherwise serve default-routed languages during baseline capture.
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
const LUA_SOURCE = `local core = {}\nfunction core.run(x)\n  return tostring(x)\nend\nreturn core\n`;
const KT_SOURCE = `fun main() {\n    println(\"x\")\n}\n`;
// The `r` wasm grammar blob is optional on dev checkouts (graceful
// parser-init failure), so the iron-rule test gates on the SELECTOR (no
// kernel call), not on r's wasm output bytes.
const R_SOURCE = `add <- function(a, b) {\n  a + b\n}\n`;

/** The real vendored kernel's 20-language contract (wave 4). */
const ALL_KERNEL_LANGUAGES = [
  'typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go', 'c', 'cpp',
  'rust', 'csharp', 'ruby', 'php', 'swift', 'kotlin', 'r', 'lua', 'luau',
  'scala', 'dart',
];

/** Deterministic projection for byte-equivalence assertions (timestamps out). */
function normalize(result: ExtractionResult): unknown {
  return JSON.parse(
    JSON.stringify(result, (key, value) =>
      key === 'updatedAt' || key === 'durationMs' ? undefined : value
    )
  );
}

function makeFakeKernel(opts?: { defer?: boolean; languages?: string[] }): { mod: KernelModule; calls: Array<[string, string, string]> } {
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
        languages: opts?.languages ?? ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'lua', 'luau', 'kotlin', 'scala', 'dart'],
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
  let wasmBaselineLua: ExtractionResult;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    // Pure-wasm baselines: kill switch pinned so the real vendored prebuild
    // (a loader candidate on dev checkouts) cannot serve routed languages.
    for (const key of ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_PATH']) {
      savedEnv[key] = process.env[key];
    }
    process.env.CODEGRAPH_KERNEL = '0';
    delete process.env.CODEGRAPH_KERNEL_LANGS;
    delete process.env.CODEGRAPH_KERNEL_PATH;
    resetKernelForTests();
    wasmBaselineTs = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    wasmBaselinePy = extractFromSource('top.py', PY_SOURCE, 'python');
    wasmBaselineLua = extractFromSource('mod.lua', LUA_SOURCE, 'lua');
    delete process.env.CODEGRAPH_KERNEL;
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

  it('iron rule: non-routed language (r) + no env ⇒ kernel never consulted', () => {
    // Wave 4 routed every kernel language except `r` (no parity corpus yet) —
    // `r` is the living proof that DEFAULT_ROUTED membership is the only
    // router: a supported-but-non-routed language never reaches the kernel.
    const { mod, calls } = makeFakeKernel({ languages: ALL_KERNEL_LANGUAGES });
    setKernelForTests(mod);
    expect(kernelRoutes('r')).toBe(false);
    extractFromSource('x.r', R_SOURCE, 'r');
    expect(calls.length).toBe(0);
  });

  it('wave 4: DEFAULT_ROUTED go/java/python/rust/c/cpp/php/ruby/csharp/swift take the kernel arm with NO env', () => {
    const { mod, calls } = makeFakeKernel({ languages: ALL_KERNEL_LANGUAGES });
    setKernelForTests(mod);
    for (const lang of ['go', 'java', 'python', 'rust', 'c', 'cpp', 'php', 'ruby', 'csharp', 'swift'] as const) {
      expect(kernelRoutes(lang)).toBe(true);
    }
    // One extraction proves the selector really engages the native arm for a
    // wave-4 language (python; byte-parity of the rest is the harness's job,
    // see cbench/kernel-parity/ksd-parity-p52-*.json).
    const result = extractFromSource('top.py', PY_SOURCE, 'python');
    expect(calls).toEqual([['top.py', PY_SOURCE, 'python']]);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
    expect(result.nodes.some((n) => n.name === 'top')).toBe(false);
  });

  it('wave 1: DEFAULT_ROUTED lua/luau take the kernel arm with NO env', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    expect(kernelRoutes('lua')).toBe(true);
    expect(kernelRoutes('luau')).toBe(true);
    const result = extractFromSource('mod.lua', LUA_SOURCE, 'lua');
    expect(calls).toEqual([['mod.lua', LUA_SOURCE, 'lua']]);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
    // the wasm baseline is still the real extractor output (no marker)
    expect(wasmBaselineLua.nodes.some((n) => n.name === 'run' && n.kind !== 'file')).toBe(true);
  });

  it('wave 2: DEFAULT_ROUTED tsjs family takes the kernel arm with NO env and decodes', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    for (const lang of ['typescript', 'tsx', 'javascript', 'jsx'] as const) {
      expect(kernelRoutes(lang)).toBe(true);
    }
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

  it('wave 3: DEFAULT_ROUTED kotlin/scala/dart take the kernel arm with NO env', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    for (const lang of ['kotlin', 'scala', 'dart'] as const) {
      expect(kernelRoutes(lang)).toBe(true);
    }
    const result = extractFromSource('Main.kt', KT_SOURCE, 'kotlin');
    expect(calls).toEqual([['Main.kt', KT_SOURCE, 'kotlin']]);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
    expect(result.nodes.some((n) => n.name === 'main')).toBe(false);
  });

  it('kill switch CODEGRAPH_KERNEL=0 returns default-routed kotlin to the wasm arm', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL = '0';
    expect(kernelRoutes('kotlin')).toBe(false);
    const result = extractFromSource('Main.kt', KT_SOURCE, 'kotlin');
    expect(calls.length).toBe(0);
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'main')).toBe(true);
  });

  it('kill switch CODEGRAPH_KERNEL=0 returns default-routed lua to the wasm arm', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL = '0';
    const result = extractFromSource('mod.lua', LUA_SOURCE, 'lua');
    expect(calls.length).toBe(0);
    expect(normalize(result)).toEqual(normalize(wasmBaselineLua));
  });

  it('kill switch CODEGRAPH_KERNEL=0 returns default-routed typescript to the wasm arm', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL = '0';
    expect(kernelRoutes('typescript')).toBe(false);
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls.length).toBe(0);
    expect(normalize(result)).toEqual(normalize(wasmBaselineTs));
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(true);
  });

  it('CODEGRAPH_KERNEL_LANGS=typescript opts typescript in and REPLACES the default set (wave-4 python back to wasm)', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    expect(kernelRoutes('typescript')).toBe(true);
    expect(kernelRoutes('python')).toBe(false); // default-routed since wave 4, but env REPLACES
    const pyResult = extractFromSource('top.py', PY_SOURCE, 'python');
    expect(calls.length).toBe(0); // no kernel call for the python file
    expect(normalize(pyResult)).toEqual(normalize(wasmBaselinePy));
    const tsResult = extractFromSource('svc.ts', TS_SOURCE, 'typescript');
    expect(calls).toEqual([['svc.ts', TS_SOURCE, 'typescript']]);
    expect(tsResult.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
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
    process.env.CODEGRAPH_KERNEL_LANGS = 'python';
    process.env.CODEGRAPH_KERNEL = '0';
    const result = extractFromSource('top.py', PY_SOURCE, 'python');
    expect(calls.length).toBe(0);
    expect(normalize(result)).toEqual(normalize(wasmBaselinePy));
  });

  it('`defer:` signal ⇒ wasm arm output, and the one-slot memo skips the repeat native parse', () => {
    const { mod, calls } = makeFakeKernel({ defer: true });
    setKernelForTests(mod);
    // no env: typescript is default-routed since wave 2
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
    // 'react' is language-applicable for typescript and has an extract() hook.
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript', ['react']);
    expect(calls.length).toBe(0);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(false);
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(true);
  });

  it('framework names without an applicable extract() hook do NOT block the kernel arm', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    // 'drupal' is php/yaml-oriented — not applicable to typescript.
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript', ['drupal']);
    expect(calls.length).toBe(1);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
  });

  it('languages the binary does not support never route (kernelSupports gate)', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    expect(kernelRoutes('ruby')).toBe(false); // fake binary lists tsjs/py/go/lua only
    // ruby isn't in the fake's languages ⇒ wasm arm (grammars loaded in beforeAll)
    const result = extractFromSource('x.rb', 'def a; end\n', 'ruby');
    expect(calls.length).toBe(0);
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});
