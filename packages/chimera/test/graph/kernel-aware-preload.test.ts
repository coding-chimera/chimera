/**
 * T0-1: kernel-aware WASM grammar preloading.
 *
 * Proves the three T0-1 contracts:
 *  a) A fully kernel-routed language set preloads NO wasm grammars — the
 *     preload set is `preloadLanguagesForFiles` minus `kernelRoutes` hits
 *     (filterKernelRoutedLanguages), and such a set is `kernelOnly`, which
 *     makes indexAll skip the ParseWorkerPool entirely (main-thread kernel
 *     arm, the existing in-process fallback branch).
 *  b) The kernel `defer:` valve still produces output: the grammar a
 *     deferred file needs is loaded LAZILY at the extraction seam
 *     (extractWithDeferredGrammarLoad — the shared helper behind the parse
 *     worker's 'parse' handler, indexAll's no-pool branch, and
 *     indexFileWithContent), then the extraction replays once.
 *  c) Behavior-preserved surfaces: non-routed languages (objc via the #1628
 *     `.h` expansion, ruling-⑤ `r`) stay in the preload set untouched, the
 *     CODEGRAPH_KERNEL=0 kill switch restores the full preload, and
 *     defer-eligible c/cpp keep the pool (isKernelOnlyLanguageSet false).
 *
 * The kernel arm is exercised with an INJECTED fake module
 * (setKernelForTests, kernel-selector.test.ts pattern) so the assertions are
 * machine-independent (no reliance on a staged vendored prebuild). The
 * lazy-load seam is made observable with unloadGrammarForTests, which evicts
 * one language from the process-global languageCache that other suites in
 * the shared bun-test process have already populated; afterEach restores it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NODE_KINDS, type ExtractionResult, type Language } from '../../src/graph/types';
import { CodeGraph } from '../../src/graph';
import { preloadLanguagesForFiles } from '../../src/graph/extraction';
import {
  initGrammars,
  loadGrammarsForLanguages,
  isGrammarLoaded,
  unloadGrammarForTests,
} from '../../src/graph/extraction/grammars';
import {
  DEFER_ELIGIBLE_LANGUAGES,
  filterKernelRoutedLanguages,
  isKernelOnlyLanguageSet,
  kernelRoutes,
  resetKernelForTests,
  resetKernelRoutingForTests,
  setKernelForTests,
  type KernelModule,
} from '../../src/graph/extraction/kernel';
import {
  extractWithDeferredGrammarLoad,
  missingKernelDeferredGrammar,
} from '../../src/graph/extraction/deferred-grammar';
import { EDGE_KINDS } from '../../src/graph/extraction/kernel/layout';
import { buildKernelBuffers } from './kernel-testutil';

const TS_SOURCE = `export class Svc {\n  run(x: number): string { return String(x); }\n}\n`;

/** Fake kernel à la kernel-selector.test.ts — marker output or a `defer:` throw. */
function makeFakeKernel(opts?: { defer?: boolean }): { mod: KernelModule; calls: string[] } {
  const calls: string[] = [];
  const buffers = buildKernelBuffers({
    nodes: [
      { kind: 'file', name: 'marker-file', id: 'file:marker' },
      { kind: 'function', name: 'kernelMarker', id: 'function:kernelMarker' },
    ],
    edges: [{ source: 0, target: 1, kind: 'contains' }],
    refs: [],
  });
  const mod: KernelModule = {
    extractFile(filePath, _content, language) {
      calls.push(`${filePath}:${language}`);
      if (opts?.defer) throw new Error('defer: parse tree contains errors — wasm recovery is canonical');
      return buffers;
    },
    contractInfo() {
      return {
        abiVersion: 2,
        kernelVersion: 'fake-preload-test-kernel',
        nodeKinds: [...NODE_KINDS],
        edgeKinds: [...EDGE_KINDS],
        // Deliberately WITHOUT objc/r: those must stay wasm-routed no matter
        // which languages are routed here.
        languages: ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'c', 'cpp', 'lua', 'luau', 'kotlin', 'scala', 'dart'],
      };
    },
    grammarInfo() {
      return null;
    },
  };
  return { mod, calls };
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-preload-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The `Failed to get parser` result shape TreeSitterExtractor.extract emits. */
function parserErrorResult(language: Language): ExtractionResult {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [{ message: `Failed to get parser for language: ${language}`, filePath: 'x.ts', severity: 'error', code: 'parser_error' }],
    durationMs: 0,
  };
}

describe('T0-1 kernel-aware grammar preload', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDir: string;

  beforeAll(async () => {
    for (const key of ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_PATH']) {
      savedEnv[key] = process.env[key];
    }
    await initGrammars();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    delete process.env.CODEGRAPH_KERNEL;
    delete process.env.CODEGRAPH_KERNEL_LANGS;
    resetKernelForTests();
    resetKernelRoutingForTests();
    tempDir = createTempDir();
  });

  afterEach(async () => {
    cleanupTempDir(tempDir);
    resetKernelForTests();
    resetKernelRoutingForTests();
    // Restore any grammar evicted by a test — the languageCache is
    // process-global and shared with every later suite in the bun-test run.
    await loadGrammarsForLanguages(['typescript', 'javascript', 'objc']);
  });

  describe('preload filter (a): routed languages never reach the wasm preload set', () => {
    it('fully kernel-routed set ⇒ empty preload set ⇒ kernelOnly ⇒ no worker pool', () => {
      const { mod } = makeFakeKernel();
      setKernelForTests(mod);

      const raw = preloadLanguagesForFiles(['src/a.ts', 'src/b.js', 'main.py', 'x.go']);
      expect([...raw].sort()).toEqual(['go', 'javascript', 'python', 'typescript']);
      for (const lang of raw) expect(kernelRoutes(lang)).toBe(true);

      // The preload set handed to loadGrammarsForLanguages / the pool is empty.
      expect(filterKernelRoutedLanguages(raw)).toEqual([]);
      // …and indexAll skips the ParseWorkerPool (useWorker && !kernelOnly).
      expect(isKernelOnlyLanguageSet(raw)).toBe(true);
      // The empty set trivially qualifies (nothing to parse, nothing to preload).
      expect(isKernelOnlyLanguageSet([])).toBe(true);
    });

    it('kill switch CODEGRAPH_KERNEL=0 leaves the preload set untouched', () => {
      const { mod } = makeFakeKernel();
      setKernelForTests(mod);
      process.env.CODEGRAPH_KERNEL = '0';

      const raw = preloadLanguagesForFiles(['src/a.ts', 'main.py']);
      expect(kernelRoutes('typescript')).toBe(false);
      expect(filterKernelRoutedLanguages(raw)).toEqual(raw);
      expect(isKernelOnlyLanguageSet(raw)).toBe(false);
    });
  });

  describe('defer-eligible + mixed sets (c): behavior-preserved surfaces', () => {
    it('c/cpp: filtered from preload (lazy instead) but the set stays pool-worthy', () => {
      const { mod } = makeFakeKernel();
      setKernelForTests(mod);

      expect(DEFER_ELIGIBLE_LANGUAGES.has('c')).toBe(true);
      expect(DEFER_ELIGIBLE_LANGUAGES.has('cpp')).toBe(true);

      const raw = preloadLanguagesForFiles(['a.c', 'b.cpp']);
      // #1628 `.h`-ambiguity expansion: c drags cpp + objc into the raw set.
      expect(raw).toContain('objc');
      // c/cpp route to the kernel ⇒ out of the preload set; objc does NOT
      // route ⇒ it stays preloaded exactly as before (the #1628 contract).
      expect(filterKernelRoutedLanguages(raw)).toEqual(['objc']);
      // A defer-eligible language in the set ⇒ NOT kernel-only ⇒ indexAll
      // keeps the worker pool for the 10–40% defer band.
      expect(isKernelOnlyLanguageSet(raw)).toBe(false);
    });

    it('mixed set with non-routed objc / ruling-⑤ r keeps them in the preload set', () => {
      const { mod } = makeFakeKernel();
      setKernelForTests(mod);

      const raw = preloadLanguagesForFiles(['src/a.ts', 'src/App.m', 'legacy/stats.r']);
      expect(raw).toContain('typescript');
      expect(raw).toContain('objc');
      expect(raw).toContain('r');

      const filtered = filterKernelRoutedLanguages(raw);
      expect(filtered).not.toContain('typescript'); // routed ⇒ lazy-only
      expect(filtered).toContain('objc'); // not routed ⇒ preloaded (unchanged)
      expect(filtered).toContain('r'); // ruling-⑤: never routed, silent degradation intact
      expect(isKernelOnlyLanguageSet(raw)).toBe(false);
    });

    it('missingKernelDeferredGrammar fires only for routed languages with the no-parser shape', () => {
      const { mod } = makeFakeKernel();
      setKernelForTests(mod);

      // Routed language + the exact "Failed to get parser" shape ⇒ lazy load.
      expect(missingKernelDeferredGrammar(parserErrorResult('typescript'), 'typescript')).toBe('typescript');
      // Routed language, ordinary parse error ⇒ no reload (semantics unchanged).
      const parseErr: ExtractionResult = {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Parse error: boom', filePath: 'x.ts', severity: 'error', code: 'parser_error' }],
        durationMs: 0,
      };
      expect(missingKernelDeferredGrammar(parseErr, 'typescript')).toBeNull();
      // Non-routed language with the no-parser shape ⇒ null: ruling-⑤ names
      // keep their unavailableGrammarErrors silent degradation, non-routed
      // names keep their preload. No pointless reload loop.
      expect(missingKernelDeferredGrammar(parserErrorResult('objc'), 'objc')).toBeNull();
      expect(missingKernelDeferredGrammar(parserErrorResult('r'), 'r')).toBeNull();
    });
  });

  describe('defer seam (b): lazy grammar load keeps deferred files productive', () => {
    it('kernel-deferred file with an unloaded grammar ⇒ lazy load + replay ⇒ wasm output', async () => {
      const { mod, calls } = makeFakeKernel({ defer: true });
      setKernelForTests(mod);
      unloadGrammarForTests('typescript');
      expect(isGrammarLoaded('typescript')).toBe(false);

      const result = await extractWithDeferredGrammarLoad('svc.ts', TS_SOURCE, 'typescript');

      // Defer semantics preserved: the wasm arm answered with real output…
      expect(result.errors).toEqual([]);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(true);
      expect(result.nodes.some((n) => n.name === 'kernelMarker')).toBe(false);
      // …the grammar was loaded lazily exactly once…
      expect(isGrammarLoaded('typescript')).toBe(true);
      // …and the one-slot defer memo short-circuited the repeat native parse
      // (one kernel call, not two).
      expect(calls).toEqual(['svc.ts:typescript']);
    });

    it('indexAll end-to-end: kernel-only TS project indexes via the kernel arm with NO wasm grammar load', async () => {
      const { mod, calls } = makeFakeKernel();
      setKernelForTests(mod);
      unloadGrammarForTests('typescript');

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export class A { run() {} }\n`);
      fs.writeFileSync(path.join(srcDir, 'b.ts'), `export function b(): number { return 1; }\n`);

      const cg = CodeGraph.initSync(tempDir);
      try {
        const result = await cg.indexAll();
        expect(result.success).toBe(true);
        expect(result.filesIndexed).toBe(2);
        // Every file went through the native arm…
        expect(calls.sort()).toEqual(['src/a.ts:typescript', 'src/b.ts:typescript']);
        // …and the wasm typescript grammar was NEVER loaded during the run
        // (preload filtered it; no defer occurred to load it lazily).
        expect(isGrammarLoaded('typescript')).toBe(false);
        const nodes = cg.getNodesInFile('src/a.ts');
        expect(nodes.some((n) => n.name === 'kernelMarker')).toBe(true);
      } finally {
        cg.close();
      }
    });

    it('indexAll end-to-end: kernel-deferred TS file still produces wasm output via the lazy seam', async () => {
      const { mod } = makeFakeKernel({ defer: true });
      setKernelForTests(mod);
      unloadGrammarForTests('typescript');
      expect(isGrammarLoaded('typescript')).toBe(false);

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), TS_SOURCE);

      const cg = CodeGraph.initSync(tempDir);
      try {
        const result = await cg.indexAll();
        // The deferred file is INDEXED, not errored: the seam loaded the
        // grammar on demand and replayed through the wasm arm.
        expect(result.filesIndexed).toBe(1);
        expect(result.filesErrored).toBe(0);
        expect(result.errors.filter((e) => e.severity === 'error')).toEqual([]);
        expect(isGrammarLoaded('typescript')).toBe(true);
        const nodes = cg.getNodesInFile('src/a.ts');
        expect(nodes.some((n) => n.kind === 'class' && n.name === 'Svc')).toBe(true);
        expect(nodes.some((n) => n.name === 'kernelMarker')).toBe(false);
      } finally {
        cg.close();
      }
    });

    it('indexAll end-to-end: mixed ts + objc project — routed file takes the kernel, non-routed objc stays wasm', async () => {
      const { mod, calls } = makeFakeKernel();
      setKernelForTests(mod);

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export class A { run() {} }\n`);
      fs.writeFileSync(
        path.join(srcDir, 'b.m'),
        `@interface Foo : NSObject\n- (void)bar;\n@end\n@implementation Foo\n- (void)bar {}\n@end\n`
      );

      const cg = CodeGraph.initSync(tempDir);
      try {
        const result = await cg.indexAll();
        expect(result.success).toBe(true);
        // The .ts file went native; the fake kernel never saw the .m file
        // (objc is not in its language table ⇒ kernelSupports gate).
        expect(calls).toEqual(['src/a.ts:typescript']);
        const tsNodes = cg.getNodesInFile('src/a.ts');
        expect(tsNodes.some((n) => n.name === 'kernelMarker')).toBe(true);
        // objc keeps its pre-existing wasm behavior: when the grammar is
        // available (npm tree-sitter-wasms) the file yields wasm nodes with
        // no kernel marker; when it is genuinely unavailable on this
        // machine, the ruling stays the pre-T0-1 silent degradation — the
        // filter above never removed it from the preload set either way.
        if (isGrammarLoaded('objc')) {
          const mNodes = cg.getNodesInFile('src/b.m');
          expect(mNodes.length).toBeGreaterThan(0);
          expect(mNodes.some((n) => n.name === 'kernelMarker')).toBe(false);
        }
      } finally {
        cg.close();
      }
    });
  });
});
