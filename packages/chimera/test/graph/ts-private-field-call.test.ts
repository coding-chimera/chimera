/**
 * this.#field.method() resolves on the field's type (#1987).
 *
 * Fork port of the private-field hunks upstream b65e05b added to
 * `__tests__/ts-this-field-call.test.ts` (self-contained here: the fork has
 * no vendored copy of that file). A call through an ES private field used to
 * be emitted as the bare method name and exact-matched whichever project
 * method shared it; the extractor now keeps `this.#items.add`, the resolver
 * matches the shape and reads the field's type off the class declaration, and
 * a builtin or external field type yields no edge.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('this.#field.method() (#1987)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1987-vault-'));
    fs.writeFileSync(path.join(dir, 'mailer.ts'), 'export class Mailer {\n  send(msg: string): string { return msg; }\n}\n');
    // ES private fields (#1987). `Outbox::send` and `Cart::add` sit in the same
    // file, so a bare-name guess would pick them over the field's real type.
    fs.writeFileSync(
      path.join(dir, 'vault.ts'),
      "import { Mailer } from './mailer';\n" +
        'export class Outbox {\n  send(msg: string): string { return msg; }\n}\n' +
        'export class Cart {\n  add(item: string): void {}\n}\n' +
        'export class Vault {\n' +
        '  #mailer: Mailer;\n' +
        '  #backup = new Mailer();\n' +
        '  #items = new Set<string>();\n' +
        '  constructor(m: Mailer) { this.#mailer = m; }\n' +
        '  notify(msg: string): string { return this.#mailer.send(msg); }\n' +
        '  fallback(msg: string): string { return this.#backup.send(msg); }\n' +
        '  put(x: string): void { this.#items.add(x); }\n' +
        '}\n'
    );
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const calleesOf = (qn: string): string[] => {
    const caller = cg.getNodesByKind('method').find((n) => n.qualifiedName === qn)!;
    expect(caller, qn).toBeDefined();
    return cg.getCallees(caller.id).map((c) => c.node.qualifiedName);
  };

  it('resolves an ES private field on its declared or constructed type (#1987)', () => {
    expect(calleesOf('Vault::notify')).toEqual(['Mailer::send']);
    expect(calleesOf('Vault::fallback')).toEqual(['Mailer::send']);
  });

  it('leaves a builtin-typed ES private field unresolved (#1987)', () => {
    // `this.#items.add()` on a Set must not bind to the project's `Cart::add`.
    expect(calleesOf('Vault::put')).toEqual([]);
  });
});

describe.each(['ts', 'tsx', 'js', 'jsx'])('private field receivers in %s (#1987)', (ext) => {
  let temp: string;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.close();
    graph = undefined;
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it.each(['LF', 'CRLF'])('keeps optional receivers distinct from public fields (%s)', async (ending) => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-private-1987-'));
    const source = `
export class Mailer { send() {} }
export class Cart { add() {} }
export class Vault {
  #mailer = new Mailer();
  #items = new Set();
  items = new Cart();
  notify() { this.#mailer?.send(); }
  optional() { this.#mailer.send?.(); }
  put() { this.#items?.add('x'); }
  publicPut() { this.items.add('x'); }
}
`;
    fs.writeFileSync(path.join(temp, `vault.${ext}`), ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source);
    graph = await CodeGraph.init(temp, { index: true });
    const callees = (name: string) => {
      const caller = graph!.getNodesByKind('method').find(n => n.qualifiedName === `Vault::${name}`)!;
      expect(caller).toBeDefined();
      return graph!.getCallees(caller.id).map(c => c.node.qualifiedName);
    };
    expect(callees('notify')).toEqual(['Mailer::send']);
    expect(callees('optional')).toEqual(['Mailer::send']);
    expect(callees('put')).toEqual([]);
    expect(callees('publicPut')).toEqual(['Cart::add']);
  });
});
