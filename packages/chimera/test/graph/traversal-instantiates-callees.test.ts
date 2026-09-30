/**
 * getCallees must cross the instantiation boundary — fork alignment with the
 * upstream v1.6.1 final state of GraphTraverser.getCalleesRecursive (#774):
 * the outgoing-edge kind set is calls/references/imports/instantiates/
 * navigates. The fork list was frozen at the pre-#774 seed import, so a
 * function whose only out-edge to a symbol was `new Foo()` (promoted to an
 * `instantiates` edge by resolution's calls→class promotion) reported NO
 * callee for `Foo` — `trace` could not cross function → class → its methods.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';

describe('getCallees instantiates edge (upstream #774 alignment)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-callees-instantiates-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'widget.ts'),
      `export class Widget {
  spin(): number {
    return 1;
  }
}
`
    );
    fs.writeFileSync(
      path.join(srcDir, 'factory.ts'),
      `import { Widget } from './widget';

export function makeWidget(): Widget {
  return new Widget();
}
`
    );

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    cg.resolveReferences();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns the constructed class as a callee over its instantiates edge', () => {
    const makeWidget = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'makeWidget' && n.filePath.endsWith('factory.ts'));
    expect(makeWidget, 'makeWidget function node').toBeTruthy();

    const widget = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'Widget' && n.filePath.endsWith('widget.ts'));
    expect(widget, 'Widget class node').toBeTruthy();

    // The construction resolved to an `instantiates` edge (resolution's
    // calls→class promotion) — the regression: the pre-#774 kind list
    // (calls/references/imports) never walked it.
    const outgoing = cg.getOutgoingEdges(makeWidget!.id);
    expect(
      outgoing.some((e) => e.kind === 'instantiates' && e.target === widget!.id),
      'instantiates edge makeWidget → Widget exists in the store'
    ).toBe(true);

    const callees = cg.getCallees(makeWidget!.id);
    expect(
      callees.some((c) => c.node.id === widget!.id && c.edge.kind === 'instantiates'),
      'getCallees crosses the instantiates edge'
    ).toBe(true);
  });
});
