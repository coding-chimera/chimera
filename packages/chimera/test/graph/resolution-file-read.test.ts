/**
 * Resolution file reads are size-guarded before decoding (#1553).
 *
 * Fork port of upstream `__tests__/resolution-file-read.test.ts` (276df3a).
 * Import resolvers may follow package metadata to an archive (`file:*.har`);
 * the guard rejects non-files and >1 MiB targets before UTF-8 decoding can
 * multiply a large binary blob into gigabytes of heap, and caches the
 * rejection.
 *
 * Adaptations:
 * - The spy-based upstream assertions run against the TS arm
 *   (CODEGRAPH_CTX=0): in the fork, readFile routes through the native ctx
 *   bridge first when a kernel is staged, so fs spies would see nothing.
 * - The native arm carries the SAME guard in resolver_ctx.rs read_file; a
 *   dual-arm behavioral test below asserts both arms return null for an
 *   oversized sparse archive and identical content for a normal file.
 * - The upstream ohpm/HAR workspace-import indexing case is dropped: the fork
 *   has no workspace-packages (oh-package.json5) resolver to exercise.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { ReferenceResolver } from '../../src/graph/resolution';
import type { ResolutionContext } from '../../src/graph/resolution/types';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../../src/graph/file-limits';
import { resetKernelForTests } from '../../src/graph/extraction/kernel';
import { hasPrebuild } from './kernel-testutil';

function sparseArchive(root: string): string {
  const relative = 'node_modules/example/react_native_openharmony.har';
  const archive = path.join(root, relative);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const fd = fs.openSync(archive, 'w');
  try {
    fs.writeSync(fd, Buffer.from([0x1f, 0x8b]));
    fs.ftruncateSync(fd, 2 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  return relative;
}

describe('resolution file reads (TS arm)', () => {
  let root: string;
  let cg: CodeGraph;
  let resolver: ReferenceResolver;
  let context: ResolutionContext;
  let savedKernel: string | undefined;
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    savedKernel = process.env.CODEGRAPH_CTX;
    process.env.CODEGRAPH_CTX = '0';
    resetKernelForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-read-'));
    cg = CodeGraph.initSync(root);
    resolver = new ReferenceResolver(root, (cg as any).queries);
    context = (resolver as any).context as ResolutionContext;
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    cg.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    if (savedKernel === undefined) delete process.env.CODEGRAPH_CTX;
    else process.env.CODEGRAPH_CTX = savedKernel;
    resetKernelForTests();
  });

  it('reads normal source files', () => {
    fs.writeFileSync(path.join(root, 'small.ts'), 'export const answer = 42;\n');
    expect(context.readFile('small.ts')).toBe('export const answer = 42;\n');
  });

  it('rejects an oversized package archive before decoding and caches the rejection', () => {
    const relative = sparseArchive(root);
    const read = spyOn(fs, 'readFileSync');
    const stat = spyOn(fs, 'statSync');
    spies.push(read, stat);
    expect(context.readFile(relative)).toBeNull();
    expect(context.readFile(relative)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, relative), 'export const repaired = true;');
    resolver.clearCaches();
    expect(context.readFile(relative)).toBe('export const repaired = true;');
  });

  it('accepts exactly the byte limit and rejects one byte more', () => {
    const content = 'a'.repeat(MAX_SOURCE_FILE_SIZE_BYTES);
    fs.writeFileSync(path.join(root, 'boundary.ts'), content);
    expect(context.readFile('boundary.ts')).toBe(content);
    fs.appendFileSync(path.join(root, 'boundary.ts'), 'a');
    resolver.clearCaches();
    const read = spyOn(fs, 'readFileSync');
    spies.push(read);
    expect(context.readFile('boundary.ts')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects directories before reading and caches missing files', () => {
    fs.mkdirSync(path.join(root, 'directory'));
    const read = spyOn(fs, 'readFileSync');
    const stat = spyOn(fs, 'statSync');
    spies.push(read, stat);
    for (const name of ['directory', 'missing.ts']) {
      expect(context.readFile(name)).toBeNull();
      expect(context.readFile(name)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!hasPrebuild())('resolution file reads (dual arm, #1553 guard mirrored in resolver_ctx.rs)', () => {
  let root: string;
  let cg: CodeGraph;
  let savedKernel: string | undefined;

  beforeEach(() => {
    savedKernel = process.env.CODEGRAPH_CTX;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-read-'));
    fs.writeFileSync(path.join(root, 'small.ts'), 'export const answer = 42;\n');
    sparseArchive(root);
    cg = CodeGraph.initSync(root);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    if (savedKernel === undefined) delete process.env.CODEGRAPH_CTX;
    else process.env.CODEGRAPH_CTX = savedKernel;
    resetKernelForTests();
  });

  function armReads(): { reads: Array<string | null>; nativeLive: boolean } {
    const resolver = new ReferenceResolver(root, (cg as any).queries);
    const context = (resolver as any).context as ResolutionContext;
    const nativeLive = resolver.getCtxBridge() !== null;
    const reads = [
      context.readFile('small.ts'),
      context.readFile('node_modules/example/react_native_openharmony.har'),
    ];
    resolver.dispose();
    return { reads, nativeLive };
  }

  it('native and TS arms answer identically for normal and oversized files', () => {
    delete process.env.CODEGRAPH_CTX;
    resetKernelForTests();
    const native = armReads();
    // The native run must actually route through the ctx bridge, else the
    // dual-arm comparison is vacuous.
    expect(native.nativeLive).toBe(true);
    process.env.CODEGRAPH_CTX = '0';
    resetKernelForTests();
    const wasm = armReads();
    expect(wasm.nativeLive).toBe(false);
    expect(native.reads).toEqual(wasm.reads);
    expect(native.reads[0]).toBe('export const answer = 42;\n');
    expect(native.reads[1]).toBeNull();
  });
});
