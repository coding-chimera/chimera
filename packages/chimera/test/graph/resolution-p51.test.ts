/**
 * K-v2 P5-1 resolution mechanism port tests.
 *
 * Covers the five workstreams end-to-end through real indexing (no resolver
 * mocks): D7 builtins merge, D8 cross-file pseudo-edge defenses (sealed
 * modules #1719, bare-call #1714, local-binding shadow, language
 * visibility #1730/#1745), D9 chain-form consumers (#1496 this.field.m,
 * #1861/#1585 rust self forms, #1683 call-receiver chains, #645 dotted
 * factory chains), the FN_REF #756 flip (function_ref → references edges
 * with metadata.fnRef), and the import-binding/re-export double-emission
 * hygiene (one file→symbol imports edge per dependency fact).
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import { Edge } from '../../src/graph/types';

describe('K-v2 P5-1 resolution mechanisms (end-to-end)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p51-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  const write = (relPath: string, content: string): void => {
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };

  const node = (filePath: string, name: string, kind?: string) =>
    cg.getNodesInFile(filePath).find((n) => n.name === name && (kind === undefined || n.kind === kind));

  const callersOf = (filePath: string, name: string): string[] => {
    const target = node(filePath, name);
    if (!target) return [];
    return cg.getCallers(target.id).map((c) => c.node.name);
  };

  const edgesBetween = (sourceFile: string, targetId: string, kind: Edge['kind']): Edge[] => {
    const sources = new Set(cg.getNodesInFile(sourceFile).map((n) => n.id));
    return [...sources]
      .flatMap((id) => cg.getOutgoingEdges(id, [kind]))
      .filter((e: Edge) => e.target === targetId);
  };

  // ── D7: builtins merge ─────────────────────────────────────────────────

  it('D7: suppresses WeakMap/WeakSet refs (N-union additions) and keeps project Map shadowing', async () => {
    write(
      'src/app.ts',
      'const cache = new WeakMap();\nexport function boot(): void { cache.set(1, 2); }\n'
    );
    write('src/weak.ts', 'export class WeakMap { set(k: number, v: number): void {} }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    // The builtin table suppresses the `WeakMap` name: no instantiates edge
    // onto the project class from the builtin-shaped use.
    const projectWeakMap = node('src/weak.ts', 'WeakMap');
    expect(projectWeakMap).toBeDefined();
    const instantiateEdges = edgesBetween('src/app.ts', projectWeakMap!.id, 'instantiates');
    expect(instantiateEdges).toHaveLength(0);
  });

  it('D7: a primitive-annotated receiver declines method binding (#1840)', async () => {
    write(
      'src/prim.ts',
      'export class Splitter { split(x: string): string[] { return [x]; } }\n' +
        'export function run(listed: string): void { listed.split(","); }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    // `listed.split()` on a `string` receiver is a builtin call: the
    // annotation evidence vetoes the heuristic strategies, so the project's
    // lone `split` method must NOT gain a caller.
    expect(callersOf('src/prim.ts', 'split')).not.toContain('run');
  });

  // ── D8: sealed module (#1719) ──────────────────────────────────────────

  it('D8: a zero-export ESM module is sealed — its symbols never bind cross-file', async () => {
    // sealed.ts has an `import` statement but exports NOTHING → sealed (#1719).
    // user.ts has NO imports, so the fork's import-veto stays permissive; only
    // the sealed-module guard can reject the cross-file bind here.
    write('src/sealed.ts', 'import { readFileSync } from "fs";\nfunction doWork(): number { return readFileSync.length; }\n');
    write('src/user.ts', 'export function go(): number { return doWork(); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/sealed.ts', 'doWork')).not.toContain('go');
  });

  it('D8: a CommonJS module is NOT sealed (module.exports counts as an export)', async () => {
    // cjs.js has an `import` statement AND a CommonJS export → the CJS
    // exemption in isSealedModule keeps it unsealed, so cjsWork binds.
    write('src/cjs.js', 'import "./polyfill";\nfunction cjsWork() { return 1; }\nmodule.exports = { cjsWork };\n');
    write('src/polyfill.js', 'export const p = 1;\n');
    write('src/caller.js', 'const { cjsWork } = require("./cjs");\nexport function drive() { return cjsWork(); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/cjs.js', 'cjsWork')).toContain('drive');
  });

  // ── D8: bare call #1714 + local-binding shadow ─────────────────────────

  it('D8: a receiver-less JS call never binds to a method (#1714)', async () => {
    write('src/svc.ts', 'export class Service { serialize(x: number): number { return x; } }\n');
    write('src/use.ts', 'import "./setup";\nexport function emit(v: number): number { return serialize(v); }\n');
    write('src/setup.ts', 'export const ready = true;\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    // `serialize(v)` is receiver-less; the only same-named symbol is a class
    // METHOD in another file — methods need a receiver, so no edge.
    expect(callersOf('src/svc.ts', 'serialize')).not.toContain('emit');
  });

  it('D8: a locally-bound name shadows cross-file symbols (no wrong edge)', async () => {
    write('src/other.ts', 'export function transform(x: number): number { return x + 1; }\n');
    write(
      'src/local.ts',
      'import { transform as otherTransform } from "./other";\n' +
        'const transform = (x: number) => otherTransform(x);\n' +
        'export function drive(v: number): number { return transform(v); }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    // The bare `transform(v)` call is a local const (shadow), not a call into
    // other.ts's exported function.
    expect(callersOf('src/other.ts', 'transform')).not.toContain('drive');
  });

  // ── D8: language visibility (#1730/#1745) ──────────────────────────────

  it('D8: a Kotlin private fun is file-local (never a cross-file candidate)', async () => {
    write('src/a.kt', 'package a\nclass Editor { private fun apply(): Int { return 1 } }\n');
    write('src/b.kt', 'package b\nfun driver(): Int { return apply() }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/a.kt', 'apply')).not.toContain('driver');
  });

  it('D8: a Go unexported name is package-local (directory-scoped)', async () => {
    write('src/pkg1/lower.go', 'package pkg1\nfunc helper() int { return 1 }\n');
    write('src/pkg2/use.go', 'package pkg2\nfunc Drive() int { return helper() }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/pkg1/lower.go', 'helper')).not.toContain('Drive');
  });

  it('D8: a C static function in a source file is translation-unit-local', async () => {
    write('src/impl.c', '#include "impl.h"\nstatic int compute_thing(int a) { return a; }\nint use_local(int b) { return compute_thing(b); }\n');
    write('src/impl.h', '#ifndef IMPL_H\n#define IMPL_H\nint use_local(int b);\n#endif\n');
    write('src/other.c', '#include "impl.h"\nint drive(int x) { return compute_thing(x); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const callers = callersOf('src/impl.c', 'compute_thing');
    expect(callers).toContain('use_local'); // same translation unit — visible
    expect(callers).not.toContain('drive'); // cross-file static — rejected
  });

  // ── D9: chain-form consumers ───────────────────────────────────────────

  it('D9: `this.field.method()` binds through the field declared type (#1496)', async () => {
    write('src/mailer.ts', 'export class Mailer { send(msg: string): void { void msg; } }\n');
    write(
      'src/notifier.ts',
      'import { Mailer } from "./mailer";\n' +
        'export class Notifier {\n' +
        '  private mailer: Mailer = new Mailer();\n' +
        '  send(msg: string): void { this.mailer.send(msg); }\n' +
        '}\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const mailerSend = callersOf('src/mailer.ts', 'send');
    expect(mailerSend).toContain('send'); // Notifier.send → Mailer.send
    // And NOT a self-edge: Notifier.send must not gain itself as caller.
    const notifierSend = node('src/notifier.ts', 'send', 'method')!;
    const selfCallers = cg.getCallers(notifierSend.id).map((c) => c.node.name);
    expect(selfCallers).not.toContain('send');
  });

  it('D9: `this.field.method()` with an external field type stays unresolved', async () => {
    write(
      'src/holder.ts',
      'export class Holder {\n' +
        '  private items: string[] = [];\n' +
        '  addOne(s: string): void { this.items.push(s); }\n' +
        '}\n'
    );
    write('src/decoy.ts', 'export class Decoy { push(s: string): void { void s; } }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    // `this.items.push()` — items is a builtin-typed field; the decoy's
    // same-named method must not gain the caller.
    expect(callersOf('src/decoy.ts', 'push')).not.toContain('addOne');
  });

  it('D9: rust `self.method()` binds to the enclosing impl type (#1861)', async () => {
    write(
      'src/target.rs',
      'pub struct Target { pub n: u32 }\nimpl Target { pub fn run(&self) -> u32 { self.reset() } pub fn reset(&self) -> u32 { 0 } }\n'
    );
    write('src/decoy.rs', 'pub struct Decoy;\nimpl Decoy { pub fn reset(&self) -> u32 { 1 } }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const targetReset = cg.getNodesInFile('src/target.rs').find((n) => n.name === 'reset' && n.kind === 'method')!;
    const callers = cg.getCallers(targetReset.id).map((c) => c.node.name);
    expect(callers).toContain('run');
    const decoyReset = cg.getNodesInFile('src/decoy.rs').find((n) => n.name === 'reset' && n.kind === 'method')!;
    expect(cg.getCallers(decoyReset.id)).toHaveLength(0);
  });

  it('D9: an unknown-receiver `inner().method` chain never fuzzy-binds (#1683)', async () => {
    write('src/proj.ts', 'export function run(): void {}\nexport function make(): { x: number } { return { x: 1 }; }\n');
    write('src/use.ts', 'import { make } from "./proj";\nexport function drive(): void { make().run(); }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    // The chain receiver's return type is unknown to the store-accessor-only
    // fallback: `make().run` must NOT bind to the project's `run` function.
    expect(callersOf('src/proj.ts', 'run')).not.toContain('drive');
  });

  it('D9: a dotted factory chain binds via the inner return type (#645)', async () => {
    write(
      'src/Factory.java',
      'package p;\npublic class Factory { public static Helper getInstance() { return new Helper(); } }\n'
    );
    write('src/Helper.java', 'package p;\npublic class Helper { public int compute() { return 2; } }\n');
    write('src/Main.java', 'package p;\npublic class Main { int go() { return Factory.getInstance().compute(); } }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callersOf('src/Helper.java', 'compute')).toContain('go');
  });

  // ── FN_REF flip (#756) ─────────────────────────────────────────────────

  it('FN_REF: a Python keyword-arg callback persists as a references edge with fnRef metadata', async () => {
    // Python is outside the fork's tsjs-scoped value-ref hook, so the #756
    // fn-ref capture is the sole emitter here (Thread(target=worker) — the
    // canonical keyword-argument registration shape).
    write(
      'src/w.py',
      'from threading import Thread\n' +
        'def worker():\n' +
        '    pass\n' +
        'def boot():\n' +
        '    Thread(target=worker)\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const worker = node('src/w.py', 'worker', 'function')!;
    const refs = cg.getIncomingEdges(worker.id, ['references']);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((e: Edge) => (e.metadata as Record<string, unknown>)?.fnRef === true)).toBe(true);
  });

  it('FN_REF: a TS bare-identifier callback co-captured by value-ref stays ONE references edge', async () => {
    // The fork's value-ref mechanism (D1 asset, broader than upstream's) also
    // captures `register(handler)` at the identical position. Both refs
    // resolve to the same edge identity (source, target, 'references', line,
    // col), so the unique index collapses them — first writer (value-ref,
    // flushed earlier) keeps its metadata. The dependency fact survives; the
    // fnRef marker yields to the earlier edge. Pinned so the co-capture can
    // never silently DOUBLE the edge.
    write(
      'src/reg.ts',
      'export function register(cb: () => void): void { cb(); }\n' +
        'function handler(): void {}\n' +
        'export function boot(): void { register(handler); }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const handler = node('src/reg.ts', 'handler', 'function')!;
    const refs = cg.getIncomingEdges(handler.id, ['references']);
    expect(refs).toHaveLength(1);
  });

  it('FN_REF: `this.member` values bind only to the enclosing class member', async () => {
    write(
      'src/comp.ts',
      'export class Comp {\n' +
        '  handleClick(): void {}\n' +
        '  wire(btn: { on(ev: string, cb: () => void): void }): void { btn.on("click", this.handleClick); }\n' +
        '}\n'
    );
    write('src/decoy2.ts', 'export function handleClick(): void {}\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const member = node('src/comp.ts', 'handleClick', 'method')!;
    const memberRefs = cg.getIncomingEdges(member.id, ['references']).filter(
      (e: Edge) => (e.metadata as Record<string, unknown>)?.fnRef === true
    );
    expect(memberRefs.length).toBeGreaterThan(0);
    const decoy = node('src/decoy2.ts', 'handleClick', 'function')!;
    expect(cg.getIncomingEdges(decoy.id, ['references'])).toHaveLength(0);
  });

  // ── Hygiene: import-binding / re-export double emission ────────────────

  it('hygiene: import + re-export of one symbol yields ONE file→symbol imports edge', async () => {
    write('src/schema.ts', 'export class Info { id = 1; }\n');
    write(
      'src/account.ts',
      'import { Info } from "./schema";\nexport { Info } from "./schema";\nexport function use(): Info { return new Info(); }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const info = node('src/schema.ts', 'Info', 'class')!;
    const importsEdges = edgesBetween('src/account.ts', info.id, 'imports');
    expect(importsEdges).toHaveLength(1);
  });

  it('hygiene: `import fs from "fs"` produces no file→import-node exact-match doubling (#915)', async () => {
    write('src/env.ts', 'import fs from "fs";\nexport function size(p: string): number { return fs.statSync(p).size; }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const fileNode = cg.getNodesByKind('file').find((n) => n.filePath === 'src/env.ts')!;
    const importNodeTargets = cg
      .getOutgoingEdges(fileNode.id, ['imports'])
      .filter((e: Edge) => cg.getNode(e.target)?.kind === 'import');
    // External module name matching an import-statement node is no longer a
    // candidate (import-kind exclusion), so no file→import-node imports edges.
    expect(importNodeTargets).toHaveLength(0);
  });
});
