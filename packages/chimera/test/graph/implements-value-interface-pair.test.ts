/**
 * implements binds to the interface of a value+interface pair (#2055).
 *
 * Fork port of the upstream `__tests__/reference-target-kind.test.ts`
 * additions (4960720) — the fork has no reference-target-kind harness file
 * (its supertype-target gate landed with the #2029 port as resolveOneCore
 * post-validation), so these tests are self-contained.
 *
 * VS Code declares every service twice under one name — the DI identifier
 * `export const IFooService = createDecorator<IFooService>(…)` beside
 * `export interface IFooService` — so the import resolves to a file holding
 * both, and a strategy that takes the first export of that name gets the
 * value. The inheritance target-kind gate used to drop the edge; it now
 * moves a TypeScript constant/variable target to the ONE same-named
 * supertype-kind node in its file, and still drops the edge when there is
 * no such sibling.
 *
 * Dual-arm: TS retarget in resolution/index.ts resolveOneCoreUngated
 * (sameNamedTypeOfValue), native mirror in resolver.rs resolve_one_ungated
 * (same_named_type_of_value).
 */

import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2055-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
  return CodeGraph.init(tmpDir, { index: true });
}

describe('implements binds to the interface of a value+interface pair (#2055)', () => {
  it.each([
    ['value declared first', 'const'],
    ['interface declared first', 'interface'],
  ] as const)('binds implements to the interface (%s)', async (_label, first) => {
    const value = `export const IFooService = createDecorator<IFooService>('fooService');\n`;
    const type = `export interface IFooService {\n  run(): void;\n}\n`;
    const cg = await indexed({
      'src/instantiation.ts': `export function createDecorator<T>(id: string): { id: string } { return { id }; }\n`,
      'src/foo.ts': `import { createDecorator } from './instantiation';\n\n` + (first === 'const' ? value + type : type + value),
      'src/fooService.ts': `import { IFooService } from './foo';\n\nexport class FooService implements IFooService {\n  run(): void {}\n}\n`,
    });
    try {
      const iface = cg.getNodesByName('IFooService').find((n) => n.kind === 'interface');
      expect(iface).toBeDefined();
      const fooService = cg.getNodesByName('FooService').find((n) => n.kind === 'class')!;
      expect(fooService).toBeDefined();
      const edges = cg.getOutgoingEdges(fooService.id).filter((e) => e.kind === 'implements');
      expect(edges.some((e) => e.target === iface!.id)).toBe(true);
      const constant = cg.getNodesByName('IFooService').find((n) => n.kind === 'constant');
      expect(constant ? edges.some((e) => e.target === constant.id) : false).toBe(false);
    } finally {
      cg.destroy();
    }
  });

  it('still drops an implements whose only same-named target is a value', async () => {
    const cg = await indexed({
      'src/foo.ts': `export const IBarService = { id: 'bar' };\n`,
      'src/barService.ts': `import { IBarService } from './foo';\n\nexport class BarService implements IBarService {\n  id = 'bar';\n}\n`,
    });
    try {
      const bar = cg.getNodesByName('IBarService').find((n) => n.kind !== 'file');
      expect(bar).toBeDefined();
      expect(cg.getIncomingEdges(bar!.id).filter((e) => e.kind === 'implements')).toEqual([]);
    } finally {
      cg.destroy();
    }
  });
});
