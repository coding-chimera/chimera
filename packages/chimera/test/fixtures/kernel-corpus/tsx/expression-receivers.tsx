// Typed expression receivers (upstream #2032 kernel-tsjs-parity fixture,
// fork corpus copy). Declarations keep `bun typecheck` clean (fork corpus
// convention, see private-fields.tsx); the syntactic receiver shapes are what
// extraction parity exercises. this/super chains live in a derived-class
// method because top-level this/super are TS errors; `window.Api` uses a
// declare-augmented Window so the bare `window.*` chain shape is preserved.
type X = { run(): void; stop(): void; install(): void; c: { has(n: number): boolean } };
declare global {
  interface Window { Api: { start(): void } }
}
declare function list(): Promise<X[]>;
declare function getTarget(id: string): X | undefined;
declare function f(): { list: X[] };
declare const g: (x: X) => number;
declare const a: X[] | undefined;
declare const b: X[];
declare const arr: X[];
class Runner { go() { return 1; } }
class Base { stop() {} }
async function exprReceivers(x: X, y: X) {
  (await list()).map(g);
  (x).run();
  x!.run();
  (y as X).run();
  (x satisfies X).stop();
  getTarget("a")!.install();
  if (x && y!.c.has(1)) {}
  (a ?? b).map(g);
  arr[0].run();
  f().list.map(g);
  (() => 1).call(null);
  new Runner().go();
  window.Api.start();
}
class Derived extends Base {
  e!: X;
  ab!: { b: X };
  chained(x: X) {
    if (x && this.e!.c.has(1)) {}
    this.ab.b.run();
    super.stop();
  }
}
