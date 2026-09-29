/**
 * C++ COM interface declarations (#1519).
 *
 * Fork port of the upstream test hunks from 7678e6e (extraction.test.ts +
 * kernel-ccpp-parity.test.ts). MSVC COM `interface X : Base { virtual … };`
 * declarations parsed as functions, losing owners and methods; declaration-
 * position `interface` keywords are now normalized to byte-padded `struct`
 * when alias or declaration evidence is present, through the shared
 * preParseCppSource hook both extraction arms consume.
 *
 * Adaptation: the upstream kernel-ccpp-parity assertion is covered by the
 * dual-arm integration describe below (native = default routing for cpp,
 * wasm = CODEGRAPH_KERNEL=0) plus a script/kernel-parity.ts run over the
 * same fixture; the fork has no per-language kernel parity test file.
 */

import { describe, it, expect, beforeAll, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { detectLanguage, initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';
import { resetKernelForTests } from '../../src/graph/extraction/kernel';
import { hasPrebuild } from './kernel-testutil';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const COM_SOURCE = (eol: string) => [
  '#define interface struct',
  'struct IParentInterface { virtual void Parent() = 0; };',
  'interface IMyComInterface : IParentInterface {',
  '    virtual void Foo() = 0;',
  '    virtual void Bar() = 0;',
  '};',
  'interface IStandalone { virtual void Run() = 0; };',
  '',
].join(eol);

describe.each(
  ['native', 'wasm'].filter((backend) => backend === 'wasm' || hasPrebuild())
)('C++ COM interface declarations (%s, #1519)', (backend) => {
  let tempDir: string | undefined;
  let cg: CodeGraph | undefined;
  let savedKernel: string | undefined;

  beforeAll(() => {
    savedKernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    resetKernelForTests();
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it.each(['\n', '\r\n'])('indexes COM owners, methods and inheritance with %j line endings', async (eol) => {
    const source = COM_SOURCE(eol);
    expect(detectLanguage('MyInterface.h', source)).toBe('cpp');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1519-'));
    fs.writeFileSync(path.join(tempDir, 'MyInterface.h'), source);
    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();
    const nodes = cg.getNodesInFile('MyInterface.h');
    const owner = nodes.find((n) => n.name === 'IMyComInterface');
    expect(owner).toMatchObject({ kind: 'struct', startLine: 3 });
    for (const [name, line] of [['Foo', 4], ['Bar', 5]] as const) {
      expect(nodes.find((n) => n.name === name)).toMatchObject({
        kind: 'method', qualifiedName: `IMyComInterface::${name}`, isAbstract: true, startLine: line,
      });
    }
    expect(nodes.find((n) => n.name === 'IStandalone')).toMatchObject({ kind: 'struct' });
    expect(nodes.find((n) => n.name === 'Run')).toMatchObject({ qualifiedName: 'IStandalone::Run', isAbstract: true });
    expect(nodes.filter((n) => n.kind === 'function')).toEqual([]);
    const parent = nodes.find((n) => n.name === 'IParentInterface');
    expect(cg.getOutgoingEdges(owner!.id)).toContainEqual(expect.objectContaining({ kind: 'extends', target: parent!.id }));
    expect(await cg.getCode(owner!.id)).toContain('interface IMyComInterface');
  });
});

describe('C++ COM interface normalization (#1519)', () => {
  it('normalizes declaration evidence without a local alias and preserves all other bytes', async () => {
    const { cppExtractor } = await import('../../src/graph/extraction/languages/c-cpp');
    const source = [
      '// interface Comment : Base {};',
      '/* interface Block { virtual void Fake() = 0; }; */',
      'const char* text = "interface String : Base {};";',
      'const char* raw = R"tag(interface Raw : Base {})tag";',
      '#define SAMPLE interface Macro : Base {}',
      '#define MULTI \\',
      'interface Continued : Base {}',
      'int interface = 1;',
      'void interface();',
      'interface value;',
      'interface ordinary{};',
      'interface IDerived : Base { virtual void Foo() = 0; };',
      'interface IStandalone { virtual void Run() = 0; };',
      '',
    ].join('\r\n');
    const expected = source.replace('interface IDerived', 'struct    IDerived').replace('interface IStandalone', 'struct    IStandalone');
    expect(cppExtractor.preParse!(source, 'com.hpp')).toBe(expected);
    expect(Buffer.byteLength(expected)).toBe(Buffer.byteLength(source));
  });
});
