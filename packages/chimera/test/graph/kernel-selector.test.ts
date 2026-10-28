/**
 * Kernel selector gating tests (P0-2a acceptance, updated for the wave-5
 * W1 opening — DEFAULT_ROUTED = lua+luau + typescript/tsx/javascript/jsx +
 * kotlin/scala/dart + go/java/python/rust/c/cpp/php/ruby/csharp/swift +
 * pascal; the only kernel-supported language left non-routed is `r`,
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
 * - Framework extract() hooks no longer block the kernel arm (P1-1): the
 *   kernel extracts the base tree and the framework nodes merge afterwards,
 *   deduped against the extractor nodes.
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
import { buildKernelBuffers, type SyntheticNode } from './kernel-testutil';

const TS_SOURCE = `export class Svc {\n  run(x: number): string { return String(x); }\n}\n`;
const PY_SOURCE = `def top(a):\n    return a\n`;
const LUA_SOURCE = `local core = {}\nfunction core.run(x)\n  return tostring(x)\nend\nreturn core\n`;
const KT_SOURCE = `fun main() {\n    println(\"x\")\n}\n`;
// React/Next fixtures: framework extract() hooks that hit a .ts file
// (react's hook pattern + Next.js page route) exercise the P1-1 merge.
const REACT_HOOK_SOURCE = `import { useState } from 'react';\n\nexport function useCounter() {\n  const [count, setCount] = useState(0);\n  return { count, setCount };\n}\n`;
const REACT_COMPONENT_SOURCE = `import React from 'react';\n\nexport const Button = React.memo(function Button() { return <button />; });\n`;
const NEXT_PAGE_SOURCE = `export default function Page() {\n  return null;\n}\n`;
// Spring `@Value` on the same line as its field: the framework binding node
// restates the extractor's constant declaration AND is a reference source.
const SPRING_VALUE_SOURCE = `public class C {\n  @Value("\${port}") private static final int port = 1;\n}\n`;
// The `r` wasm grammar blob is optional on dev checkouts (graceful
// parser-init failure), so the iron-rule test gates on the SELECTOR (no
// kernel call), not on r's wasm output bytes.
const R_SOURCE = `add <- function(a, b) {\n  a + b\n}\n`;

/** The real vendored kernel's 23-language contract (wave 5, W1 objc). */
const ALL_KERNEL_LANGUAGES = [
  'typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go', 'c', 'cpp',
  'rust', 'csharp', 'ruby', 'php', 'swift', 'kotlin', 'r', 'lua', 'luau',
  'scala', 'dart', 'pascal', 'nix', 'objc',
];

/** Deterministic projection for byte-equivalence assertions (timestamps out). */
function normalize(result: ExtractionResult): unknown {
  return JSON.parse(
    JSON.stringify(result, (key, value) =>
      key === 'updatedAt' || key === 'durationMs' ? undefined : value
    )
  );
}

function makeFakeKernel(opts?: {
  defer?: boolean;
  languages?: string[];
  extraNodes?: SyntheticNode[];
}): { mod: KernelModule; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  const buffers = buildKernelBuffers({
    nodes: [
      { kind: 'file', name: 'marker-file', id: 'file:marker' },
      { kind: 'function', name: 'kernelMarker', id: 'function:kernelMarker' },
      ...(opts?.extraNodes ?? []),
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

  it('wave 5 (W1): DEFAULT_ROUTED pascal takes the kernel arm with NO env', () => {
    const { mod, calls } = makeFakeKernel({ languages: ALL_KERNEL_LANGUAGES });
    setKernelForTests(mod);
    expect(kernelRoutes('pascal')).toBe(true);
    const result = extractFromSource('Sample.pas', 'unit Sample;\ninterface\nimplementation\nend.\n', 'pascal');
    expect(calls.length).toBe(1);
    expect(calls[0]?.[2]).toBe('pascal');
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
  });

  it('wave 5 (W1): DEFAULT_ROUTED nix takes the kernel arm with NO env', () => {
    const { mod, calls } = makeFakeKernel({ languages: ALL_KERNEL_LANGUAGES });
    setKernelForTests(mod);
    expect(kernelRoutes('nix')).toBe(true);
    const result = extractFromSource('flake.nix', '{ pkgs }: { imports = [ ./hardware.nix ]; }', 'nix');
    expect(calls.length).toBe(1);
    expect(calls[0]?.[2]).toBe('nix');
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
  });

  it('wave 5 (W1): DEFAULT_ROUTED objc takes the kernel arm with NO env', () => {
    const { mod, calls } = makeFakeKernel({ languages: ALL_KERNEL_LANGUAGES });
    setKernelForTests(mod);
    expect(kernelRoutes('objc')).toBe(true);
    const result = extractFromSource('Foo.m', '@interface Foo : NSObject\n- (void)bar;\n@end\n', 'objc');
    expect(calls.length).toBe(1);
    expect(calls[0]?.[2]).toBe('objc');
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
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

  it('framework extract() hook no longer blocks the kernel arm; the merge pass still runs (P1-1)', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    // 'react' is language-applicable for typescript and has an extract() hook.
    const result = extractFromSource('svc.ts', TS_SOURCE, 'typescript', ['react']);
    expect(calls).toEqual([['svc.ts', TS_SOURCE, 'typescript']]);
    expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
    // The base tree is the kernel's, not the wasm extractor's.
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(false);
  });

  it('React .ts fixture: kernel arm + framework merge — a hook node never duplicates the extractor node', () => {
    const { mod, calls } = makeFakeKernel({
      extraNodes: [
        { kind: 'function', name: 'useCounter', id: 'function:useCounter', startLine: 3, endLine: 6 },
      ],
    });
    setKernelForTests(mod);
    const result = extractFromSource('src/hooks.ts', REACT_HOOK_SOURCE, 'typescript', ['react']);
    expect(calls).toEqual([['src/hooks.ts', REACT_HOOK_SOURCE, 'typescript']]);
    // react's extract() re-states `function useCounter` as a `hook:` node; the
    // merge keeps the extractor node and drops the restatement.
    const hooks = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useCounter');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.id).toBe('function:useCounter');
  });

  it('React .js fixture: a memo component is not duplicated by the framework merge', () => {
    const { mod } = makeFakeKernel({
      extraNodes: [
        { kind: 'component', name: 'Button', id: 'component:kernel', startLine: 3, endLine: 3 },
      ],
    });
    setKernelForTests(mod);
    const result = extractFromSource('src/Button.js', REACT_COMPONENT_SOURCE, 'javascript', ['react']);
    const components = result.nodes.filter((n) => n.kind === 'component' && n.name === 'Button');
    expect(components).toHaveLength(1);
    expect(components[0]!.id).toBe('component:kernel');
  });

  it('Next .ts fixture: kernel arm + framework route merge keeps a stable node order', () => {
    const { mod, calls } = makeFakeKernel();
    setKernelForTests(mod);
    const first = extractFromSource('src/app/page.ts', NEXT_PAGE_SOURCE, 'typescript', ['react']);
    expect(calls).toEqual([['src/app/page.ts', NEXT_PAGE_SOURCE, 'typescript']]);
    // Kernel nodes first (wire order), then the framework route appended.
    expect(first.nodes.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'file:marker-file',
      'function:kernelMarker',
      'route:/',
    ]);
    const second = extractFromSource('src/app/page.ts', NEXT_PAGE_SOURCE, 'typescript', ['react']);
    expect(second.nodes.map((n) => `${n.kind}:${n.name}`)).toEqual(
      first.nodes.map((n) => `${n.kind}:${n.name}`)
    );
  });

  it('framework merge still runs on the wasm result when the kernel defers', () => {
    const { mod, calls } = makeFakeKernel({ defer: true });
    setKernelForTests(mod);
    const result = extractFromSource('src/hooks.ts', REACT_HOOK_SOURCE, 'typescript', ['react']);
    expect(calls.length).toBe(1);
    // The wasm arm answered (its `function useCounter` is present) and react's
    // restatement is deduped, exactly as on the kernel arm.
    const hooks = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useCounter');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.id.startsWith('hook:')).toBe(false);
  });

  it('a deduped framework restatement keeps its references attached (no dangling fromNodeId)', () => {
    const { mod } = makeFakeKernel({
      languages: ALL_KERNEL_LANGUAGES,
      extraNodes: [
        { kind: 'constant', name: 'port', id: 'constant:port', startLine: 2, endLine: 2 },
      ],
    });
    setKernelForTests(mod);
    // spring's `@Value("${port}")` emits `spring-value:C.java:2:port`: same
    // kind/name/file/line as the extractor's `constant:port` field. The node
    // collapses, but its reference must follow the retained declaration.
    const result = extractFromSource('C.java', SPRING_VALUE_SOURCE, 'java', ['spring']);
    const ports = result.nodes.filter((n) => n.kind === 'constant' && n.name === 'port');
    expect(ports).toHaveLength(1);
    expect(ports[0]!.id).toBe('constant:port');
    const springRef = result.unresolvedReferences.find((r) => r.referenceName === 'port');
    expect(springRef).toEqual(
      expect.objectContaining({ fromNodeId: 'constant:port', referenceKind: 'references' })
    );
    // Every merged reference still points at a node the merge kept.
    for (const ref of result.unresolvedReferences) {
      expect(result.nodes.some((n) => n.id === ref.fromNodeId)).toBe(true);
    }
    // Same guarantee on the wasm arm (kill switch), where the restatement
    // collides with the wasm extractor's own constant node.
    process.env.CODEGRAPH_KERNEL = '0';
    const wasm = extractFromSource('C.java', SPRING_VALUE_SOURCE, 'java', ['spring']);
    expect(wasm.nodes.filter((n) => n.kind === 'constant' && n.name === 'port')).toHaveLength(1);
    for (const ref of wasm.unresolvedReferences) {
      expect(wasm.nodes.some((n) => n.id === ref.fromNodeId)).toBe(true);
    }
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
