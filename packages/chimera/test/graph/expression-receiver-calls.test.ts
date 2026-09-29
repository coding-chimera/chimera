/**
 * Expression receivers never bind by bare name (upstream #2032 / #1944 family).
 *
 * A method called on an EXPRESSION receiver never binds by bare name to an
 * unrelated project method. `(await list()).map(...)` in TypeScript and
 * `v.iter().map(...)` in Rust both reached the resolver as the bare `map`,
 * which exact-matched a TypeScript class's `map` — the Rust one across
 * languages. TS/JS extraction now looks through wrappers that keep the
 * receiver (`(x)`, `x!`, `x as T`, `await`) and emits nothing for a receiver
 * with no static type; the resolver refuses a bare-named call into another
 * language family's class members.
 *
 * Fork port of upstream `__tests__/expression-receiver-calls.test.ts` (9649ce1).
 * Dual-arm: extraction in tree-sitter.ts + codegraph-kernel/src/tsjs/extractors.rs
 * (peel_receiver / keeps_bare_receiver); resolution gate in name-matcher.ts +
 * resolver.rs. Fork adaptations: getCallees/getCallers replaced with
 * getOutgoingEdges/getIncomingEdges + getNode; stmt@ statement nodes (fork-only
 * D2 extraction) filtered from caller lists.
 */

import { describe, it, expect, beforeAll, afterAll } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';

let dir: string;
let cg: CodeGraph;

const files: Record<string, string> = {
  'src/adapter.ts':
    'export class GraphAdapter { async map(req?: string) { return req ?? \'\'; } }\n' +
    'export class Runner { run() { return 1; } }\n' +
    'export class Base { hello() { return 1; } }\n',
  'src/use.ts':
    "import { GraphAdapter, Runner, Base } from './adapter';\n" +
    "import { helper } from './helper.js';\n" +
    'async function list(): Promise<string[]> { return []; }\n' +
    'export async function names() {\n' +
    '  const a = (await list()).map((d) => d.length);\n' +
    '  const b = [1, 2].map((x) => x + 1);\n' +
    '  const c = (a ?? []).map((x) => x);\n' +
    '  return [a, b, c];\n' +
    '}\n' +
    'export function typed(g: GraphAdapter | undefined) {\n' +
    '  return g!.map();\n' +
    '}\n' +
    'export function fresh() { return new Runner().run() + helper(); }\n' +
    'export class Child extends Base {\n' +
    '  greet() { return this.hello() + super.hello(); }\n' +
    '}\n',
  'src/helper.js': 'export function helper() { return 2; }\n',
  'k/src/lib.rs':
    'pub fn lens(v: Vec<String>) -> Vec<usize> { v.iter().map(|s| s.len()).collect() }\n' +
    'pub fn opt(o: Option<u8>) -> Option<u16> { o.map(|x| x as u16) }\n',
  // A cgo `//export` function called from Swift through the bridging header.
  'export_ios.go': 'package main\n\nimport "C"\n\n//export OpenFluxStop\nfunc OpenFluxStop() {}\n',
  'ios/Tunnel.swift': 'func stopTunnel() {\n  OpenFluxStop()\n}\n',
  // Kotlin's `Log.i(...)` reaches the resolver as the bare `i`.
  'web/min.js': 'function i(a) { return a; }\n',
  'android/Diag.kt': 'fun report() {\n  android.util.Log.i("tag", "msg")\n}\n',
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exprrecv-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.resolveReferences();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const node = (name: string, file: string) =>
  cg.getNodesByName(name).find((n) => n.filePath.endsWith(file) && (n.kind === 'function' || n.kind === 'method'))!;
const calleesOf = (name: string, file: string) => {
  // Fork adaptation: upstream getCallees lists UNIQUE callee nodes; the fork
  // keeps one edge per emitted ref (this.hello AND super.hello both bind
  // Base::hello), so dedupe by target id.
  const seen = new Set<string>();
  return cg.getOutgoingEdges(node(name, file).id, ['calls'])
    .map((e) => cg.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n && !seen.has(n.id) && !!seen.add(n.id))
    .map((n) => n.qualifiedName)
    .sort();
};
const callersOf = (name: string, file: string) =>
  cg.getIncomingEdges(node(name, file).id, ['calls'])
    .map((e) => cg.getNode(e.source))
    .filter((n): n is NonNullable<typeof n> => !!n && !n.name.startsWith('stmt@'))
    .map((n) => n.name);

describe('expression receivers', () => {
  it('TS: a call-result receiver does not bind `.map` to a project method', () => {
    expect(calleesOf('names', 'use.ts')).toEqual(['list']);
    expect(callersOf('map', 'adapter.ts')).toEqual(['typed']);
  });

  it('Rust: `v.iter().map()` does not bind to a TypeScript class method', () => {
    expect(calleesOf('lens', 'lib.rs')).toEqual([]);
    expect(calleesOf('opt', 'lib.rs')).toEqual([]);
  });

  it('keeps receiver-typed, bare, constructor, this/super and TS→JS calls', () => {
    expect(calleesOf('typed', 'use.ts')).toEqual(['GraphAdapter::map']);
    expect(calleesOf('fresh', 'use.ts')).toEqual(['Runner::run', 'helper']);
    expect(calleesOf('greet', 'use.ts')).toEqual(['Base::hello']);
  });

  it('Kotlin: a bare-named call does not bind to a JavaScript function', () => {
    expect(calleesOf('report', 'Diag.kt')).toEqual([]);
  });

  it('keeps a cross-language call to an exported free function (Swift → cgo)', () => {
    expect(calleesOf('stopTunnel', 'Tunnel.swift')).toEqual(['OpenFluxStop']);
  });

  it('TS extraction: wrappers peel to the receiver, untyped expressions emit nothing', () => {
    const src =
      'async function f(x: X, y: any) {\n' +
      '  (await list()).map(g);\n' +
      '  x!.run();\n' +
      '  (y as X).run();\n' +
      '  (x satisfies X).stop();\n' +
      '  getTarget("a")!.install();\n' +
      '  (a ?? b).map(g);\n' +
      '  arr[0].run();\n' +
      '  f().list.map(g);\n' +
      '  (() => 1).call(null);\n' +
      '  this.a.b.run();\n' +
      '  new Runner().go();\n' +
      '  window.Api.start();\n' +
      '}\n';
    const result = extractFromSource('t.ts', src, 'typescript');
    // Fork adaptation: the D2 statement extraction emits each ref twice —
    // once attributed to the stmt@ node and once to the enclosing function
    // (pre-existing fork behavior). Filter to the function-attributed copy,
    // like upstream's kernel-tsjs-parity test filters by fromNodeId.
    const fn = result.nodes.find((n) => n.name === 'f')!;
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls' && r.fromNodeId === fn.id)
      .map((r) => r.referenceName);
    expect(refs).toEqual([
      'list().map', 'list', 'x.run', 'y.run', 'x.stop', 'getTarget().install', 'getTarget',
      'f', 'run', 'go', 'start',
    ]);
  });
});
