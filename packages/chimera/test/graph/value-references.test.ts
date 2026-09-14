/**
 * Value-position identifier reference tests
 *
 * The JS/TS extractor emits a `references` unresolved reference for
 * identifiers in value positions — object shorthand `{ fn }`, bare call
 * arguments `register(fn)`, JSX expression bodies `onClick={h}`, assignment
 * right-hand sides — so a function passed as a value stays visible to
 * cross-file dependency walks. Declaration bindings, member receivers,
 * import specifiers, and type positions are deliberately NOT collected.
 * Separately, re-export sources feed the file→file kind='imports' edge
 * materialization alongside import mappings.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import { Edge, Node } from '../../src/graph/types';

describe('Value-position identifier references', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-value-refs-test-'));
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

  const index = async (): Promise<void> => {
    cg = await CodeGraph.init(tempDir, { index: true });
  };

  const fileNode = (filePath: string): Node | undefined =>
    cg.getNodesByKind('file').find((n) => n.filePath === filePath);

  const symbolNode = (filePath: string, name: string): Node | undefined =>
    cg.getNodesInFile(filePath).find((n) => n.name === name && n.kind !== 'file' && n.kind !== 'import');

  /** All resolved `references` edges leaving symbols (or the file node) of `filePath`. */
  const referencesFrom = (filePath: string): Edge[] => {
    const sources = new Set(cg.getNodesInFile(filePath).map((n) => n.id));
    return [...sources]
      .flatMap((id) => cg.getOutgoingEdges(id, ['references']))
      .filter((edge: Edge) => sources.has(edge.source));
  };

  /** References from `filePath` whose target is `name` in `targetFilePath`. */
  const referencesTo = (filePath: string, targetFilePath: string, name: string): Edge[] => {
    const target = symbolNode(targetFilePath, name);
    if (!target) return [];
    return referencesFrom(filePath).filter((edge: Edge) => edge.target === target.id);
  };

  /** file→file kind='imports' edges (materialized from import + re-export mappings). */
  const fileLevelImportEdges = (filePath: string): Edge[] => {
    const file = fileNode(filePath)!;
    return cg
      .getOutgoingEdges(file.id, ['imports'])
      .filter((edge: Edge) => cg.getNode(edge.target)?.kind === 'file');
  };

  it('collects object shorthand `{ fn }` as a cross-file references edge', async () => {
    write('src/dep.ts', 'export function handlerValue(): number { return 1; }\n');
    write('src/app.ts', 'import { handlerValue } from "./dep";\nexport const cfg = { handlerValue };\n');

    await index();

    const edges = referencesTo('src/app.ts', 'src/dep.ts', 'handlerValue');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.metadata?.refName).toBe('handlerValue');
  });

  it('collects a bare call argument `register(fn)` inside a function body', async () => {
    write('src/dep.ts', 'export function workerValue(): number { return 2; }\n');
    write(
      'src/app.ts',
      'import { workerValue } from "./dep";\nexport function boot(): void { registerForShutdown(workerValue); }\n'
    );

    await index();

    const edges = referencesTo('src/app.ts', 'src/dep.ts', 'workerValue');
    expect(edges).toHaveLength(1);
    expect(cg.getNode(edges[0]!.source)?.name).toBe('boot');
    // The callee position is covered by the `calls` path, never duplicated as
    // a value reference.
    expect(referencesTo('src/app.ts', 'src/dep.ts', 'registerForShutdown')).toHaveLength(0);
  });

  it('collects a JSX expression prop `onClick={h}` (tsx)', async () => {
    write('src/dep.tsx', 'export function clickHandler(): number { return 3; }\n');
    write(
      'src/view.tsx',
      'import { clickHandler } from "./dep";\nexport function Widget() { return <button onClick={clickHandler}>go</button>; }\n'
    );

    await index();

    const edges = referencesTo('src/view.tsx', 'src/dep.tsx', 'clickHandler');
    expect(edges).toHaveLength(1);
    expect(cg.getNode(edges[0]!.source)?.name).toBe('Widget');
  });

  it('emits zero edges for a destructuring binding shorthand', async () => {
    // `alphaValue` exists in the SAME file, so the cross-file import veto
    // cannot explain the zero-edge result: the binding position itself must
    // be excluded (shorthand_property_identifier_pattern, object_pattern).
    write(
      'src/app.ts',
      'export function alphaValue(): number { return 1; }\n' +
        'function take(): number { const { alphaValue } = payload(); return 0; }\n'
    );

    await index();

    expect(referencesFrom('src/app.ts')).toHaveLength(0);
  });

  it('does not emit a bare references edge for a member-expression receiver', async () => {
    // `registry` IS imported, so the veto would let a (wrong) edge through:
    // only the member-object guard keeps `referencesFrom` empty. The call
    // itself stays visible via the receiver-qualified `calls` reference.
    write('src/obj.ts', 'export const registry = { fetchData(): number { return 1; } };\n');
    write(
      'src/app.ts',
      'import { registry } from "./obj";\nexport function run(): number { return registry.fetchData(); }\n'
    );

    await index();

    expect(referencesFrom('src/app.ts')).toHaveLength(0);
    const calls = cg
      .getOutgoingEdges(symbolNode('src/app.ts', 'run')!.id, ['calls'])
      .filter((edge: Edge) => cg.getNode(edge.target)?.filePath === 'src/obj.ts');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('emits no self-referential references edges from import statements', async () => {
    write('src/dep.ts', 'export function fetchData(): number { return 1; }\n');
    write('src/app.ts', 'import { fetchData } from "./dep";\nexport const wrapperValue = fetchData();\n');

    await index();

    expect(referencesFrom('src/app.ts')).toHaveLength(0);
    // Control: the import wiring itself IS indexed, so the zero result above
    // is the specifier guard, not a missing import fact.
    expect(cg.getNodesInFile('src/app.ts').some((n) => n.kind === 'import')).toBe(true);
  });

  it('skips value references with names of two characters or fewer', async () => {
    write('src/dep.ts', 'export function ab(): number { return 1; }\n');
    write('src/app.ts', 'import { ab } from "./dep";\nexport const cfg = { ab };\n');

    await index();

    expect(referencesTo('src/app.ts', 'src/dep.ts', 'ab')).toHaveLength(0);
  });

  it("materializes a file-level imports edge for `export { x } from './a'`", async () => {
    write('src/a.ts', 'export function fmt(): number { return 1; }\n');
    write('src/c.ts', 'export { fmt } from "./a";\n');

    await index();

    const edges = fileLevelImportEdges('src/c.ts');
    expect(edges).toHaveLength(1);
    expect(cg.getNode(edges[0]!.target)?.filePath).toBe('src/a.ts');
    expect(cg.getFileDependents('src/a.ts')).toContain('src/c.ts');
  });

  it('keeps the import veto: local same-name without import yields zero edges to the foreign file', async () => {
    // app.ts has NO imports, so the unimported cross-file candidate in dep.ts
    // is vetoed; the same-file candidate stays allowed but is ambiguous.
    write('src/dep.ts', 'export function sharedName(): number { return 1; }\n');
    write('src/app.ts', 'const sharedName = 1;\nexport const cfg = { sharedName };\n');

    await index();

    expect(referencesTo('src/app.ts', 'src/dep.ts', 'sharedName')).toHaveLength(0);
  });
});
