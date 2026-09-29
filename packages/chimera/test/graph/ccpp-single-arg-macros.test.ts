/**
 * C/C++ single-argument function macros (#1373).
 *
 * Fork port of the upstream test hunks in extraction.test.ts and
 * resolution.test.ts from 9b5c8e4 (the upstream kernel-ccpp-parity.test.ts
 * hunk is covered in the fork by running script/kernel-parity.ts over a
 * macros fixture — the fork has no per-language kernel parity test file).
 *
 * Single-argument function macros were indexed under parentheses in C or the
 * macro name in C++, breaking caller resolution. The name is now recovered
 * from BOTH parser shapes, but only when a preceding local #define establishes
 * the function name (registration, token-pasting, typedef and K&R forms stay
 * untouched; conditional-macro regions are never guessed across).
 *
 * Dual-arm extraction parity: wasm side in languages/c-cpp.ts
 * (recoverSingleArgMacroDefinedName), native side in
 * codegraph-kernel/src/ccpp/mod.rs. The wasm arm is pinned here
 * (CODEGRAPH_KERNEL=0); the native arm is verified by kernel-parity.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';

let savedKernelEnv: string | undefined;

beforeAll(async () => {
  savedKernelEnv = process.env.CODEGRAPH_KERNEL;
  process.env.CODEGRAPH_KERNEL = '0';
  await initGrammars();
  await loadAllGrammars();
});

afterAll(() => {
  if (savedKernelEnv === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = savedKernelEnv;
});

describe('C/C++ single-argument function macros (#1373)', () => {
  it.each(['c', 'cpp'] as const)('recovers single-argument function macros in %s (#1373)', (language) => {
    const code = '#define NATIVE_FN(name) int name(void)\n'
      + 'NATIVE_FN(get_version) { return helper(); }\n'
      + 'int use_it(void) { return get_version(); }\n';
    const result = extractFromSource(`main.${language}`, code, language);
    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.map((n) => n.name)).toEqual(['get_version', 'use_it']);
    expect(functions[0]).toMatchObject({ qualifiedName: 'get_version', startLine: 2, endLine: 2, startColumn: 0 });
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: functions[0].id, referenceName: 'helper', referenceKind: 'calls' }),
      expect.objectContaining({ fromNodeId: functions[1].id, referenceName: 'get_version', referenceKind: 'calls' }),
    ]));
  });

  it.each(['c', 'cpp'] as const)('does not guess single-argument macro names in %s (#1373)', (language) => {
    for (const prefix of [
      '',
      '// #define NATIVE_FN(name) int name(void)\n',
      '#define NATIVE_FN(name) int fixed(name)\n',
      '#define NATIVE_FN(name) int test_ ## name(void)\n',
      '#define NATIVE_FN(name) register_test(name)\n',
      '#define NATIVE_FN(name) typedef int name(void)\n',
      '#define NATIVE_FN(name) int name(void)\n#define NATIVE_FN int\n',
      '#define NATIVE_FN(name) int name(void)\n#ifdef OTHER\n#undef NATIVE_FN\n#endif\n',
      '#define NATIVE_FN(name) int name(void)\n#undef NATIVE_FN\n',
      '#define NATIVE_FN(name) int name(void)\n#define NATIVE_FN(name) int fixed(name)\n',
    ]) {
      const result = extractFromSource(`main.${language}`, prefix + 'NATIVE_FN(candidate) { return 1; }\n', language);
      expect(result.nodes.filter((n) => n.kind === 'function').map((n) => n.name)).not.toContain('candidate');
    }
    const alternate = extractFromSource(`main.${language}`, [
      '#ifdef OTHER', '#define NATIVE_FN(name) int name(void)', '#else',
      'NATIVE_FN(candidate) { return 1; }', '#endif', '',
    ].join('\n'), language);
    expect(alternate.nodes.filter((n) => n.kind === 'function').map((n) => n.name)).not.toContain('candidate');
    const ordinary = extractFromSource(`main.${language}`, 'int (parenthesized)(void) { return 1; }\n', language);
    expect(ordinary.nodes.find((n) => n.kind === 'function')?.name).toBe('(parenthesized)');
    if (language === 'c') {
      const knr = extractFromSource('knr.c', 'int old_style(arg) int arg; { return arg; }\n', 'c');
      expect(knr.nodes.find((n) => n.kind === 'function')?.name).toBe('old_style');
    }
  });
});

describe('C/C++ single-argument macro resolution (#1373)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it.each(['c', 'cpp'] as const)('connects single-argument function macros in %s (#1373)', async (language) => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1373-'));
    const file = `main.${language}`;
    fs.writeFileSync(path.join(tempDir, file), [
      '#define NATIVE_FN(name) int name(void)',
      'int helper(void) { return 1; }',
      'NATIVE_FN(get_version) { return helper(); }',
      'int use_it(void) { return get_version(); }',
      'int plain_func(void) { return 42; }',
      '',
    ].join('\n'));
    cg = await CodeGraph.init(tempDir, { index: true });
    const functions = cg.getNodesByKind('function');
    const recovered = functions.find((n) => n.name === 'get_version');
    expect(recovered).toBeDefined();
    expect(cg.getCallers(recovered!.id).map((c) => c.node.name)).toContain('use_it');
    expect(cg.getCallees(recovered!.id).map((c) => c.node.name)).toContain('helper');
    const caller = functions.find((n) => n.name === 'use_it')!;
    expect(cg.getCallees(caller.id).map((c) => c.node.id)).toContain(recovered!.id);
    expect(functions.map((n) => n.name)).toContain('plain_func');
    // The upstream codegraph_explore Flow-rendering assertion is dropped: the
    // fork's explore output shape differs (blast-radius + verbatim source).
  });
});
